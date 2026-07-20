/**
 * xlsx-worker.js
 * 通过 Electron 的 utilityProcess.fork() 在独立 Node.js 进程中执行 exceljs 操作。
 *
 * utilityProcess 是 Electron 官方提供的后台 Node.js 进程方案：
 *   - 不带 GUI / Crashpad / 渲染器，是纯 Node.js 进程
 *   - 进程崩溃/OOM 不会影响 Main Process
 *   - 通信使用 process.parentPort（MessagePort API）
 */

process.parentPort.on('message', async (e) => {
  const data = e.data
  const { source_path, output_path, modifications, append_rows, merge_cells, add_sheet, column_widths, data_validations } = data

  try {
    const ExcelJS = require('exceljs')
    const fs = require('fs')
    const JSZip = require('jszip')

    // 预处理以避免 exceljs 在解析包含超大 sqref 范围的数据验证时卡死/OOM
    let cleanBuffer
    try {
      const buffer = await fs.promises.readFile(source_path)
      const zip = await JSZip.loadAsync(buffer)
      const sheetFiles = Object.keys(zip.files).filter(name => name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml'))
      let modified = false

      for (const sheetFile of sheetFiles) {
        const xmlContent = await zip.file(sheetFile).async('string')
        
        // 动态计算最大数据行号
        let maxRow = 1000
        const dimMatch = xmlContent.match(/<dimension[^>]+ref="[A-Z]+\d+:([A-Z]+)(\d+)"/)
        if (dimMatch) {
          maxRow = parseInt(dimMatch[2], 10)
        } else {
          const singleMatch = xmlContent.match(/<dimension[^>]+ref="[A-Z]+(\d+)"/)
          if (singleMatch) {
            maxRow = parseInt(singleMatch[1], 10)
          }
        }
        
        // 设定限制上限为：最大行号 + 10000（最小 10000）
        const limitRow = Math.max(10000, maxRow + 10000)

        // 替换 sqref 里超过 limitRow 的大行号为 limitRow，防止 exceljs 卡死
        const cleanXml = xmlContent.replace(/<dataValidation([^>]*)sqref="([^"]+)"([^>]*)/g, (match, p1, sqref, p2) => {
          const newSqref = sqref.replace(/(\d+)/g, (numStr) => {
            const num = parseInt(numStr, 10)
            if (num > limitRow) {
              modified = true
              return String(limitRow)
            }
            return numStr
          })
          return `<dataValidation${p1}sqref="${newSqref}"${p2}`
        })

        if (modified) {
          zip.file(sheetFile, cleanXml)
        }
      }

      if (modified) {
        cleanBuffer = await zip.generateAsync({ type: 'nodebuffer' })
      } else {
        cleanBuffer = buffer
      }
    } catch (zipErr) {
      console.warn('[xlsx-worker] 预处理 zip 文件失败，降级为直接读取:', zipErr)
    }

    const workbook = new ExcelJS.Workbook()
    if (cleanBuffer) {
      await workbook.xlsx.load(cleanBuffer)
    } else {
      await workbook.xlsx.readFile(source_path)
    }

    // 添加新工作表
    if (add_sheet) {
      const sheetNames = Array.isArray(add_sheet) ? add_sheet : [add_sheet]
      for (const sheetName of sheetNames) {
        if (typeof sheetName === 'string' && sheetName && !workbook.getWorksheet(sheetName)) {
          workbook.addWorksheet(sheetName)
        }
      }
    }

    // 应用单元格修改
    let modCount = 0
    if (modifications && Array.isArray(modifications)) {
      for (const mod of modifications) {
        const ws = mod.sheet
          ? workbook.getWorksheet(mod.sheet)
          : workbook.worksheets[0]
        if (!ws) continue

        const cell = ws.getCell(mod.cell)
        if (mod.formula) {
          cell.value = { formula: mod.formula.replace(/^=/, '') }
        } else if (mod.value !== undefined) {
          cell.value = mod.value
        }

        if (mod.style) {
          const s = mod.style
          const font = {}
          if (s.bold) font.bold = true
          if (s.italic) font.italic = true
          if (s.fontSize) font.size = s.fontSize
          if (s.fontColor) font.color = { argb: 'FF' + s.fontColor.replace(/^#/, '') }
          if (Object.keys(font).length > 0) cell.font = font

          if (s.bgColor) {
            cell.fill = {
              type: 'pattern', pattern: 'solid',
              fgColor: { argb: 'FF' + s.bgColor.replace(/^#/, '') }
            }
          }

          if (s.borderStyle) {
            const border = {}
            const side = { style: s.borderStyle, color: s.borderColor ? { argb: 'FF' + s.borderColor.replace(/^#/, '') } : undefined }
            border.top = side; border.bottom = side; border.left = side; border.right = side
            cell.border = border
          }

          const alignment = {}
          if (s.align) alignment.horizontal = s.align
          if (s.valign) alignment.vertical = s.valign
          if (s.wrapText) alignment.wrapText = true
          if (Object.keys(alignment).length > 0) cell.alignment = alignment

          if (s.numberFormat) cell.numFmt = s.numberFormat
        }
        modCount++
      }
    }

    // 追加新行
    let appendCount = 0
    if (append_rows && Array.isArray(append_rows)) {
      for (const rowData of append_rows) {
        const ws = rowData.sheet
          ? workbook.getWorksheet(rowData.sheet)
          : workbook.worksheets[0]
        if (!ws) continue

        let rowValues = rowData.values
        if (!Array.isArray(rowValues)) {
          const cells = Array.isArray(rowData.row)
            ? rowData.row
            : Array.isArray(rowData.cells)
              ? rowData.cells
              : null
          if (cells) {
            const indexedValues = cells
              .map((cell) => {
                const match = String(cell && cell.cell || '').trim().match(/^([A-Z]+)(?:\d+)?$/i)
                if (!match) return null
                let index = 0
                for (const character of match[1].toUpperCase()) {
                  index = index * 26 + character.charCodeAt(0) - 64
                }
                return { index: index - 1, value: cell.value }
              })
              .filter(Boolean)
            const maxIndex = indexedValues.reduce((maximum, cell) => Math.max(maximum, cell.index), -1)
            rowValues = Array.from({ length: maxIndex + 1 }, () => null)
            for (const cell of indexedValues) rowValues[cell.index] = cell.value
          }
        }

        if (Array.isArray(rowValues)) {
          const processedValues = rowValues.map((val) => {
            if (typeof val === 'string' && val.startsWith('=')) {
              return { formula: val.substring(1) }
            }
            return val
          })
          ws.addRow(processedValues)
          appendCount++
        }
      }
    }

    // 合并单元格
    if (merge_cells && Array.isArray(merge_cells)) {
      const ws = workbook.worksheets[0]
      for (const range of merge_cells) {
        try { ws.unmergeCells(range) } catch (e) { /* ignore */ }
        ws.mergeCells(range)
      }
    }

    // 设置列宽
    if (column_widths && typeof column_widths === 'object') {
      const ws = workbook.worksheets[0]
      for (const [col, width] of Object.entries(column_widths)) {
        ws.getColumn(col).width = width
      }
    }

    // 设置数据验证
    if (data_validations && typeof data_validations === 'object') {
      const ws = workbook.worksheets[0]
      if (ws && ws.dataValidations) {
        for (const [range, dv] of Object.entries(data_validations)) {
          ws.dataValidations.add(range, {
            type: dv.type || 'list',
            formulae: dv.formulae || [],
            showErrorMessage: dv.showErrorMessage !== false,
            errorTitle: dv.errorTitle || '输入错误',
            error: dv.error || '请从下拉列表中选择',
            showInputMessage: dv.showInputMessage || false,
            promptTitle: dv.promptTitle || '',
            prompt: dv.prompt || ''
          })
        }
      }
    }

    await workbook.xlsx.writeFile(output_path)

    process.parentPort.postMessage({ success: true, modCount, appendCount })
  } catch (err) {
    process.parentPort.postMessage({ success: false, error: err.message || String(err) })
  }
})

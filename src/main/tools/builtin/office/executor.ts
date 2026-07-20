import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import { join } from 'path'

import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { resolveLocalPath, getGeneratedFilesDir, sessionLastXlsxMap } from '../../utils/paths'

export class OfficeExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. generate_file
      if (api === 'generate_file') {
        const { file_name, content, file_type } = args
        if (!file_name || !content) {
          return { content: '错误：缺少必要参数 file_name 或 content', success: false }
        }

        const genDir = getGeneratedFilesDir(context.sessionId)
        const safeName = file_name.replace(/[<>:”/\\|?*]/g, '_')
        const filePath = join(genDir, safeName)

        if (file_type === 'excel') {
          const ExcelJS = require('exceljs')
          const workbook = new ExcelJS.Workbook()

          let jsonData: any = null
          try { jsonData = JSON.parse(content) } catch (e) {}

          if (jsonData && jsonData.sheets && Array.isArray(jsonData.sheets)) {
            for (const sheetDef of jsonData.sheets) {
              const ws = workbook.addWorksheet(sheetDef.name || 'Sheet1')
              if (sheetDef.data && Array.isArray(sheetDef.data)) {
                for (let r = 0; r < sheetDef.data.length; r++) {
                  const row = sheetDef.data[r]
                  for (let c = 0; c < row.length; c++) {
                    const cell = ws.getCell(r + 1, c + 1)
                    cell.value = row[c]
                  }
                }
              }
              if (sheetDef.styles) {
                for (const [cellRef, style] of Object.entries(sheetDef.styles as Record<string, any>)) {
                  const cell = ws.getCell(cellRef)
                  const font: any = {}
                  if (style.bold) font.bold = true
                  if (style.italic) font.italic = true
                  if (style.fontSize) font.size = style.fontSize
                  if (style.fontColor) font.color = { argb: 'FF' + String(style.fontColor).replace(/^#/, '') }
                  if (Object.keys(font).length > 0) cell.font = font
                  if (style.bgColor) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + String(style.bgColor).replace(/^#/, '') } }
                  }
                  if (style.borderStyle) {
                    const side = { style: style.borderStyle, color: style.borderColor ? { argb: 'FF' + String(style.borderColor).replace(/^#/, '') } : undefined }
                    cell.border = { top: side, bottom: side, left: side, right: side }
                  }
                  const alignment: any = {}
                  if (style.align) alignment.horizontal = style.align
                  if (style.valign) alignment.vertical = style.valign
                  if (style.wrapText) alignment.wrapText = true
                  if (Object.keys(alignment).length > 0) cell.alignment = alignment
                  if (style.numberFormat) cell.numFmt = style.numberFormat
                }
              }
              if (sheetDef.formulas) {
                for (const [cellRef, formula] of Object.entries(sheetDef.formulas as Record<string, string>)) {
                  ws.getCell(cellRef).value = { formula: String(formula).replace(/^=/, '') }
                }
              }
              if (sheetDef.merge && Array.isArray(sheetDef.merge)) {
                for (const range of sheetDef.merge) {
                  ws.mergeCells(range)
                }
              }
              if (sheetDef.colWidths) {
                for (const [col, width] of Object.entries(sheetDef.colWidths as Record<string, number>)) {
                  ws.getColumn(col).width = width
                }
              }
              if (sheetDef.dataValidations) {
                for (const [range, dv] of Object.entries(sheetDef.dataValidations as Record<string, any>)) {
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
          } else {
            const ws = workbook.addWorksheet('Sheet1')
            const lines = content.split('\n')
            for (const line of lines) {
              ws.addRow(line.split(','))
            }
          }

          const sourceXlsx = context.sessionId ? sessionLastXlsxMap.get(context.sessionId) : null
          if (sourceXlsx && fs.existsSync(sourceXlsx)) {
            try {
              const ExcelJSReader = require('exceljs')
              const srcReaderWb = new ExcelJSReader.Workbook()
              await srcReaderWb.xlsx.readFile(sourceXlsx)
              for (const srcWs of srcReaderWb.worksheets) {
                const dstWs = workbook.getWorksheet(srcWs.name) || workbook.worksheets[0]
                if (!dstWs) continue
                const dvModel = (srcWs.dataValidations as any).model || srcWs.dataValidations
                if (!dvModel) continue
                for (const [addr, dv] of Object.entries(dvModel as Record<string, any>)) {
                  try {
                    dstWs.dataValidations.add(addr, {
                      type: dv.type || 'list',
                      formulae: dv.formulae || [],
                      showErrorMessage: dv.showErrorMessage !== false,
                      errorTitle: dv.errorTitle || '输入错误',
                      error: dv.error || '请从下拉列表中选择',
                      showInputMessage: dv.showInputMessage || false,
                      promptTitle: dv.promptTitle || '',
                      prompt: dv.prompt || ''
                    })
                  } catch (_) {}
                }
              }
            } catch (e: any) {
              console.warn('复制源文件数据验证失败（不影响文件生成）:', e.message)
            }
          }

          await workbook.xlsx.writeFile(filePath)
        } else if (file_type === 'word') {
          const docx = require('docx')
          const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } = docx
          const lines = content.split('\n')

          // 辅助解析 PNG/JPEG 图片宽高的函数
          const getImageSize = (buffer: Buffer): { width: number; height: number } | null => {
            try {
              if (
                buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
                buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
              ) {
                const width = buffer.readUInt32BE(16)
                const height = buffer.readUInt32BE(20)
                return { width, height }
              }
              if (buffer[0] === 0xff && buffer[1] === 0xd8) {
                let offset = 2
                while (offset < buffer.length) {
                  if (buffer[offset] !== 0xff) break
                  const marker = buffer[offset + 1]
                  const isSOF =
                    (marker >= 0xc0 && marker <= 0xc3) ||
                    (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) ||
                    (marker >= 0xcd && marker <= 0xcf)
                  if (isSOF) {
                    const height = buffer.readUInt16BE(offset + 5)
                    const width = buffer.readUInt16BE(offset + 7)
                    return { width, height }
                  }
                  const length = buffer.readUInt16BE(offset + 2)
                  offset += length + 2
                }
              }
            } catch (_) {}
            return null
          }

          const children: any[] = []
          for (const line of lines) {
            const trimmed = line.trim()
            const imgMatch = trimmed.match(/^!\[(.*?)\]\((.*?)\)/)
            if (imgMatch) {
              const imgPath = resolveLocalPath(imgMatch[2].trim())
              if (fs.existsSync(imgPath)) {
                try {
                  const imgBuffer = fs.readFileSync(imgPath)
                  let width = 450
                  let height = 300
                  const dimensions = getImageSize(imgBuffer)
                  if (dimensions && dimensions.width && dimensions.height) {
                    const maxWidth = 480
                    if (dimensions.width > maxWidth) {
                      width = maxWidth
                      height = Math.round((dimensions.height * maxWidth) / dimensions.width)
                    } else {
                      width = dimensions.width
                      height = dimensions.height
                    }
                  }
                  children.push(new Paragraph({
                    children: [
                      new ImageRun({
                        data: imgBuffer,
                        transformation: {
                          width,
                          height
                        }
                      })
                    ]
                  }))
                } catch (readErr) {
                  console.error('[docx-generation] 读取图片失败:', imgPath, readErr)
                  children.push(new Paragraph({
                    children: [new TextRun({ text: `[读取图片失败: ${imgMatch[2]}]`, size: 24, color: 'FF0000' })]
                  }))
                }
              } else {
                children.push(new Paragraph({
                  children: [new TextRun({ text: `[图片文件未找到: ${imgMatch[2]}]`, size: 24, color: 'FF0000' })]
                }))
              }
            } else if (line.startsWith('# ')) {
              children.push(new Paragraph({
                heading: HeadingLevel.HEADING_1,
                children: [new TextRun({ text: line.replace(/^#+\s*/, ''), bold: true, size: 32 })]
              }))
            } else if (line.startsWith('## ')) {
              children.push(new Paragraph({
                heading: HeadingLevel.HEADING_2,
                children: [new TextRun({ text: line.replace(/^#+\s*/, ''), bold: true, size: 28 })]
              }))
            } else if (line.startsWith('### ')) {
              children.push(new Paragraph({
                heading: HeadingLevel.HEADING_3,
                children: [new TextRun({ text: line.replace(/^#+\s*/, ''), bold: true, size: 24 })]
              }))
            } else if (line.trim() === '') {
              children.push(new Paragraph({ children: [] }))
            } else {
              children.push(new Paragraph({
                children: [new TextRun({ text: line, size: 24 })]
              }))
            }
          }

          const doc = new Document({ sections: [{ children }] })
          const buffer = await Packer.toBuffer(doc)
          await fs.promises.writeFile(filePath, buffer)
        } else if (file_type === 'pdf') {
          const PDFDocument = require('pdfkit')
          await new Promise<void>((resolve, reject) => {
            const pdf = new PDFDocument({ size: 'A4', margin: 50 })
            const stream = fs.createWriteStream(filePath)
            pdf.pipe(stream)
            try {
              const fontPath = process.platform === 'win32'
                ? 'C:/Windows/Fonts/msyh.ttc'
                : process.platform === 'darwin'
                  ? '/System/Library/Fonts/PingFang.ttc'
                  : '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'
              if (fs.existsSync(fontPath)) {
                pdf.registerFont('CJK', fontPath)
                pdf.font('CJK')
              }
            } catch (e) {}
            const lines = content.split('\n')
            for (const line of lines) {
              if (line.startsWith('# ')) {
                pdf.fontSize(20).text(line.replace(/^#+\s*/, ''), { continued: false })
                pdf.moveDown(0.3)
              } else if (line.startsWith('## ')) {
                pdf.fontSize(16).text(line.replace(/^#+\s*/, ''), { continued: false })
                pdf.moveDown(0.2)
              } else if (line.startsWith('### ')) {
                pdf.fontSize(14).text(line.replace(/^#+\s*/, ''), { continued: false })
                pdf.moveDown(0.1)
              } else {
                pdf.fontSize(11).text(line || ' ', { continued: false })
              }
            }
            pdf.end()
            stream.on('finish', resolve)
            stream.on('error', reject)
          })
        } else if (file_type === 'powerpoint' || file_type === 'pptx') {
          const PptxGenJS = require('pptxgenjs')
          const pptx = new PptxGenJS()
          pptx.layout = 'LAYOUT_16x9'
          const lines = content.split('\n')
          let currentSlide: any = null
          let lineCount = 0
          const maxLinesPerSlide = 12
          const ensureSlide = () => {
            if (!currentSlide) currentSlide = pptx.addSlide()
            return currentSlide
          }
          for (const line of lines) {
            if (line.startsWith('# ')) {
              currentSlide = pptx.addSlide()
              currentSlide.addText(line.replace(/^#+\s*/, ''), {
                x: 0.5, y: 0.3, w: '90%', h: 0.8,
                fontSize: 28, bold: true, color: '1a1a2e'
              })
              lineCount = 0
            } else if (line.startsWith('## ')) {
              currentSlide = pptx.addSlide()
              currentSlide.addText(line.replace(/^#+\s*/, ''), {
                x: 0.5, y: 0.3, w: '90%', h: 0.6,
                fontSize: 22, bold: true, color: '2d3436'
              })
              lineCount = 0
            } else if (line.trim() === '') {
              continue
            } else {
              if (lineCount >= maxLinesPerSlide) {
                currentSlide = pptx.addSlide()
                lineCount = 0
              }
              ensureSlide().addText(line, {
                x: 0.5, y: 1.0 + lineCount * 0.45, w: '90%', h: 0.4,
                fontSize: 14, color: '333333'
              })
              lineCount++
            }
          }
          ensureSlide()
          const buffer = await pptx.write({ outputType: 'nodebuffer' })
          await fs.promises.writeFile(filePath, buffer)
        } else {
          await fs.promises.writeFile(filePath, content, 'utf-8')
        }

        const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (activeWin) {
          activeWin.webContents.send('api:generated-file-updated')
        }

        return {
          content: JSON.stringify({
            status: 'success',
            message: `文件 “${safeName}” 已生成`,
            file_path: filePath,
            file_name: safeName
          }, null, 2),
          success: true
        }
      }

      // 2. modify_docx_file
      if (api === 'modify_docx_file') {
        let { source_path, output_name, modifications, images } = args
        source_path = resolveLocalPath(source_path)
        if (!source_path || !output_name) {
          return { content: '错误：缺少必要参数 source_path 或 output_name', success: false }
        }
        if (!modifications && !images) {
          return { content: '错误：至少需要提供 modifications 或 images 参数', success: false }
        }
        if (!fs.existsSync(source_path)) {
          return { content: `错误：源文件不存在：${source_path}`, success: false }
        }

        const JSZip = require('jszip')
        const path = require('path')
        
        let zip
        try {
          const buffer = await fs.promises.readFile(source_path)
          zip = await JSZip.loadAsync(buffer)
        } catch (e: any) {
          return { content: `错误：读取或解析源 Docx 文件失败：${e.message}`, success: false }
        }

        const docXmlFile = zip.file('word/document.xml')
        if (!docXmlFile) {
          return { content: '错误：该 docx 文件结构异常，未找到 word/document.xml', success: false }
        }

        let xml = await docXmlFile.async('string')
        let replaceCount = 0
        let imageCount = 0

        const mergeRPr = (existingRPr: string, style: any): string => {
          let rPr = existingRPr || '<w:rPr></w:rPr>'
          if (!rPr.includes('<w:rPr>')) rPr = '<w:rPr></w:rPr>'

          const upsert = (tag: string, value: string) => {
            const tagBase = tag.replace(/\/.*$/, '')
            const re = new RegExp(`${tagBase}[^/]*?\\/>`, 'g')
            if (rPr.match(re)) {
              rPr = rPr.replace(re, value)
            } else {
              rPr = rPr.replace('</w:rPr>', value + '</w:rPr>')
            }
          }

          if (style.bold !== undefined) {
            if (style.bold) upsert('<w:b', '<w:b/><w:bCs/>')
            else { rPr = rPr.replace(/<w:b\/>/g, '').replace(/<w:bCs\/>/g, '') }
          }
          if (style.italic !== undefined) {
            if (style.italic) upsert('<w:i', '<w:i/><w:iCs/>')
            else { rPr = rPr.replace(/<w:i\/>/g, '').replace(/<w:iCs\/>/g, '') }
          }
          if (style.underline !== undefined) {
            upsert('<w:u', `<w:u w:val="${style.underline ? 'single' : 'none'}"/>`)
          }
          if (style.color) upsert('<w:color', `<w:color w:val="${style.color}"/>`)
          if (style.fontSize) upsert('<w:sz', `<w:sz w:val="${style.fontSize}"/><w:szCs w:val="${style.fontSize}"/>`)
          if (style.highlight) upsert('<w:highlight', `<w:highlight w:val="${style.highlight}"/>`)
          return rPr
        }

        const replaceInXml = (xmlStr: string, search: string, replaceText: string, style?: any): string => {
          const bodyMatch = xmlStr.match(/([\s\S]*?<w:body[^>]*>)([\s\S]*?)(<\/w:body>[\s\S]*)/)
          if (!bodyMatch) {
            return replaceInXmlCore(xmlStr, search, replaceText, style)
          }
          const bodyPrefix = bodyMatch[1]
          const bodyContent = bodyMatch[2]
          const bodySuffix = bodyMatch[3]
          const newBody = replaceInXmlCore(bodyContent, search, replaceText, style)
          if (newBody !== bodyContent) return bodyPrefix + newBody + bodySuffix
          return xmlStr
        }

        const replaceInXmlCore = (xmlStr: string, search: string, replaceText: string, style?: any): string => {
          if (xmlStr.includes(search)) {
            if (style) {
              const runStart = '<w:r '
              const runStartAlt = '<w:r>'
              const runEnd = '</w:r>'
              let pos = 0
              while (pos < xmlStr.length) {
                let rStart = xmlStr.indexOf(runStart, pos)
                const rStartAlt = xmlStr.indexOf(runStartAlt, pos)
                if (rStart === -1) rStart = rStartAlt
                else if (rStartAlt !== -1 && rStartAlt < rStart) rStart = rStartAlt
                if (rStart === -1) break

                const rEnd = xmlStr.indexOf(runEnd, rStart)
                if (rEnd === -1) break
                const block = xmlStr.substring(rStart, rEnd + runEnd.length)

                if (block.includes(search)) {
                  let newBlock = block.replace(search, replaceText)
                  const existingRPrM = newBlock.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)
                  const existingRPr = existingRPrM ? existingRPrM[0] : ''
                  const mergedRPr = mergeRPr(existingRPr, style)
                  if (existingRPr) {
                    newBlock = newBlock.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, mergedRPr)
                  } else {
                    const rTagEnd = newBlock.indexOf('>')
                    newBlock = newBlock.substring(0, rTagEnd + 1) + mergedRPr + newBlock.substring(rTagEnd + 1)
                  }
                  return xmlStr.substring(0, rStart) + newBlock + xmlStr.substring(rEnd + runEnd.length)
                }
                pos = rEnd + runEnd.length
              }
            }
            return xmlStr.split(search).join(replaceText)
          }

          const runStart = '<w:r '
          const runStartAlt = '<w:r>'
          const runEnd = '</w:r>'
          const nodes: { type: 'run' | 'other'; content: string; text: string }[] = []
          let scanPos = 0

          while (scanPos < xmlStr.length) {
            let rStart = xmlStr.indexOf(runStart, scanPos)
            const rStartAlt = xmlStr.indexOf(runStartAlt, scanPos)
            if (rStart === -1) rStart = rStartAlt
            else if (rStartAlt !== -1 && rStartAlt < rStart) rStart = rStartAlt
            if (rStart === -1) {
              nodes.push({ type: 'other', content: xmlStr.substring(scanPos), text: '' })
              break
            }
            if (rStart > scanPos) {
              nodes.push({ type: 'other', content: xmlStr.substring(scanPos, rStart), text: '' })
            }
            const rEnd = xmlStr.indexOf(runEnd, rStart)
            if (rEnd === -1) {
              nodes.push({ type: 'other', content: xmlStr.substring(rStart), text: '' })
              break
            }
            const block = xmlStr.substring(rStart, rEnd + runEnd.length)
            const textM = block.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)
            nodes.push({ type: 'run', content: block, text: textM ? textM[1] : '' })
            scanPos = rEnd + runEnd.length
          }

          const runNodes = nodes.filter(n => n.type === 'run')
          let concat = ''
          const charOffsets: number[] = []
          for (const rn of runNodes) {
            charOffsets.push(concat.length)
            concat += rn.text
          }

          const idx = concat.indexOf(search)
          if (idx === -1) return xmlStr

          const endIdx = idx + search.length
          const involved: number[] = []
          for (let i = 0; i < runNodes.length; i++) {
            const start = charOffsets[i]
            const end = start + (runNodes[i].text?.length || 0)
            if (start < endIdx && end > idx) involved.push(i)
          }
          if (involved.length === 0) return xmlStr

          const first = involved[0]
          const last = involved[involved.length - 1]
          const prefix = (runNodes[first].text || '').slice(0, idx - charOffsets[first])
          const suffix = (runNodes[last].text || '').slice(endIdx - charOffsets[last])

          for (let i = 0; i <= last; i++) {
            if (!involved.includes(i)) continue
            const rn = runNodes[i]
            if (i === first) {
              let newContent = rn.content
              newContent = newContent.replace(/(<w:t[^>]*>)[\s\S]*?(<\/w:t>)/, `$1${prefix}${replaceText}${suffix}$2`)
              if (style) {
                const existingRPrM = newContent.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)
                const existingRPr = existingRPrM ? existingRPrM[0] : ''
                const mergedRPr = mergeRPr(existingRPr, style)
                if (existingRPr) {
                  newContent = newContent.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, mergedRPr)
                } else {
                  const rTagEnd = newContent.indexOf('>')
                  newContent = newContent.substring(0, rTagEnd + 1) + mergedRPr + newContent.substring(rTagEnd + 1)
                }
              }
              rn.content = newContent
              rn.text = prefix + replaceText + suffix
            } else {
              rn.content = rn.content.replace(/(<w:t[^>]*>)[\s\S]*?(<\/w:t>)/, '$1$2')
              rn.text = ''
            }
          }

          let result = ''
          let runIdx = 0
          for (const node of nodes) {
            if (node.type === 'other') {
              result += node.content
            } else {
              result += runNodes[runIdx].content
              runIdx++
            }
          }
          return result
        }

        if (modifications && Array.isArray(modifications)) {
          for (const mod of modifications) {
            if (!mod.search || typeof mod.search !== 'string') continue
            const before = xml
            const replacement = mod.replace ?? mod.search

            if (mod.paragraphStyle) {
              const pStyleVal = mod.paragraphStyle
              const paraRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
              let pm: RegExpExecArray | null
              let newXml = ''
              let lastPEnd = 0
              while ((pm = paraRegex.exec(xml)) !== null) {
                const paraBlock = pm[0]
                const paraStart = pm.index
                const styleMatch = paraBlock.match(/<w:pStyle\s+w:val="([^"]+)"/)
                const paraStyle = styleMatch ? styleMatch[1] : 'Normal'
                newXml += xml.slice(lastPEnd, paraStart)
                if (paraStyle === pStyleVal || paraStyle.toLowerCase() === pStyleVal.toLowerCase()) {
                  newXml += replaceInXml(paraBlock, mod.search, replacement, mod.style)
                } else {
                  newXml += paraBlock
                }
                lastPEnd = paraStart + paraBlock.length
              }
              newXml += xml.slice(lastPEnd)
              xml = newXml
            } else {
              xml = replaceInXml(xml, mod.search, replacement, mod.style)
            }

            const changed = xml !== before
            if (changed) replaceCount++
          }
        }

        if (images && Array.isArray(images)) {
          let relsXml = ''
          const relsFile = zip.file('word/_rels/document.xml.rels')
          if (relsFile) {
            relsXml = await relsFile.async('string')
          } else {
            relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
          }

          let contentTypes = ''
          const ctFile = zip.file('[Content_Types].xml')
          if (ctFile) {
            contentTypes = await ctFile.async('string')
          }

          for (const img of images) {
            if (!img.search_text || !img.image_path) continue
            const resolvedPath = resolveLocalPath(img.image_path)
            if (!fs.existsSync(resolvedPath)) {
              return { content: `错误：图片文件未找到，路径：${img.image_path}`, success: false }
            }

            let imgBuffer
            try {
              imgBuffer = await fs.promises.readFile(resolvedPath)
            } catch (e: any) {
              return { content: `错误：读取图片失败，路径：${img.image_path}，详情：${e.message}`, success: false }
            }
            
            const imgExt = path.extname(resolvedPath).toLowerCase().replace('.', '') || 'png'
            const contentTypeMap: Record<string, string> = {
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp'
            }
            const contentType = contentTypeMap[imgExt] || 'image/png'

            const existingMedia = Object.keys(zip.files).filter(f => f.startsWith('word/media/image'))
            const imgIndex = existingMedia.length + 1
            const imgFileName = `image${imgIndex}.${imgExt}`
            const relId = `rIdImg${imgIndex}`

            zip.file(`word/media/${imgFileName}`, imgBuffer)

            relsXml = relsXml.replace('</Relationships>',
              `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imgFileName}"/></Relationships>`)

            if (!contentTypes.includes(`Extension="${imgExt}"`)) {
              contentTypes = contentTypes.replace('</Types>',
                `<Default Extension="${imgExt}" ContentType="${contentType}"/></Types>`)
            }

            const widthEmu = Math.round((img.width || 10) * 360000)
            const heightEmu = Math.round((img.height || 8) * 360000)
            const drawingXml = `<w:drawing>` +
              `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
              `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
              `<wp:docPr id="${imgIndex}" name="Picture ${imgIndex}"/>` +
              `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
              `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
              `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
              `<pic:nvPicPr><pic:cNvPr id="${imgIndex}" name="${imgFileName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
              `<pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
              `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
              `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`

            const beforeImg = xml
            xml = replaceInXml(xml, img.search_text, drawingXml)
            if (xml === beforeImg) {
              xml = xml.replace(img.search_text, drawingXml)
            }
            imageCount++
          }

          zip.file('word/_rels/document.xml.rels', relsXml)
          zip.file('[Content_Types].xml', contentTypes)
        }

        zip.file('word/document.xml', xml)
        
        let outputBuffer
        try {
          outputBuffer = await zip.generateAsync({ type: 'nodebuffer' })
        } catch (e: any) {
          return { content: `错误：打包 Docx 文件失败：${e.message}`, success: false }
        }

        const genDir = getGeneratedFilesDir(context.sessionId)
        const safeName = output_name.replace(/[<>:"/\\|?*]/g, '_')
        const filePath = join(genDir, safeName)
        
        try {
          await fs.promises.writeFile(filePath, outputBuffer)
        } catch (e: any) {
          return { content: `错误：写入修改后的文件失败：${e.message}`, success: false }
        }

        const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (activeWin) {
          activeWin.webContents.send('api:generated-file-updated')
        }

        const parts: string[] = []
        if (replaceCount > 0) parts.push(`${replaceCount} 处文本`)
        if (imageCount > 0) parts.push(`${imageCount} 张图片`)

        return {
          content: JSON.stringify({
            status: 'success',
            message: `文件 "${safeName}" 已生成，修改了 ${parts.join('、')}`,
            file_path: filePath,
            file_name: safeName,
            replaced: replaceCount,
            images: imageCount
          }, null, 2),
          success: true
        }
      }

      // 3. modify_xlsx_file
      if (api === 'modify_xlsx_file') {
        let { source_path, output_name, modifications, append_rows, merge_cells, add_sheet, column_widths, data_validations } = args
        source_path = resolveLocalPath(source_path)
        if (!source_path || !output_name) {
          return { content: '错误：缺少必要参数 source_path 或 output_name', success: false }
        }
        if (!modifications && !append_rows && !merge_cells && !add_sheet && !column_widths && !data_validations) {
          return { content: '错误：未提供任何修改操作（modifications, append_rows, merge_cells 等至少需要提供一个）', success: false }
        }
        if (!fs.existsSync(source_path)) {
          return { content: `错误：源文件不存在：${source_path}`, success: false }
        }

        const genDir = getGeneratedFilesDir(context.sessionId)
        const safeName = output_name.replace(/[<>:"/\\|?*]/g, '_')
        const filePath = join(genDir, safeName)

        const { utilityProcess } = require('electron')
        let workerPath = join(app.getAppPath(), 'out', 'main', 'xlsx-worker.js')
        if (!fs.existsSync(workerPath)) {
          workerPath = join(app.getAppPath(), 'src', 'main', 'xlsx-worker.js')
        }
        if (!fs.existsSync(workerPath)) {
          workerPath = join(__dirname, 'xlsx-worker.js')
        }
        if (!fs.existsSync(workerPath)) {
          workerPath = join(__dirname, '..', '..', '..', 'xlsx-worker.js')
        }

        const { modCount, appendCount } = await new Promise<{ modCount: number; appendCount: number }>((resolve, reject) => {
          const child = utilityProcess.fork(workerPath, [], {
            serviceName: 'xlsx-worker',
            stdio: 'pipe',
            execArgv: ['--max-old-space-size=8192']
          })

          child.stdout?.on('data', (d: Buffer) => console.log('[xlsx-worker]', d.toString().trim()))
          child.stderr?.on('data', (d: Buffer) => console.error('[xlsx-worker err]', d.toString().trim()))

          let settled = false
          const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }

          const timeout = setTimeout(() => {
            child.kill()
            done(() => reject(new Error('xlsx 处理超时（>120s）')))
          }, 120000)

          child.on('message', (msg: any) => {
            clearTimeout(timeout)
            if (msg.success) {
              done(() => resolve({ modCount: msg.modCount, appendCount: msg.appendCount }))
            } else {
              done(() => reject(new Error(msg.error || 'xlsx 子进程处理失败')))
            }
            child.kill()
          })

          child.on('exit', (code: number) => {
            clearTimeout(timeout)
            if (code !== 0) {
              done(() => reject(new Error(`xlsx 子进程异常退出，code=${code}`)))
            }
          })

          child.postMessage({
            source_path,
            output_path: filePath,
            modifications,
            append_rows,
            merge_cells,
            add_sheet,
            column_widths,
            data_validations
          })
        })

        const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (activeWin) {
          activeWin.webContents.send('api:generated-file-updated')
        }

        const parts: string[] = []
        if (modCount > 0) parts.push(`修改了 ${modCount} 个单元格`)
        if (appendCount > 0) parts.push(`追加了 ${appendCount} 行数据`)
        const messageStr = parts.length > 0 ? parts.join('，') : '无数据改动'

        return {
          content: JSON.stringify({
            status: 'success',
            message: `文件 "${safeName}" 已生成，${messageStr}`,
            file_path: filePath,
            file_name: safeName,
            modified: modCount,
            appended: appendCount
          }, null, 2),
          success: true
        }
      }

      return { content: `未知的操作类型: ${api}`, success: false }
    } catch (err: any) {
      return {
        content: `Office操作失败：${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    }
  }

  public getApiNames(): string[] {
    return ['generate_file', 'modify_docx_file', 'modify_xlsx_file']
  }
}

export const officeExecutor = new OfficeExecutor()

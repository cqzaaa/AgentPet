/* eslint-disable @typescript-eslint/no-explicit-any */

import { spawn } from 'child_process'
import * as fs from 'fs'
import { basename, extname, join } from 'path'

import ExcelJS from 'exceljs'
import { createCanvas } from '@napi-rs/canvas'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { officeRuntimeManager, type OfficeRuntimeInfo } from '../../../../interaction/office-runtime-manager'
import { getSessionFilesDir } from '../../../../utils/paths'
import { writeGeneratedFile } from '../shared'
import { extractPdfMarkdownWithPaddle } from './paddle-pdf-converter'
import {
  classifyPdfForEditableConversion,
  type PdfClassification
} from './pdf2docx-converter'
import { createConversionRuntime } from './runtime'

interface ExtractedCell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  text: string
  bbox?: number[]
}

interface ExtractedTable {
  page: number
  index: number
  bbox?: number[]
  rowCount: number
  colCount: number
  columnWidths?: number[]
  rowHeights?: number[]
  cells: ExtractedCell[]
}

interface ExtractedPage {
  page: number
  width?: number
  height?: number
  tableCount: number
  text?: string
  watermarks?: Array<{
    text: string
    angle: number
    fontSize: number
    count: number
  }>
}

interface ExtractedPdfTables {
  pages: ExtractedPage[]
  tables: ExtractedTable[]
  source: 'pdf-structure' | 'document-ocr'
}

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim()
}

function attributeNumber(attributes: string, name: string): number {
  const match = new RegExp(`${name}=["']?(\\d+)`, 'i').exec(attributes)
  return Math.max(1, Number(match?.[1] || 1))
}

function parseHtmlTable(html: string, page: number, index: number): ExtractedTable | null {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
  if (rows.length === 0) return null
  const cells: ExtractedCell[] = []
  const occupied = new Set<string>()
  let maxColumn = 0
  rows.forEach((rowMatch, rowIndex) => {
    let columnIndex = 0
    const rowCells = [...rowMatch[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)]
    for (const cellMatch of rowCells) {
      while (occupied.has(`${rowIndex}:${columnIndex}`)) columnIndex += 1
      const rowSpan = attributeNumber(cellMatch[1], 'rowspan')
      const colSpan = attributeNumber(cellMatch[1], 'colspan')
      cells.push({
        row: rowIndex,
        col: columnIndex,
        rowSpan,
        colSpan,
        text: decodeHtml(cellMatch[2])
      })
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        for (let colOffset = 0; colOffset < colSpan; colOffset += 1) {
          occupied.add(`${rowIndex + rowOffset}:${columnIndex + colOffset}`)
        }
      }
      columnIndex += colSpan
      maxColumn = Math.max(maxColumn, columnIndex)
    }
  })
  return {
    page,
    index,
    rowCount: rows.length,
    colCount: Math.max(1, maxColumn),
    cells
  }
}

function parsePipeTables(markdown: string, page: number, startIndex: number): ExtractedTable[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const tables: ExtractedTable[] = []
  const splitRow = (line: string): string[] =>
    line.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => cell.trim())
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index].includes('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) continue
    const rows: string[][] = [splitRow(lines[index])]
    index += 2
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
      rows.push(splitRow(lines[index]))
      index += 1
    }
    index -= 1
    const colCount = Math.max(...rows.map(row => row.length))
    tables.push({
      page,
      index: startIndex + tables.length,
      rowCount: rows.length,
      colCount,
      cells: rows.flatMap((row, rowIndex) =>
        row.map((text, colIndex) => ({
          row: rowIndex,
          col: colIndex,
          rowSpan: 1,
          colSpan: 1,
          text
        }))
      )
    })
  }
  return tables
}

function parsePaddleTables(markdown: string): ExtractedPdfTables {
  const pageParts = markdown.split(/<!--\s*page-break\s*-->/i)
  const tables: ExtractedTable[] = []
  const pages: ExtractedPage[] = []
  pageParts.forEach((pageMarkdown, pageIndex) => {
    const page = pageIndex + 1
    let tableIndex = 1
    const htmlMatches = [...pageMarkdown.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    for (const match of htmlMatches) {
      const table = parseHtmlTable(match[0], page, tableIndex)
      if (table) {
        tables.push(table)
        tableIndex += 1
      }
    }
    const withoutHtmlTables = pageMarkdown.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, '')
    const pipeTables = parsePipeTables(withoutHtmlTables, page, tableIndex)
    tables.push(...pipeTables)
    pages.push({
      page,
      tableCount: htmlMatches.length + pipeTables.length,
      text: decodeHtml(withoutHtmlTables)
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })
  })
  return { pages, tables, source: 'document-ocr' }
}

async function runTableExtractor(
  runtimeInfo: OfficeRuntimeInfo,
  sourcePath: string,
  outputPath: string,
  selectedPages: number[],
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      runtimeInfo.pythonPath,
      [
        runtimeInfo.tableExtractorScriptPath,
        sourcePath,
        outputPath,
        JSON.stringify(selectedPages.map(page => page - 1))
      ],
      {
        cwd: runtimeInfo.rootDir,
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' }
      }
    )
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('PDF 表格分析超时'))
    }, 10 * 60 * 1000)
    const abort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('PDF 转 Excel 已取消'))
      else if (code === 0) resolvePromise()
      else reject(new Error(`PDF 表格分析失败（退出码 ${code}）：${stderr.slice(-1200)}`))
    })
  })
}

function typedCellValue(text: string): { value: ExcelJS.CellValue; numFmt?: string } {
  const value = text.trim()
  if (!value) return { value: '' }
  const percentage = /^(-?\d+(?:\.\d+)?)%$/.exec(value)
  if (percentage) return { value: Number(percentage[1]) / 100, numFmt: '0.00%' }
  const date = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value)
  if (date) {
    return {
      value: new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])),
      numFmt: 'yyyy-mm-dd'
    }
  }
  const normalizedNumber = value.replace(/,/g, '')
  if (
    /^-?\d+(?:\.\d+)?$/.test(normalizedNumber) &&
    !/^0\d+/.test(normalizedNumber) &&
    normalizedNumber.length <= 15
  ) {
    return {
      value: Number(normalizedNumber),
      numFmt: normalizedNumber.includes('.') ? '#,##0.00' : '#,##0'
    }
  }
  return { value }
}

function safeSheetName(rawName: string, used: Set<string>): string {
  const base = rawName.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet'
  let name = base
  let suffix = 2
  while (used.has(name)) {
    const suffixText = `_${suffix}`
    name = `${base.slice(0, 31 - suffixText.length)}${suffixText}`
    suffix += 1
  }
  used.add(name)
  return name
}

function createWatermarkTile(watermark: NonNullable<ExtractedPage['watermarks']>[number]): Buffer {
  const canvas = createCanvas(520, 240)
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.save()
  context.translate(canvas.width / 2, canvas.height / 2)
  context.rotate((watermark.angle * Math.PI) / 180)
  const pixelSize = Math.max(24, Math.min(54, watermark.fontSize * 1.7))
  context.font = `${pixelSize}px Microsoft YaHei`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = 'rgba(125, 125, 125, 0.18)'
  context.fillText(watermark.text, 0, 0)
  context.restore()
  return canvas.toBuffer('image/png')
}

function applyWorksheetWatermark(
  workbook: ExcelJS.Workbook,
  worksheet: ExcelJS.Worksheet,
  page: ExtractedPage | undefined,
  imageCache: Map<string, number>
): void {
  const watermark = page?.watermarks?.find(item => item.text.trim() && item.count >= 2)
  if (!watermark) return
  const key = `${watermark.text}\0${watermark.angle}\0${watermark.fontSize}`
  let imageId = imageCache.get(key)
  if (imageId === undefined) {
    imageId = workbook.addImage({ buffer: createWatermarkTile(watermark) as any, extension: 'png' })
    imageCache.set(key, imageId)
  }
  worksheet.addBackgroundImage(imageId)
}

function styleWorksheetTable(worksheet: ExcelJS.Worksheet, table: ExtractedTable): void {
  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'thin', color: { argb: 'FF000000' } },
    bottom: { style: 'thin', color: { argb: 'FF000000' } },
    right: { style: 'thin', color: { argb: 'FF000000' } }
  }
  for (let row = 1; row <= table.rowCount; row += 1) {
    for (let column = 1; column <= table.colCount; column += 1) {
      const cell = worksheet.getCell(row, column)
      cell.border = thinBorder
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.font = { name: 'Microsoft YaHei', size: 10 }
    }
  }

  const sortedCells = [...table.cells].sort((left, right) => left.row - right.row || left.col - right.col)
  for (const extractedCell of sortedCells) {
    const startRow = extractedCell.row + 1
    const startColumn = extractedCell.col + 1
    const endRow = startRow + Math.max(1, extractedCell.rowSpan) - 1
    const endColumn = startColumn + Math.max(1, extractedCell.colSpan) - 1
    if (endRow > startRow || endColumn > startColumn) {
      try {
        worksheet.mergeCells(startRow, startColumn, endRow, endColumn)
      } catch {
        // Ignore overlapping OCR merge ranges and keep the top-left value editable.
      }
    }
    const cell = worksheet.getCell(startRow, startColumn)
    const typed = typedCellValue(extractedCell.text)
    cell.value = typed.value
    if (typed.numFmt) cell.numFmt = typed.numFmt
    const titleCell = extractedCell.row === 0 && extractedCell.colSpan >= table.colCount
    const labelCell = extractedCell.col === 0 && table.colCount > 1
    cell.font = {
      name: 'Microsoft YaHei',
      size: titleCell ? 16 : 10,
      bold: titleCell || labelCell || (extractedCell.row === 0 && table.rowCount > 2)
    }
    if (titleCell) cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  }

  table.columnWidths?.forEach((widthPoints, index) => {
    worksheet.getColumn(index + 1).width = Math.max(8, Math.min(45, widthPoints / 7))
  })
  if (!table.columnWidths) {
    for (let column = 1; column <= table.colCount; column += 1) {
      let maxLength = 8
      for (let row = 1; row <= table.rowCount; row += 1) {
        maxLength = Math.max(maxLength, String(worksheet.getCell(row, column).value || '').length)
      }
      worksheet.getColumn(column).width = Math.min(40, maxLength + 3)
    }
  }
  table.rowHeights?.forEach((heightPoints, index) => {
    worksheet.getRow(index + 1).height = Math.max(20, Math.min(90, heightPoints))
  })
  worksheet.pageSetup = {
    orientation: table.colCount > 8 ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
  }
  worksheet.views = [{ showGridLines: false }]
}

async function createWorkbook(extracted: ExtractedPdfTables): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'AgentPet'
  workbook.created = new Date()
  const usedNames = new Set<string>()
  const pageByNumber = new Map(extracted.pages.map(page => [page.page, page]))
  const watermarkImages = new Map<string, number>()

  for (const table of extracted.tables) {
    const worksheet = workbook.addWorksheet(
      safeSheetName(`P${table.page}_表${table.index}`, usedNames)
    )
    styleWorksheetTable(worksheet, table)
    applyWorksheetWatermark(workbook, worksheet, pageByNumber.get(table.page), watermarkImages)
  }

  const pagesWithoutTables = extracted.pages.filter(page => page.tableCount === 0 && page.text?.trim())
  if (pagesWithoutTables.length > 0 || extracted.tables.length === 0) {
    const worksheet = workbook.addWorksheet(safeSheetName('其他内容', usedNames))
    worksheet.columns = [
      { header: '页码', key: 'page', width: 10 },
      { header: '内容', key: 'content', width: 80 }
    ]
    worksheet.getRow(1).font = { bold: true, name: 'Microsoft YaHei' }
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }
    for (const page of pagesWithoutTables) {
      worksheet.addRow({ page: page.page, content: page.text || '' })
    }
    worksheet.getColumn(2).alignment = { vertical: 'top', wrapText: true }
    worksheet.views = [{ state: 'frozen', ySplit: 1 }]
    const firstWatermarkedPage = pagesWithoutTables.find(page => page.watermarks?.some(item => item.count >= 2))
    applyWorksheetWatermark(workbook, worksheet, firstWatermarkedPage, watermarkImages)
  }

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function extractDigitalPdfTables(
  sourcePath: string,
  context: ToolContext,
  runtimeInfo: OfficeRuntimeInfo,
  selectedPages: number[]
): Promise<ExtractedPdfTables> {
  const cacheDir = join(getSessionFilesDir(context.sessionId), '.agentpet-cache', 'pdf-tables')
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const outputPath = join(cacheDir, `${Date.now()}-${process.pid}.json`)
  try {
    await runTableExtractor(
      runtimeInfo,
      sourcePath,
      outputPath,
      selectedPages,
      context.abortSignal
    )
    const parsed = JSON.parse(await fs.promises.readFile(outputPath, 'utf8'))
    return {
      pages: Array.isArray(parsed?.pages) ? parsed.pages : [],
      tables: Array.isArray(parsed?.tables) ? parsed.tables : [],
      source: 'pdf-structure'
    }
  } finally {
    await fs.promises.rm(outputPath, { force: true }).catch(() => undefined)
  }
}

export async function convertPdfToXlsx(
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const runtime = createConversionRuntime(input, context, 'PDF → Excel')
  runtime.report(0, 4, '正在准备 Office 组件包')
  const officeRuntime = await officeRuntimeManager.ensure(context)
  runtime.report(1, 4, '正在识别 PDF 表格结构')
  const classification: PdfClassification = await classifyPdfForEditableConversion(
    sourcePath,
    input.pages
  )

  let extracted: ExtractedPdfTables
  if (classification.kind === 'digital') {
    extracted = await extractDigitalPdfTables(
      sourcePath,
      context,
      officeRuntime,
      classification.selectedPages
    )
  } else {
    const paddle = await extractPdfMarkdownWithPaddle(sourcePath, input, context)
    extracted = parsePaddleTables(paddle.markdown)
  }

  runtime.report(2, 4, '正在生成 Excel 工作表')
  const bytes = await createWorkbook(extracted)
  const output = await writeGeneratedFile(
    bytes,
    input.output_name,
    `${basename(sourcePath, extname(sourcePath))}.xlsx`,
    '.xlsx',
    context
  )
  runtime.report(3, 4, '正在验证 Excel 文件')
  const validationWorkbook = new ExcelJS.Workbook()
  await validationWorkbook.xlsx.load(bytes as any)
  if (validationWorkbook.worksheets.length === 0) throw new Error('生成的 Excel 没有工作表')
  runtime.report(4, 4, 'Excel 文件已生成')

  const state = {
    status: 'success',
    skill: 'pdf',
    action: 'convert',
    conversion: {
      source_format: 'pdf',
      target_format: 'xlsx',
      mode: 'structured'
    },
    source_path: sourcePath,
    file_path: output.filePath,
    file_name: output.fileName,
    converted_pages: classification.selectedPages,
    document_classification: classification,
    table_count: extracted.tables.length,
    worksheet_count: validationWorkbook.worksheets.length,
    validation: { valid: true }
  }
  return {
    success: true,
    state,
    content: JSON.stringify(
      {
        status: 'success',
        message: 'PDF 已转换为 Excel',
        file_path: output.filePath,
        file_name: output.fileName
      },
      null,
      2
    )
  }
}

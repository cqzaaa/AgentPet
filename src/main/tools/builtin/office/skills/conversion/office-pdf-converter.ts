/* eslint-disable @typescript-eslint/no-explicit-any */

import { execFile } from 'child_process'
import * as fs from 'fs'
import { basename, extname, join } from 'path'
import { promisify } from 'util'

import { PDFDocument } from 'pdf-lib'
import { PDFParse } from 'pdf-parse'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { getGeneratedFilesDir } from '../../../../utils/paths'
import {
  jsonResult,
  normalizeOutputName,
  notifyGeneratedFilesChanged
} from '../shared'
import { assertOfficeConversionSupported } from './capabilities'
import { createConversionRuntime, resolveConversionSource } from './runtime'
import { resolveRequestedSheetNames } from './spreadsheet-converter'
import * as XLSX from 'xlsx'

const execFileAsync = promisify(execFile)

interface NativeOfficeExportResult {
  sourcePages?: number
  exporter: 'Microsoft Word' | 'Microsoft PowerPoint' | 'Microsoft Excel'
  sheets?: string[]
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function officeExportScript(source: 'pptx' | 'docx' | 'xlsx'): string {
  const common = `
$ErrorActionPreference = 'Stop'
$sourcePath = [Environment]::GetEnvironmentVariable('AGENTPET_OFFICE_SOURCE', 'Process')
$outputPath = [Environment]::GetEnvironmentVariable('AGENTPET_OFFICE_OUTPUT', 'Process')
$selectedSheetsJson = [Environment]::GetEnvironmentVariable('AGENTPET_OFFICE_SHEETS', 'Process')
if ([string]::IsNullOrWhiteSpace($sourcePath) -or [string]::IsNullOrWhiteSpace($outputPath)) {
  throw 'Office export paths are missing'
}
`

  if (source === 'docx') {
    return `${common}
$app = $null
$document = $null
try {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false
  $app.DisplayAlerts = 0
  $document = $app.Documents.Open($sourcePath, $false, $true)
  $sourcePages = [int]$document.ComputeStatistics(2)
  $document.ExportAsFixedFormat($outputPath, 17)
  @{ sourcePages = $sourcePages; exporter = 'Microsoft Word' } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $document) { $document.Close(0) }
  if ($null -ne $app) { $app.Quit() }
  if ($null -ne $document) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  if ($null -ne $app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}`
  }

  if (source === 'pptx') {
    return `${common}
$app = $null
$presentation = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $presentation = $app.Presentations.Open($sourcePath, $true, $true, $false)
  $sourcePages = [int]$presentation.Slides.Count
  $presentation.ExportAsFixedFormat($outputPath, 2)
  @{ sourcePages = $sourcePages; exporter = 'Microsoft PowerPoint' } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $presentation) { $presentation.Close() }
  if ($null -ne $app) { $app.Quit() }
  if ($null -ne $presentation) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) }
  if ($null -ne $app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}`
  }

  return `${common}
$app = $null
$workbook = $null
try {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $workbook = $app.Workbooks.Open($sourcePath, 0, $true)
  $selectedSheetNames = @()
  if (-not [string]::IsNullOrWhiteSpace($selectedSheetsJson)) {
    $selectedSheetNames = @($selectedSheetsJson | ConvertFrom-Json)
  }
  $selectedLookup = @{}
  foreach ($name in $selectedSheetNames) { $selectedLookup[[string]$name] = $true }
  if ($selectedSheetNames.Count -gt 0) {
    $matched = 0
    foreach ($sheet in $workbook.Worksheets) {
      if ($selectedLookup.ContainsKey([string]$sheet.Name)) {
        $sheet.Visible = -1
        $matched++
      }
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sheet)
    }
    if ($matched -ne $selectedSheetNames.Count) { throw 'One or more selected worksheets do not exist' }
    foreach ($sheet in $workbook.Worksheets) {
      if (-not $selectedLookup.ContainsKey([string]$sheet.Name)) { $sheet.Visible = 0 }
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sheet)
    }
  }
  $sourcePages = 0
  $exportedSheets = @()
  foreach ($sheet in $workbook.Worksheets) {
    if ($sheet.Visible -eq -1) {
      $exportedSheets += [string]$sheet.Name
      $sheet.Activate()
      $count = $app.ExecuteExcel4Macro('GET.DOCUMENT(50)')
      if ($count -is [double] -or $count -is [int]) { $sourcePages += [int]$count }
    }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($sheet)
  }
  $workbook.ExportAsFixedFormat(0, $outputPath, 0, $true, $false)
  @{ sourcePages = $sourcePages; exporter = 'Microsoft Excel'; sheets = $exportedSheets } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $workbook) { $workbook.Close($false) }
  if ($null -ne $app) { $app.Quit() }
  if ($null -ne $workbook) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook) }
  if ($null -ne $app) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}`
}

async function exportWithMicrosoftOffice(
  source: 'pptx' | 'docx' | 'xlsx',
  sourcePath: string,
  outputPath: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  selectedSheets?: string[]
): Promise<NativeOfficeExportResult> {
  if (process.platform !== 'win32') {
    throw new Error('高保真 Office → PDF 当前需要 Windows 和 Microsoft Office')
  }

  const script = officeExportScript(source)
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(script)
      ],
      {
        timeout: timeoutMs,
        signal: abortSignal,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          AGENTPET_OFFICE_SOURCE: sourcePath,
          AGENTPET_OFFICE_OUTPUT: outputPath,
          AGENTPET_OFFICE_SHEETS: selectedSheets?.length ? JSON.stringify(selectedSheets) : ''
        }
      }
    )
    const jsonLine = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .reverse()
      .find(line => line.startsWith('{'))
    if (!jsonLine) throw new Error('Microsoft Office 未返回导出结果')
    return JSON.parse(jsonLine) as NativeOfficeExportResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (abortSignal?.aborted) throw new Error('转换已取消')
    if (/timed out|timeout/i.test(message)) throw new Error('Microsoft Office 导出超时')
    if (/80040154|class not registered|ActiveX component/i.test(message)) {
      throw new Error('未检测到可用的 Microsoft Office 桌面版，无法执行高保真 PDF 导出')
    }
    throw new Error(`Microsoft Office 导出失败：${message}`)
  }
}

async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: pdfBytes })
  try {
    const result = await parser.getText()
    return result.text || ''
  } finally {
    await parser.destroy()
  }
}

export async function convertOfficeToPdf(
  expectedSource: 'pptx' | 'docx' | 'xlsx',
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const source = resolveConversionSource(input.source_path || input.file_path, context)
  if (source.format !== expectedSource) {
    throw new Error(`文件格式不匹配：需要 ${expectedSource}，实际为 ${source.format}`)
  }
  assertOfficeConversionSupported(source.format, 'pdf')

  const hasRequestedSheets =
    (Array.isArray(input.sheets) && input.sheets.length > 0) ||
    (typeof input.sheet_name === 'string' && input.sheet_name.trim().length > 0)
  const selectedSheets =
    expectedSource === 'xlsx' && hasRequestedSheets
      ? resolveRequestedSheetNames(input, XLSX.readFile(source.path).SheetNames)
      : undefined

  const runtime = createConversionRuntime(input, context, `${expectedSource.toUpperCase()} → PDF`)
  const outputName = normalizeOutputName(
    input.output_name,
    `${basename(source.path, extname(source.path))}.pdf`,
    '.pdf'
  )
  const outputPath = join(getGeneratedFilesDir(context.sessionId), outputName)
  await fs.promises.rm(outputPath, { force: true })

  runtime.report(0, 3, '正在调用 Microsoft Office 原生 PDF 导出')
  let nativeResult: NativeOfficeExportResult
  try {
    nativeResult = await exportWithMicrosoftOffice(
      expectedSource,
      source.path,
      outputPath,
      runtime.timeoutMs,
      context.abortSignal,
      selectedSheets
    )
    runtime.check()
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('Microsoft Office 未生成 PDF 文件')
    }

    runtime.report(2, 3, '正在校验 PDF 页数和可搜索文字')
    const outputBytes = await fs.promises.readFile(outputPath)
    const pdf = await PDFDocument.load(outputBytes)
    const pageCount = pdf.getPageCount()
    const sourcePageCount = Number(nativeResult.sourcePages) || undefined
    if (sourcePageCount && pageCount !== sourcePageCount) {
      throw new Error(`页数校验失败：源文件 ${sourcePageCount} 页，PDF ${pageCount} 页`)
    }
    const extractedText = await extractPdfText(outputBytes)
    const searchable = extractedText.trim().length > 0
    if (expectedSource === 'docx' && !searchable) {
      throw new Error('PDF 未包含可搜索文字，已拒绝返回图片型转换结果')
    }

    notifyGeneratedFilesChanged()
    runtime.report(3, 3, '转换完成')
    return jsonResult({
      status: 'success',
      skill: expectedSource,
      action: 'convert',
      conversion: {
        source_format: expectedSource,
        target_format: 'pdf',
        mode: 'native',
        exporter: nativeResult.exporter
      },
      source_path: source.path,
      file_path: outputPath,
      file_name: outputName,
      source_page_count: sourcePageCount,
      selected_sheets: nativeResult.sheets,
      page_count: pageCount,
      searchable_text: searchable,
      extracted_text_characters: extractedText.trim().length,
      validation: {
        valid: !sourcePageCount || pageCount === sourcePageCount,
        source_page_count: sourcePageCount,
        page_count: pageCount,
        searchable_text: searchable,
        checks: ['native_office_export', 'pdf_page_tree', 'source_page_count', 'searchable_text']
      },
      progress: { status: 'completed', completed: 3, total: 3 }
    })
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true })
    throw error
  }
}

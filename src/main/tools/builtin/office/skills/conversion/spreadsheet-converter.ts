/* eslint-disable @typescript-eslint/no-explicit-any */

import { basename, extname } from 'path'
import * as XLSX from 'xlsx'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { jsonResult, writeGeneratedFile } from '../shared'
import { assertOfficeConversionSupported, normalizeConversionFormat } from './capabilities'
import { createConversionRuntime, resolveConversionSource } from './runtime'

function safeSheetName(value: string): string {
  const normalized = [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character
    )
    .join('')
    .trim()
  return normalized || 'Sheet'
}

export function resolveRequestedSheetNames(
  input: Record<string, any>,
  availableSheetNames: string[]
): string[] {
  const requested = Array.isArray(input.sheets)
    ? input.sheets
        .filter((name: unknown): name is string => typeof name === 'string')
        .map((name: string) => name.trim())
        .filter(Boolean)
    : typeof input.sheet_name === 'string' && input.sheet_name.trim()
      ? [input.sheet_name.trim()]
      : []
  if (requested.length === 0) return [...availableSheetNames]

  const selected = [...new Set(requested)]
  const missing = selected.filter(name => !availableSheetNames.includes(name))
  if (missing.length > 0) throw new Error(`工作表不存在：${missing.join('、')}`)
  return selected
}

export async function convertSpreadsheet(
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const source = resolveConversionSource(input.source_path || input.file_path, context)
  const target = normalizeConversionFormat(input.target_format)
  if (target !== 'csv' && target !== 'xlsx') throw new Error('表格转换仅支持 CSV 或 XLSX')
  const capability = assertOfficeConversionSupported(source.format, target)
  const runtime = createConversionRuntime(
    input,
    context,
    `${source.format.toUpperCase()} → ${target.toUpperCase()}`
  )
  runtime.report(0, 1, '正在读取表格')

  const workbook = XLSX.readFile(source.path, { cellDates: true, raw: false })
  runtime.check()
  const baseName = basename(source.path, extname(source.path))
  const sheetNames = resolveRequestedSheetNames(input, workbook.SheetNames)

  if (target === 'xlsx') {
    const selectedWorkbook = XLSX.utils.book_new()
    selectedWorkbook.Props = workbook.Props
    selectedWorkbook.Custprops = workbook.Custprops
    for (const sheetName of sheetNames) {
      XLSX.utils.book_append_sheet(selectedWorkbook, workbook.Sheets[sheetName], sheetName)
    }
    const bytes = XLSX.write(selectedWorkbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const output = await writeGeneratedFile(
      bytes,
      input.output_name,
      `${baseName}.xlsx`,
      '.xlsx',
      context
    )
    const validationWorkbook = XLSX.readFile(output.filePath)
    runtime.report(1, 1, 'XLSX 已生成')
    return jsonResult({
      status: 'success',
      skill: 'xlsx',
      action: 'convert',
      conversion: { source_format: source.format, target_format: target, mode: capability.mode },
      source_path: source.path,
      file_path: output.filePath,
      file_name: output.fileName,
      sheet_count: sheetNames.length,
      selected_sheets: sheetNames,
      validation: {
        valid:
          validationWorkbook.SheetNames.length === sheetNames.length &&
          validationWorkbook.SheetNames.every((name, index) => name === sheetNames[index]),
        checks: ['xlsx_package', 'workbook_load', 'sheet_count']
      },
      progress: { status: 'completed', completed: 1, total: 1 }
    })
  }

  const outputs: Array<{ file_path: string; file_name: string; sheet: string }> = []
  for (let index = 0; index < sheetNames.length; index++) {
    runtime.check()
    const sheetName = sheetNames[index]
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: true })
    const outputName =
      sheetNames.length === 1 ? input.output_name : `${baseName}-${safeSheetName(sheetName)}.csv`
    const output = await writeGeneratedFile(
      Buffer.from(`\uFEFF${csv}`, 'utf8'),
      outputName,
      `${baseName}.csv`,
      '.csv',
      context
    )
    outputs.push({ file_path: output.filePath, file_name: output.fileName, sheet: sheetName })
    runtime.report(index + 1, sheetNames.length, `已转换工作表 ${sheetName}`)
  }

  return jsonResult({
    status: 'success',
    skill: 'xlsx',
    action: 'convert',
    conversion: { source_format: source.format, target_format: target, mode: capability.mode },
    source_path: source.path,
    file_path: outputs.length === 1 ? outputs[0].file_path : undefined,
    file_name: outputs.length === 1 ? outputs[0].file_name : undefined,
    files: outputs,
    sheet_count: outputs.length,
    selected_sheets: sheetNames,
    validation: { valid: outputs.length > 0, checks: ['csv_write', 'non_empty_output_set'] },
    progress: { status: 'completed', completed: outputs.length, total: outputs.length }
  })
}

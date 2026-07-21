/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

import * as fs from 'fs'

import type { ToolContext, ToolResult } from '../../../core/types'
import { officeExecutor } from '../executor'
import { convertOfficeToPdf, convertSpreadsheet } from './conversion'
import { renderOfficeArtifact } from './rendering'
import type { OfficeSkill, OfficeSkillAction, OfficeSkillDescriptor } from './types'
import {
  attachVisiblePreviewValidation,
  jsonResult,
  normalizeOutputName,
  readToolResultState,
  resolveRequiredSource,
  skillError
} from './shared'

const descriptor: OfficeSkillDescriptor = {
  name: 'xlsx',
  title: 'Excel 工作簿 Skill',
  description: '创建、检查、修改和验证 XLSX；修改任务在 Electron utilityProcess 中隔离执行。',
  extensions: ['.xlsx'],
  instructions: [
    '处理 XLSX 时必须使用本 Skill，不要改用 pandas、openpyxl 或终端脚本，除非用户明确要求 Python 实现。',
    '数值、日期、百分比和公式必须保持为对应单元格类型，不要预先格式化成字符串。',
    '修改已有工作簿前先 inspect，沿用原工作表名称、隐藏行、公式模式、样式、命名区域和数据验证。',
    '对于下拉字段，只能使用工作簿数据验证允许的选项；不得用“是”代替 Y，或跨字段混用选项。',
    '修改默认另存为新文件，并在完成后 validate；validate 未通过时不得向用户宣称任务成功。',
    '公式由兼容的电子表格应用打开时计算；本 Skill 检查公式结构、缓存错误值和下拉选项。'
  ],
  operations: {
    create: {
      description: '使用结构化 JSON 创建多工作表 XLSX。',
      inputSchema: {
        type: 'object',
        properties: {
          output_name: { type: 'string' },
          content: {
            description:
              'JSON 字符串或对象：{sheets:[{name,data,styles,formulas,merge,colWidths,dataValidations}]}'
          }
        },
        required: ['output_name', 'content']
      }
    },
    inspect: {
      description: '检查工作表尺寸、公式、合并区域、错误值和数据验证。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    modify: {
      description: '修改单元格、追加行、增加工作表、合并单元格、列宽和数据验证。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string' },
          output_name: { type: 'string' },
          modifications: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sheet: { type: 'string' },
                cell: { type: 'string' },
                value: {},
                formula: { type: 'string' },
                style: { type: 'object' }
              },
              required: ['cell']
            }
          },
          append_rows: {
            type: 'array',
            description:
              '追加行。首选 {sheet:"Sheet1",values:[值1,值2,...]}；也兼容 {sheet:"Sheet1",row:[{cell:"A",value:值1},...]}。',
            items: {
              type: 'object',
              properties: {
                sheet: { type: 'string' },
                values: { type: 'array', items: {} },
                row: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { cell: { type: 'string' }, value: {} },
                    required: ['cell']
                  }
                }
              }
            }
          },
          add_sheet: { type: 'array', items: { type: 'string' } },
          merge_cells: { type: 'array', items: { type: 'string' } },
          column_widths: { type: 'object' },
          data_validations: { type: 'object' }
        },
        required: ['source_path', 'output_name']
      }
    },
    validate: {
      description: '重新载入工作簿并扫描公式错误、结构问题和非法下拉值。',
      inputSchema: {
        type: 'object',
        properties: { source_path: { type: 'string' } },
        required: ['source_path']
      }
    },
    convert: {
      description: 'XLSX 与 CSV 进行结构化转换，或通过 Microsoft Excel 原生导出完整 PDF。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string' },
          target_format: { type: 'string', enum: ['pdf', 'xlsx', 'csv'] },
          output_name: { type: 'string' },
          sheets: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
            description: '可选工作表名称；不提供时处理全部工作表'
          },
          sheet_name: { type: 'string', description: '兼容旧调用的单个工作表名称' },
          timeout_seconds: { type: 'number', minimum: 10, maximum: 300 }
        },
        required: ['source_path', 'target_format']
      }
    },
    render: {
      description: '在右侧用 open-file-viewer 打开工作簿，并截取可见预览供模型视觉检查。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string' },
          max_frames: { type: 'number', description: '最多截取 1-12 个预览视口，默认 8' }
        },
        required: ['source_path']
      }
    }
  }
}

function columnIndexFromAddress(address: unknown): number | null {
  const match = String(address || '').trim().match(/^([A-Z]+)(?:\d+)?$/i)
  if (!match) return null
  let index = 0
  for (const character of match[1].toUpperCase()) {
    index = index * 26 + character.charCodeAt(0) - 64
  }
  return index - 1
}

function normalizeAppendRows(value: unknown): any[] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    if (Array.isArray((item as any).values)) return item
    const cells = Array.isArray((item as any).row)
      ? (item as any).row
      : Array.isArray((item as any).cells)
        ? (item as any).cells
        : null
    if (!cells) return item

    const indexedValues = cells
      .map((cell: any) => ({ index: columnIndexFromAddress(cell?.cell), value: cell?.value }))
      .filter((cell: any): cell is { index: number; value: unknown } => cell.index !== null)
    const maxIndex = indexedValues.reduce((maximum, cell) => Math.max(maximum, cell.index), -1)
    const values = Array.from({ length: maxIndex + 1 }, () => null)
    for (const cell of indexedValues) values[cell.index] = cell.value
    return { ...(item as any), values }
  })
}

interface XlsxCellRange {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

interface XlsxListValidation {
  sheet: string
  ranges: XlsxCellRange[]
  formula: string
  options: string[]
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function xmlAttribute(attributes: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = attributes.match(new RegExp(`(?:^|\\s)${escapedName}="([^"]*)"`, 'i'))
  return match ? decodeXml(match[1]) : ''
}

function normalizeWorksheetTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return normalized.slice(1)
  return `xl/${normalized.replace(/^\.\.\//, '')}`
}

function parseXlsxRange(XLSX: any, value: string): XlsxCellRange | null {
  try {
    const decoded = XLSX.utils.decode_range(value.replace(/\$/g, ''))
    return {
      startRow: decoded.s.r,
      endRow: decoded.e.r,
      startColumn: decoded.s.c,
      endColumn: decoded.e.c
    }
  } catch {
    return null
  }
}

function cellInRanges(row: number, column: number, ranges: XlsxCellRange[]): boolean {
  return ranges.some(
    range =>
      row >= range.startRow &&
      row <= range.endRow &&
      column >= range.startColumn &&
      column <= range.endColumn
  )
}

function resolveValidationOptions(XLSX: any, workbook: any, formula: string): string[] {
  const trimmed = decodeXml(formula).trim().replace(/^=/, '')
  if (/^"[\s\S]*"$/.test(trimmed)) {
    return [
      ...new Set(
        trimmed
          .slice(1, -1)
          .split(',')
          .map(value => value.trim())
          .filter(Boolean)
      )
    ] as string[]
  }

  const names = Array.isArray(workbook.Workbook?.Names) ? workbook.Workbook.Names : []
  const namedRange = names.find((item: any) => item?.Name === trimmed)?.Ref
  const reference = String(namedRange || trimmed).replace(/^=/, '')
  const match = reference.match(
    /^'?((?:[^']|'')+)'?!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i
  )
  if (!match) return []
  const sourceSheet = workbook.Sheets[match[1].replace(/''/g, "'")]
  if (!sourceSheet) return []

  const start = XLSX.utils.decode_cell(`${match[2]}${match[3]}`)
  const end = XLSX.utils.decode_cell(`${match[4] || match[2]}${match[5] || match[3]}`)
  const values: string[] = []
  for (let row = start.r; row <= end.r && values.length < 500; row++) {
    for (let column = start.c; column <= end.c && values.length < 500; column++) {
      const cell = sourceSheet[XLSX.utils.encode_cell({ r: row, c: column })]
      const value = cell?.w ?? cell?.v
      if (value !== undefined && value !== null && String(value).trim()) {
        values.push(String(value).trim())
      }
    }
  }
  return [...new Set(values)] as string[]
}

async function readListValidations(
  sourcePath: string,
  XLSX: any,
  workbook: any
): Promise<XlsxListValidation[]> {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(await fs.promises.readFile(sourcePath))
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string')
  const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!workbookXml || !relationshipsXml) return []

  const relationships = new Map<string, string>()
  for (const match of relationshipsXml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/gi)) {
    const id = xmlAttribute(match[1], 'Id')
    const target = xmlAttribute(match[1], 'Target')
    if (id && target) relationships.set(id, normalizeWorksheetTarget(target))
  }

  const validations: XlsxListValidation[] = []
  for (const sheetMatch of workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = sheetMatch[1]
    const sheetName = xmlAttribute(attributes, 'name')
    const relationshipId = xmlAttribute(attributes, 'r:id')
    const sheetPath = relationships.get(relationshipId)
    const sheetXml = sheetPath ? await zip.file(sheetPath)?.async('string') : undefined
    if (!sheetName || !sheetXml) continue

    for (const match of sheetXml.matchAll(
      /<(?:\w+:)?dataValidation\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?dataValidation>/gi
    )) {
      if (xmlAttribute(match[1], 'type').toLowerCase() !== 'list') continue
      const ranges = xmlAttribute(match[1], 'sqref')
        .split(/\s+/)
        .map(value => parseXlsxRange(XLSX, value))
        .filter((range): range is XlsxCellRange => Boolean(range))
      const formulaMatch = match[2].match(
        /<(?:\w+:)?formula1\b[^>]*>([\s\S]*?)<\/(?:\w+:)?formula1>/i
      )
      const formula = formulaMatch ? decodeXml(formulaMatch[1]) : ''
      if (!ranges.length) continue
      validations.push({
        sheet: sheetName,
        ranges,
        formula,
        options: resolveValidationOptions(XLSX, workbook, formula)
      })
    }
  }
  return validations
}

export async function inspectXlsx(sourcePath: string): Promise<Record<string, any>> {
  // ExcelJS expands data-validation ranges while loading. Templates commonly
  // apply dropdowns to whole columns (for example A3:A1048576), which can block
  // Electron's main process for minutes. SheetJS keeps those ranges compact and
  // is sufficient for the structural/formula checks performed here.
  const XLSX = require('xlsx')
  const workbook = XLSX.readFile(sourcePath, {
    cellDates: true,
    cellFormula: true,
    cellNF: true,
    cellStyles: false
  })

  let formulaCount = 0
  let nonEmptyCellCount = 0
  const formulaErrors: Array<{ sheet: string; cell: string; error: string }> = []
  const validationErrors: Array<{
    sheet: string
    cell: string
    value: string
    allowed_values: string[]
  }> = []
  const errorPattern = /^(#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$/
  const listValidations = await readListValidations(sourcePath, XLSX, workbook)

  const sheets = workbook.SheetNames.map((sheetName: string, sheetIndex: number) => {
    const worksheet = workbook.Sheets[sheetName]
    const rawRange = worksheet?.['!ref'] || 'A1:A1'
    const range = XLSX.utils.decode_range(rawRange)
    let sheetFormulaCount = 0
    let sheetNonEmptyCount = 0
    for (const [address, cell] of Object.entries(worksheet || {})) {
      if (address.startsWith('!') || !cell || typeof cell !== 'object') continue
      const typedCell = cell as { f?: string; v?: unknown; w?: string }
      if (typedCell.v == null && !typedCell.f && !typedCell.w) continue
      sheetNonEmptyCount++
      nonEmptyCellCount++
      if (typeof typedCell.f === 'string') {
        sheetFormulaCount++
        formulaCount++
      }
      const displayedValue = typedCell.w ?? typedCell.v
      if (typeof displayedValue === 'string' && errorPattern.test(displayedValue)) {
        formulaErrors.push({ sheet: sheetName, cell: address, error: displayedValue })
      }
      const position = XLSX.utils.decode_cell(address)
      for (const validation of listValidations) {
        if (
          validation.sheet !== sheetName ||
          validation.options.length === 0 ||
          !cellInRanges(position.r, position.c, validation.ranges)
        ) {
          continue
        }
        const value = String(typedCell.v ?? typedCell.w ?? '').trim()
        if (value && !validation.options.includes(value)) {
          validationErrors.push({
            sheet: sheetName,
            cell: address,
            value,
            allowed_values: validation.options.slice(0, 50)
          })
        }
      }
    }

    const visibility = Number(workbook.Workbook?.Sheets?.[sheetIndex]?.Hidden || 0)

    return {
      name: sheetName,
      row_count: range.e.r - range.s.r + 1,
      column_count: range.e.c - range.s.c + 1,
      non_empty_cells: sheetNonEmptyCount,
      formulas: sheetFormulaCount,
      merged_ranges: Array.isArray(worksheet?.['!merges']) ? worksheet['!merges'].length : 0,
      state: visibility === 2 ? 'veryHidden' : visibility === 1 ? 'hidden' : 'visible'
    }
  })

  return {
    status: 'success',
    skill: 'xlsx',
    source_path: sourcePath,
    size_bytes: (await fs.promises.stat(sourcePath)).size,
    sheet_count: sheets.length,
    non_empty_cells: nonEmptyCellCount,
    formulas: formulaCount,
    formula_errors: formulaErrors.slice(0, 100),
    formula_errors_truncated: formulaErrors.length > 100,
    list_validations: listValidations.length,
    unresolved_list_validations: listValidations.filter(item => item.options.length === 0).map(item => ({
      sheet: item.sheet,
      formula: item.formula
    })),
    data_validation_errors: validationErrors.slice(0, 100),
    data_validation_errors_truncated: validationErrors.length > 100,
    sheets
  }
}

async function addXlsxValidation(
  result: ToolResult,
  context: ToolContext,
  focus: {
    mode: 'overview' | 'changes'
    texts?: string[]
    cells?: string[]
    sheets?: string[]
  } = { mode: 'overview' }
): Promise<ToolResult> {
  if (!result.success) return result
  const state = readToolResultState(result)
  if (typeof state.file_path !== 'string') return result
  const summary = await inspectXlsx(state.file_path)
  return attachVisiblePreviewValidation(
    jsonResult({
      ...state,
      skill: 'xlsx',
      validation: {
        valid:
          summary.formula_errors.length === 0 &&
          summary.data_validation_errors.length === 0 &&
          summary.unresolved_list_validations.length === 0,
        sheet_count: summary.sheet_count,
        formulas: summary.formulas,
        formula_errors: summary.formula_errors,
        data_validation_errors: summary.data_validation_errors,
        unresolved_list_validations: summary.unresolved_list_validations,
        checks: [
          'xlsx_package',
          'workbook_load',
          'worksheet_dimensions',
          'formula_error_scan',
          'data_validation_scan'
        ]
      }
    }),
    context,
    focus
  )
}

export const xlsxSkill: OfficeSkill = {
  descriptor,

  async execute(
    action: OfficeSkillAction,
    input: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      if (action === 'create') {
        const content =
          typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? {})
        const result = await officeExecutor.execute(
          'generate_file',
          {
            file_name: normalizeOutputName(
              input.output_name || input.file_name,
              'workbook.xlsx',
              '.xlsx'
            ),
            content,
            file_type: 'excel'
          },
          context
        )
        return addXlsxValidation(result, context)
      }

      if (action === 'convert') {
        return input.target_format === 'pdf'
          ? convertOfficeToPdf('xlsx', input, context)
          : convertSpreadsheet(input, context)
      }

      if (action === 'modify') {
        const sourcePath = resolveRequiredSource(input, '.xlsx', context)
        const normalizedAppendRows = normalizeAppendRows(input.append_rows)
        const result = await officeExecutor.execute(
          'modify_xlsx_file',
          {
            source_path: sourcePath,
            output_name: normalizeOutputName(input.output_name, 'modified.xlsx', '.xlsx'),
            modifications: input.modifications || input.operations,
            append_rows: normalizedAppendRows,
            merge_cells: input.merge_cells,
            add_sheet: input.add_sheet,
            column_widths: input.column_widths,
            data_validations: input.data_validations
          },
          context
        )
        if (result.success && normalizedAppendRows.length > 0) {
          const resultState = readToolResultState(result)
          const appended = Number(resultState.appended || 0)
          if (appended < normalizedAppendRows.length) {
            return jsonResult(
              {
                ...resultState,
                status: 'error',
                message: `请求追加 ${normalizedAppendRows.length} 行，但实际只追加 ${appended} 行，已停止成功报告。`,
                requested_appends: normalizedAppendRows.length,
                appended
              },
              false
            )
          }
        }
        const modifications = Array.isArray(input.modifications || input.operations)
          ? input.modifications || input.operations
          : []
        const appendedRows = normalizedAppendRows
        const focusTexts = [
          ...modifications.flatMap((item: any) => [item?.value, item?.formula]),
          ...appendedRows.flatMap((item: any) => (Array.isArray(item?.values) ? item.values : [])),
          ...(Array.isArray(input.add_sheet) ? input.add_sheet : [])
        ]
          .filter((value: unknown) => value !== undefined && value !== null)
          .map(String)
        const focusCells = modifications
          .map((item: any) => item?.cell)
          .filter((value: unknown): value is string => typeof value === 'string')
        const focusSheets = [
          ...modifications.map((item: any) => item?.sheet),
          ...appendedRows.map((item: any) => item?.sheet),
          ...(Array.isArray(input.add_sheet) ? input.add_sheet : [])
        ].filter((value: unknown): value is string => typeof value === 'string')
        return addXlsxValidation(result, context, {
          mode: 'changes',
          texts: focusTexts,
          cells: focusCells,
          sheets: focusSheets
        })
      }

      const sourcePath = resolveRequiredSource(input, '.xlsx', context)
      if (action === 'render') return renderOfficeArtifact('xlsx', sourcePath, input, context)
      const summary = await inspectXlsx(sourcePath)
      if (action === 'validate') {
        return jsonResult({
          ...summary,
          validation: {
            valid:
              summary.formula_errors.length === 0 &&
              summary.data_validation_errors.length === 0 &&
              summary.unresolved_list_validations.length === 0,
            checks: [
              'xlsx_package',
              'workbook_load',
              'worksheet_dimensions',
              'formula_error_scan',
              'data_validation_scan'
            ]
          }
        })
      }
      return jsonResult(summary)
    } catch (error) {
      return skillError(error)
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NormalizedXlsxStyle {
  range: string
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
  style: Record<string, any>
}

const MAX_STYLED_CELLS = 100_000

function columnNumber(value: string): number {
  let result = 0
  for (const character of value.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64
  }
  return result
}

function parseRange(range: unknown, path: string): Omit<NormalizedXlsxStyle, 'style'> {
  const text = String(range ?? '')
    .trim()
    .toUpperCase()
  const match = text.match(/^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/)
  if (!match) {
    throw new Error(
      `${path} 必须是有效的 Excel 单元格或范围，例如 A1 或 A1:C10；收到：${JSON.stringify(range)}`
    )
  }

  const startColumn = columnNumber(match[1])
  const startRow = Number(match[2])
  const endColumn = columnNumber(match[3] || match[1])
  const endRow = Number(match[4] || match[2])
  if (endColumn < startColumn || endRow < startRow) {
    throw new Error(`${path} 的起始单元格必须位于结束单元格之前；收到：${text}`)
  }

  const cellCount = (endColumn - startColumn + 1) * (endRow - startRow + 1)
  if (cellCount > MAX_STYLED_CELLS) {
    throw new Error(`${path} 覆盖 ${cellCount} 个单元格，超过上限 ${MAX_STYLED_CELLS}`)
  }

  return { range: text, startRow, endRow, startColumn, endColumn }
}

function normalizeStyle(style: unknown, path: string): Record<string, any> {
  if (!style || typeof style !== 'object' || Array.isArray(style)) {
    throw new Error(`${path} 必须是样式对象`)
  }
  const value = style as Record<string, any>
  const alignment =
    value.alignment && typeof value.alignment === 'object'
      ? (value.alignment as Record<string, any>)
      : {}
  return {
    ...value,
    bgColor: value.bgColor ?? value.fill,
    fontColor: value.fontColor ?? value.color,
    align: value.align ?? alignment.horizontal,
    valign: value.valign ?? alignment.vertical,
    wrapText: value.wrapText ?? alignment.wrapText
  }
}

/** Accepts both the documented range-array form and the legacy cell-keyed object form. */
export function normalizeXlsxStyles(styles: unknown): NormalizedXlsxStyle[] {
  if (styles === undefined || styles === null) return []

  if (Array.isArray(styles)) {
    return styles.map((entry, index) => {
      const path = `styles[${index}]`
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${path} 必须是包含 range 和样式属性的对象`)
      }
      const value = entry as Record<string, any>
      if (value.range === undefined && value.cell === undefined) {
        throw new Error(`${path} 缺少 range；示例：{range:"A1:C1",bold:true}`)
      }
      const style = { ...value }
      delete style.range
      delete style.cell
      return {
        ...parseRange(value.range ?? value.cell, `${path}.range`),
        style: normalizeStyle(style, path)
      }
    })
  }

  if (typeof styles === 'object') {
    return Object.entries(styles as Record<string, unknown>).map(([range, style]) => ({
      ...parseRange(range, `styles.${range}`),
      style: normalizeStyle(style, `styles.${range}`)
    }))
  }

  throw new Error('styles 必须是范围样式数组或以单元格地址为键的对象')
}

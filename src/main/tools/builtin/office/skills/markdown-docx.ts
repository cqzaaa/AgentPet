import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'

export type MarkdownDocxOptions = {
  resolveImage?: (line: string) => Paragraph | null
}

function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  let cursor = 0
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) runs.push(new TextRun({ text: text.slice(cursor, index) }))
    const token = match[0]
    if (token.startsWith('`')) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas', color: '1F4E79', size: 19 }))
    } else if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }))
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true }))
    }
    cursor = index + token.length
  }
  if (cursor < text.length) runs.push(new TextRun({ text: text.slice(cursor) }))
  return runs.length ? runs : [new TextRun({ text })]
}

function paragraph(text: string, options: Record<string, any> = {}): Paragraph {
  const isHeading = Boolean(options.heading)
  return new Paragraph({
    ...options,
    spacing: isHeading
      ? { before: 260, after: 120, line: 300 }
      : { after: 150, line: 300 },
    children: inlineRuns(text)
  })
}

function codeParagraph(text: string): Paragraph {
  return new Paragraph({
    style: 'Code Block',
    keepLines: true,
    shading: { type: ShadingType.SOLID, color: 'F3F4F6' },
    spacing: { before: 70, after: 35, line: 240 },
    indent: { left: 300, right: 300 },
    children: [new TextRun({ text, font: 'Consolas', size: 18, color: '333333' })]
  })
}

function markdownTable(rows: string[][]): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9E2F3' }
  const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }
  const makeCell = (text: string, header: boolean) => new TableCell({
    shading: { type: ShadingType.SOLID, color: header ? '1F4E79' : 'FFFFFF' },
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [new Paragraph({ children: header ? [new TextRun({ text, bold: true, color: 'FFFFFF' })] : inlineRuns(text) })]
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, borders,
    rows: rows.map((row, index) => new TableRow({ children: row.map(cell => makeCell(cell, index === 0)) }))
  })
}

export function markdownToDocx(content: string, options: MarkdownDocxOptions = {}): Document {
  const children: Array<Paragraph | Table> = []
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  let inCode = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) { inCode = !inCode; i += 1; continue }
    if (inCode) { children.push(codeParagraph(line)); i += 1; continue }
    if (!trimmed || trimmed === '---') { i += 1; continue }
    const image = options.resolveImage?.(line)
    if (image) { children.push(image); i += 1; continue }
    if (trimmed.startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const row = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
        if (!row.every(cell => /^:?-{3,}:?$/.test(cell))) rows.push(row)
        i += 1
      }
      if (rows.length) {
        children.push(new Paragraph({ spacing: { before: 100, after: 100 }, children: [] }))
        children.push(markdownTable(rows))
        children.push(new Paragraph({ spacing: { before: 100, after: 100 }, children: [] }))
      }
      continue
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = Math.min(3, heading[1].length)
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]
      children.push(paragraph(heading[2], { heading: levels[level - 1] }))
      i += 1; continue
    }
    const numberedHeading = trimmed.match(/^(\d+(?:\.\d+)*)\.\s+(.+)$/)
    if (numberedHeading && !/^\d+\.\s+[-*]/.test(trimmed)) {
      const level = Math.min(3, numberedHeading[1].split('.').length)
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]
      children.push(paragraph(trimmed, { heading: levels[level - 1] }))
      i += 1; continue
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (bullet) {
      children.push(paragraph(bullet[2], { bullet: { level: Math.min(1, Math.floor(bullet[1].length / 2)) } }))
      i += 1; continue
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (ordered) { children.push(paragraph(ordered[1], { numbering: { reference: 'ordered-list', level: 0 } })); i += 1; continue }
    children.push(paragraph(trimmed))
    i += 1
  }
  return new Document({
    numbering: { config: [{ reference: 'ordered-list', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT }] }] },
    styles: {
      default: { document: { run: { font: '等线', size: 21 }, paragraph: { spacing: { after: 100, line: 276 } } } },
      paragraphStyles: [
        { id: 'Code Block', name: 'Code Block', basedOn: 'Normal', run: { font: 'Consolas', size: 18 }, paragraph: { spacing: { after: 0, line: 220 } } }
      ]
    },
    sections: [{
      properties: { page: { margin: { top: 1037, bottom: 1037, left: 1181, right: 1181 } } },
      children
    }]
  })
}

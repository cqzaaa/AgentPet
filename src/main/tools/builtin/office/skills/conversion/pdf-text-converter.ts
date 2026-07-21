/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs'
import { basename, extname } from 'path'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { writeGeneratedFile } from '../shared'
import { extractPdfMarkdownWithPaddle } from './paddle-pdf-converter'
import {
  classifyPdfForEditableConversion,
  type PdfClassification
} from './pdf2docx-converter'
import { createConversionRuntime } from './runtime'

interface PdfTextLine {
  text: string
  x: number
  y: number
  fontSize: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function joinTextRuns(runs: any[]): string {
  let text = ''
  let previousRight = 0
  let previousText = ''
  for (const run of runs) {
    const value = String(run.str || '')
    if (!value) continue
    const x = Number(run.transform?.[4] || 0)
    const width = Number(run.width || 0)
    const fontSize = Math.hypot(
      Number(run.transform?.[2] || 0),
      Number(run.transform?.[3] || 0)
    )
    const gap = x - previousRight
    const shouldSeparate =
      text &&
      gap > Math.max(2, fontSize * 0.28) &&
      !/[\u3400-\u9fff]$/.test(previousText) &&
      !/^[\u3400-\u9fff，。；：！？、）》】]/.test(value)
    if (shouldSeparate) text += ' '
    text += value
    previousRight = x + Math.max(0, width)
    previousText = value
  }
  return text.trim()
}

async function extractDigitalPdfLines(
  sourcePath: string,
  selectedPages: number[]
): Promise<PdfTextLine[][]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await getDocument({
    data: new Uint8Array(await fs.promises.readFile(sourcePath)),
    disableWorker: true,
    useSystemFonts: true
  } as any).promise
  const pages: PdfTextLine[][] = []
  try {
    for (const pageNumber of selectedPages) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const runs = (content.items as any[])
          .filter(item => typeof item?.str === 'string' && item.str.trim() && Array.isArray(item.transform))
          .map(item => ({
            ...item,
            x: Number(item.transform[4] || 0),
            y: Number(item.transform[5] || 0),
            fontSize: Math.hypot(Number(item.transform[2] || 0), Number(item.transform[3] || 0))
          }))
          .sort((left, right) => right.y - left.y || left.x - right.x)
        const grouped: any[][] = []
        for (const run of runs) {
          const line = grouped.find(candidate => Math.abs(Number(candidate[0]?.y || 0) - run.y) <= 1.8)
          if (line) line.push(run)
          else grouped.push([run])
        }
        pages.push(
          grouped
            .map(lineRuns => {
              lineRuns.sort((left, right) => left.x - right.x)
              return {
                text: joinTextRuns(lineRuns),
                x: Math.min(...lineRuns.map(run => run.x)),
                y: median(lineRuns.map(run => run.y)),
                fontSize: median(lineRuns.map(run => run.fontSize))
              }
            })
            .filter(line => line.text)
            .sort((left, right) => right.y - left.y || left.x - right.x)
        )
      } finally {
        page.cleanup()
      }
    }
  } finally {
    await document.destroy()
  }
  return pages
}

function digitalLinesToMarkdown(pages: PdfTextLine[][]): string {
  const bodySize = median(
    pages.flatMap(page => page.map(line => line.fontSize).filter(size => size >= 7 && size <= 24))
  ) || 12
  return pages
    .map(page => {
      const blocks: string[] = []
      let paragraph: string[] = []
      let previousLine: PdfTextLine | null = null
      const flush = (): void => {
        const text = paragraph.join('').trim()
        if (text) blocks.push(text)
        paragraph = []
      }
      for (const line of page) {
        const headingLevel =
          line.text.length <= 80 && line.fontSize >= bodySize * 1.45
            ? 1
            : line.text.length <= 100 && line.fontSize >= bodySize * 1.18
              ? 2
              : 0
        const verticalGap = previousLine ? previousLine.y - line.y : 0
        if (headingLevel > 0) {
          flush()
          blocks.push(`${'#'.repeat(headingLevel)} ${line.text}`)
        } else {
          if (previousLine && verticalGap > Math.max(bodySize * 1.9, previousLine.fontSize * 1.8)) {
            flush()
          }
          paragraph.push(line.text)
        }
        previousLine = line
      }
      flush()
      return blocks.join('\n\n')
    })
    .join('\n\n<!-- page-break -->\n\n')
}

function digitalLinesToText(pages: PdfTextLine[][]): string {
  return pages.map(page => page.map(line => line.text).join('\n')).join('\n\n\f\n\n')
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/<!--\s*page-break\s*-->/gi, '\n\n\f\n\n')
    .replace(/<table\b[^>]*>/gi, '')
    .replace(/<\/table>/gi, '')
    .replace(/<tr\b[^>]*>/gi, '')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<t[dh]\b[^>]*>/gi, '')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/!\[([^\]]*)]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\|/g, '\t')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function convertPdfToMarkdownOrText(
  sourcePath: string,
  target: 'markdown' | 'txt',
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const runtime = createConversionRuntime(
    input,
    context,
    `PDF → ${target === 'markdown' ? 'Markdown' : 'TXT'}`
  )
  runtime.report(0, 3, '正在分析 PDF 文本类型')
  const classification: PdfClassification = await classifyPdfForEditableConversion(
    sourcePath,
    input.pages
  )
  runtime.report(1, 3, '正在提取文档内容')

  let content: string
  let extractionMode: 'pdf-text-layer' | 'document-ocr'
  if (classification.kind === 'digital') {
    const pages = await extractDigitalPdfLines(sourcePath, classification.selectedPages)
    content = target === 'markdown' ? digitalLinesToMarkdown(pages) : digitalLinesToText(pages)
    extractionMode = 'pdf-text-layer'
  } else {
    const extracted = await extractPdfMarkdownWithPaddle(sourcePath, input, context)
    content = target === 'markdown' ? extracted.markdown : markdownToPlainText(extracted.markdown)
    extractionMode = 'document-ocr'
  }
  if (!content.trim()) throw new Error('PDF 中没有提取到可输出的文本内容')

  const extension = target === 'markdown' ? '.md' : '.txt'
  const output = await writeGeneratedFile(
    Buffer.from(content, 'utf8'),
    input.output_name,
    `${basename(sourcePath, extname(sourcePath))}${extension}`,
    extension,
    context
  )
  runtime.report(3, 3, '文本文件已生成')
  const state = {
    status: 'success',
    skill: 'pdf',
    action: 'convert',
    conversion: {
      source_format: 'pdf',
      target_format: target,
      mode: 'structured',
      extraction: extractionMode
    },
    source_path: sourcePath,
    file_path: output.filePath,
    file_name: output.fileName,
    document_classification: classification,
    converted_pages: classification.selectedPages,
    validation: { valid: true, text_length: content.length }
  }
  return {
    success: true,
    state,
    content: JSON.stringify(
      {
        status: 'success',
        message: `PDF 已转换为 ${target === 'markdown' ? 'Markdown' : 'TXT'}`,
        file_path: output.filePath,
        file_name: output.fileName
      },
      null,
      2
    )
  }
}

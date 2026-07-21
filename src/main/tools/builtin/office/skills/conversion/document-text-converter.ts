/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs'
import { basename, extname } from 'path'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import JSZip from 'jszip'
import * as mammoth from 'mammoth'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { jsonResult, writeGeneratedFile } from '../shared'
import { assertOfficeConversionSupported, normalizeConversionFormat } from './capabilities'
import { createConversionRuntime, resolveConversionSource } from './runtime'

function decodeEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return entities[entity.toLowerCase()] ?? `&${entity};`
  })
}

function htmlToMarkdown(html: string): string {
  return decodeEntities(html)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, level, text) => `${'#'.repeat(Number(level))} ${text}\n\n`
    )
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlToText(html: string): string {
  return decodeEntities(html)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function markdownToParagraphs(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = []
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6
      ]
      paragraphs.push(new Paragraph({ text: heading[2], heading: levels[heading[1].length - 1] }))
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/)
    if (bullet) {
      paragraphs.push(new Paragraph({ text: bullet[1], bullet: { level: 0 } }))
      continue
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (numbered) {
      paragraphs.push(
        new Paragraph({ text: numbered[1], numbering: { reference: 'ordered-list', level: 0 } })
      )
      continue
    }
    paragraphs.push(new Paragraph({ children: [new TextRun(line)] }))
  }
  return paragraphs.length > 0 ? paragraphs : [new Paragraph('')]
}

async function createDocx(
  content: string,
  outputName: unknown,
  fallback: string,
  context: ToolContext
): Promise<{ filePath: string; fileName: string }> {
  const document = new Document({
    numbering: {
      config: [
        {
          reference: 'ordered-list',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }]
        }
      ]
    },
    sections: [{ children: markdownToParagraphs(content) }]
  })
  return writeGeneratedFile(await Packer.toBuffer(document), outputName, fallback, '.docx', context)
}

export async function convertDocumentText(
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const source = resolveConversionSource(input.source_path || input.file_path, context)
  const target = normalizeConversionFormat(input.target_format)
  if (target !== 'docx' && target !== 'markdown' && target !== 'html' && target !== 'txt') {
    throw new Error('文档结构化转换仅支持 DOCX、Markdown、HTML 或 TXT')
  }
  const capability = assertOfficeConversionSupported(source.format, target)
  const runtime = createConversionRuntime(
    input,
    context,
    `${source.format.toUpperCase()} → ${target.toUpperCase()}`
  )
  runtime.report(0, 1, '正在读取文档')
  const baseName = basename(source.path, extname(source.path))
  let output: { filePath: string; fileName: string }

  if (source.format === 'docx') {
    if (target === 'html') {
      const result = await mammoth.convertToHtml({ path: source.path })
      output = await writeGeneratedFile(
        Buffer.from(result.value),
        input.output_name,
        `${baseName}.html`,
        '.html',
        context
      )
    } else if (target === 'txt') {
      const result = await mammoth.extractRawText({ path: source.path })
      output = await writeGeneratedFile(
        Buffer.from(result.value),
        input.output_name,
        `${baseName}.txt`,
        '.txt',
        context
      )
    } else if (target === 'markdown') {
      const result = await mammoth.convertToHtml({ path: source.path })
      output = await writeGeneratedFile(
        Buffer.from(htmlToMarkdown(result.value)),
        input.output_name,
        `${baseName}.md`,
        '.md',
        context
      )
    } else {
      throw new Error('DOCX 不能结构化转换为 DOCX')
    }
  } else {
    const raw = await fs.promises.readFile(source.path, 'utf8')
    runtime.check()
    const markdown = source.format === 'html' ? htmlToMarkdown(raw) : raw
    output = await createDocx(
      markdown || htmlToText(raw),
      input.output_name,
      `${baseName}.docx`,
      context
    )
  }

  runtime.report(1, 1, '文档已生成')
  const outputBytes = await fs.promises.readFile(output.filePath)
  let valid = outputBytes.length > 0
  const checks = ['non_empty_output']
  if (target === 'docx') {
    const archive = await JSZip.loadAsync(outputBytes)
    valid = Boolean(archive.file('word/document.xml'))
    checks.push('zip_package', 'document_part')
  }
  return jsonResult({
    status: 'success',
    skill: 'docx',
    action: 'convert',
    conversion: { source_format: source.format, target_format: target, mode: capability.mode },
    source_path: source.path,
    file_path: output.filePath,
    file_name: output.fileName,
    validation: { valid, checks },
    progress: { status: 'completed', completed: 1, total: 1 }
  })
}

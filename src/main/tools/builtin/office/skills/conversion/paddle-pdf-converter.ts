/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'crypto'
import * as fs from 'fs'
import { basename, extname, isAbsolute, join, resolve } from 'path'

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import PptxGenJS from 'pptxgenjs'

import type { ToolContext, ToolResult } from '../../../../core/types'
import { mcpManager } from '../../../../mcp/mcp-manager'
import { getSessionFilesDir } from '../../../../utils/paths'
import { jsonResult, writeGeneratedFile } from '../shared'
import { createConversionRuntime } from './runtime'

const PADDLE_PRESET = 'paddleocr-aistudio' as const
const PADDLE_MODEL = 'PaddleOCR-VL-1.6'
const TOKEN_GUIDE_URL = 'https://aistudio.baidu.com/paddleocr'
const MAX_PADDLE_PAGES_PER_REQUEST = 100

interface MarkdownBlock {
  type: 'heading' | 'paragraph' | 'bullet' | 'table'
  text?: string
  level?: number
  rows?: string[][]
}

function paddleSetupError(detail?: string): Error {
  return new Error(
    [
      'PDF 可编辑转换需要 PaddleOCR 官方解析服务。',
      `请先访问 ${TOKEN_GUIDE_URL} 注册/登录并获取 AI Studio Access Token，`,
      '然后在“Agent 设置 → MCP 服务 → 配置 PaddleOCR”中保存并测试连接。',
      detail
    ]
      .filter(Boolean)
      .join('')
  )
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []
  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim()
    if (text) blocks.push({ type: 'paragraph', text })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      flushParagraph()
      continue
    }
    if (/<table\b/i.test(line)) {
      flushParagraph()
      let html = line
      while (!/<\/table>/i.test(html) && index + 1 < lines.length) {
        index += 1
        html += lines[index]
      }
      const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(row =>
          [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell =>
            cell[1]
              .replace(/<br\s*\/?\s*>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/gi, ' ')
              .replace(/&amp;/gi, '&')
              .replace(/&lt;/gi, '<')
              .replace(/&gt;/gi, '>')
              .trim()
          )
        )
        .filter(row => row.length > 0)
      if (rows.length > 0) blocks.push({ type: 'table', rows })
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      continue
    }
    const bullet = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line)
    if (bullet) {
      flushParagraph()
      blocks.push({ type: 'bullet', text: bullet[1].trim() })
      continue
    }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      flushParagraph()
      const rows: string[][] = []
      const splitRow = (value: string): string[] =>
        value.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      rows.push(splitRow(line))
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index].trim()))
        index += 1
      }
      index -= 1
      blocks.push({ type: 'table', rows })
      continue
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line)
    const htmlImage = /<img\b[^>]*?(?:alt="([^"]*)")?[^>]*>/i.exec(line)
    paragraph.push(
      image
        ? `[图片：${image[1] || basename(image[2])}]`
        : htmlImage
          ? `[图片：${htmlImage[1] || '文档插图'}]`
          : line.replace(/<[^>]+>/g, '')
    )
  }
  flushParagraph()
  return blocks
}

function extractMarkdown(response: string, outputDir: string): string {
  const candidates: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      candidates.push(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['markdown', 'md', 'content', 'result', 'text', 'output']) {
        if (key in record) visit(record[key])
      }
    }
  }

  const trimmed = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    visit(JSON.parse(trimmed))
  } catch {
    candidates.push(response)
  }

  for (const candidate of candidates) {
    const possiblePath = candidate.trim().replace(/^file:\/\//, '')
    if (/\.md$/i.test(possiblePath) && isAbsolute(possiblePath)) {
      const absolute = resolve(possiblePath)
      const relative = absolute.toLowerCase().startsWith(resolve(outputDir).toLowerCase())
      if (relative && fs.existsSync(absolute)) return fs.readFileSync(absolute, 'utf8')
    }
  }
  const markdown = candidates.sort((a, b) => b.length - a.length)[0]?.trim() || ''
  if (!markdown) throw new Error('PADDLEOCR_EMPTY_MARKDOWN')
  return markdown
}

function buildPaddleArguments(tool: any, sourcePath: string, outputDir: string): Record<string, unknown> {
  const schema = tool?.inputSchema || {}
  const properties = schema.properties || {}
  const pathNames = [
    'input_data',
    'file_path',
    'input_path',
    'source_path',
    'path',
    'file',
    'input',
    'file_url',
    'url'
  ]
  const pathName = pathNames.find(name => name in properties) || 'file_path'
  const args: Record<string, unknown> = {
    [pathName]: properties[pathName]?.type === 'array' ? [sourcePath] : sourcePath
  }
  if ('file_type' in properties) args.file_type = 'pdf'
  if ('output_mode' in properties) args.output_mode = 'simple'
  if ('return_images' in properties) args.return_images = false
  for (const name of ['output_dir', 'output_path', 'save_dir']) {
    if (name in properties) args[name] = outputDir
  }
  for (const name of ['return_markdown', 'save_markdown']) {
    if (name in properties) args[name] = true
  }
  return args
}

function selectPaddleTool(tools: any[]): any {
  const exact = tools.find(tool => String(tool.name).toLowerCase() === 'paddleocr_vl')
  if (exact) return exact
  const vl = tools.find(tool => {
    const name = String(tool.name).toLowerCase()
    return name.includes('paddleocr') && name.includes('vl')
  })
  if (vl) return vl
  return tools.length === 1 ? tools[0] : null
}

async function parsePdfWithPaddle(
  sourcePath: string,
  context: ToolContext,
  timeoutMs: number,
  report: (completed: number, total: number, detail: string) => void
): Promise<{ markdown: string; cached: boolean; toolName: string }> {
  const server = mcpManager.getEnabledServerByPreset(PADDLE_PRESET)
  if (!server || !server.apiKey) throw paddleSetupError()

  const sessionDir = getSessionFilesDir(context.sessionId)
  const cacheDir = join(sessionDir, '.agentpet-cache', 'paddleocr')
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const sourceBytes = await fs.promises.readFile(sourcePath)
  const digest = createHash('sha256')
    .update(sourceBytes)
    .update(`\0${server.model || PADDLE_MODEL}`)
    .digest('hex')
  const cachePath = join(cacheDir, `${digest}.md`)
  if (fs.existsSync(cachePath)) {
    const markdown = await fs.promises.readFile(cachePath, 'utf8')
    if (markdown.trim()) return { markdown, cached: true, toolName: 'cache' }
  }

  report(1, 4, '正在启动 PaddleOCR 官方解析服务')
  const tools = await mcpManager.getServerTools(server.id)
  const tool = selectPaddleTool(tools)
  if (!tool) {
    throw paddleSetupError('当前服务未发现 PaddleOCR-VL 工具，请在 MCP 设置中测试连接。')
  }
  report(2, 4, '正在用 PaddleOCR 解析整份 PDF')
  try {
    const pdf = await PDFDocument.load(sourceBytes)
    const pageCount = pdf.getPageCount()
    const inputs: Array<{ path: string; start: number; end: number; temporary: boolean }> = []
    if (pageCount <= MAX_PADDLE_PAGES_PER_REQUEST) {
      inputs.push({ path: sourcePath, start: 1, end: pageCount, temporary: false })
    } else {
      for (let start = 0; start < pageCount; start += MAX_PADDLE_PAGES_PER_REQUEST) {
        const end = Math.min(pageCount, start + MAX_PADDLE_PAGES_PER_REQUEST)
        const chunk = await PDFDocument.create()
        const copied = await chunk.copyPages(
          pdf,
          Array.from({ length: end - start }, (_, index) => start + index)
        )
        copied.forEach(page => chunk.addPage(page))
        const chunkPath = join(cacheDir, `${digest}-pages-${start + 1}-${end}.pdf`)
        await fs.promises.writeFile(chunkPath, await chunk.save())
        inputs.push({ path: chunkPath, start: start + 1, end, temporary: true })
      }
    }

    const parts: string[] = []
    for (let index = 0; index < inputs.length; index += 1) {
      const item = inputs[index]
      const partCache = join(cacheDir, `${digest}-pages-${item.start}-${item.end}.md`)
      try {
        let part = fs.existsSync(partCache) ? await fs.promises.readFile(partCache, 'utf8') : ''
        if (!part.trim()) {
          report(
            2 + index / Math.max(1, inputs.length),
            4,
            inputs.length === 1
              ? '正在用 PaddleOCR 解析整份 PDF'
              : `正在解析第 ${item.start}-${item.end} 页（${index + 1}/${inputs.length}）`
          )
          const response = await mcpManager.executeToolOnServer(
            server.id,
            tool.name,
            buildPaddleArguments(tool, item.path, cacheDir),
            context.abortSignal,
            timeoutMs
          )
          part = extractMarkdown(response, cacheDir)
          await fs.promises.writeFile(partCache, part, 'utf8')
        }
        parts.push(
          inputs.length === 1 ? part : `<!-- PDF pages ${item.start}-${item.end} -->\n\n${part}`
        )
      } finally {
        if (item.temporary) await fs.promises.rm(item.path, { force: true })
      }
    }
    const markdown = parts.join('\n\n')
    await fs.promises.writeFile(cachePath, markdown, 'utf8')
    report(3, 4, 'PaddleOCR 结构解析完成')
    return { markdown, cached: false, toolName: tool.name }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/429|quota|额度|limit/i.test(message)) {
      throw new Error('PaddleOCR 今日解析额度已用完，请明日重试或在 AI Studio 申请更多页数。')
    }
    if (/401|403|token|unauthor|forbidden/i.test(message)) {
      throw paddleSetupError('Access Token 无效或已过期，请重新获取并更新。')
    }
    if (/ENOENT|uvx|MCP_SERVICE_UNAVAILABLE/i.test(message)) {
      throw paddleSetupError('本机未找到 uvx 或 PaddleOCR MCP 启动失败，请先安装 uv。')
    }
    throw new Error(`PaddleOCR 解析失败：${message}`)
  }
}

function docxChildren(blocks: MarkdownBlock[]): Array<Paragraph | Table> {
  const levels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6
  ]
  return blocks.map(block => {
    if (block.type === 'heading') {
      return new Paragraph({ text: block.text || '', heading: levels[(block.level || 1) - 1] })
    }
    if (block.type === 'bullet') {
      return new Paragraph({ text: block.text || '', bullet: { level: 0 } })
    }
    if (block.type === 'table') {
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: (block.rows || []).map(
          row =>
            new TableRow({
              children: row.map(
                cell =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun(cell)] })]
                  })
              )
            })
        )
      })
    }
    return new Paragraph({ children: [new TextRun(block.text || '')] })
  })
}

async function createEditableDocx(
  blocks: MarkdownBlock[],
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext
): Promise<{ filePath: string; fileName: string; valid: boolean }> {
  const document = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: basename(sourcePath),
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER
          }),
          ...docxChildren(blocks)
        ]
      }
    ]
  })
  const output = await writeGeneratedFile(
    await Packer.toBuffer(document),
    input.output_name,
    `${basename(sourcePath, extname(sourcePath))}-editable.docx`,
    '.docx',
    context
  )
  const archive = await JSZip.loadAsync(await fs.promises.readFile(output.filePath))
  return { ...output, valid: Boolean(archive.file('word/document.xml')) }
}

function addEditableSlides(pptx: PptxGenJS, blocks: MarkdownBlock[]): number {
  const groups: MarkdownBlock[][] = []
  let current: MarkdownBlock[] = []
  let size = 0
  for (const block of blocks) {
    const blockSize = block.text?.length || (block.rows || []).flat().join('').length
    if (current.length > 0 && (block.type === 'heading' || size + blockSize > 900)) {
      groups.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += blockSize
  }
  if (current.length > 0) groups.push(current)
  if (groups.length === 0) groups.push([{ type: 'paragraph', text: '' }])

  for (const group of groups) {
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    const heading = group.find(block => block.type === 'heading')
    slide.addText(heading?.text || '文档内容', {
      x: 0.65,
      y: 0.35,
      w: 12,
      h: 0.55,
      fontFace: 'Microsoft YaHei',
      fontSize: 24,
      bold: true,
      color: '1F2937',
      margin: 0
    })
    let y = 1.1
    for (const block of group.filter(item => item !== heading)) {
      if (y > 6.75) break
      if (block.type === 'table' && block.rows?.length) {
        const height = Math.min(3.8, 0.38 * block.rows.length + 0.2)
        slide.addTable(
          block.rows.map(row => row.map(cell => ({ text: cell }))),
          {
          x: 0.65,
          y,
          w: 12,
          h: height,
          fontFace: 'Microsoft YaHei',
          fontSize: 11,
          border: { type: 'solid', color: 'CBD5E1', pt: 1 },
          fill: 'F8FAFC',
          margin: 0.06
          } as any
        )
        y += height + 0.22
      } else {
        const text = `${block.type === 'bullet' ? '• ' : ''}${block.text || ''}`
        const height = Math.min(1.45, Math.max(0.34, Math.ceil(text.length / 58) * 0.34))
        slide.addText(text, {
          x: 0.75,
          y,
          w: 11.8,
          h: height,
          fontFace: 'Microsoft YaHei',
          fontSize: block.type === 'heading' ? 18 : 13,
          bold: block.type === 'heading',
          color: '334155',
          breakLine: false,
          valign: 'top',
          margin: 0.02
        })
        y += height + 0.1
      }
    }
  }
  return groups.length
}

async function createEditablePptx(
  blocks: MarkdownBlock[],
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext
): Promise<{ filePath: string; fileName: string; valid: boolean; slideCount: number }> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'AgentPet Office Skill'
  pptx.subject = 'PaddleOCR editable PDF conversion'
  const slideCount = addEditableSlides(pptx, blocks)
  const bytes = await pptx.write({ outputType: 'nodebuffer', compression: true })
  const output = await writeGeneratedFile(
    Buffer.from(bytes as Uint8Array),
    input.output_name,
    `${basename(sourcePath, extname(sourcePath))}-editable.pptx`,
    '.pptx',
    context
  )
  const archive = await JSZip.loadAsync(await fs.promises.readFile(output.filePath))
  return { ...output, valid: Boolean(archive.file('ppt/presentation.xml')), slideCount }
}

export async function convertPdfWithPaddle(
  sourcePath: string,
  target: 'docx' | 'pptx',
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const runtime = createConversionRuntime(input, context, `PDF → ${target.toUpperCase()}（可编辑）`)
  runtime.report(0, 4, '正在准备 PaddleOCR 解析')
  const parsed = await parsePdfWithPaddle(
    sourcePath,
    context,
    runtime.timeoutMs,
    runtime.report
  )
  runtime.check()
  const blocks = parseMarkdown(parsed.markdown)
  if (blocks.length === 0) throw new Error('PaddleOCR 未解析出可转换内容')

  const sourcePdf = await PDFDocument.load(await fs.promises.readFile(sourcePath))
  const pageCount = sourcePdf.getPageCount()
  const output =
    target === 'docx'
      ? await createEditableDocx(blocks, sourcePath, input, context)
      : await createEditablePptx(blocks, sourcePath, input, context)
  runtime.report(4, 4, '可编辑文档已生成')

  return jsonResult({
    status: 'success',
    skill: 'pdf',
    action: 'convert',
    conversion: {
      source_format: 'pdf',
      target_format: target,
      mode: 'editable',
      parser: PADDLE_MODEL
    },
    source_path: sourcePath,
    file_path: output.filePath,
    file_name: output.fileName,
    page_count: pageCount,
    slide_count: 'slideCount' in output ? output.slideCount : undefined,
    editable: true,
    paddleocr: { cached: parsed.cached, tool: parsed.toolName },
    validation: { valid: output.valid, checks: ['office_package', 'editable_structure'] },
    progress: { status: 'completed', completed: 4, total: 4 }
  })
}

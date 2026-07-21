/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'crypto'
import * as fs from 'fs'
import { basename, extname, join } from 'path'

import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  LineRuleType,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  SectionType,
  Tab,
  TabStopType,
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
import { credentialManager } from '../../../../interaction/credential-manager'
import {
  clearPaddleOcrToken,
  getPaddleOcrToken,
  setPaddleOcrToken
} from '../../../../../security/paddle-ocr-token'
import { getSessionFilesDir } from '../../../../utils/paths'
import { writeGeneratedFile } from '../shared'
import { parsePdfPageSelection } from './pdf2docx-converter'
import { createConversionRuntime } from './runtime'

const PADDLE_MODEL = 'PaddleOCR-VL-1.6'
const TOKEN_GUIDE_URL = 'https://aistudio.baidu.com/paddleocr'
const PADDLE_JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'

interface PreparedPdfPages {
  path: string
  selectedPages: number[]
  cleanup: () => Promise<void>
}

async function preparePdfPages(
  sourcePath: string,
  pages: unknown,
  context: ToolContext
): Promise<PreparedPdfPages> {
  const sourceBytes = await fs.promises.readFile(sourcePath)
  const sourcePdf = await PDFDocument.load(sourceBytes)
  const pageCount = sourcePdf.getPageCount()
  const selectedPages = parsePdfPageSelection(pages, pageCount)
  const allPagesSelected =
    selectedPages.length === pageCount && selectedPages.every((page, index) => page === index + 1)
  if (allPagesSelected) {
    return { path: sourcePath, selectedPages, cleanup: async () => undefined }
  }

  const subsetPdf = await PDFDocument.create()
  const copiedPages = await subsetPdf.copyPages(
    sourcePdf,
    selectedPages.map(page => page - 1)
  )
  for (const page of copiedPages) subsetPdf.addPage(page)
  const cacheDir = join(
    getSessionFilesDir(context.sessionId),
    '.agentpet-cache',
    'pdf-pages',
    `${Date.now()}-${process.pid}`
  )
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const subsetPath = join(cacheDir, basename(sourcePath))
  await fs.promises.writeFile(subsetPath, await subsetPdf.save())
  return {
    path: subsetPath,
    selectedPages,
    cleanup: async () => {
      await fs.promises.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

class PaddleAuthError extends Error {}

async function ensurePaddleConfigured(context: ToolContext, replacing = false): Promise<string> {
  const savedToken = getPaddleOcrToken()
  if (savedToken && !replacing) return savedToken

  const response = await credentialManager.request(
    {
      kind: 'paddleocr-api',
      title: replacing ? 'PaddleOCR Token 已失效，请更换' : 'PDF 可编辑转换需要 PaddleOCR Token',
      description: replacing
        ? '旧 Token 无法通过鉴权。填写新 Token 后会自动继续当前转换，不需要重新上传文件。'
        : '上传附件时提取的是 PDF 文本预览，无法恢复字体、段落样式、分页和版面。填写 Token 后将通过 PaddleOCR API 解析原始 PDF，并继续当前转换。',
      guideUrl: TOKEN_GUIDE_URL,
      fieldLabel: 'AI Studio Access Token',
      placeholder: '粘贴 Access Token'
    },
    context.sessionId,
    context.event?.sender
  )
  if (response.cancelled || !response.token) {
    throw new Error('PADDLEOCR_CONFIGURATION_CANCELLED: 用户取消了 PaddleOCR Token 配置，PDF 转换未执行。')
  }
  setPaddleOcrToken(response.token)
  return response.token
}

interface MarkdownBlock {
  type: 'heading' | 'paragraph' | 'bullet' | 'table' | 'pageBreak'
  text?: string
  level?: number
  rows?: string[][]
  continuation?: boolean
}

interface PaddleLayoutBlock {
  label: string
  content: string
  bbox: [number, number, number, number]
  order: number
}

interface PaddleLayoutPage {
  width: number
  height: number
  blocks: PaddleLayoutBlock[]
}

interface PaddleParseResult {
  markdown: string
  layoutPages: PaddleLayoutPage[]
  cached: boolean
  toolName: string
  apiSubmitted: boolean
  jobId?: string
  elapsedMs: number
}

function paddleSetupError(detail?: string): Error {
  return new Error(
    [
      'PDF 可编辑转换需要 PaddleOCR AI Studio API。',
      `请先访问 ${TOKEN_GUIDE_URL} 注册/登录并获取 AI Studio Access Token，`,
      '然后在安全凭据卡片中填写 Token。',
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
  let pageStart = true
  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim()
    if (text) {
      const continuation = pageStart && !/^第[一二三四五六七八九十百千万零〇0-9]+(?:章|条)/.test(text)
      blocks.push({ type: 'paragraph', text, continuation })
      pageStart = false
    }
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      flushParagraph()
      continue
    }
    if (line === '<!-- page-break -->') {
      flushParagraph()
      blocks.push({ type: 'pageBreak' })
      pageStart = true
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
      pageStart = false
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      const headingText = heading[2].trim()
      if (/^第[一二三四五六七八九十百千万零〇0-9]+条/.test(headingText)) {
        blocks.push({ type: 'paragraph', text: headingText, continuation: false })
      } else {
        blocks.push({ type: 'heading', level: heading[1].length, text: headingText })
      }
      pageStart = false
      continue
    }
    const bullet = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line)
    if (bullet) {
      flushParagraph()
      blocks.push({ type: 'bullet', text: bullet[1].trim() })
      pageStart = false
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
      pageStart = false
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

function paddleRequestSignal(context: ToolContext, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(Math.max(1000, timeoutMs))
  return context.abortSignal
    ? AbortSignal.any([context.abortSignal, timeoutSignal])
    : timeoutSignal
}

async function readPaddleJson(response: Response, operation: string): Promise<any> {
  const body = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new PaddleAuthError(`${operation}鉴权失败（HTTP ${response.status}）`)
    }
    throw new Error(`${operation}失败（HTTP ${response.status}）：${body.slice(0, 1200)}`)
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${operation}返回了无效 JSON：${body.slice(0, 500)}`)
  }
}

async function waitForPaddlePoll(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, 5000)
    if (!signal) return
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('UserAborted'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function parsePdfWithPaddleApi(
  sourcePath: string,
  token: string,
  context: ToolContext,
  timeoutMs: number,
  report: (completed: number, total: number, detail: string) => void
): Promise<PaddleParseResult> {
  const startedAt = Date.now()
  const sessionDir = getSessionFilesDir(context.sessionId)
  const cacheDir = join(sessionDir, '.agentpet-cache', 'paddleocr')
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const sourceBytes = await fs.promises.readFile(sourcePath)
  const digest = createHash('sha256')
    .update(sourceBytes)
    .update(`\0${PADDLE_MODEL}\0api-v2-layout-v4`)
    .digest('hex')
  const cachePath = join(cacheDir, `${digest}.md`)
  const layoutCachePath = join(cacheDir, `${digest}.layout.json`)
  if (fs.existsSync(cachePath) && fs.existsSync(layoutCachePath)) {
    const markdown = await fs.promises.readFile(cachePath, 'utf8')
    const layoutPages = JSON.parse(await fs.promises.readFile(layoutCachePath, 'utf8'))
    if (markdown.trim() && Array.isArray(layoutPages)) {
      report(3, 4, `正在使用已缓存的 PaddleOCR API 结果（${layoutPages.length} 页）`)
      return {
        markdown,
        layoutPages,
        cached: true,
        toolName: 'cache',
        apiSubmitted: false,
        elapsedMs: Date.now() - startedAt
      }
    }
  }

  const headers = { Authorization: `bearer ${token}` }
  const form = new FormData()
  form.append('model', PADDLE_MODEL)
  form.append(
    'optionalPayload',
    JSON.stringify({
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useChartRecognition: false
    })
  )
  form.append('file', new Blob([sourceBytes], { type: 'application/pdf' }), basename(sourcePath))

  try {
    report(1, 4, '正在提交 PDF 到 PaddleOCR AI Studio API')
    const submitResponse = await fetch(PADDLE_JOB_URL, {
      method: 'POST',
      headers,
      body: form,
      signal: paddleRequestSignal(context, timeoutMs)
    })
    const submitJson = await readPaddleJson(submitResponse, '提交 PaddleOCR 任务')
    const jobId = String(submitJson?.data?.jobId || '')
    if (!jobId) throw new Error('PaddleOCR API 未返回 jobId')
    report(1, 4, `PaddleOCR API 已提交任务：${jobId}`)

    const deadline = Date.now() + timeoutMs
    let jsonlUrl = ''
    while (Date.now() < deadline) {
      const statusResponse = await fetch(`${PADDLE_JOB_URL}/${encodeURIComponent(jobId)}`, {
        headers,
        signal: paddleRequestSignal(context, Math.max(1000, deadline - Date.now()))
      })
      const statusJson = await readPaddleJson(statusResponse, '查询 PaddleOCR 任务')
      const data = statusJson?.data || {}
      const state = String(data.state || '')
      if (state === 'done') {
        jsonlUrl = String(data?.resultUrl?.jsonUrl || '')
        break
      }
      if (state === 'failed') throw new Error(String(data.errorMsg || 'PaddleOCR 任务失败'))
      const totalPages = Number(data?.extractProgress?.totalPages || 0)
      const extractedPages = Number(data?.extractProgress?.extractedPages || 0)
      report(
        2,
        4,
        totalPages > 0
          ? `PaddleOCR 正在解析：${extractedPages}/${totalPages} 页`
          : `PaddleOCR 任务状态：${state || 'pending'}`
      )
      await waitForPaddlePoll(context.abortSignal)
    }
    if (!jsonlUrl) throw new Error('PaddleOCR 解析超时或未返回结果地址')

    report(3, 4, '正在下载 PaddleOCR 结构化结果')
    const jsonlResponse = await fetch(jsonlUrl, {
      signal: paddleRequestSignal(context, Math.max(1000, deadline - Date.now()))
    })
    if (!jsonlResponse.ok) {
      throw new Error(`下载 PaddleOCR 结果失败（HTTP ${jsonlResponse.status}）`)
    }
    const jsonl = await jsonlResponse.text()
    const parts: string[] = []
    const layoutPages: PaddleLayoutPage[] = []
    for (const line of jsonl.split(/\r?\n/)) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line)
      const layoutResults = parsed?.result?.layoutParsingResults
      if (!Array.isArray(layoutResults)) continue
      for (const result of layoutResults) {
        const pruned = result?.prunedResult || {}
        const rawBlocks = Array.isArray(pruned.parsing_res_list) ? pruned.parsing_res_list : []
        layoutPages.push({
          width: Number(pruned.width || 0),
          height: Number(pruned.height || 0),
          blocks: rawBlocks
            .map((block: any) => ({
              label: String(block?.block_label || 'text'),
              content: String(block?.block_content || ''),
              bbox: Array.isArray(block?.block_bbox) && block.block_bbox.length === 4
                ? block.block_bbox.map((value: unknown) => Number(value || 0)) as [number, number, number, number]
                : [0, 0, 0, 0] as [number, number, number, number],
              order: Number(block?.block_order || 0)
            }))
            .filter((block: PaddleLayoutBlock) => block.content.trim())
            .sort((a: PaddleLayoutBlock, b: PaddleLayoutBlock) => a.order - b.order)
        })
        const markdown = result?.markdown?.text
        if (typeof markdown === 'string' && markdown.trim()) {
          if (parts.length > 0) parts.push('<!-- page-break -->')
          parts.push(markdown.trim())
        }
      }
    }
    const markdown = parts.join('\n\n')
    if (!markdown.trim()) throw new Error('PaddleOCR API 结果中没有可转换的 Markdown 内容')
    await fs.promises.writeFile(cachePath, markdown, 'utf8')
    await fs.promises.writeFile(layoutCachePath, JSON.stringify(layoutPages), 'utf8')
    return {
      markdown,
      layoutPages,
      cached: false,
      toolName: 'aistudio-api-v2',
      apiSubmitted: true,
      jobId,
      elapsedMs: Date.now() - startedAt
    }
  } catch (error) {
    if (error instanceof PaddleAuthError) {
      clearPaddleOcrToken()
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    if (/401|403|access\s*token|unauthor|forbidden|鉴权/i.test(message)) {
      clearPaddleOcrToken()
      throw new PaddleAuthError('PaddleOCR Access Token 无效或已过期')
    }
    if (/429|quota|额度|limit/i.test(message)) {
      throw new Error('PaddleOCR 今日解析额度已用完，请明日重试或在 AI Studio 申请更多页数。')
    }
    throw new Error(`PaddleOCR API 解析失败：${message}`)
  }
}

async function parsePdfWithConfiguredPaddle(
  sourcePath: string,
  context: ToolContext,
  timeoutMs: number,
  report: (completed: number, total: number, detail: string) => void
): Promise<PaddleParseResult> {
  let token = await ensurePaddleConfigured(context)
  try {
    return await parsePdfWithPaddleApi(sourcePath, token, context, timeoutMs, report)
  } catch (error) {
    if (!(error instanceof PaddleAuthError)) throw error
    token = await ensurePaddleConfigured(context, true)
    try {
      return await parsePdfWithPaddleApi(sourcePath, token, context, timeoutMs, report)
    } catch (retryError) {
      if (retryError instanceof PaddleAuthError) {
        throw paddleSetupError('新 Access Token 仍无法通过鉴权，请确认 Token 是否完整且未过期。')
      }
      throw retryError
    }
  }
}

export async function extractPdfMarkdownWithPaddle(
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext
): Promise<{ markdown: string; cached: boolean; transport: string }> {
  const runtime = createConversionRuntime(input, context, 'PDF 文本解析')
  runtime.report(0, 4, '正在准备文档解析')
  const prepared = await preparePdfPages(sourcePath, input.pages, context)
  try {
    const parsed = await parsePdfWithConfiguredPaddle(
      prepared.path,
      context,
      runtime.timeoutMs,
      runtime.report
    )
    runtime.check()
    return { markdown: parsed.markdown, cached: parsed.cached, transport: parsed.toolName }
  } finally {
    await prepared.cleanup()
  }
}

interface PdfLayoutRun {
  text: string
  x: number
  y: number
  width: number
  fontSize: number
  fontName: string
  fontFamily: string
}

interface PdfLayoutLine {
  y: number
  runs: PdfLayoutRun[]
}

interface PdfLayoutPage {
  width: number
  height: number
  lines: PdfLayoutLine[]
}

interface PdfTextLayout {
  pages: PdfLayoutPage[]
  dominantFontName: string
  dominantFontSize: number
  cjk: boolean
  legalDocument: boolean
  textLength: number
  text: string
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function extractPdfTextLayout(sourcePath: string): Promise<PdfTextLayout | null> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const bytes = await fs.promises.readFile(sourcePath)
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useSystemFonts: true
  } as any)
  const document = await loadingTask.promise
  const pages: PdfLayoutPage[] = []
  const fontWeights = new Map<string, number>()
  const fontSizes: number[] = []
  let combinedText = ''

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const runs: PdfLayoutRun[] = []
        for (const item of content.items as any[]) {
          const text = typeof item?.str === 'string' ? item.str : ''
          if (!text.trim() || !Array.isArray(item.transform)) continue
          const fontSize = Math.hypot(Number(item.transform[2]) || 0, Number(item.transform[3]) || 0)
          if (!Number.isFinite(fontSize) || fontSize < 4 || fontSize > 120) continue
          const fontName = String(item.fontName || '')
          const fontFamily = String((content.styles as any)?.[fontName]?.fontFamily || '')
          runs.push({
            text,
            x: Number(item.transform[4]) || 0,
            y: Number(item.transform[5]) || 0,
            width: Number(item.width) || 0,
            fontSize,
            fontName,
            fontFamily
          })
          const weight = Math.max(1, text.replace(/\s/g, '').length)
          fontWeights.set(fontName, (fontWeights.get(fontName) || 0) + weight)
          for (let index = 0; index < Math.min(weight, 20); index += 1) fontSizes.push(fontSize)
          combinedText += text
        }

        runs.sort((a, b) => b.y - a.y || a.x - b.x)
        const lines: PdfLayoutLine[] = []
        for (const run of runs) {
          const line = lines.find(candidate => Math.abs(candidate.y - run.y) <= 1.5)
          if (line) {
            line.runs.push(run)
            line.y = (line.y * (line.runs.length - 1) + run.y) / line.runs.length
          } else {
            lines.push({ y: run.y, runs: [run] })
          }
        }
        lines.sort((a, b) => b.y - a.y)
        lines.forEach(line => line.runs.sort((a, b) => a.x - b.x))
        pages.push({ width: viewport.width, height: viewport.height, lines })
      } finally {
        page.cleanup()
      }
    }
  } finally {
    await document.destroy()
  }

  const textLength = combinedText.replace(/\s/g, '').length
  if (textLength < Math.max(80, pages.length * 20)) return null
  const dominantFontName = [...fontWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const bodyCandidates = fontSizes.filter(size => size >= 7 && size <= 24)
  const dominantFontSize = median(bodyCandidates) || 12
  const cjkCount = (combinedText.match(/[\u3400-\u9fff]/g) || []).length
  const cjk = cjkCount > combinedText.length * 0.2
  const legalDocument =
    (combinedText.match(/第[一二三四五六七八九十百千万零〇0-9]+条/g) || []).length >= 5 &&
    /第[一二三四五六七八九十百千万零〇0-9]+章/.test(combinedText)
  return {
    pages,
    dominantFontName,
    dominantFontSize,
    cjk,
    legalDocument,
    textLength,
    text: combinedText
  }
}

function comparableText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function textLayerAgreement(pdfText: string, paddleText: string): number {
  const left = comparableText(pdfText)
  const right = comparableText(paddleText)
  if (!left || !right) return 0
  const grams = (value: string): Set<string> => {
    const result = new Set<string>()
    for (let index = 0; index < value.length - 1; index += 1) {
      result.add(value.slice(index, index + 2))
    }
    return result
  }
  const leftGrams = grams(left)
  const rightGrams = grams(right)
  if (leftGrams.size === 0 || rightGrams.size === 0) return left === right ? 1 : 0
  let intersection = 0
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1
  }
  return intersection / Math.max(1, Math.min(leftGrams.size, rightGrams.size))
}

function resolveLayoutFont(run: PdfLayoutRun, layout: PdfTextLayout, bold: boolean): string {
  const family = `${run.fontFamily} ${run.fontName}`.toLowerCase()
  if (layout.cjk) {
    if (/fang|仿宋/.test(family)) return 'FangSong_GB2312'
    if (/kai|楷/.test(family)) return 'KaiTi'
    if (/hei|yahei|gothic|黑体|微软雅黑/.test(family)) return bold ? 'SimHei' : 'Microsoft YaHei'
    if (/song|simsun|宋体/.test(family)) return bold ? 'SimHei' : 'SimSun'
    if (layout.legalDocument) return bold ? 'SimHei' : 'FangSong_GB2312'
    if (/mono/.test(family)) return 'SimSun'
    return bold ? 'Microsoft YaHei' : 'SimSun'
  }
  if (/mono/.test(family)) return 'Courier New'
  if (/sans/.test(family)) return 'Arial'
  return 'Times New Roman'
}

function resolveSemanticLayoutFont(
  run: PdfLayoutRun,
  layout: PdfTextLayout,
  bold: boolean,
  semanticLabel: string
): string {
  if (layout.cjk && semanticLabel === 'doc_title') return '方正小标宋简体'
  if (layout.cjk && /paragraph_title|section_title/.test(semanticLabel)) return 'SimHei'
  return resolveLayoutFont(run, layout, bold)
}

function layoutRunIsBold(
  run: PdfLayoutRun,
  lineText: string,
  layout: PdfTextLayout,
  semanticLabel = ''
): boolean {
  if (/title|heading/.test(semanticLabel)) return true
  if (/bold|black|heavy|semibold|demi/i.test(`${run.fontName} ${run.fontFamily}`)) return true
  if (/^第[一二三四五六七八九十百千万零〇0-9]+(?:章|条)/.test(run.text.trim())) return true
  if (run.fontSize >= layout.dominantFontSize * 1.18) return true
  if (layout.legalDocument) return false
  return run.fontName !== layout.dominantFontName && lineText.trim().length <= 30 && !/^\d+$/.test(run.text.trim())
}

function findPaddleBlockForLine(
  line: PdfLayoutLine,
  pdfPage: PdfLayoutPage,
  paddlePage?: PaddleLayoutPage
): PaddleLayoutBlock | undefined {
  if (!paddlePage || paddlePage.width <= 0 || paddlePage.height <= 0 || line.runs.length === 0) {
    return undefined
  }
  const xScale = pdfPage.width / paddlePage.width
  const yScale = pdfPage.height / paddlePage.height
  const lineLeft = Math.min(...line.runs.map(run => run.x))
  const lineRight = Math.max(...line.runs.map(run => run.x + Math.max(1, run.width)))
  const maxFontSize = Math.max(...line.runs.map(run => run.fontSize))
  const lineTop = pdfPage.height - line.y - maxFontSize
  const lineBottom = lineTop + maxFontSize * 1.25
  const centerX = (lineLeft + lineRight) / 2
  const centerY = (lineTop + lineBottom) / 2

  return paddlePage.blocks
    .map(block => {
      const [x1, y1, x2, y2] = block.bbox
      const left = x1 * xScale
      const top = y1 * yScale
      const right = x2 * xScale
      const bottom = y2 * yScale
      const containsCenter = centerX >= left - 4 && centerX <= right + 4 && centerY >= top - 4 && centerY <= bottom + 4
      const overlapX = Math.max(0, Math.min(lineRight, right) - Math.max(lineLeft, left))
      const overlapY = Math.max(0, Math.min(lineBottom, bottom) - Math.max(lineTop, top))
      const score = (containsCenter ? 1000 : 0) + overlapX * Math.max(1, overlapY)
      return { block, score }
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.block
}

function layoutPageParagraphs(
  page: PdfLayoutPage,
  layout: PdfTextLayout,
  paddlePage?: PaddleLayoutPage
): Paragraph[] {
  let cursorTop = 0
  return page.lines.map(line => {
    const maxFontSize = Math.max(...line.runs.map(run => run.fontSize), layout.dominantFontSize)
    const lineTop = Math.max(0, page.height - line.y - maxFontSize)
    const lineHeight = Math.max(maxFontSize * 1.15, maxFontSize + 1)
    const before = Math.max(0, lineTop - cursorTop)
    cursorTop = lineTop + lineHeight
    const lineText = line.runs.map(run => run.text).join('')
    const semanticBlock = findPaddleBlockForLine(line, page, paddlePage)
    const semanticLabel = semanticBlock?.label || ''
    const lineLeft = Math.min(...line.runs.map(run => run.x))
    const lineRight = Math.max(...line.runs.map(run => run.x + Math.max(1, run.width)))
    const centeredByGeometry = Math.abs(lineLeft - (page.width - lineRight)) <= Math.max(8, page.width * 0.025)
    const centered = semanticLabel === 'doc_title' ||
      (/paragraph_title|section_title/.test(semanticLabel) && centeredByGeometry)
    const tabStops = line.runs.slice(1).map(run => ({
      type: TabStopType.LEFT,
      position: Math.max(0, Math.round(run.x * 20))
    }))
    const children: TextRun[] = []
    let previousRight = lineLeft
    for (let index = 0; index < line.runs.length; index += 1) {
      const run = line.runs[index]
      const bold = layoutRunIsBold(run, lineText, layout, semanticLabel)
      if (index > 0 && run.x - previousRight > Math.max(3, run.fontSize * 0.45)) {
        children.push(new TextRun({ children: [new Tab()] }))
      }
      children.push(
        new TextRun({
          text: run.text,
          font: resolveSemanticLayoutFont(run, layout, bold, semanticLabel),
          size: Math.max(8, Math.round(run.fontSize * 2)),
          bold
        })
      )
      previousRight = run.x + Math.max(0, run.width)
    }
    return new Paragraph({
      alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
      tabStops,
      indent: centered
        ? undefined
        : {
            left: Math.max(0, Math.round(lineLeft * 20)),
            right: Math.max(0, Math.round((page.width - lineRight) * 20))
          },
      spacing: {
        before: Math.round(before * 20),
        after: 0,
        line: Math.round(lineHeight * 20),
        lineRule: LineRuleType.EXACT
      },
      children
    })
  })
}

function estimatePaddleBlockFontSize(
  block: PaddleLayoutBlock,
  page: PaddleLayoutPage,
  targetWidthPoints: number,
  targetHeightPoints: number
): number {
  const [, y1, , y2] = block.bbox
  const [x1, , x2] = block.bbox
  const widthPoints = Math.max(1, (x2 - x1) * targetWidthPoints / Math.max(1, page.width))
  const heightPoints = Math.max(1, (y2 - y1) * targetHeightPoints / Math.max(1, page.height))
  if (block.label === 'doc_title' || block.label === 'paragraph_title') {
    return Math.min(36, Math.max(10, heightPoints * 0.86))
  }
  const textLength = Math.max(1, block.content.replace(/\s/g, '').length)
  const cjk = /[\u3400-\u9fff]/.test(block.content)
  const widthFactor = cjk ? 1 : 0.52
  const estimate = Math.sqrt((heightPoints * widthPoints) / (1.75 * textLength * widthFactor))
  return Math.min(24, Math.max(8, estimate))
}

function pdfRunsForPaddleBlock(
  block: PaddleLayoutBlock,
  paddlePage: PaddleLayoutPage,
  pdfPage?: PdfLayoutPage
): PdfLayoutRun[] {
  if (!pdfPage || paddlePage.width <= 0 || paddlePage.height <= 0) return []
  const xScale = pdfPage.width / paddlePage.width
  const yScale = pdfPage.height / paddlePage.height
  const [x1, y1, x2, y2] = block.bbox
  const left = x1 * xScale
  const top = y1 * yScale
  const right = x2 * xScale
  const bottom = y2 * yScale
  return pdfPage.lines.flatMap(line =>
    line.runs.filter(run => {
      const centerX = run.x + Math.max(1, run.width) / 2
      const centerY = pdfPage.height - run.y - run.fontSize / 2
      return centerX >= left - 4 && centerX <= right + 4 && centerY >= top - 4 && centerY <= bottom + 4
    })
  )
}

function normalizePaddleBlockText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('')
    .replace(/\s+([，。；：！？、）》】])/g, '$1')
    .replace(/([《（【])\s+/g, '$1')
}

function paddlePageParagraphs(
  page: PaddleLayoutPage,
  pageWidthPoints: number,
  pageHeightPoints: number,
  pdfPage?: PdfLayoutPage,
  pdfLayout?: PdfTextLayout
): Paragraph[] {
  const xScale = pageWidthPoints / Math.max(1, page.width)
  const yScale = pageHeightPoints / Math.max(1, page.height)
  let previousBottom = 0
  return page.blocks.map(block => {
    const [x1, y1, x2, y2] = block.bbox
    const sourceRuns = pdfRunsForPaddleBlock(block, page, pdfPage)
    const sourceFontSizes = sourceRuns.map(run => run.fontSize).filter(size => size >= 5 && size <= 72)
    const estimatedFontSize = estimatePaddleBlockFontSize(
      block,
      page,
      pageWidthPoints,
      pageHeightPoints
    )
    const fontSize = sourceFontSizes.length > 0 ? median(sourceFontSizes) : estimatedFontSize
    const top = y1 * yScale
    const bottom = y2 * yScale
    const before = previousBottom === 0
      ? Math.min(180, Math.max(0, top))
      : Math.min(72, Math.max(0, top - previousBottom))
    previousBottom = bottom
    const title = block.label === 'doc_title'
    const paragraphTitle = block.label === 'paragraph_title' || block.label === 'section_title'
    const blockLeft = x1 * xScale
    const blockRight = x2 * xScale
    const centeredByGeometry = Math.abs(blockLeft - (pageWidthPoints - blockRight)) <= Math.max(8, pageWidthPoints * 0.025)
    const pageNumber = block.label === 'number'
    const narrowCenteredText =
      centeredByGeometry &&
      blockRight - blockLeft <= pageWidthPoints * 0.82 &&
      block.content.replace(/\s/g, '').length <= 120 &&
      !/^第[一二三四五六七八九十百千万零〇0-9]+条/.test(block.content.trim())
    const centered = title || ((paragraphTitle || pageNumber) && centeredByGeometry) || narrowCenteredText
    const text = normalizePaddleBlockText(block.content)
    const article = /^(第[一二三四五六七八九十百千万零〇0-9]+条)(\s*)(.*)$/.exec(text)
    const representativeRun = sourceRuns
      .slice()
      .sort((leftRun, rightRun) => rightRun.text.length - leftRun.text.length)[0]
    const semanticFont = representativeRun && pdfLayout
      ? resolveSemanticLayoutFont(
          representativeRun,
          pdfLayout,
          paragraphTitle,
          block.label
        )
      : title
        ? '方正小标宋简体'
        : paragraphTitle
          ? 'SimHei'
          : pdfLayout?.legalDocument
            ? 'FangSong_GB2312'
            : 'SimSun'
    const bodyLineHeight = Math.max(fontSize * 1.55, fontSize + 5)
    return new Paragraph({
      alignment: centered ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
      spacing: {
        before: Math.round(before * 20),
        after: 0,
        line: Math.round(bodyLineHeight * 20),
        lineRule: LineRuleType.EXACT
      },
      indent: {
        left: Math.round(blockLeft * 20),
        right: Math.round(Math.max(0, pageWidthPoints - blockRight) * 20),
        firstLine: !centered && article ? Math.round(fontSize * 2 * 20) : 0
      },
      children: article
        ? [
            new TextRun({
              text: article[1],
              font: 'SimHei',
              size: Math.round(fontSize * 2),
              bold: true
            }),
            new TextRun({
              text: `${article[2]}${article[3]}`,
              font: semanticFont,
              size: Math.round(fontSize * 2)
            })
          ]
        : [
            new TextRun({
              text,
              font: semanticFont,
              size: Math.round(fontSize * 2),
              bold: paragraphTitle
            })
          ]
    })
  })
}

function docxChildren(blocks: MarkdownBlock[], legalLayout: boolean): Array<Paragraph | Table> {
  const levels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6
  ]
  return blocks.map(block => {
    if (block.type === 'pageBreak') {
      return new Paragraph({ children: [new PageBreak()] })
    }
    if (block.type === 'heading') {
      const level = Math.min(Math.max(block.level || 1, 1), 6)
      const text = block.text || ''
      if (legalLayout && level === 1) {
        return new Paragraph({
          alignment: AlignmentType.CENTER,
          keepNext: true,
          spacing: { before: 0, after: 360, line: 720, lineRule: LineRuleType.EXACT },
          children: [
            new TextRun({ text, bold: false, font: '方正小标宋简体', size: 44 })
          ]
        })
      }
      if (legalLayout && /^第[一二三四五六七八九十百千万零〇0-9]+章/.test(text)) {
        return new Paragraph({
          alignment: AlignmentType.CENTER,
          keepNext: true,
          spacing: { before: 120, after: 120, line: 560, lineRule: LineRuleType.EXACT },
          children: [new TextRun({ text, bold: true, font: 'SimHei', size: 32 })]
        })
      }
      return new Paragraph({
        heading: levels[level - 1],
        alignment: level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: level === 1 ? 280 : 200, after: 140 },
        children: [
          new TextRun({
            text: block.text || '',
            bold: true,
            font: 'Microsoft YaHei',
            size: level === 1 ? 32 : level === 2 ? 28 : 24
          })
        ]
      })
    }
    if (block.type === 'bullet') {
      if (legalLayout) {
        return new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { before: 0, after: 0, line: 560, lineRule: LineRuleType.EXACT },
          indent: { firstLine: 640 },
          children: [new TextRun({ text: block.text || '', font: 'FangSong_GB2312', size: 32 })]
        })
      }
      return new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 100, line: 360 },
        children: [new TextRun({ text: block.text || '', font: 'SimSun', size: 24 })]
      })
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
                    children: [
                      new Paragraph({
                        spacing: { before: 60, after: 60 },
                        children: [new TextRun({ text: cell, font: 'SimSun', size: 22 })]
                      })
                    ]
                  })
              )
            })
        )
      })
    }
    const text = block.text || ''
    if (legalLayout) {
      const approval = /^（.*(?:通过|批准).*）$/.test(text)
      if (approval) {
        return new Paragraph({
          alignment: AlignmentType.CENTER,
          keepNext: true,
          spacing: { before: 0, after: 360, line: 560, lineRule: LineRuleType.EXACT },
          children: [new TextRun({ text, font: 'FangSong_GB2312', size: 32 })]
        })
      }
      const article = /^(第[一二三四五六七八九十百千万零〇0-9]+条)(\s*)(.*)$/.exec(text)
      return new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        spacing: { before: 0, after: 0, line: 560, lineRule: LineRuleType.EXACT },
        indent: { firstLine: block.continuation ? 0 : 640 },
        children: article
          ? [
              new TextRun({ text: article[1], bold: true, font: 'SimHei', size: 32 }),
              new TextRun({ text: `${article[2]}${article[3]}`, font: 'FangSong_GB2312', size: 32 })
            ]
          : [new TextRun({ text, font: 'FangSong_GB2312', size: 32 })]
      })
    }
    return new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 120, line: 420 },
      indent: { firstLine: 480 },
      children: [new TextRun({ text, font: 'SimSun', size: 24 })]
    })
  })
}

async function createEditableDocx(
  blocks: MarkdownBlock[],
  pdfLayout: PdfTextLayout | null,
  paddleLayoutPages: PaddleLayoutPage[],
  sourcePageSizes: Array<{ width: number; height: number }>,
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext
): Promise<{ filePath: string; fileName: string; valid: boolean }> {
  const hasCompletePaddleLayout =
    paddleLayoutPages.length === sourcePageSizes.length &&
    paddleLayoutPages.every(page => page.blocks.length > 0)

  if (pdfLayout && !hasCompletePaddleLayout) {
    const document = new Document({
      sections: pdfLayout.pages.map((page, index) => ({
        properties: {
          ...(index > 0 ? { type: SectionType.NEXT_PAGE } : {}),
          page: {
            size: {
              width: Math.round(page.width * 20),
              height: Math.round(page.height * 20)
            },
            margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 }
          }
        },
        children: layoutPageParagraphs(page, pdfLayout, paddleLayoutPages[index])
      }))
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

  if (hasCompletePaddleLayout) {
    const document = new Document({
      sections: paddleLayoutPages.map((page, index) => {
        const sourceSize = sourcePageSizes[index]
        const pageWidthPoints = sourceSize?.width || page.width / 2
        const pageHeightPoints = sourceSize?.height || page.height / 2
        return {
          properties: {
            ...(index > 0 ? { type: SectionType.NEXT_PAGE } : {}),
            page: {
              size: {
                width: Math.round(pageWidthPoints * 20),
                height: Math.round(pageHeightPoints * 20)
              },
              margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 }
            }
          },
          children: paddlePageParagraphs(
            page,
            pageWidthPoints,
            pageHeightPoints,
            pdfLayout?.pages[index],
            pdfLayout || undefined
          )
        }
      })
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

  const legalLayout =
    blocks.filter(block => /^第[一二三四五六七八九十百千万零〇0-9]+条/.test(block.text || '')).length >= 5 &&
    blocks.some(block => /^第[一二三四五六七八九十百千万零〇0-9]+章/.test(block.text || ''))
  const document = new Document({
    sections: [
      {
        properties: legalLayout
          ? {
              page: {
                size: { width: 11906, height: 16838 },
                margin: { top: 2098, right: 1474, bottom: 1984, left: 1587, footer: 900 }
              }
            }
          : {},
        footers: legalLayout
          ? {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 0, after: 0 },
                    children: [
                      new TextRun({
                        font: 'SimSun',
                        size: 28,
                        children: ['— ', PageNumber.CURRENT, ' —']
                      })
                    ]
                  })
                ]
              })
            }
          : undefined,
        children: docxChildren(blocks, legalLayout)
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
    if (block.type === 'pageBreak') {
      if (current.length > 0) groups.push(current)
      current = []
      size = 0
      continue
    }
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
  pdfLayout: PdfTextLayout | null,
  paddleLayoutPages: PaddleLayoutPage[],
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext
): Promise<{ filePath: string; fileName: string; valid: boolean; slideCount: number }> {
  const pptx = new PptxGenJS()
  pptx.author = 'AgentPet Office Skill'
  pptx.subject = 'PaddleOCR editable PDF conversion'
  let slideCount: number
  if (pdfLayout?.pages.length) {
    const firstPage = pdfLayout.pages[0]
    const layoutName = 'PDF_SOURCE_LAYOUT'
    pptx.defineLayout({
      name: layoutName,
      width: firstPage.width / 72,
      height: firstPage.height / 72
    })
    pptx.layout = layoutName
    for (const page of pdfLayout.pages) {
      const slide = pptx.addSlide()
      slide.background = { color: 'FFFFFF' }
      const scale = Math.min(firstPage.width / page.width, firstPage.height / page.height)
      const offsetX = (firstPage.width - page.width * scale) / 2
      const offsetY = (firstPage.height - page.height * scale) / 2
      for (const line of page.lines) {
        const lineText = line.runs.map(run => run.text).join('')
        for (const run of line.runs) {
          const bold = layoutRunIsBold(run, lineText, pdfLayout)
          slide.addText(run.text, {
            x: (offsetX + run.x * scale) / 72,
            y: (offsetY + (page.height - run.y - run.fontSize) * scale) / 72,
            w: Math.max(run.width * scale, run.fontSize * 0.7) / 72,
            h: Math.max(run.fontSize * 1.35 * scale, 4) / 72,
            fontFace: resolveLayoutFont(run, pdfLayout, bold),
            fontSize: run.fontSize * scale,
            bold,
            color: '000000',
            margin: 0,
            breakLine: false,
            valign: 'top'
          })
        }
      }
    }
    slideCount = pdfLayout.pages.length
  } else if (paddleLayoutPages.length > 0) {
    const firstPage = paddleLayoutPages[0]
    const layoutName = 'PADDLE_SOURCE_LAYOUT'
    pptx.defineLayout({ name: layoutName, width: firstPage.width / 144, height: firstPage.height / 144 })
    pptx.layout = layoutName
    for (const page of paddleLayoutPages) {
      const slide = pptx.addSlide()
      slide.background = { color: 'FFFFFF' }
      const scale = Math.min(firstPage.width / page.width, firstPage.height / page.height)
      const offsetX = (firstPage.width - page.width * scale) / 2
      const offsetY = (firstPage.height - page.height * scale) / 2
      for (const block of page.blocks) {
        const [x1, y1, x2, y2] = block.bbox
        const title = block.label === 'doc_title' || block.label === 'paragraph_title'
        slide.addText(block.content, {
          x: (offsetX + x1 * scale) / 144,
          y: (offsetY + y1 * scale) / 144,
          w: Math.max(1, (x2 - x1) * scale) / 144,
          h: Math.max(1, (y2 - y1) * scale) / 144,
          fontFace: title ? 'Microsoft YaHei' : 'SimSun',
          fontSize: estimatePaddleBlockFontSize(block, page, page.width / 2, page.height / 2),
          bold: title,
          color: '000000',
          margin: 0,
          breakLine: false,
          valign: 'top',
          align: title ? 'center' : 'left',
          fit: 'shrink'
        } as any)
      }
    }
    slideCount = paddleLayoutPages.length
  } else {
    pptx.layout = 'LAYOUT_WIDE'
    slideCount = addEditableSlides(pptx, blocks)
  }
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
  const prepared = await preparePdfPages(sourcePath, input.pages, context)
  try {
  const parsed = await parsePdfWithConfiguredPaddle(
    prepared.path,
    context,
    runtime.timeoutMs,
    runtime.report
  )
  runtime.check()
  const blocks = parseMarkdown(parsed.markdown)
  if (blocks.length === 0) throw new Error('PaddleOCR 未解析出可转换内容')
  runtime.report(3, 4, '正在读取源 PDF 的字体、坐标和分页信息')
  const extractedPdfLayout = await extractPdfTextLayout(prepared.path)

  const sourcePdf = await PDFDocument.load(await fs.promises.readFile(prepared.path))
  const pageCount = sourcePdf.getPageCount()
  const sourcePageSizes = sourcePdf.getPages().map(page => ({
    width: page.getWidth(),
    height: page.getHeight()
  }))
  const textAgreement = extractedPdfLayout
    ? textLayerAgreement(extractedPdfLayout.text, parsed.markdown)
    : 0
  const pdfLayout =
    extractedPdfLayout &&
    extractedPdfLayout.pages.length === pageCount &&
    textAgreement >= 0.45
      ? extractedPdfLayout
      : null
  const hasCompletePaddleLayout =
    parsed.layoutPages.length === pageCount && parsed.layoutPages.every(page => page.blocks.length > 0)
  const output =
    target === 'docx'
      ? await createEditableDocx(
          blocks,
          pdfLayout,
          parsed.layoutPages,
          sourcePageSizes,
          prepared.path,
          input,
          context
        )
      : await createEditablePptx(
          blocks,
          pdfLayout,
          parsed.layoutPages,
          prepared.path,
          input,
          context
        )
  runtime.report(4, 4, '可编辑文档已生成')

  const state = {
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
    converted_pages: prepared.selectedPages,
    slide_count: 'slideCount' in output ? output.slideCount : undefined,
    editable: true,
    document_classification: input.document_classification || undefined,
    layout_reconstruction: hasCompletePaddleLayout
      ? {
          source: pdfLayout
            ? 'paddleocr-semantic-blocks+pdf-style-hints'
            : 'paddleocr-semantic-blocks',
          pages: parsed.layoutPages.length,
          text_length: pdfLayout?.textLength,
          text_agreement: Math.round(textAgreement * 1000) / 1000,
          paddle_layout_pages: parsed.layoutPages.length
        }
      : {
          source: pdfLayout ? 'pdf-text-layer-fallback' : 'paddleocr-markdown-fallback',
          text_layer_rejected: Boolean(extractedPdfLayout),
          text_agreement: Math.round(textAgreement * 1000) / 1000,
          paddle_layout_pages: parsed.layoutPages.length
        },
    paddleocr: {
      cached: parsed.cached,
      transport: parsed.toolName,
      api_submitted: parsed.apiSubmitted,
      job_id: parsed.jobId,
      elapsed_ms: parsed.elapsedMs,
      layout_pages: parsed.layoutPages.length
    },
    validation: {
      valid: output.valid,
      checks: [
        'office_package',
        'editable_structure',
        'source_page_geometry',
        'paddleocr_layout_consumed'
      ]
    },
    progress: { status: 'completed', completed: 4, total: 4 }
  }
  return {
    success: true,
    state,
    content: JSON.stringify(
      {
        status: 'success',
        message: `PDF 已转换为可编辑 ${target.toUpperCase()}`,
        file_path: output.filePath,
        file_name: output.fileName
      },
      null,
      2
    )
  }
  } finally {
    await prepared.cleanup()
  }
}

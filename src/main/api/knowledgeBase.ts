import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import * as fs from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import * as Papa from 'papaparse'
import JSZip from 'jszip'
import {
  cosineSimilarity,
  embedTexts,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embeddingContentHash
} from '../embedding/embedding-client'
import { ModelRuntimeFactory } from '../model-runtime'
import {
  createKnowledgeRetrievalPlan,
  definitionStructureScore,
  extractDefinitionEntity,
  type KnowledgeRetrievalPlan
} from './knowledge-retrieval'

import {
  parseLegalPdf,
  type CanonicalKnowledgeNode,
  type KnowledgeNodeType
} from '../document-parsing/legal-pdf-parser'
import {
  createDocumentMediaStore,
  decodeDataImage,
  extractOoxmlMedia,
  type DocumentMediaAsset,
  type DocumentMediaStore
} from '../document-parsing/document-media'

interface KnowledgeBaseDependencies {
  getDB: () => Promise<any>
  getSystemLlmConfig?: () => any
}

type KnowledgeImportStage = 'queued' | 'parsing' | 'structuring' | 'saving' | 'embedding' | 'completed' | 'failed'

interface KnowledgeImportFileProgress {
  name: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: KnowledgeImportStage
  processedNodes: number
  totalNodes: number
  documentId?: string
  error?: string
}

interface KnowledgeImportBatchProgress {
  batchId: string
  knowledgeBaseId: string
  status: 'running' | 'completed'
  total: number
  completed: number
  failed: number
  currentIndex: number
  startedAt: number
  updatedAt: number
  files: KnowledgeImportFileProgress[]
}

const latestKnowledgeImportByBase = new Map<string, KnowledgeImportBatchProgress>()

function knowledgeImportSnapshot(batch: KnowledgeImportBatchProgress): KnowledgeImportBatchProgress {
  return { ...batch, files: batch.files.map(file => ({ ...file })) }
}

function publishKnowledgeImportProgress(event: { sender: WebContents }, batch: KnowledgeImportBatchProgress): void {
  batch.updatedAt = Date.now()
  latestKnowledgeImportByBase.set(batch.knowledgeBaseId, batch)
  event.sender.send('api:knowledge-import-progress', knowledgeImportSnapshot(batch))
}

type NodeType = KnowledgeNodeType

interface ParsedBlock {
  type: Exclude<NodeType, 'document' | 'section'> | 'heading'
  text: string
  title?: string
  level?: number
  page?: number
  sourceMeta?: Record<string, unknown>
}

interface KnowledgeNodeDraft {
  id: string
  parentId: string | null
  type: NodeType
  level: number
  title: string
  headingPath: string[]
  content: string
  orderIndex: number
  pageStart: number | null
  pageEnd: number | null
  tokenCount: number
  confidence: number
  sourceMeta: Record<string, unknown>
}

const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'json', 'html', 'htm', 'xml', 'yaml', 'yml']
const MAX_CHUNK_CHARS = 1600
const CHUNK_OVERLAP_CHARS = 160

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function estimateTokens(text: string): number {
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length
  const other = Math.max(0, text.length - chinese)
  return Math.max(1, Math.ceil(chinese / 1.6 + other / 4))
}

function splitLongText(text: string): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim()
  if (!clean) return []
  if (clean.length <= MAX_CHUNK_CHARS) return [clean]

  const sentences = clean.split(/(?<=[。！？.!?；;])\s*|\n+/).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_CHUNK_CHARS) {
      chunks.push(current.trim())
      current = `${current.slice(-CHUNK_OVERLAP_CHARS)}${sentence}`
    } else {
      current += sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

function looksLikeHeading(line: string): { title: string; level: number } | null {
  const markdown = /^(#{1,6})\s+(.+)$/.exec(line)
  if (markdown) return { title: markdown[2].trim(), level: markdown[1].length }

  const numbered = /^(第[一二三四五六七八九十百\d]+[章节篇部]|\d+(?:\.\d+){0,3})[\s、.．:-]+(.+)$/.exec(line)
  if (numbered) {
    const prefix = numbered[1]
    const level = prefix.startsWith('第') ? 1 : Math.min(4, (prefix.match(/\./g) || []).length + 1)
    return { title: line.trim(), level }
  }

  if (line.length <= 32 && !/[。！？.!?；;]$/.test(line) && /[\u3400-\u9fffA-Za-z]/.test(line)) {
    return { title: line.trim(), level: 2 }
  }
  return null
}

function parsePlainText(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  const paragraphs = text.replace(/\r/g, '').split(/\n\s*\n+/)
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n').map(line => line.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const heading = lines.length === 1 ? looksLikeHeading(lines[0]) : null
    if (heading) {
      blocks.push({ type: 'heading', text: heading.title, level: heading.level })
      continue
    }
    const isList = lines.every(line => /^[-*+•]\s+|^\d+[.)、]\s*/.test(line))
    blocks.push({ type: isList ? 'list' : 'paragraph', text: lines.join(isList ? '\n' : ' ') })
  }
  return blocks
}

function figureBlock(asset: DocumentMediaAsset, title = ''): ParsedBlock {
  return {
    type: 'figure',
    text: title,
    title: title || basename(asset.imagePath),
    sourceMeta: { ...asset }
  }
}

function parseHtmlBlocks(html: string, imageAssets = new Map<string, DocumentMediaAsset>()): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  const regex = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi
  const seenImages = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = regex.exec(html))) {
    const tag = match[1].toLowerCase()
    const innerHtml = match[2]
    const images = [...innerHtml.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    const text = decodeHtml(innerHtml.replace(/<img\b[^>]*>/gi, ' '))
    if (text && tag.startsWith('h')) {
      blocks.push({ type: 'heading', text, level: Number(tag.slice(1)) })
    } else if (text && tag === 'table') {
      blocks.push({ type: 'table', text })
    } else if (text) {
      blocks.push({ type: tag === 'li' ? 'list' : 'paragraph', text })
    }
    for (const image of images) {
      const source = image[1]
      const asset = imageAssets.get(source)
      if (asset) {
        blocks.push(figureBlock(asset))
        seenImages.add(source)
      }
    }
  }
  for (const [source, asset] of imageAssets) {
    if (!seenImages.has(source)) blocks.push(figureBlock(asset))
  }
  return blocks.length > 0 ? blocks : parsePlainText(decodeHtml(html))
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function saveReferencedImage(
  source: string,
  filePath: string,
  store: DocumentMediaStore,
  index: number
): Promise<DocumentMediaAsset | null> {
  const dataImage = decodeDataImage(source)
  if (dataImage) return store.save(dataImage.bytes, `inline-${index}.${dataImage.extension}`, `data-uri:${index}`)
  if (/^(?:https?:)?\/\//i.test(source)) return null
  const candidate = resolve(dirname(filePath), decodeURIComponent(source.replace(/^file:\/\//i, '')))
  try {
    const stat = await fs.promises.stat(candidate)
    if (!stat.isFile()) return null
    return store.save(await fs.promises.readFile(candidate), basename(candidate), candidate)
  } catch {
    return null
  }
}

async function parseHtmlWithMedia(filePath: string, html: string): Promise<{ blocks: ParsedBlock[]; assetDir?: string; imageCount: number }> {
  const sources = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1])
  if (sources.length === 0) return { blocks: parseHtmlBlocks(html), imageCount: 0 }
  const store = await createDocumentMediaStore(filePath)
  const imageAssets = new Map<string, DocumentMediaAsset>()
  for (let index = 0; index < sources.length; index++) {
    if (imageAssets.has(sources[index])) continue
    const asset = await saveReferencedImage(sources[index], filePath, store, index + 1)
    if (asset) imageAssets.set(sources[index], asset)
  }
  return { blocks: parseHtmlBlocks(html, imageAssets), assetDir: store.assetDir, imageCount: imageAssets.size }
}

async function parseMarkdownWithMedia(filePath: string, markdown: string): Promise<{ blocks: ParsedBlock[]; assetDir?: string; imageCount: number }> {
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  const matches = [...markdown.matchAll(imagePattern)]
  if (matches.length === 0) return { blocks: parsePlainText(markdown), imageCount: 0 }
  const store = await createDocumentMediaStore(filePath)
  const blocks: ParsedBlock[] = []
  let cursor = 0
  let imageCount = 0
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]
    blocks.push(...parsePlainText(markdown.slice(cursor, match.index)))
    const asset = await saveReferencedImage(match[2], filePath, store, index + 1)
    if (asset) {
      blocks.push(figureBlock(asset, match[1].trim()))
      imageCount++
    } else {
      blocks.push({ type: 'caption', text: match[1].trim() || `未能保存的图片引用：${match[2]}` })
    }
    cursor = (match.index || 0) + match[0].length
  }
  blocks.push(...parsePlainText(markdown.slice(cursor)))
  return { blocks, assetDir: store.assetDir, imageCount }
}

interface ParsedFile {
  blocks: ParsedBlock[]
  nodes?: CanonicalKnowledgeNode[]
  parser: string
  warning: string
  characterCount: number
  qualityScore: number
  profile: Record<string, unknown>
}

export async function parseKnowledgeFile(filePath: string, event?: { sender: WebContents }): Promise<ParsedFile> {
  const ext = extname(filePath).slice(1).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new Error(`暂不支持 .${ext || 'unknown'} 文件`)

  if (ext === 'pdf') {
    try {
      const structured = await parseLegalPdf(filePath, basename(filePath), { event })
      return { ...structured, blocks: [] }
    } catch (structuredError) {
      const buffer = await fs.promises.readFile(filePath)
      const parser = new PDFParse({ data: buffer })
      const result = await parser.getText()
      await parser.destroy()
      const text = result.text || ''
      const warning = text.trim().length < 80
        ? '本地未提取到足够文字，可能是扫描件；建议启用 Docling 或 MinerU。'
        : `已降级为轻量文本解析：${structuredError instanceof Error ? structuredError.message : String(structuredError)}`
      return {
        blocks: parsePlainText(text), parser: 'local-pdf-text-fallback', warning,
        characterCount: text.length, qualityScore: text.length >= 80 ? 0.45 : 0.15,
        profile: { kind: text.length >= 80 ? 'digital-pdf' : 'scanned-or-empty', fallback: true }
      }
    }
  }

  if (ext === 'docx') {
    const buffer = await fs.promises.readFile(filePath)
    const store = await createDocumentMediaStore(filePath)
    const imageAssets = new Map<string, DocumentMediaAsset>()
    let imageIndex = 0
    const result = await mammoth.convertToHtml({ buffer }, {
      convertImage: mammoth.images.imgElement(async image => {
        imageIndex++
        const contentType = image.contentType || 'image/png'
        const extension = contentType.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'
        const source = `kb-docx-image:${imageIndex}`
        const bytes = Buffer.from(await image.read('base64'), 'base64')
        imageAssets.set(source, await store.save(bytes, `docx-image-${imageIndex}.${extension}`, source))
        return { src: source }
      })
    })
    const blocks = parseHtmlBlocks(result.value || '', imageAssets)
    return {
      blocks,
      parser: 'local-docx-structure',
      warning: result.messages.length > 0 ? '部分 Word 样式未完全转换，已保留可识别的标题与段落结构。' : '',
      characterCount: blocks.reduce((sum, block) => sum + block.text.length, 0),
      qualityScore: blocks.length > 0 ? 0.72 : 0.2,
      profile: { kind: 'office-document', format: 'docx', imageCount: imageAssets.size, imageAssetDir: store.assetDir }
    }
  }

  if (ext === 'pptx') {
    const store = await createDocumentMediaStore(filePath)
    const archive = await JSZip.loadAsync(await fs.promises.readFile(filePath))
    const media = await extractOoxmlMedia(filePath, store, 'ppt/media/')
    const slideEntries = Object.values(archive.files)
      .filter(entry => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const blocks: ParsedBlock[] = []
    const referencedMedia = new Set<string>()
    for (let slideIndex = 0; slideIndex < slideEntries.length; slideIndex++) {
      const slideEntry = slideEntries[slideIndex]
      const slideNumber = slideIndex + 1
      blocks.push({ type: 'heading', text: `第 ${slideNumber} 页`, level: 1, page: slideNumber })
      const slideXml = await slideEntry.async('text')
      const texts = [...slideXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
        .map(match => decodeXmlText(match[1]).trim())
        .filter(Boolean)
      if (texts.length > 0) blocks.push({ type: 'paragraph', text: texts.join('\n'), page: slideNumber })

      const relsName = `ppt/slides/_rels/${basename(slideEntry.name)}.rels`
      const relsEntry = archive.file(relsName)
      if (relsEntry) {
        const relsXml = await relsEntry.async('text')
        const targets = [...relsXml.matchAll(/Target=["']\.\.\/media\/([^"']+)["']/gi)]
        for (const target of targets) {
          const mediaPath = `ppt/media/${target[1]}`
          const asset = media.get(mediaPath)
          if (!asset) continue
          referencedMedia.add(mediaPath)
          blocks.push({ ...figureBlock(asset, `第 ${slideNumber} 页图片`), page: slideNumber })
        }
      }
    }
    const unreferenced = [...media.entries()].filter(([path]) => !referencedMedia.has(path))
    if (unreferenced.length > 0) {
      blocks.push({ type: 'heading', text: '演示文稿媒体资源', level: 1 })
      for (const [, asset] of unreferenced) blocks.push(figureBlock(asset))
    }
    return {
      blocks,
      parser: 'local-pptx-structure+media',
      warning: '',
      characterCount: blocks.reduce((sum, block) => sum + block.text.length, 0),
      qualityScore: blocks.length > 0 ? 0.78 : 0.2,
      profile: { kind: 'presentation', format: 'pptx', slideCount: slideEntries.length, imageCount: media.size, imageAssetDir: store.assetDir }
    }
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.readFile(filePath)
    const blocks: ParsedBlock[] = []
    for (const sheetName of workbook.SheetNames) {
      blocks.push({ type: 'heading', text: `工作表：${sheetName}`, level: 1 })
      const sheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' })
      if (rows.length > 0) {
        const headers = rows[0].map(value => String(value || '').trim())
        blocks.push({ type: 'table', text: `列：${headers.filter(Boolean).join('｜')}` })
        rows.slice(1).forEach((row, index) => {
          const text = row.map((value, column) => `${headers[column] || `列${column + 1}`}=${String(value ?? '').trim()}`).join('；')
          if (text.replace(/[；=\s]/g, '')) blocks.push({ type: 'table_row', text: `第 ${index + 1} 行：${text}` })
        })
      }
    }
    let imageCount = 0
    let imageAssetDir: string | undefined
    if (ext === 'xlsx') {
      const store = await createDocumentMediaStore(filePath)
      const media = await extractOoxmlMedia(filePath, store, 'xl/media/')
      imageCount = media.size
      imageAssetDir = store.assetDir
      if (media.size > 0) {
        blocks.push({ type: 'heading', text: '工作簿图片', level: 1 })
        for (const asset of media.values()) blocks.push(figureBlock(asset))
      }
    }
    const warning = ext === 'xls'
      ? '旧版 XLS 的内嵌图片无法稳定提取；如需保留图片，请先另存为 XLSX。'
      : ''
    return { blocks, parser: imageCount > 0 ? 'local-workbook-structure+media' : 'local-workbook-structure', warning, characterCount: blocks.reduce((sum, block) => sum + block.text.length, 0), qualityScore: 0.82, profile: { kind: 'workbook', format: ext, imageCount, imageAssetDir } }
  }

  if (ext === 'csv') {
    const text = await fs.promises.readFile(filePath, 'utf-8')
    const parsed = Papa.parse<any[]>(text, { header: false, skipEmptyLines: true })
    const rows = parsed.data || []
    const headers = (rows[0] || []).map(value => String(value || '').trim())
    const blocks: ParsedBlock[] = [{ type: 'heading', text: 'CSV 数据', level: 1 }]
    if (headers.length > 0) blocks.push({ type: 'table', text: `列：${headers.join('｜')}` })
    rows.slice(1).forEach((row, index) => {
      blocks.push({
        type: 'table_row',
        text: `第 ${index + 1} 行：${row.map((value, column) => `${headers[column] || `列${column + 1}`}=${String(value ?? '').trim()}`).join('；')}`
      })
    })
    return { blocks, parser: 'local-csv-structure', warning: '', characterCount: text.length, qualityScore: 0.9, profile: { kind: 'table', format: 'csv' } }
  }

  const text = await fs.promises.readFile(filePath, 'utf-8')
  const mediaResult = ext === 'html' || ext === 'htm'
    ? await parseHtmlWithMedia(filePath, text)
    : ext === 'md'
      ? await parseMarkdownWithMedia(filePath, text)
      : { blocks: parsePlainText(text), imageCount: 0, assetDir: undefined }
  return {
    blocks: mediaResult.blocks,
    parser: `local-${ext || 'text'}-structure${mediaResult.imageCount > 0 ? '+media' : ''}`,
    warning: '',
    characterCount: text.length,
    qualityScore: mediaResult.blocks.length > 0 ? 0.8 : 0.2,
    profile: { kind: 'text', format: ext || 'text', imageCount: mediaResult.imageCount, imageAssetDir: mediaResult.assetDir }
  }
}

export function buildKnowledgeNodes(title: string, blocks: ParsedBlock[]): KnowledgeNodeDraft[] {
  const rootId = randomUUID()
  const nodes: KnowledgeNodeDraft[] = [{
    id: rootId,
    parentId: null,
    type: 'document',
    level: 0,
    title,
    headingPath: [title],
    content: title,
    orderIndex: 0,
    pageStart: null,
    pageEnd: null,
    tokenCount: estimateTokens(title),
    confidence: 0.95,
    sourceMeta: {}
  }]
  const sectionStack: Array<{ id: string; level: number; title: string }> = []
  let orderIndex = 1

  for (const block of blocks) {
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, block.level || 2))
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) sectionStack.pop()
      const id = randomUUID()
      const parentId = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1].id : rootId
      const headingPath = [title, ...sectionStack.map(item => item.title), block.text]
      nodes.push({
        id,
        parentId,
        type: 'section',
        level,
        title: block.text,
        headingPath,
        content: block.text,
        orderIndex: orderIndex++,
        pageStart: block.page || null,
        pageEnd: block.page || null,
        tokenCount: estimateTokens(block.text),
        confidence: 0.82,
        sourceMeta: {}
      })
      sectionStack.push({ id, level, title: block.text })
      continue
    }

    const parentId = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1].id : rootId
    const headingPath = [title, ...sectionStack.map(item => item.title)]
    if (block.type === 'figure') {
      const figureTitle = block.title || '文档图片'
      nodes.push({
        id: randomUUID(),
        parentId,
        type: 'figure',
        level: sectionStack.length + 1,
        title: figureTitle,
        headingPath: [...headingPath, figureTitle],
        content: block.text,
        orderIndex: orderIndex++,
        pageStart: block.page || null,
        pageEnd: block.page || null,
        tokenCount: estimateTokens(block.text || figureTitle),
        confidence: block.title ? 0.84 : 0.7,
        sourceMeta: block.sourceMeta || {}
      })
      continue
    }
    for (const content of splitLongText(block.text)) {
      nodes.push({
        id: randomUUID(),
        parentId,
        type: block.type,
        level: sectionStack.length + 1,
        title: '',
        headingPath,
        content,
        orderIndex: orderIndex++,
        pageStart: block.page || null,
        pageEnd: block.page || null,
        tokenCount: estimateTokens(content),
        confidence: 0.78,
        sourceMeta: block.sourceMeta || {}
      })
    }
  }
  return nodes
}

function extractTerms(query: string): string[] {
  const normalized = query.toLowerCase().trim()
  const terms = new Set((normalized.match(/[a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) || []).flatMap(value => {
    if (/^[\u3400-\u9fff]+$/.test(value) && value.length > 4) {
      return [value, ...Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2))]
    }
    return [value]
  }))
  return [...terms].slice(0, 24)
}

const SEARCHABLE_NODE_TYPES = new Set(['clause', 'item', 'paragraph', 'list', 'table', 'table_row', 'figure', 'caption'])

function parseHeadingPath(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function knowledgeEmbeddingText(row: any): string {
  const path = parseHeadingPath(row.heading_path).slice(1).join(' / ')
  return [
    `节点类型：${String(row.node_type || '')}`,
    path ? `章节路径：${path}` : '',
    row.title ? `标题：${String(row.title)}` : '',
    `正文：${String(row.content || '')}`
  ].filter(Boolean).join('\n').slice(0, 24_000)
}

function parseStoredVector(value: unknown): number[] | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed) || parsed.length !== EMBEDDING_DIMENSIONS) return null
    const vector = parsed.map(Number)
    return vector.every(Number.isFinite) ? vector : null
  } catch {
    return null
  }
}

async function ensureKnowledgeEmbeddings(
  database: any,
  rows: any[],
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  const pending = rows.filter(row => {
    if (row.node_type === 'figure' && !String(row.title || row.content || '').trim()) return false
    const text = knowledgeEmbeddingText(row)
    return !parseStoredVector(row.embedding_vector)
      || row.embedding_model !== EMBEDDING_MODEL
      || row.embedding_hash !== embeddingContentHash(text)
  })
  onProgress?.(0, pending.length)
  for (let offset = 0; offset < pending.length; offset += 16) {
    const batch = pending.slice(offset, offset + 16)
    const texts = batch.map(knowledgeEmbeddingText)
    const vectors = await embedTexts(texts)
    for (let index = 0; index < batch.length; index++) {
      const vector = vectors[index]
      if (!vector) continue
      const row = batch[index]
      const hash = embeddingContentHash(texts[index])
      await database.run(`
        INSERT INTO knowledge_embeddings (node_id, model, dimensions, vector, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          model = excluded.model,
          dimensions = excluded.dimensions,
          vector = excluded.vector,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `, row.id, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, JSON.stringify(vector), hash, Date.now())
      row.embedding_vector = JSON.stringify(vector)
      row.embedding_model = EMBEDDING_MODEL
      row.embedding_hash = hash
    }
    onProgress?.(Math.min(offset + batch.length, pending.length), pending.length)
  }
}

async function indexKnowledgeDocument(
  database: any,
  documentId: string,
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  const rows = await database.all(`
    SELECT n.*, e.vector AS embedding_vector, e.model AS embedding_model, e.content_hash AS embedding_hash
    FROM knowledge_nodes n
    LEFT JOIN knowledge_embeddings e ON e.node_id = n.id
    WHERE n.document_id = ?
  `, documentId)
  const searchable = rows.filter((row: any) => SEARCHABLE_NODE_TYPES.has(row.node_type)
    || (row.node_type === 'article' && !rows.some((child: any) => child.parent_id === row.id && ['clause', 'item'].includes(child.node_type))))
  try {
    for (const row of searchable) {
      await database.run('DELETE FROM knowledge_nodes_fts WHERE node_id = ?', row.id)
      await database.run(
        'INSERT INTO knowledge_nodes_fts (node_id, title, content, heading_path) VALUES (?, ?, ?, ?)',
        row.id, row.title || '', row.content || '', parseHeadingPath(row.heading_path).slice(1).join(' / ')
      )
    }
  } catch {
    // Some SQLite builds omit FTS5. The in-process BM25 path below remains active.
  }
  await ensureKnowledgeEmbeddings(database, searchable, onProgress)
}

function countOccurrences(text: string, term: string): number {
  let count = 0
  let offset = 0
  while (term && (offset = text.indexOf(term, offset)) >= 0) {
    count += 1
    offset += term.length
  }
  return count
}

async function callKnowledgePlanner(deps: KnowledgeBaseDependencies, prompt: string): Promise<string> {
  const config = deps.getSystemLlmConfig?.()
  if (!config?.model) throw new Error('KNOWLEDGE_PLANNER_MODEL_UNAVAILABLE')
  if (config.provider !== 'ollama' && !config.apiKey) throw new Error('KNOWLEDGE_PLANNER_CREDENTIAL_UNAVAILABLE')
  const provider = ModelRuntimeFactory.getProvider(config.provider, config.apiKey || '', config.baseUrl || '')
  const response = await provider.chat([
    { role: 'system', content: '你只负责生成法规知识库检索计划，必须严格输出 JSON。' },
    { role: 'user', content: prompt }
  ], {
    model: config.model,
    temperature: 0,
    maxTokens: 700
  })
  if (typeof response.content === 'string') return response.content
  if (Array.isArray(response.content)) {
    return response.content.map((item: any) => item?.text || item?.content || '').join('')
  }
  return String(response.content || '')
}

export function registerKnowledgeBaseAPIs(deps: KnowledgeBaseDependencies): void {
  ipcMain.handle('api:knowledge-list-bases', async () => {
    const database = await deps.getDB()
    return database.all(`
      SELECT kb.id, kb.name, kb.description, kb.created_at AS createdAt, kb.updated_at AS updatedAt,
             COUNT(DISTINCT d.id) AS documentCount, COUNT(n.id) AS nodeCount
      FROM knowledge_bases kb
      LEFT JOIN knowledge_documents d ON d.knowledge_base_id = kb.id
      LEFT JOIN knowledge_nodes n ON n.document_id = d.id
      GROUP BY kb.id
      ORDER BY kb.updated_at DESC
    `)
  })

  ipcMain.handle('api:knowledge-create-base', async (_, name: string, description = '') => {
    const database = await deps.getDB()
    const id = randomUUID()
    const now = Date.now()
    await database.run(
      'INSERT INTO knowledge_bases (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      (name || '未命名知识库').trim(),
      description.trim(),
      now,
      now
    )
    return id
  })

  ipcMain.handle('api:knowledge-delete-base', async (_, id: string) => {
    const database = await deps.getDB()
    await database.run('DELETE FROM knowledge_bases WHERE id = ?', id)
    return true
  })

  ipcMain.handle('api:knowledge-list-documents', async (_, knowledgeBaseId: string) => {
    const database = await deps.getDB()
    return database.all(`
      SELECT id, knowledge_base_id AS knowledgeBaseId, name, source_path AS sourcePath,
             file_type AS fileType, file_size AS fileSize, parser, parse_status AS parseStatus,
             warning, quality_score AS qualityScore, profile_json AS profileJson,
             character_count AS characterCount, node_count AS nodeCount,
             created_at AS createdAt, updated_at AS updatedAt
      FROM knowledge_documents
      WHERE knowledge_base_id = ?
      ORDER BY updated_at DESC
    `, knowledgeBaseId)
  })

  ipcMain.handle('api:knowledge-get-import-progress', (_, knowledgeBaseId: string) => {
    const batch = latestKnowledgeImportByBase.get(knowledgeBaseId)
    return batch ? knowledgeImportSnapshot(batch) : null
  })

  ipcMain.handle('api:knowledge-import-documents', async (event, knowledgeBaseId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return []
    const selection = await dialog.showOpenDialog(window, {
      title: '导入知识库文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '知识库文档', extensions: SUPPORTED_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (selection.canceled) return []

    const batch: KnowledgeImportBatchProgress = {
      batchId: randomUUID(),
      knowledgeBaseId,
      status: 'running',
      total: selection.filePaths.length,
      completed: 0,
      failed: 0,
      currentIndex: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      files: selection.filePaths.map(filePath => ({
        name: basename(filePath),
        status: 'queued',
        stage: 'queued',
        processedNodes: 0,
        totalNodes: 0
      }))
    }
    publishKnowledgeImportProgress(event, batch)

    const database = await deps.getDB()
    const imported: Array<{ id?: string; name: string; success: boolean; error?: string }> = []
    for (let fileIndex = 0; fileIndex < selection.filePaths.length; fileIndex++) {
      const filePath = selection.filePaths[fileIndex]
      const name = basename(filePath)
      const fileProgress = batch.files[fileIndex]
      batch.currentIndex = fileIndex
      fileProgress.status = 'running'
      fileProgress.stage = 'parsing'
      publishKnowledgeImportProgress(event, batch)
      try {
        const stat = await fs.promises.stat(filePath)
        const parsed = await parseKnowledgeFile(filePath, event)
        const documentId = randomUUID()
        const nodes = parsed.nodes || buildKnowledgeNodes(name, parsed.blocks)
        fileProgress.documentId = documentId
        fileProgress.stage = 'structuring'
        fileProgress.totalNodes = nodes.length
        publishKnowledgeImportProgress(event, batch)
        const now = Date.now()
        const parseStatus = nodes.length <= 1 || parsed.characterCount < 80 || parsed.qualityScore < 0.6
          ? 'needs_review'
          : 'ready'

        await database.exec('BEGIN TRANSACTION')
        try {
          await database.run(`
            INSERT INTO knowledge_documents (
              id, knowledge_base_id, name, source_path, file_type, file_size, parser,
              parse_status, warning, quality_score, profile_json, character_count, node_count,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, documentId, knowledgeBaseId, name, filePath, extname(filePath).slice(1).toLowerCase(), stat.size,
          parsed.parser, parseStatus, parsed.warning, parsed.qualityScore, JSON.stringify(parsed.profile),
          parsed.characterCount, nodes.length, now, now)

          fileProgress.stage = 'saving'
          publishKnowledgeImportProgress(event, batch)
          for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
            const node = nodes[nodeIndex]
            await database.run(`
              INSERT INTO knowledge_nodes (
                id, document_id, parent_id, node_type, level, title, heading_path,
                content, order_index, page_start, page_end, token_count, confidence,
                source_meta, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, node.id, documentId, node.parentId, node.type, node.level, node.title,
            JSON.stringify(node.headingPath), node.content, node.orderIndex, node.pageStart,
            node.pageEnd, node.tokenCount, node.confidence, JSON.stringify(node.sourceMeta), now)
            if (nodeIndex === nodes.length - 1 || nodeIndex % 20 === 19) {
              fileProgress.processedNodes = nodeIndex + 1
              publishKnowledgeImportProgress(event, batch)
            }
          }
          await database.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', now, knowledgeBaseId)
          await database.exec('COMMIT')
        } catch (error) {
          await database.exec('ROLLBACK')
          throw error
        }
        try {
          fileProgress.stage = 'embedding'
          fileProgress.processedNodes = 0
          publishKnowledgeImportProgress(event, batch)
          await indexKnowledgeDocument(database, documentId, (processed, total) => {
            fileProgress.processedNodes = processed
            fileProgress.totalNodes = total || nodes.length
            publishKnowledgeImportProgress(event, batch)
          })
        } catch (error) {
          console.warn(`[KnowledgeBase] Vector indexing failed for ${name}; lexical search remains available.`, error)
        }
        imported.push({ id: documentId, name, success: true })
        fileProgress.status = 'completed'
        fileProgress.stage = 'completed'
        fileProgress.processedNodes = fileProgress.totalNodes
        batch.completed += 1
      } catch (error: any) {
        const message = error.message || String(error)
        imported.push({ name, success: false, error: message })
        fileProgress.status = 'failed'
        fileProgress.stage = 'failed'
        fileProgress.error = message
        batch.failed += 1
      }
      publishKnowledgeImportProgress(event, batch)
    }
    batch.status = 'completed'
    publishKnowledgeImportProgress(event, batch)
    return imported
  })

  ipcMain.handle('api:knowledge-get-document', async (_, documentId: string) => {
    const database = await deps.getDB()
    const document = await database.get(`
      SELECT id, knowledge_base_id AS knowledgeBaseId, name, source_path AS sourcePath,
             file_type AS fileType, file_size AS fileSize, parser, parse_status AS parseStatus,
             warning, quality_score AS qualityScore, profile_json AS profileJson,
             character_count AS characterCount, node_count AS nodeCount,
             created_at AS createdAt, updated_at AS updatedAt
      FROM knowledge_documents WHERE id = ?
    `, documentId)
    if (!document) return null
    const rows = await database.all(`
      SELECT id, document_id AS documentId, parent_id AS parentId, node_type AS type,
             level, title, heading_path AS headingPath, content, order_index AS orderIndex,
             page_start AS pageStart, page_end AS pageEnd, token_count AS tokenCount,
             confidence, source_meta AS sourceMeta
      FROM knowledge_nodes WHERE document_id = ? ORDER BY order_index ASC
    `, documentId)
    return {
      document,
      nodes: rows.map((row: any) => ({
        ...row,
        headingPath: (() => { try { return JSON.parse(row.headingPath || '[]') } catch { return [] } })(),
        sourceMeta: (() => { try { return JSON.parse(row.sourceMeta || '{}') } catch { return {} } })()
      }))
    }
  })

  ipcMain.handle('api:knowledge-delete-document', async (_, documentId: string) => {
    const database = await deps.getDB()
    const row = await database.get('SELECT knowledge_base_id AS knowledgeBaseId, profile_json AS profileJson FROM knowledge_documents WHERE id = ?', documentId)
    await database.run('DELETE FROM knowledge_documents WHERE id = ?', documentId)
    try {
      const profile = JSON.parse(row?.profileJson || '{}')
      const assetDir = typeof profile.imageAssetDir === 'string' ? resolve(profile.imageAssetDir) : ''
      const assetRoot = resolve(join(app.getPath('userData'), 'knowledge-assets'))
      if (assetDir && assetDir.startsWith(`${assetRoot}\\`)) {
        await fs.promises.rm(assetDir, { recursive: true, force: true })
      }
    } catch {
      // Legacy documents may not have an asset directory.
    }
    if (row?.knowledgeBaseId) await database.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', Date.now(), row.knowledgeBaseId)
    return true
  })

  ipcMain.handle('api:knowledge-search', async (_, knowledgeBaseId: string, query: string) => {
    const database = await deps.getDB()
    const plan = await createKnowledgeRetrievalPlan(
      query,
      deps.getSystemLlmConfig ? prompt => callKnowledgePlanner(deps, prompt) : undefined
    )
    if (!plan.normalizedQuery || plan.subQueries.length === 0) return []
    const rows = await database.all(`
      SELECT n.*, d.name AS document_name, d.source_path, d.parser,
             e.vector AS embedding_vector, e.model AS embedding_model, e.content_hash AS embedding_hash
      FROM knowledge_nodes n
      JOIN knowledge_documents d ON d.id = n.document_id
      LEFT JOIN knowledge_embeddings e ON e.node_id = n.id
      WHERE d.knowledge_base_id = ? AND (
        n.node_type IN ('clause', 'item', 'paragraph', 'list', 'table', 'table_row', 'figure', 'caption')
        OR (
          n.node_type = 'article'
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_nodes child
            WHERE child.parent_id = n.id AND child.node_type IN ('clause', 'item')
          )
        )
      )
    `, knowledgeBaseId)
    if (rows.length === 0) return []

    await ensureKnowledgeEmbeddings(database, rows)
    const queryVectors = await embedTexts(plan.subQueries)
    const averageLength = rows.reduce((total: number, row: any) => total + String(row.content || '').length, 0) / rows.length || 1
    const aggregated = new Map<string, any>()

    for (let queryIndex = 0; queryIndex < plan.subQueries.length; queryIndex++) {
      const subQuery = plan.subQueries[queryIndex]
      const terms = extractTerms(subQuery)
      if (terms.length === 0) continue
      const normalizedQuery = subQuery.toLowerCase().trim()
      const entity = extractDefinitionEntity(subQuery)
      const queryVector = queryVectors[queryIndex]
      const documentFrequency = new Map<string, number>()
      for (const term of terms) {
        documentFrequency.set(term, rows.filter((row: any) => {
          const path = parseHeadingPath(row.heading_path).slice(1).join(' / ').toLowerCase()
          return `${row.title || ''}\n${row.content || ''}\n${path}`.toLowerCase().includes(term)
        }).length)
      }

      const candidates = rows.map((row: any) => {
        const content = String(row.content || '').toLowerCase()
        const title = String(row.title || '').toLowerCase()
        const path = parseHeadingPath(row.heading_path).slice(1).join(' / ').toLowerCase()
        const length = Math.max(1, content.length)
        let lexicalScore = content.includes(normalizedQuery) || title.includes(normalizedQuery) ? 2.5 : 0
        for (const term of terms) {
          const frequency = countOccurrences(content, term)
            + countOccurrences(title, term) * 2
            + countOccurrences(path, term) * 0.35
          if (frequency <= 0) continue
          const df = documentFrequency.get(term) || 0
          const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5))
          const normalizedTf = frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * length / averageLength))
          lexicalScore += idf * normalizedTf
        }

        const storedVector = parseStoredVector(row.embedding_vector)
        const vectorScore = queryVector && storedVector ? cosineSimilarity(queryVector, storedVector) : 0
        let structureScore = definitionStructureScore(entity, content, vectorScore)
        if (!structureScore && entity && title.includes(entity)) structureScore = 0.75
        return { row, lexicalScore, vectorScore, structureScore, fusionScore: 0, matchSources: [] as string[] }
      })

      const lexicalRank = candidates.filter((item: any) => item.lexicalScore > 0)
        .sort((a: any, b: any) => b.lexicalScore - a.lexicalScore).slice(0, 40)
      const vectorRank = candidates.filter((item: any) => item.vectorScore > 0.25)
        .sort((a: any, b: any) => b.vectorScore - a.vectorScore).slice(0, 40)
      const structureRank = candidates.filter((item: any) => item.structureScore > 0)
        .sort((a: any, b: any) => b.structureScore - a.structureScore).slice(0, 20)
      const addRank = (ranked: any[], source: string) => ranked.forEach((item, index) => {
        item.fusionScore += 1 / (60 + index + 1)
        item.matchSources.push(source)
      })
      addRank(lexicalRank, '词法')
      addRank(vectorRank, '语义')
      addRank(structureRank, '定义规则')
      for (const item of candidates) {
        if (item.structureScore) item.fusionScore += item.structureScore * 0.015
        if (item.fusionScore <= 0) continue
        const current = aggregated.get(item.row.id)
        if (!current) {
          aggregated.set(item.row.id, {
            ...item,
            maxFusionScore: item.fusionScore,
            matchedQueries: [subQuery],
            matchSources: [...item.matchSources]
          })
          continue
        }
        current.lexicalScore = Math.max(current.lexicalScore, item.lexicalScore)
        current.vectorScore = Math.max(current.vectorScore, item.vectorScore)
        current.structureScore = Math.max(current.structureScore, item.structureScore)
        current.maxFusionScore = Math.max(current.maxFusionScore, item.fusionScore)
        if (!current.matchedQueries.includes(subQuery)) current.matchedQueries.push(subQuery)
        for (const source of item.matchSources) {
          if (!current.matchSources.includes(source)) current.matchSources.push(source)
        }
      }
    }

    const ranked = [...aggregated.values()].map(item => ({
      ...item,
      fusionScore: item.maxFusionScore + Math.min(0.016, Math.max(0, item.matchedQueries.length - 1) * 0.004),
      matchSources: plan.mode === 'agentic' ? [...item.matchSources, '多步检索'] : item.matchSources
    })).sort((a, b) => b.fusionScore - a.fusionScore)

    const maxEvidence = plan.mode === 'agentic' ? 10 : 6
    const selected: any[] = []
    const selectedIds = new Set<string>()
    const seenContent = new Set<string>()
    const addEvidence = (item: any): void => {
      if (!item || selectedIds.has(item.row.id)) return
      const key = String(item.row.content || '').replace(/\s+/g, '')
      if (!key || seenContent.has(key)) return
      selected.push(item)
      selectedIds.add(item.row.id)
      seenContent.add(key)
    }
    if (plan.mode === 'agentic') {
      for (const subQuery of plan.subQueries) {
        addEvidence(ranked.find(item => item.matchedQueries.includes(subQuery)))
      }
    }
    for (const item of ranked) {
      if (selected.length >= maxEvidence) break
      addEvidence(item)
    }
    const scored = selected.slice(0, maxEvidence)

    const coveredSubQueries = plan.subQueries.filter(subQuery => scored.some(item => item.matchedQueries.includes(subQuery)))
    const retrievalPlan: KnowledgeRetrievalPlan & { coveredSubQueries: string[]; missingSubQueries: string[] } = {
      ...plan,
      coveredSubQueries,
      missingSubQueries: plan.subQueries.filter(subQuery => !coveredSubQueries.includes(subQuery))
    }

    const evidence: any[] = []
    for (let index = 0; index < scored.length; index++) {
      const { row, lexicalScore, vectorScore, fusionScore, matchSources, matchedQueries } = scored[index]
      const parent = row.parent_id
        ? await database.get('SELECT id, node_type AS type, title, content, heading_path AS headingPath FROM knowledge_nodes WHERE id = ?', row.parent_id)
        : null
      const adjacent = await database.all(`
        SELECT order_index AS orderIndex, content FROM knowledge_nodes
        WHERE document_id = ? AND parent_id IS ? AND order_index BETWEEN ? AND ? AND id <> ?
        ORDER BY order_index
      `, row.document_id, row.parent_id, row.order_index - 1, row.order_index + 1, row.id)
      const headingPath = parseHeadingPath(row.heading_path)
      evidence.push({
        citationId: `KB${index + 1}`,
        documentId: row.document_id,
        document: row.document_name,
        sourcePath: row.source_path,
        parser: row.parser,
        nodeId: row.id,
        parentId: row.parent_id,
        headingPath,
        parentTitle: parent?.title || '',
        parentType: parent?.type || '',
        parentContent: parent?.content || '',
        matchedContent: row.content,
        contextBefore: adjacent.find((item: any) => item.orderIndex < row.order_index)?.content || '',
        contextAfter: adjacent.find((item: any) => item.orderIndex > row.order_index)?.content || '',
        pageStart: row.page_start,
        pageEnd: row.page_end,
        confidence: row.confidence,
        sourceMeta: (() => { try { return JSON.parse(row.source_meta || '{}') } catch { return {} } })(),
        lexicalScore,
        vectorScore,
        fusionScore,
        matchSources,
        matchedQueries,
        retrievalPlan
      })
    }
    return evidence
  })
}

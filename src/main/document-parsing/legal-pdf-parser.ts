import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { app, type WebContents } from 'electron'
import * as fs from 'fs'
import { extname, join } from 'path'

import { officeRuntimeManager } from '../tools/interaction/office-runtime-manager'

export type KnowledgeNodeType =
  | 'document'
  | 'part'
  | 'chapter'
  | 'section'
  | 'article'
  | 'clause'
  | 'item'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'table_row'
  | 'figure'
  | 'caption'
  | 'footnote'
  | 'appendix'

export interface CanonicalKnowledgeNode {
  id: string
  parentId: string | null
  type: KnowledgeNodeType
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

interface LayoutLine {
  text: string
  page: number
  pageWidth: number
  pageHeight: number
  bbox: [number, number, number, number]
  fontSize: number
  blockIndex: number
  lineIndex: number
}

interface LayoutDocument {
  pageCount: number
  metadata: Record<string, unknown>
  lines: LayoutLine[]
  images: LayoutImage[]
}

interface LayoutImage {
  page: number
  pageWidth: number
  pageHeight: number
  bbox: [number, number, number, number]
  width: number
  height: number
  imagePath: string
  extension: string
  byteSize: number
}

interface LogicalParagraph {
  text: string
  pageStart: number
  pageEnd: number
  sources: Array<{ page: number; bbox: [number, number, number, number] }>
}

export interface StructuredPdfResult {
  nodes: CanonicalKnowledgeNode[]
  parser: string
  warning: string
  characterCount: number
  qualityScore: number
  profile: Record<string, unknown>
}

const PYMUPDF_LAYOUT_SCRIPT = String.raw`
import fitz, hashlib, json, sys

document = fitz.open(sys.argv[1])
image_dir = sys.argv[2]
result = {"pageCount": document.page_count, "metadata": document.metadata or {}, "lines": [], "images": []}
seen_images = set()
try:
    for page_index in range(document.page_count):
        page = document[page_index]
        payload = page.get_text("dict", sort=True)
        for block_index, block in enumerate(payload.get("blocks", [])):
            if block.get("type") == 1 and block.get("image"):
                bbox = block.get("bbox") or [0, 0, 0, 0]
                width = int(block.get("width") or 0)
                height = int(block.get("height") or 0)
                image_bytes = block.get("image")
                if width >= 48 and height >= 48 and len(image_bytes) >= 1024:
                    digest = hashlib.sha1(image_bytes).hexdigest()
                    if digest in seen_images:
                        continue
                    seen_images.add(digest)
                    extension = (block.get("ext") or "png").lower().replace("jpeg", "jpg")
                    image_name = f"page-{page_index + 1}-image-{block_index + 1}.{extension}"
                    image_path = image_dir + "/" + image_name
                    with open(image_path, "wb") as image_file:
                        image_file.write(image_bytes)
                    result["images"].append({
                        "page": page_index + 1,
                        "pageWidth": float(page.rect.width),
                        "pageHeight": float(page.rect.height),
                        "bbox": [float(value) for value in bbox],
                        "width": width,
                        "height": height,
                        "imagePath": image_path,
                        "extension": extension,
                        "byteSize": len(image_bytes),
                    })
                continue
            if block.get("type") != 0:
                continue
            for line_index, line in enumerate(block.get("lines", [])):
                spans = line.get("spans", [])
                text = "".join(span.get("text", "") for span in spans).strip()
                if not text:
                    continue
                bbox = line.get("bbox") or block.get("bbox") or [0, 0, 0, 0]
                result["lines"].append({
                    "text": text,
                    "page": page_index + 1,
                    "pageWidth": float(page.rect.width),
                    "pageHeight": float(page.rect.height),
                    "bbox": [float(value) for value in bbox],
                    "fontSize": max([float(span.get("size", 0)) for span in spans] or [0]),
                    "blockIndex": block_index,
                    "lineIndex": line_index,
                })
finally:
    document.close()
print(json.dumps(result, ensure_ascii=False))
`

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9
}

const LEGAL_MARKER = /^(第[零〇一二两三四五六七八九十百千万\d]+(?:编|章|节|条))\s*/
const CHAPTER_PATTERN = /^(第[零〇一二两三四五六七八九十百千万\d]+章)\s*(.*)$/
const SECTION_PATTERN = /^(第[零〇一二两三四五六七八九十百千万\d]+节)\s*(.*)$/
const ARTICLE_PATTERN = /^(第[零〇一二两三四五六七八九十百千万\d]+条)\s*(.*)$/
const ITEM_PATTERN = /^([（(][零〇一二两三四五六七八九十百千万\d]+[）)])\s*(.*)$/
const PAGE_NUMBER_PATTERN = /^(?:[-—–―－]\s*)?\d+(?:\s*(?:\/|of)\s*\d+)?(?:\s*[-—–―－])?$/i

function randomId(): string {
  return randomUUID()
}

function estimateTokens(text: string): number {
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length
  return Math.max(1, Math.ceil(chinese / 1.6 + Math.max(0, text.length - chinese) / 4))
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, '').replace(/[‐‑‒–—―－]/g, '-')
}

function overlapRatio(a: LayoutLine['bbox'], b: LayoutLine['bbox']): number {
  const left = Math.max(a[0], b[0])
  const top = Math.max(a[1], b[1])
  const right = Math.min(a[2], b[2])
  const bottom = Math.min(a[3], b[3])
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const areaA = Math.max(1, (a[2] - a[0]) * (a[3] - a[1]))
  const areaB = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
  return intersection / Math.min(areaA, areaB)
}

function cleanLayoutLines(layout: LayoutDocument): { lines: LayoutLine[]; removedCount: number } {
  const repeatedMargins = new Map<string, Set<number>>()
  for (const line of layout.lines) {
    const inMargin = line.bbox[1] < line.pageHeight * 0.1 || line.bbox[3] > line.pageHeight * 0.92
    if (!inMargin || PAGE_NUMBER_PATTERN.test(normalizeText(line.text))) continue
    const key = normalizeText(line.text)
    if (key.length < 2) continue
    const pages = repeatedMargins.get(key) || new Set<number>()
    pages.add(line.page)
    repeatedMargins.set(key, pages)
  }
  const repeatedThreshold = Math.max(3, Math.ceil(layout.pageCount * 0.5))
  const kept: LayoutLine[] = []
  let removedCount = 0
  for (const line of layout.lines) {
    const normalized = normalizeText(line.text)
    if (PAGE_NUMBER_PATTERN.test(normalized)) {
      removedCount++
      continue
    }
    const marginPages = repeatedMargins.get(normalized)
    if (marginPages && marginPages.size >= repeatedThreshold) {
      removedCount++
      continue
    }
    const duplicate = kept.find(previous => {
      if (previous.page !== line.page) return false
      const previousText = normalizeText(previous.text)
      const relatedText = previousText.includes(normalized) || normalized.includes(previousText)
      return relatedText && overlapRatio(previous.bbox, line.bbox) > 0.55
    })
    if (duplicate) {
      removedCount++
      continue
    }
    kept.push(line)
  }
  return { lines: kept, removedCount }
}

function paragraphize(lines: LayoutLine[]): LogicalParagraph[] {
  const leftEdges = new Map<number, number>()
  for (const line of lines) {
    if (line.bbox[1] < line.pageHeight * 0.1 || line.bbox[3] > line.pageHeight * 0.92) continue
    if (line.text.length < 4 || CHAPTER_PATTERN.test(line.text) || SECTION_PATTERN.test(line.text)) continue
    const current = leftEdges.get(line.page)
    leftEdges.set(line.page, current == null ? line.bbox[0] : Math.min(current, line.bbox[0]))
  }

  const paragraphs: LogicalParagraph[] = []
  let current: LogicalParagraph | null = null
  const flush = (): void => {
    if (!current) return
    current.text = current.text.replace(/\s+/g, ' ').trim()
    if (current.text) paragraphs.push(current)
    current = null
  }

  for (const line of lines) {
    const baseLeft = leftEdges.get(line.page) ?? line.bbox[0]
    const centeredHeading = CHAPTER_PATTERN.test(line.text) || SECTION_PATTERN.test(line.text)
    const explicitMarker = LEGAL_MARKER.test(line.text) || ITEM_PATTERN.test(line.text)
    const indentedParagraph = line.bbox[0] >= baseLeft + 18
    const startsParagraph = centeredHeading || explicitMarker || indentedParagraph

    if (!current || startsParagraph) {
      flush()
      current = {
        text: line.text,
        pageStart: line.page,
        pageEnd: line.page,
        sources: [{ page: line.page, bbox: line.bbox }]
      }
    } else {
      current.text += line.text
      current.pageEnd = line.page
      current.sources.push({ page: line.page, bbox: line.bbox })
    }
  }
  flush()
  return paragraphs
}

function chineseNumberToInt(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value)
  let total = 0
  let section = 0
  let digit = 0
  for (const character of value) {
    if (character in CHINESE_DIGITS) {
      digit = CHINESE_DIGITS[character]
    } else if (character === '十' || character === '百' || character === '千') {
      const unit = character === '十' ? 10 : character === '百' ? 100 : 1000
      section += (digit || 1) * unit
      digit = 0
    } else if (character === '万') {
      total += (section + digit) * 10000
      section = 0
      digit = 0
    }
  }
  const result = total + section + digit
  return result > 0 ? result : null
}

function intToChinese(value: number): string {
  if (value <= 10) return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][value]
  if (value < 20) return `十${intToChinese(value % 10)}`
  if (value < 100) return `${intToChinese(Math.floor(value / 10))}十${value % 10 ? intToChinese(value % 10) : ''}`
  return String(value)
}

function markerNumber(marker: string): number | null {
  const value = marker.replace(/^第/, '').replace(/[编章节条（）()]/g, '')
  return chineseNumberToInt(value)
}

function detectTitle(paragraphs: LogicalParagraph[], fallbackTitle: string): string {
  const firstMarker = paragraphs.findIndex(paragraph => CHAPTER_PATTERN.test(paragraph.text) || ARTICLE_PATTERN.test(paragraph.text))
  const candidates = paragraphs.slice(0, firstMarker < 0 ? 6 : firstMarker)
    .map(paragraph => paragraph.text.trim())
    .filter(text => text.length >= 4 && text.length <= 40 && /条例|办法|规定|细则|法|章程/.test(text))
  return candidates[0] || fallbackTitle.replace(extname(fallbackTitle), '')
}

function buildLegalNodes(paragraphs: LogicalParagraph[], fallbackTitle: string): {
  nodes: CanonicalKnowledgeNode[]
  title: string
  articleNumbers: number[]
  counts: Record<string, number>
} {
  const title = detectTitle(paragraphs, fallbackTitle)
  const isLegalDocument = paragraphs.some(paragraph => ARTICLE_PATTERN.test(paragraph.text))
  const rootId = randomId()
  const nodes: CanonicalKnowledgeNode[] = []
  let orderIndex = 0
  const root: CanonicalKnowledgeNode = {
    id: rootId, parentId: null, type: 'document', level: 0, title,
    headingPath: [title], content: title, orderIndex: orderIndex++, pageStart: 1,
    pageEnd: paragraphs.at(-1)?.pageEnd || 1, tokenCount: estimateTokens(title),
    confidence: 0.98, sourceMeta: { resolver: 'legal-cn-v1' }
  }
  nodes.push(root)

  let chapter: CanonicalKnowledgeNode | null = null
  let section: CanonicalKnowledgeNode | null = null
  let article: CanonicalKnowledgeNode | null = null
  let clause: CanonicalKnowledgeNode | null = null
  let clauseIndex = 0
  let preamble: LogicalParagraph | null = null
  const articleNumbers: number[] = []
  const counts = { chapter: 0, section: 0, article: 0, clause: 0, item: 0, paragraph: 0 }

  const addNode = (
    type: KnowledgeNodeType,
    parent: CanonicalKnowledgeNode,
    nodeTitle: string,
    content: string,
    paragraph: LogicalParagraph,
    confidence: number
  ): CanonicalKnowledgeNode => {
    const pathTitle = nodeTitle || content.slice(0, 36)
    const node: CanonicalKnowledgeNode = {
      id: randomId(), parentId: parent.id, type, level: parent.level + 1, title: nodeTitle,
      headingPath: [...parent.headingPath, pathTitle], content, orderIndex: orderIndex++,
      pageStart: paragraph.pageStart, pageEnd: paragraph.pageEnd, tokenCount: estimateTokens(content),
      confidence, sourceMeta: { spans: paragraph.sources }
    }
    nodes.push(node)
    return node
  }

  const appendArticleSource = (target: CanonicalKnowledgeNode, paragraph: LogicalParagraph): void => {
    target.pageEnd = paragraph.pageEnd
    target.content = `${target.content}\n${paragraph.text}`.trim()
    target.tokenCount = estimateTokens(target.content)
    const spans = Array.isArray(target.sourceMeta.spans) ? target.sourceMeta.spans : []
    target.sourceMeta = { ...target.sourceMeta, spans: [...spans, ...paragraph.sources] }
  }

  const flushPreamble = (): void => {
    if (!preamble) return
    addNode('paragraph', root, '制定与批准信息', preamble.text, preamble, 0.9)
    counts.paragraph++
    preamble = null
  }

  for (const paragraph of paragraphs) {
    if (normalizeText(paragraph.text) === normalizeText(title)) continue

    const chapterMatch = CHAPTER_PATTERN.exec(paragraph.text)
    const articleMatch = ARTICLE_PATTERN.exec(paragraph.text)
    if (isLegalDocument && !chapter && !article && !chapterMatch && !articleMatch) {
      if (!preamble) {
        preamble = { ...paragraph, sources: [...paragraph.sources] }
      } else {
        preamble.text += `\n${paragraph.text}`
        preamble.pageEnd = paragraph.pageEnd
        preamble.sources.push(...paragraph.sources)
      }
      continue
    }

    if (chapterMatch) {
      flushPreamble()
      chapter = addNode('chapter', root, `${chapterMatch[1]}${chapterMatch[2] ? ` ${chapterMatch[2]}` : ''}`, paragraph.text, paragraph, 0.99)
      section = null
      article = null
      clause = null
      counts.chapter++
      continue
    }

    const sectionMatch = SECTION_PATTERN.exec(paragraph.text)
    if (sectionMatch) {
      section = addNode('section', chapter || root, `${sectionMatch[1]}${sectionMatch[2] ? ` ${sectionMatch[2]}` : ''}`, paragraph.text, paragraph, 0.99)
      article = null
      clause = null
      counts.section++
      continue
    }

    if (articleMatch) {
      flushPreamble()
      article = addNode('article', section || chapter || root, articleMatch[1], paragraph.text, paragraph, 0.99)
      const articleNumber = markerNumber(articleMatch[1])
      if (articleNumber != null) articleNumbers.push(articleNumber)
      counts.article++
      clauseIndex = 1
      const firstClauseText = articleMatch[2].trim()
      clause = firstClauseText
        ? addNode('clause', article, `第${intToChinese(clauseIndex)}款`, firstClauseText, paragraph, 0.88)
        : null
      if (clause) counts.clause++
      continue
    }

    const itemMatch = ITEM_PATTERN.exec(paragraph.text)
    if (itemMatch && article) {
      if (!clause) {
        clauseIndex++
        clause = addNode('clause', article, `第${intToChinese(clauseIndex)}款`, '', paragraph, 0.72)
        counts.clause++
      }
      addNode('item', clause, itemMatch[1], itemMatch[2].trim() || paragraph.text, paragraph, 0.98)
      appendArticleSource(article, paragraph)
      counts.item++
      continue
    }

    if (article) {
      clauseIndex++
      clause = addNode('clause', article, `第${intToChinese(clauseIndex)}款`, paragraph.text, paragraph, 0.86)
      appendArticleSource(article, paragraph)
      counts.clause++
      continue
    }

    addNode('paragraph', section || chapter || root, '', paragraph.text, paragraph, 0.78)
    counts.paragraph++
  }

  flushPreamble()

  return { nodes, title, articleNumbers, counts }
}

function nodeSpans(node: CanonicalKnowledgeNode): Array<{ page: number; bbox: [number, number, number, number] }> {
  const spans = node.sourceMeta.spans
  return Array.isArray(spans) ? spans as Array<{ page: number; bbox: [number, number, number, number] }> : []
}

function attachImageNodes(
  nodes: CanonicalKnowledgeNode[],
  images: LayoutImage[],
  lines: LayoutLine[]
): CanonicalKnowledgeNode[] {
  if (images.length === 0) return nodes
  const root = nodes.find(node => node.type === 'document')
  if (!root) return nodes
  let orderIndex = Math.max(...nodes.map(node => node.orderIndex), 0) + 1

  for (let index = 0; index < images.length; index++) {
    const image = images[index]
    const imageCenterY = (image.bbox[1] + image.bbox[3]) / 2
    const candidates = nodes.filter(node =>
      ['article', 'clause', 'item', 'paragraph', 'section', 'chapter'].includes(node.type) &&
      node.pageStart != null && node.pageEnd != null &&
      image.page >= node.pageStart && image.page <= node.pageEnd
    )
    const parent = candidates.sort((a, b) => {
      const distance = (node: CanonicalKnowledgeNode): number => {
        const spans = nodeSpans(node).filter(span => span.page === image.page)
        if (spans.length === 0) return Number.MAX_SAFE_INTEGER
        return Math.min(...spans.map(span => Math.abs(((span.bbox[1] + span.bbox[3]) / 2) - imageCenterY)))
      }
      const distanceDelta = distance(a) - distance(b)
      return distanceDelta || b.level - a.level
    })[0] || root

    const nearbyCaption = lines
      .filter(line => line.page === image.page && line.bbox[1] >= image.bbox[3] && line.bbox[1] - image.bbox[3] <= 60)
      .sort((a, b) => a.bbox[1] - b.bbox[1])[0]
    const caption = nearbyCaption && /^(图|表|Figure|Fig\.)/i.test(nearbyCaption.text)
      ? nearbyCaption.text
      : ''
    const coverage = ((image.bbox[2] - image.bbox[0]) * (image.bbox[3] - image.bbox[1])) /
      Math.max(1, image.pageWidth * image.pageHeight)
    const title = caption || `第 ${image.page} 页图片 ${index + 1}`
    nodes.push({
      id: randomId(),
      parentId: parent.id,
      type: 'figure',
      level: parent.level + 1,
      title,
      headingPath: [...parent.headingPath, title],
      content: caption,
      orderIndex: orderIndex++,
      pageStart: image.page,
      pageEnd: image.page,
      tokenCount: estimateTokens(caption || title),
      confidence: caption ? 0.86 : 0.7,
      sourceMeta: {
        imagePath: image.imagePath,
        extension: image.extension,
        byteSize: image.byteSize,
        pixelWidth: image.width,
        pixelHeight: image.height,
        bbox: image.bbox,
        page: image.page,
        role: coverage >= 0.7 ? 'page_scan' : 'figure',
        analysisStatus: caption ? 'caption_only' : 'pending'
      }
    })
  }
  return nodes
}

function sequenceScore(numbers: number[]): number {
  if (numbers.length < 2) return numbers.length === 1 ? 0.7 : 0
  let continuous = 0
  for (let index = 1; index < numbers.length; index++) {
    if (numbers[index] === numbers[index - 1] + 1) continuous++
  }
  return continuous / (numbers.length - 1)
}

async function runPythonLayout(pythonPath: string, filePath: string, imageDir: string): Promise<LayoutDocument> {
  return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-c', PYMUPDF_LAYOUT_SCRIPT, filePath, imageDir], {
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', value => { stdout += String(value) })
    child.stderr.on('data', value => { stderr += String(value) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error((stderr || `PyMuPDF 退出码 ${code}`).slice(-3000)))
      try {
        resolve(JSON.parse(stdout) as LayoutDocument)
      } catch (error) {
        reject(new Error(`PyMuPDF 返回了无效 JSON：${String(error)}`))
      }
    })
  })
}

export async function parseLegalPdf(
  filePath: string,
  fallbackTitle: string,
  context: { event?: { sender: WebContents } }
): Promise<StructuredPdfResult> {
  const runtime = await officeRuntimeManager.ensure(context)
  const stat = await fs.promises.stat(filePath)
  const assetKey = createHash('sha1')
    .update(`${filePath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 20)
  const imageDir = join(app.getPath('userData'), 'knowledge-assets', assetKey, 'images')
  await fs.promises.mkdir(imageDir, { recursive: true })
  const layout = await runPythonLayout(runtime.pythonPath, filePath, imageDir.replace(/\\/g, '/'))
  const cleaned = cleanLayoutLines(layout)
  const paragraphs = paragraphize(cleaned.lines)
  const built = buildLegalNodes(paragraphs, fallbackTitle)
  const nodes = attachImageNodes(built.nodes, layout.images || [], cleaned.lines)
  const characterCount = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0)
  const continuity = sequenceScore(built.articleNumbers)
  const structured = built.counts.article > 0
  const pageCoverage = new Set(cleaned.lines.map(line => line.page)).size / Math.max(1, layout.pageCount)
  const duplicateRate = cleaned.removedCount / Math.max(1, layout.lines.length)
  const qualityScore = Math.max(0, Math.min(1,
    (characterCount >= 200 ? 0.3 : characterCount / 200 * 0.3) +
    (structured ? 0.3 : 0.08) +
    continuity * 0.2 +
    pageCoverage * 0.15 +
    Math.max(0, 0.05 - duplicateRate * 0.05)
  ))
  const warning = qualityScore >= 0.8
    ? ''
    : '结构解析置信度偏低，建议使用 Docling 或 MinerU 复核复杂版面。'

  return {
    nodes,
    parser: structured ? 'pymupdf-layout+legal-cn-v1' : 'pymupdf-layout+generic-v1',
    warning,
    characterCount,
    qualityScore,
    profile: {
      kind: structured ? 'legal-document' : 'digital-pdf',
      pageCount: layout.pageCount,
      title: built.title,
      counts: built.counts,
      imageCount: layout.images?.length || 0,
      imageAssetDir: imageDir,
      articleContinuity: continuity,
      removedArtifacts: cleaned.removedCount
    }
  }
}

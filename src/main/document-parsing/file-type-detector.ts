import * as fs from 'fs'
import { extname } from 'path'

export type CanonicalFileType =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'xls'
  | 'csv'
  | 'tsv'
  | 'txt'
  | 'md'
  | 'json'
  | 'jsonl'
  | 'html'
  | 'xml'
  | 'yaml'

export interface DetectedFileType {
  fileType: CanonicalFileType | 'unknown'
  rawExtension: string
  normalizedExtension: string
  isBinary: boolean
  confidence: number
  matchedBy: 'magic_bytes' | 'extension' | 'content_heuristic' | 'fallback'
  warning?: string
  delimiter?: string
}

/** Extension normalization alias map (Obsidian / standard tool interoperability) */
const EXTENSION_ALIASES: Record<string, CanonicalFileType> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  xls: 'xls',
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  txt: 'txt',
  text: 'txt',
  log: 'txt',
  rst: 'txt',
  md: 'md',
  markdown: 'md',
  mdown: 'md',
  mkdn: 'md',
  mdwn: 'md',
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  geojson: 'json',
  jsonld: 'json',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
}

export const SUPPORTED_CANONICAL_TYPES = new Set<CanonicalFileType>([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'xls',
  'csv',
  'tsv',
  'txt',
  'md',
  'json',
  'jsonl',
  'html',
  'xml',
  'yaml'
])

export const EDITABLE_CANONICAL_TYPES = new Set<CanonicalFileType>(['md', 'txt'])

/** Known Magic Bytes signatures */
const MAGIC_PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
const MAGIC_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // PK\x03\x04 (docx, pptx, xlsx)
const MAGIC_ZIP_EMPTY = Buffer.from([0x50, 0x4b, 0x05, 0x06]) // PK\x05\x06
const MAGIC_OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) // legacy doc, xls
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * Normalizes any raw file extension into its canonical format.
 */
export function normalizeExtension(rawExt: string): CanonicalFileType | 'unknown' {
  const clean = rawExt.replace(/^\./, '').trim().toLowerCase()
  return EXTENSION_ALIASES[clean] || 'unknown'
}

/**
 * Checks whether a buffer represents binary data (contains null bytes or illegal control characters).
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  // Check for UTF-16 BOMs first
  if (
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
  ) {
    return false
  }

  const sampleSize = Math.min(buffer.length, 1024)
  let nullCount = 0
  let suspiciousControlCount = 0

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i]
    if (byte === 0x00) {
      nullCount++
      if (nullCount > 1) return true
    } else if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      suspiciousControlCount++
    }
  }

  return suspiciousControlCount / sampleSize > 0.15
}

/**
 * Auto-detect delimiter for tabular text (comma, tab, semicolon).
 */
export function detectDelimiter(sampleText: string): string {
  const lines = sampleText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10)
  if (lines.length === 0) return ','

  let tabScore = 0
  let commaScore = 0
  let semicolonScore = 0

  for (const line of lines) {
    tabScore += (line.match(/\t/g) || []).length
    commaScore += (line.match(/,/g) || []).length
    semicolonScore += (line.match(/;/g) || []).length
  }

  if (tabScore > commaScore && tabScore > semicolonScore) return '\t'
  if (semicolonScore > commaScore && semicolonScore > tabScore) return ';'
  return ','
}

/**
 * Inspects initial text content to sniff XML, HTML, JSON, or YAML.
 */
function sniffTextContent(text: string): CanonicalFileType | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // HTML detection
  if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return 'html'
  }

  // XML detection
  if (/^<\?xml/i.test(trimmed)) {
    return 'xml'
  }

  // JSON detection
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // not valid single json, could be jsonl
    }
  }

  // JSONL detection
  const firstLines = trimmed.split(/\r?\n/).slice(0, 3).filter(Boolean)
  if (firstLines.length > 0 && firstLines.every((line) => line.trim().startsWith('{') && line.trim().endsWith('}'))) {
    try {
      JSON.parse(firstLines[0])
      return 'jsonl'
    } catch {
      // ignore
    }
  }

  return null
}

/**
 * Sniffs the file type using file extension, magic bytes header, and content heuristics.
 */
export async function sniffFileType(filePath: string, existingBuffer?: Buffer): Promise<DetectedFileType> {
  const rawExt = extname(filePath).slice(1).toLowerCase()
  const normalizedExt = normalizeExtension(rawExt)

  let header: Buffer
  try {
    if (existingBuffer) {
      header = existingBuffer.subarray(0, 4096)
    } else {
      const fd = await fs.promises.open(filePath, 'r')
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await fd.read(buffer, 0, 4096, 0)
      await fd.close()
      header = buffer.subarray(0, bytesRead)
    }
  } catch {
    // If file cannot be read, fallback strictly to extension
    return {
      fileType: normalizedExt,
      rawExtension: rawExt,
      normalizedExtension: normalizedExt,
      isBinary: false,
      confidence: normalizedExt !== 'unknown' ? 0.7 : 0,
      matchedBy: 'extension'
    }
  }

  // 1. Magic Bytes Check: PDF
  if (header.subarray(0, 5).equals(MAGIC_PDF)) {
    return {
      fileType: 'pdf',
      rawExtension: rawExt,
      normalizedExtension: normalizedExt,
      isBinary: true,
      confidence: 0.99,
      matchedBy: 'magic_bytes'
    }
  }

  // 2. Magic Bytes Check: ZIP-based OOXML formats (docx, pptx, xlsx)
  if (header.subarray(0, 4).equals(MAGIC_ZIP) || header.subarray(0, 4).equals(MAGIC_ZIP_EMPTY)) {
    // If extension is already docx/pptx/xlsx, confirm with high confidence
    if (['docx', 'pptx', 'xlsx'].includes(normalizedExt)) {
      return {
        fileType: normalizedExt as CanonicalFileType,
        rawExtension: rawExt,
        normalizedExtension: normalizedExt,
        isBinary: true,
        confidence: 0.98,
        matchedBy: 'magic_bytes'
      }
    }
  }

  // 3. Magic Bytes Check: OLE2 (legacy doc / xls)
  if (header.subarray(0, 8).equals(MAGIC_OLE2)) {
    const fileType = normalizedExt === 'xls' ? 'xls' : 'unknown'
    return {
      fileType,
      rawExtension: rawExt,
      normalizedExtension: normalizedExt,
      isBinary: true,
      confidence: 0.95,
      matchedBy: 'magic_bytes'
    }
  }

  // 4. Check for binary stream on supposedly text files
  const isBinary = isBinaryBuffer(header)
  if (isBinary) {
    if (['pdf', 'docx', 'pptx', 'xlsx', 'xls'].includes(normalizedExt)) {
      return {
        fileType: normalizedExt as CanonicalFileType,
        rawExtension: rawExt,
        normalizedExtension: normalizedExt,
        isBinary: true,
        confidence: 0.9,
        matchedBy: 'extension'
      }
    }
    // Corrupted or binary file posing as text
    return {
      fileType: 'unknown',
      rawExtension: rawExt,
      normalizedExtension: normalizedExt,
      isBinary: true,
      confidence: 0.9,
      matchedBy: 'magic_bytes',
      warning: '文件包含二进制数据或不支持的编码，已跳过解析。'
    }
  }

  // 5. Text content heuristics
  let cleanTextHeader = header
  if (cleanTextHeader.subarray(0, 3).equals(UTF8_BOM)) {
    cleanTextHeader = cleanTextHeader.subarray(3)
  }
  const sampleString = cleanTextHeader.toString('utf8', 0, Math.min(cleanTextHeader.length, 2048))

  // Tabular files (csv, tsv) delimiter detection
  if (normalizedExt === 'csv' || normalizedExt === 'tsv') {
    const delimiter = detectDelimiter(sampleString)
    return {
      fileType: delimiter === '\t' ? 'tsv' : 'csv',
      rawExtension: rawExt,
      normalizedExtension: normalizedExt,
      isBinary: false,
      confidence: 0.95,
      matchedBy: 'content_heuristic',
      delimiter
    }
  }

  const sniffedType = sniffTextContent(sampleString)
  if (sniffedType) {
    return {
      fileType: sniffedType,
      rawExtension: rawExt,
      normalizedExtension: normalizedExt,
      isBinary: false,
      confidence: 0.95,
      matchedBy: 'content_heuristic'
    }
  }

  // 6. Valid extension match
  if (normalizedExt !== 'unknown') {
    return {
      fileType: normalizedExt,
      rawExtension: rawExt,
      normalizedExtension: normalizedExt,
      isBinary: false,
      confidence: 0.85,
      matchedBy: 'extension'
    }
  }

  return {
    fileType: 'unknown',
    rawExtension: rawExt,
    normalizedExtension: normalizedExt,
    isBinary: false,
    confidence: 0.2,
    matchedBy: 'fallback'
  }
}

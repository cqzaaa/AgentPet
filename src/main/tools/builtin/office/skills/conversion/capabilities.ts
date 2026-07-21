import { extname } from 'path'

export type OfficeConversionFormat =
  | 'pdf'
  | 'png'
  | 'jpg'
  | 'webp'
  | 'pptx'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'markdown'
  | 'html'
  | 'txt'
export type OfficeConversionTargetFormat = Exclude<OfficeConversionFormat, 'webp'>
export type OfficeConversionMode = 'visual' | 'structured' | 'editable' | 'native'

export interface OfficeConversionCapability {
  source: OfficeConversionFormat
  target: OfficeConversionTargetFormat
  mode: OfficeConversionMode
  multipleInputs: boolean
  multipleOutputs: boolean
}

const capabilities: readonly OfficeConversionCapability[] = [
  { source: 'png', target: 'pdf', mode: 'visual', multipleInputs: true, multipleOutputs: false },
  { source: 'jpg', target: 'pdf', mode: 'visual', multipleInputs: true, multipleOutputs: false },
  { source: 'webp', target: 'pdf', mode: 'visual', multipleInputs: true, multipleOutputs: false },
  { source: 'pdf', target: 'png', mode: 'visual', multipleInputs: false, multipleOutputs: true },
  { source: 'pdf', target: 'jpg', mode: 'visual', multipleInputs: false, multipleOutputs: true },
  { source: 'pdf', target: 'pptx', mode: 'editable', multipleInputs: false, multipleOutputs: false },
  { source: 'pdf', target: 'docx', mode: 'editable', multipleInputs: false, multipleOutputs: false },
  { source: 'pdf', target: 'xlsx', mode: 'structured', multipleInputs: false, multipleOutputs: false },
  { source: 'pdf', target: 'markdown', mode: 'structured', multipleInputs: false, multipleOutputs: false },
  { source: 'pdf', target: 'txt', mode: 'structured', multipleInputs: false, multipleOutputs: false },
  { source: 'pptx', target: 'pdf', mode: 'native', multipleInputs: false, multipleOutputs: false },
  { source: 'docx', target: 'pdf', mode: 'native', multipleInputs: false, multipleOutputs: false },
  { source: 'xlsx', target: 'pdf', mode: 'native', multipleInputs: false, multipleOutputs: false },
  {
    source: 'xlsx',
    target: 'csv',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: true
  },
  {
    source: 'csv',
    target: 'xlsx',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: false
  },
  {
    source: 'docx',
    target: 'markdown',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: false
  },
  {
    source: 'docx',
    target: 'html',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: false
  },
  {
    source: 'docx',
    target: 'txt',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: false
  },
  {
    source: 'markdown',
    target: 'docx',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: false
  },
  {
    source: 'html',
    target: 'docx',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: false
  },
  {
    source: 'txt',
    target: 'docx',
    mode: 'structured',
    multipleInputs: false,
    multipleOutputs: false
  }
]

const aliases: Record<string, OfficeConversionFormat> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  webp: 'webp',
  pptx: 'pptx',
  docx: 'docx',
  xlsx: 'xlsx',
  csv: 'csv',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  txt: 'txt'
}

export function listOfficeConversionCapabilities(): OfficeConversionCapability[] {
  return capabilities.map((capability) => ({ ...capability }))
}

export function normalizeConversionFormat(value: unknown): OfficeConversionFormat | null {
  if (typeof value !== 'string') return null
  return aliases[value.trim().toLowerCase().replace(/^\./, '')] || null
}

export function formatFromPath(filePath: string): OfficeConversionFormat | null {
  return normalizeConversionFormat(extname(filePath))
}

export function getOfficeConversionCapability(
  source: OfficeConversionFormat,
  target: OfficeConversionTargetFormat
): OfficeConversionCapability | null {
  return capabilities.find((item) => item.source === source && item.target === target) || null
}

export function assertOfficeConversionSupported(
  source: OfficeConversionFormat,
  target: OfficeConversionTargetFormat
): OfficeConversionCapability {
  const capability = getOfficeConversionCapability(source, target)
  if (capability) return capability

  const supportedTargets = capabilities
    .filter((item) => item.source === source)
    .map((item) => item.target)
  const suggestion =
    supportedTargets.length > 0 ? `；${source} 可转换为 ${supportedTargets.join(', ')}` : ''
  throw new Error(`暂不支持 ${source} → ${target}${suggestion}`)
}

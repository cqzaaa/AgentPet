export type OfficeSkillName = 'docx' | 'xlsx' | 'pdf' | 'pptx'

const ATTACHMENT_MARKER = /\n\s*(?:---\s*)?\[(?:附带文件|源文件路径|工作表|attached file|source file path|worksheet)\s*:/i
const OFFICE_ATTACHMENT = /\[(?:附带文件|源文件路径|attached file|source file path)\s*:[^\]\r\n]*?\.(docx|xlsx|pdf|pptx)\b/i

/**
 * Attachment previews can contain arbitrary user data, including words such as
 * "搜索" or "网页". Tool routing must only use the instruction that precedes
 * the generated attachment metadata/preview block.
 */
export function extractPrimaryToolIntent(text: string): string {
  const normalized = String(text || '')
  const marker = ATTACHMENT_MARKER.exec(normalized)
  return (marker ? normalized.slice(0, marker.index) : normalized).trim()
}

/** Detect an Office attachment from AgentPet's generated attachment metadata. */
export function detectOfficeAttachment(text: string): OfficeSkillName | null {
  const match = OFFICE_ATTACHMENT.exec(String(text || ''))
  return (match?.[1]?.toLowerCase() as OfficeSkillName | undefined) || null
}

export function shouldForceDomBrowser(text: string): boolean {
  const intent = extractPrimaryToolIntent(text).toLowerCase()
  return /浏览器|浏览|网页|网站|搜索|搜一下|链接|网址|url|browser|website|web page|search/.test(intent)
}

export function shouldForceBingSearch(text: string): boolean {
  const intent = extractPrimaryToolIntent(text).toLowerCase()
  const asksToSearch = /搜索|搜一下|search/.test(intent)
  const explicitlyRequestsBaidu = /百度|baidu/.test(intent)
  return asksToSearch && !explicitlyRequestsBaidu
}

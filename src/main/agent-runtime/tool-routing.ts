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
  return /浏览器|浏览|网页|网站|搜索|搜一下|链接|网址/.test(intent) ||
    /\b(?:url|browser|website|search)\b|\bweb\s+page\b/.test(intent)
}

export function shouldForceBingSearch(text: string): boolean {
  const intent = extractPrimaryToolIntent(text).toLowerCase()
  const asksToSearch = /搜索|搜一下/.test(intent) || /\bsearch\b/.test(intent)
  const explicitlyRequestsBaidu = /百度|baidu/.test(intent)
  return asksToSearch && !explicitlyRequestsBaidu
}

export function getExplicitlyRequestedTaskTools(text: string): string[] {
  const intent = extractPrimaryToolIntent(text)
  return ['update_task_plan', 'delegate_tasks'].filter(name =>
    new RegExp(`\\b${name}\\b`, 'i').test(intent)
  )
}

/**
 * Conservative fast-path for one-file, one-mutation requests. A false negative
 * merely keeps planning available; a false positive would hide it, so ambiguous,
 * collaborative, destructive, multi-output, or multi-action wording opts out.
 */
export function isSimpleSingleFileMutationRequest(text: string): boolean {
  const fullText = String(text || '')
  const intent = extractPrimaryToolIntent(fullText)
  if (!intent || /\bupdate_task_plan\b/i.test(intent)) return false

  const attachmentCount = (fullText.match(/\[(?:附带文件|attached file)\s*:/gi) || []).length
  const pathOrExtensionCount = (intent.match(/(?:[a-z]:[\\/][^\s"']+|\b[^\s"']+\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|png|jpe?g|webp)\b)/gi) || []).length
  const hasSingleFileTarget = attachmentCount === 1 || (attachmentCount === 0 && pathOrExtensionCount <= 1 && /文件|文档|表格|图片|PDF|DOCX|XLSX|PPTX|\bfile\b|\bdocument\b/i.test(intent))
  if (!hasSingleFileTarget || attachmentCount > 1 || pathOrExtensionCount > 1) return false

  if (/多人|协作|并行|子\s*agent|子智能体|delegate|sub-?agent|researcher|reviewer/i.test(intent)) return false
  if (/批量|多个|多份|所有文件|每个文件|分别|逐个|合并|汇总|对比|比较|发布|部署|发送|上传|删除|清空|覆盖|付款|转账|生产环境|数据库|注册表|管理员|格式化/i.test(intent)) return false
  if (/然后|接着|再(?:把|将|做|生成)|同时|并且|以及|and then|followed by/i.test(intent)) return false

  const mutationPatterns = [
    /修改|改成|改为|替换|重命名|转换|导出|填写|填充|加上|添加|插入|调整|设置|标红|改色/i,
    /\b(?:edit|change|replace|rename|convert|export|fill|insert|adjust|set)\b/i
  ]
  return mutationPatterns.some(pattern => pattern.test(intent))
}

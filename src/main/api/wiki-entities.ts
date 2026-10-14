import type { WikiEntityEvidence } from '../../preload/wiki-types'

export interface WikiEntityNodeRow {
  nodeId: string
  headingPath: string
  itemId: string
  itemTitle: string
  nodeType: string
  title: string
  content: string
  pageStart: number | null
}

export interface EntityCandidate {
  name: string
  normalizedName: string
  entityType: string
  mentionCount: number
  confidence: number
  evidence: WikiEntityEvidence[]
}

const ENTITY_STOP_WORDS = new Set([
  'about', 'after', 'and', 'async', 'await', 'before', 'click', 'code', 'const', 'content',
  'data', 'default', 'example', 'false', 'file', 'for', 'from', 'function', 'http',
  'https', 'info', 'into', 'item', 'let', 'link', 'name', 'new', 'null', 'page', 'result',
  'return', 'source', 'text', 'that', 'the', 'this', 'true', 'type', 'undefined', 'value',
  'var', 'when', 'where', 'wiki', 'with', 'www',
  '内容', '功能', '代码', '信息', '问题', '方案', '文章', '文件', '页面', '数据', '系统',
  '用户', '工作区', '示例', '默认', '方法', '属性', '结果', '来源'
])
const ENTITY_SUFFIXES = [
  '自定义控件', '组件', '控件', '框架', '插件', '数据库', '浏览器', '地图', '接口',
  '协议', '模型', '算法', '脚本', '模块', '平台', '服务', '工具', '终端', '应用'
]
const ENTITY_ACTION_PREFIXES = [
  '如何', '通过', '使用', '实现', '开发', '解决', '关于', '集成', '监听', '获取',
  '创建', '移除', '引入', '调用', '配置', '支持', '基于', '针对', '利用'
]

export function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN')
}

function cleanEntityName(value: string): string {
  return value
    .replace(/^[`*_#\s'"“”‘’《》「」【】()[\]{}<>，。！？；：、,.!?;:/\\|-]+/u, '')
    .replace(/[`*_#\s'"“”‘’《》「」【】()[\]{}<>，。！？；：、,.!?;:/\\|-]+$/u, '')
    .trim()
}

function entityEvidence(text: string, name: string): string {
  const compact = text.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim()
  const index = compact.toLocaleLowerCase('zh-CN').indexOf(name.toLocaleLowerCase('zh-CN'))
  if (index < 0) return ''
  const start = Math.max(0, index - 34)
  return compact.slice(start, Math.min(compact.length, index + name.length + 54)).trim()
}

function inferEntityType(name: string): string {
  if (/[A-Za-z]/.test(name)) return 'technology'
  if (/(?:框架|组件|控件|插件|数据库|浏览器|接口|协议|脚本|模块|平台|工具|终端|应用)$/.test(name)) return 'technology'
  if (/(?:地图|模型|算法|服务)$/.test(name)) return 'concept'
  return 'concept'
}

function countMentions(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const boundary = /^[A-Za-z0-9_.+# -]+$/.test(name)
  return [...text.matchAll(new RegExp(boundary ? `(?<![\\w])${escaped}(?![\\w])` : escaped, 'giu'))].length || 1
}

export function parseEntityEvidence(value: string): WikiEntityEvidence[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(entry => {
      // Read old indexes until the next sync upgrades their evidence.
      if (typeof entry === 'string') return [{ nodeId: null, title: '正文摘录', pageStart: null, quote: entry }]
      if (!entry || typeof entry !== 'object' || typeof entry.quote !== 'string') return []
      return [{
        nodeId: typeof entry.nodeId === 'string' ? entry.nodeId : null,
        title: typeof entry.title === 'string' ? entry.title : '正文',
        pageStart: typeof entry.pageStart === 'number' ? entry.pageStart : null, quote: entry.quote
      }]
    })
  } catch { return [] }
}

export function extractEntityCandidates(row: WikiEntityNodeRow): EntityCandidate[] {
  const candidates = new Map<string, EntityCandidate>()
  // A section's title and content often contain the same text. Do not count it twice.
  const sourceText = [...new Set([row.title, row.content].filter(Boolean))].join('\n')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/(?:https?|repo):\/\/\S+/gi, ' ')
  const titleText = row.title || ''
  const add = (rawName: string, confidence: number): void => {
    const name = cleanEntityName(rawName)
    const normalizedName = normalizeEntityName(name)
    if (name.length < 2 || name.length > 40 || ENTITY_STOP_WORDS.has(normalizedName)) return
    if (/^\d+(?:[._-]\d+)*$/.test(name)) return
    const quote = entityEvidence(sourceText, name)
    if (!quote) return
    let path: string[] = []
    try { const parsed = JSON.parse(row.headingPath); if (Array.isArray(parsed)) path = parsed.filter(value => typeof value === 'string') } catch { /* Older indexes may lack a heading path. */ }
    const evidence: WikiEntityEvidence = {
      nodeId: row.nodeId, title: path.slice(1).join(' / ') || row.title || '正文',
      pageStart: row.pageStart, quote
    }
    const existing = candidates.get(normalizedName)
    if (existing) {
      existing.confidence = Math.max(existing.confidence, confidence)
      return
    }
    candidates.set(normalizedName, {
      name,
      normalizedName,
      entityType: inferEntityType(name),
      mentionCount: countMentions(sourceText, name),
      confidence,
      evidence: evidence ? [evidence] : []
    })
  }

  for (const match of sourceText.matchAll(/`([^`\n]{2,40})`/g)) {
    if (/^[\p{L}\p{N}_.+#-]+$/u.test(match[1])) add(match[1], 0.98)
  }
  for (const match of sourceText.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) add(match[1], 0.98)

  // Preserve named concepts in structured headings instead of splitting every phrase into words.
  if (['section', 'heading', 'chapter'].includes(row.nodeType)) {
    const heading = titleText.replace(/^(?:\d+[.\s]*)+/, '').trim()
    if (heading.length <= 24 && !/[，。！？:：?]/.test(heading)
      && !ENTITY_ACTION_PREFIXES.some(prefix => heading.startsWith(prefix))
      && !/^(abstract|introduction|conclusions?|references|acknowledg(?:e)?ments?|摘要|引言|结论|参考文献)$/i.test(heading)) add(heading, 0.9)
  }

  const knownTechnologies = new Set([
    'api', 'css', 'electron', 'html', 'javascript', 'jquery', 'jsapi', 'markdown', 'node',
    'nodejs', 'react', 'sdk', 'sql', 'sqlite', 'typescript', 'vue'
  ])
  for (const match of sourceText.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[.+#_-][A-Za-z0-9]+)*\b/g)) {
    const name = match[0]
    const normalized = name.toLowerCase()
    const looksNamed = knownTechnologies.has(normalized)
      || /[A-Z]/.test(name.slice(1))
      || /^[A-Z][A-Z0-9.+#_-]+$/.test(name)
    if (looksNamed) add(name, 0.94)
  }

  const segments = sourceText.split(/[\n，。！？；：、()[\]{}<>“”‘’"'`]+/u).map(value => value.trim()).filter(Boolean)
  for (const segment of segments) {
    const segmentCandidates = new Set<string>()
    for (const suffix of ENTITY_SUFFIXES) {
      let offset = 0
      while (offset < segment.length) {
        const suffixIndex = segment.indexOf(suffix, offset)
        if (suffixIndex < 0) break
        const end = suffixIndex + suffix.length
        let candidate = segment.slice(Math.max(0, end - 18), end)
        let actionEnd = -1
        for (const prefix of ENTITY_ACTION_PREFIXES) {
          const prefixIndex = candidate.lastIndexOf(prefix)
          if (prefixIndex >= 0) actionEnd = Math.max(actionEnd, prefixIndex + prefix.length)
        }
        if (actionEnd >= 0) candidate = candidate.slice(actionEnd)
        candidate = candidate.replace(/^(?:在|将|与|和|及|用|对|把|由|从|的|该)+/u, '')
        if (candidate.includes('自定义')) candidate = candidate.slice(candidate.lastIndexOf('自定义'))
        candidate = cleanEntityName(candidate).slice(-16)
        if (candidate.length >= 2) segmentCandidates.add(candidate)
        offset = end
      }
    }
    for (const candidate of segmentCandidates) add(candidate, row.nodeType === 'section' ? 0.96 : 0.9)
  }
  return [...candidates.values()]
}


export type KnowledgeRetrievalMode = 'direct' | 'agentic'

export interface KnowledgeRetrievalPlan {
  mode: KnowledgeRetrievalMode
  intent: string
  originalQuery: string
  normalizedQuery: string
  subQueries: string[]
  planner: 'none' | 'heuristic' | 'llm'
}

type Planner = (prompt: string) => Promise<string>

const QUESTION_DIMENSIONS = [
  /谁|何人|主体|部门|单位/,
  /什么条件|哪些情形|何种情形|适用范围|前提/,
  /如何|怎么|程序|流程|步骤/,
  /责任|承担|负责/,
  /费用|资金|预算/,
  /处罚|后果|法律责任/,
  /例外|除外|但书|特殊情形/,
  /何时|期限|时限/,
  /区别|异同|比较|相比/
]

export function normalizeKnowledgeQuery(query: string): string {
  return String(query || '')
    .trim()
    .replace(/\s+/g, ' ')
}

export function extractDefinitionEntity(query: string): string {
  const normalized = normalizeKnowledgeQuery(query)
    .toLowerCase()
    .replace(/[？?。！!，,；;：:\s]/g, '')
    .replace(/^(请问|请解释|解释一下|说明一下)/, '')
  if (!/(什么是|指的是什么|是指什么|指什么|是什么|何谓|定义|含义|意思)/.test(normalized)) return ''
  return normalized
    .replace(/^(什么是|何谓)/, '')
    .replace(
      /(指的是什么|是指什么|是什么意思|是什么含义|是什么|指什么|的定义|定义|的含义|含义|意思)$/g,
      ''
    )
    .trim()
}

function normalizedTerm(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^(?:本法|本条例|本办法|本规定|本细则)所称/, '')
    .replace(/[“”"'‘’（）()《》\s，,。；;：:]/g, '')
}

function ngrams(value: string, size: number): Set<string> {
  const result = new Set<string>()
  for (let index = 0; index <= value.length - size; index++) {
    result.add(value.slice(index, index + size))
  }
  return result
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const value of left) {
    if (right.has(value)) intersection += 1
  }
  return (2 * intersection) / (left.size + right.size)
}

export function extractDefinedTerm(content: string): string {
  const normalized = String(content || '')
    .replace(/\s+/g, ' ')
    .trim()
  const patterns = [
    /(?:本(?:法|条例|办法|规定|细则))?所称[“"]?([^”"，,。；;]{2,32})[”"]?[，,]\s*(?:是指|指)/,
    /[“"]([^”"]{2,32})[”"][，,]?\s*(?:是指|定义为)/,
    /(?:^|[。；;])([^，,。；;]{2,24})[，,]\s*(?:是指|定义为)/
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(normalized)
    if (match?.[1]) return normalizedTerm(match[1])
  }
  return ''
}

export function definitionStructureScore(entity: string, content: string, vectorScore = 0): number {
  const queryTerm = normalizedTerm(entity)
  if (!queryTerm) return 0
  const definedTerm = extractDefinedTerm(content)
  if (!definedTerm) {
    return normalizedTerm(content).includes(queryTerm) && /(?:是指|定义为)/.test(content) ? 2 : 0
  }
  if (
    queryTerm === definedTerm ||
    queryTerm.includes(definedTerm) ||
    definedTerm.includes(queryTerm)
  )
    return 4

  const characterScore = diceSimilarity(new Set(queryTerm), new Set(definedTerm))
  const bigramScore = diceSimilarity(ngrams(queryTerm, 2), ngrams(definedTerm, 2))
  const termScore = characterScore * 0.8 + bigramScore * 0.2
  if (queryTerm.length >= 3 && definedTerm.length >= 3 && termScore >= 0.6) return 3
  if (termScore >= 0.45 && vectorScore >= 0.45) return 2.5
  if (vectorScore >= 0.58) return 1.75
  return 0
}

export function isComplexKnowledgeQuery(query: string): boolean {
  const normalized = normalizeKnowledgeQuery(query)
  if (!normalized) return false
  const dimensionCount = QUESTION_DIMENSIONS.filter((pattern) => pattern.test(normalized)).length
  if (extractDefinitionEntity(normalized) && dimensionCount < 2) return false
  if (/(综合|分别|逐一|对比|比较|异同|从.+到.+|结合.+说明)/.test(normalized)) return true
  const questionCount = (normalized.match(/[？?]/g) || []).length
  const clauseCount = normalized.split(/[；;。\n]/).filter((part) => part.trim().length >= 4).length
  return dimensionCount >= 2 || questionCount >= 2 || clauseCount >= 2
}

function inferIntent(query: string): string {
  if (extractDefinitionEntity(query)) return 'definition'
  if (/区别|异同|比较|相比/.test(query)) return 'comparison'
  if (/如何|怎么|程序|流程|步骤|从.+到.+/.test(query)) return 'procedure'
  if (/谁|何人|主体|部门|单位|责任|负责/.test(query)) return 'responsibility'
  return 'fact_lookup'
}

function uniqueQueries(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizeKnowledgeQuery(value)
      .replace(/^[\d一二三四五六七八九十]+[.、)）]\s*/, '')
      .trim()
    if (normalized.length < 2 || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= 5) break
  }
  return result
}

export function fallbackKnowledgeSubQueries(query: string): string[] {
  const normalized = normalizeKnowledgeQuery(query)
  const expanded = normalized.replace(/(?:以及|并且|同时|另外|此外|还要|还需)/g, '；')
  const punctuationParts = expanded
    .split(/[；;。\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
  if (punctuationParts.length >= 2) return uniqueQueries(punctuationParts)

  const commaParts = expanded
    .split(/[，,]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
  const questionLikeParts = commaParts.filter((part) =>
    QUESTION_DIMENSIONS.some((pattern) => pattern.test(part))
  )
  return questionLikeParts.length >= 2 ? uniqueQueries(questionLikeParts) : [normalized]
}

function parsePlannerJson(raw: string): { intent?: string; subQueries?: unknown } | null {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function plannerPrompt(query: string): string {
  return `你是法规知识库检索规划器。请把复杂问题拆成最多 5 个可以独立检索原文条款的子问题。

要求：
1. 保留责任主体、适用条件、程序、期限、费用、例外等限定信息。
2. 子问题必须自包含，不要使用“上述”“该事项”等指代。
3. 不回答问题，不编造法规内容。
4. 只输出 JSON：{"intent":"简短英文标签","subQueries":["子问题1","子问题2"]}

用户问题：${query}`
}

export async function createKnowledgeRetrievalPlan(
  query: string,
  planner?: Planner
): Promise<KnowledgeRetrievalPlan> {
  const originalQuery = String(query || '').trim()
  const normalizedQuery = normalizeKnowledgeQuery(originalQuery)
  if (!isComplexKnowledgeQuery(normalizedQuery)) {
    return {
      mode: 'direct',
      intent: inferIntent(normalizedQuery),
      originalQuery,
      normalizedQuery,
      subQueries: [normalizedQuery],
      planner: 'none'
    }
  }

  const fallback = fallbackKnowledgeSubQueries(normalizedQuery)
  if (!planner) {
    return {
      mode: 'agentic',
      intent: inferIntent(normalizedQuery),
      originalQuery,
      normalizedQuery,
      subQueries: fallback,
      planner: 'heuristic'
    }
  }

  try {
    const parsed = parsePlannerJson(await planner(plannerPrompt(normalizedQuery)))
    const plannedQueries = Array.isArray(parsed?.subQueries)
      ? uniqueQueries(
          parsed.subQueries.filter((value): value is string => typeof value === 'string')
        )
      : []
    if (plannedQueries.length > 0) {
      return {
        mode: 'agentic',
        intent:
          typeof parsed?.intent === 'string'
            ? parsed.intent.slice(0, 40)
            : inferIntent(normalizedQuery),
        originalQuery,
        normalizedQuery,
        subQueries: plannedQueries,
        planner: 'llm'
      }
    }
  } catch (error: unknown) {
    console.warn(
      '[KnowledgeBase] Agentic query planning failed; using heuristic plan.',
      error instanceof Error ? error.message : String(error)
    )
  }

  return {
    mode: 'agentic',
    intent: inferIntent(normalizedQuery),
    originalQuery,
    normalizedQuery,
    subQueries: fallback,
    planner: 'heuristic'
  }
}

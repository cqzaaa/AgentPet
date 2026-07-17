import type { JsonValue, RpaNode, RpaTaskManifest } from '../../../rpa/domain/types'

const normalize = (value: string): string =>
  value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

const bigrams = (value: string): Set<string> => {
  const normalized = normalize(value)
  if (normalized.length < 2) return new Set(normalized ? [normalized] : [])
  return new Set(
    Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2))
  )
}

export const workflowScore = (workflow: RpaTaskManifest, query: string): number => {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return 1
  const name = normalize(workflow.name)
  const description = normalize(workflow.description || '')
  if (name === normalizedQuery) return 100
  let score = 0
  if (name.includes(normalizedQuery)) score += 60
  if (description.includes(normalizedQuery)) score += 30

  const queryPairs = bigrams(normalizedQuery)
  const candidatePairs = bigrams(`${name}${description}`)
  if (queryPairs.size > 0) {
    const matches = [...queryPairs].filter((pair) => candidatePairs.has(pair)).length
    score += (matches / queryPairs.size) * 20
  }
  return score
}

export const collectTemplateParameters = (nodes: RpaNode[]): string[] => {
  const parameters = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g)) {
        parameters.add(match[1])
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1))
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach((item) => visit(item, depth + 1))
    }
  }
  nodes.forEach((node) => visit(node.data, 0))
  return [...parameters].sort()
}

export const sanitizeWorkflowInputs = (value: unknown): Record<string, JsonValue> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const sanitized: Record<string, JsonValue> = Object.create(null)
  for (const [key, input] of Object.entries(value).slice(0, 50)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
    if (!/^[a-zA-Z_][\w.-]{0,79}$/.test(key)) continue
    const serialized = JSON.stringify(input)
    if (serialized === undefined) continue
    sanitized[key] = JSON.parse(serialized) as JsonValue
  }
  return sanitized
}

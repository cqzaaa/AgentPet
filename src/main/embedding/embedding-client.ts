import { createHash } from 'crypto'
import { getEmbeddingServiceToken } from '../security/embedding-service-token'

export const EMBEDDING_ENDPOINT = 'https://124.222.33.171/embed'
export const EMBEDDING_MODEL = 'BAAI/bge-m3@tei-cpu-1.5'
export const EMBEDDING_DIMENSIONS = 1024

const REQUEST_TIMEOUT_MS = 30_000
const MAX_BATCH_SIZE = 16

export function embeddingContentHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex')
}

function normalizeVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) return null
  const vector = value.map(Number)
  return vector.every(Number.isFinite) ? vector : null
}

export async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  const normalized = texts.map(text => String(text || '').trim())
  if (normalized.length === 0) return []
  if (normalized.length > MAX_BATCH_SIZE) {
    const results: Array<number[] | null> = []
    for (let offset = 0; offset < normalized.length; offset += MAX_BATCH_SIZE) {
      results.push(...await embedTexts(normalized.slice(offset, offset + MAX_BATCH_SIZE)))
    }
    return results
  }

  const token = getEmbeddingServiceToken()
  if (!token) {
    console.warn('[Embedding] Secure service token is not configured; using lexical fallback.')
    return normalized.map(() => null)
  }

  const nonEmptyIndexes = normalized.map((text, index) => text ? index : -1).filter(index => index >= 0)
  if (nonEmptyIndexes.length === 0) return normalized.map(() => null)
  const inputs = nonEmptyIndexes.map(index => normalized[index])
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(EMBEDDING_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: inputs.length === 1 ? inputs[0] : inputs }),
      signal: controller.signal
    })
    if (!response.ok) {
      console.error(`[Embedding] Service returned HTTP ${response.status}.`)
      return normalized.map(() => null)
    }
    const payload = await response.json() as unknown
    const rawVectors = inputs.length === 1 && Array.isArray(payload) && !Array.isArray(payload[0])
      ? [payload]
      : Array.isArray(payload) ? payload : []
    const results = normalized.map<number[] | null>(() => null)
    nonEmptyIndexes.forEach((originalIndex, resultIndex) => {
      results[originalIndex] = normalizeVector(rawVectors[resultIndex])
    })
    return results
  } catch (error: any) {
    if (error?.name === 'AbortError') console.error('[Embedding] Request timed out after 30 seconds.')
    else console.error('[Embedding] Request failed:', error?.message || error)
    return normalized.map(() => null)
  } finally {
    clearTimeout(timeout)
  }
}

export async function embedText(text: string): Promise<number[] | null> {
  return (await embedTexts([text]))[0] || null
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

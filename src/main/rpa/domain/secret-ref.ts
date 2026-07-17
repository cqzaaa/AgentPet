import type { JsonValue, RpaSecretRef, RpaValueSource } from './types'

const SECRET_REF_PATTERN = /^secret\.[a-z0-9][a-z0-9._-]{0,119}$/i
const SECRET_EXPRESSION_PATTERN = /^\$\{\s*(secret\.[a-z0-9][a-z0-9._-]{0,119})\s*\}$/i

export function isRpaSecretRef(value: string): value is RpaSecretRef {
  return SECRET_REF_PATTERN.test(value)
}

export function parseSecretExpression(value: unknown): RpaSecretRef | null {
  if (typeof value !== 'string') return null
  const match = SECRET_EXPRESSION_PATTERN.exec(value)
  return match && isRpaSecretRef(match[1]) ? match[1] : null
}

export function toRpaValueSource(value: JsonValue): RpaValueSource {
  const secretRef = parseSecretExpression(value)
  if (secretRef) return { type: 'secretRef', ref: secretRef }
  if (typeof value === 'string') {
    const variableMatch = /^\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}$/.exec(value)
    if (variableMatch) return { type: 'variable', name: variableMatch[1] }
  }
  return { type: 'literal', value }
}

export function containsSecretExpression(value: unknown): boolean {
  if (typeof value === 'string') return /\$\{\s*secret\./i.test(value)
  if (Array.isArray(value)) return value.some(containsSecretExpression)
  if (value && typeof value === 'object') return Object.values(value).some(containsSecretExpression)
  return false
}

export function sanitizeRuntimeValue(value: unknown, depth = 0): JsonValue {
  if (depth > 6) return '[truncated]'
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    return parseSecretExpression(value) ? value : value.slice(0, 500)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeRuntimeValue(item, depth + 1))
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = /user(name)?|pass(word)?|secret|token|api.?key|authorization|credential/i.test(key)
        ? '[redacted]'
        : sanitizeRuntimeValue(item, depth + 1)
    }
    return output
  }
  return String(value).slice(0, 500)
}

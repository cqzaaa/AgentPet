import { createHash } from 'crypto'

const DATA_URL = /^data:([^;,]+)?(?:;[^,]*)?,/i
const MAX_TRACE_DEPTH = 18
const SECRET_KEYS = new Set([
  'apikey', 'authorization', 'password', 'passwd', 'token', 'secret', 'cookie',
  'accesstoken', 'refreshtoken', 'bearertoken', 'authtoken', 'sessiontoken',
  'credential', 'credentials'
])

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.replace(/[_-]/g, '').toLocaleLowerCase())
}

function sanitizeString(value: string): string | Record<string, unknown> {
  const match = value.match(DATA_URL)
  if (!match) return value
  const comma = value.indexOf(',')
  const encodedLength = comma >= 0 ? value.length - comma - 1 : value.length
  return {
    kind: 'inline-binary',
    mimeType: match[1] || 'application/octet-stream',
    encodedLength,
    omitted: true
  }
}

/** Removes credentials and keeps large inline media out of the event database. */
export function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_TRACE_DEPTH) return '[maximum trace depth reached]'
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => sanitizeTraceValue(item, depth + 1))

  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? '[REDACTED]' : sanitizeTraceValue(child, depth + 1)
  }
  return output
}

export function traceFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sanitizeTraceValue(value))).digest('hex')
}

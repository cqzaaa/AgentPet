export const SESSION_LINK_PREFIX = 'agentpet://threads/'

export interface SessionReference {
  id: string
  url: string
}

export function sessionLink(id: string): string {
  return `${SESSION_LINK_PREFIX}${encodeURIComponent(id)}`
}

export function extractSessionReferences(text: string): SessionReference[] {
  const refs = new Map<string, SessionReference>()
  for (const match of text.matchAll(/agentpet:\/\/threads\/[A-Za-z0-9_%~.-]+/g)) {
    try {
      const id = decodeURIComponent(match[0].slice(SESSION_LINK_PREFIX.length))
      if (id && id.length <= 256 && !/[\s/\\\x00-\x1f]/.test(id)) {
        refs.set(id, { id, url: match[0] })
      }
    } catch { /* Malformed clipboard URLs remain ordinary text. */ }
  }
  return [...refs.values()]
}

export function removeSessionReferences(text: string): string {
  let result = text
  for (const { url } of extractSessionReferences(text)) result = result.split(`${url}\n`).join('').split(url).join('')
  return result
}

/** Only completed leading reference lines become chips; keep an in-progress typed URL editable. */
export function splitSessionReferenceDraft(value: string): { references: SessionReference[]; text: string } {
  const references: SessionReference[] = []
  let text = value
  while (true) {
    const newline = text.indexOf('\n')
    if (newline < 0) break
    const line = text.slice(0, newline)
    const ref = extractSessionReferences(line)[0]
    if (!ref || ref.url !== line) break
    references.push(ref)
    text = text.slice(newline + 1)
  }
  return { references, text }
}

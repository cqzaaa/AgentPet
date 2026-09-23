export type InspectionEvidence = {
  read?: { path: string; version: string; ranges: Array<{ start: number; end: number }>; truncated: boolean; unchanged: boolean; unresolved?: string }
  searches?: Array<{ question?: string; pattern: string; scope?: string; status: string; files?: string[]; locations?: string[]; unresolved?: string }>
}

const MARKER = '[代码检索检查点] '

export function inspectionEvidence(state: any): InspectionEvidence | undefined {
  if (state?.readEvidence) {
    const { path, version, ranges, truncated, unchanged, unresolved } = state.readEvidence
    return { read: { path, version, ranges, truncated, unchanged, unresolved } }
  }
  if (Array.isArray(state?.searchEvidence)) {
    return { searches: state.searchEvidence.slice(0, 6).map(item => ({
      question: item.question, pattern: item.pattern, scope: item.scope, status: item.status,
      files: item.files?.slice(0, 6), locations: item.locations?.slice(0, 3), unresolved: item.unresolved
    })) }
  }
  return undefined
}

export function formatInspectionEvidence(evidence: InspectionEvidence): string {
  return MARKER + JSON.stringify(evidence)
}

// Stored in modelResult, so the existing session-event store persists this without a second database.
export function parseInspectionEvidence(result: string): InspectionEvidence | undefined {
  const line = result.split(/\r?\n/, 1)[0]
  if (!line.startsWith(MARKER)) return
  try {
    const value = JSON.parse(line.slice(MARKER.length))
    if (value?.read && typeof value.read.path === 'string' && typeof value.read.version === 'string') return value
    if (Array.isArray(value?.searches)) return value
  } catch { /* Legacy tool outputs do not contain structured evidence. */ }
  return undefined
}

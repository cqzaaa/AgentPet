import type { SessionEventRecord } from './types'

type TraceEvent = Pick<SessionEventRecord, 'type' | 'time' | 'step' | 'data' | 'correlationId'>
const FILE_EDITS = new Set(['edit_file', 'edit_files', 'write_file', 'move_file', 'delete_file'])

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sum(values: Array<number | undefined>): number | null {
  const measured = values.filter((value): value is number => value !== undefined)
  return measured.length ? measured.reduce((total, value) => total + value, 0) : null
}

/** Measures existing events; does not add provider calls or store full requests again. */
export function summarizeTracePerformance(events: TraceEvent[]) {
  const start = events[0]?.time
  const calls = new Map<string, number>()
  const intervals: Array<[number, number]> = []
  const rounds: Array<{
    step?: number; totalMs?: number; firstChunkMs?: number
    promptTokens?: number; completionTokens?: number; reasoningTokens?: number; cachedTokens?: number
  }> = []
  const toolCounts: number[] = []
  let modelRequestCount = 0
  let firstFileEditMs: number | null = null
  let repeatedSearchCount = 0
  let measuredSearchCount = 0
  let multiToolResponseCount = 0
  let batchedSearchCount = 0
  const searchFingerprints = new Set<string>()
  for (const event of events) {
    const data = event.data as any
    if (event.type === 'model/request') {
      modelRequestCount++
      const tools = data.request?.body?.tools
      if (Array.isArray(tools)) toolCounts.push(tools.length)
    } else if (event.type === 'model/response') {
      const response = data.response
      const frames: any[] = response?.events || []
      const usage = [...frames].reverse().find(frame => frame?.usage)?.usage || response?.body?.usage
      rounds.push({
        step: event.step, totalMs: finite(response?.timing?.totalMs), firstChunkMs: finite(response?.timing?.firstChunkMs),
        promptTokens: finite(usage?.prompt_tokens), completionTokens: finite(usage?.completion_tokens),
        reasoningTokens: finite(usage?.completion_tokens_details?.reasoning_tokens),
        cachedTokens: finite(usage?.prompt_tokens_details?.cached_tokens)
      })
    } else if (event.type === 'assistant/message') {
      if (data.message?.tool_calls?.length > 1) multiToolResponseCount++
    } else if (event.type === 'tool/call') {
      const id = data.callId || event.correlationId
      if (id) calls.set(id, event.time)
      if (start !== undefined && firstFileEditMs === null && FILE_EDITS.has(data.name)) firstFileEditMs = Math.max(0, event.time - start)
      if (data.name === 'grep_content' && Array.isArray(data.arguments?.queries)) batchedSearchCount++
    } else if (event.type === 'tool/result') {
      const id = data.callId || event.correlationId
      const callStart = calls.get(id)
      if (callStart !== undefined) {
        intervals.push([callStart, Math.max(callStart, event.time)])
        calls.delete(id)
      }
      const result = String(data.modelResult || '')
      const marker = '[代码检索检查点] '
      if (result.startsWith(marker)) {
        try {
          const evidence = JSON.parse(result.split(/\r?\n/, 1)[0].slice(marker.length))
          for (const search of evidence.searches || []) {
            if (!search.fingerprint) continue
            measuredSearchCount++
            if (searchFingerprints.has(search.fingerprint)) repeatedSearchCount++
            searchFingerprints.add(search.fingerprint)
          }
        } catch { /* Legacy or truncated results have no machine-readable evidence. */ }
      }
      // A mutation may change the meaning of a subsequent identical search.
      if (FILE_EDITS.has(data.name)) searchFingerprints.clear()
    }
  }
  let toolBusyMs = 0
  let end = -Infinity
  for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
    toolBusyMs += Math.max(0, to - Math.max(from, end))
    end = Math.max(end, to)
  }
  return {
    wallMs: start === undefined ? null : Math.max(0, events[events.length - 1].time - start),
    modelRequestCount, measuredModelResponses: rounds.filter(round => round.totalMs !== undefined).length,
    modelRequestTotalMs: sum(rounds.map(round => round.totalMs)),
    modelFirstChunkTotalMs: sum(rounds.map(round => round.firstChunkMs)),
    toolCallTotalMs: sum(intervals.map(([from, to]) => to - from)), toolBusyMs,
    firstFileEditMs, measuredSearchCount, repeatedSearchCount: measuredSearchCount ? repeatedSearchCount : null,
    multiToolResponseCount, batchedSearchCount,
    minExposedTools: toolCounts.length ? Math.min(...toolCounts) : null,
    maxExposedTools: toolCounts.length ? Math.max(...toolCounts) : null,
    promptTokens: sum(rounds.map(round => round.promptTokens)),
    completionTokens: sum(rounds.map(round => round.completionTokens)),
    reasoningTokens: sum(rounds.map(round => round.reasoningTokens)),
    cachedTokens: sum(rounds.map(round => round.cachedTokens)),
    // Missing usage fields remain null, never estimates of zero usage or cost.
    rounds
  }
}

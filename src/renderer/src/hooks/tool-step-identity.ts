/** New events use a request-scoped call ID. Legacy rows only merge identical
 * payloads created at the same millisecond; progress may change timestamp later. */
export function toolStepKey(step: any): string | undefined {
  if (step.type !== 'call' && step.type !== 'result') return
  if (step.callId) return JSON.stringify([step.type, step.callId])
  const createdAt = Number(/^step-(\d+)-/.exec(String(step.id || ''))?.[1]) || step.timestamp
  if (!createdAt) return
  return JSON.stringify([step.type, step.name, createdAt, step.detail])
}

export function uniqueToolSteps<T>(steps: T[]): T[] {
  const seen = new Set<string>()
  return steps.filter(step => {
    const key = toolStepKey(step)
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

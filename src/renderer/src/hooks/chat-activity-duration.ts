/** Stored inside toolSteps so existing message persistence also retains elapsed time. */
export function recordActivityDuration(message: any, now = Date.now()): any {
  const steps = Array.isArray(message.toolSteps) ? message.toolSteps : []
  const timing = steps.find((step: any) => step.type === 'turnTiming')
  if (timing) {
    if (!timing.attemptStartedAt) return message
    return { ...message, toolSteps: steps.map((step: any) => step === timing
      ? { ...timing, durationMs: timing.durationMs + Math.max(0, now - timing.attemptStartedAt), attemptStartedAt: undefined, timestamp: now }
      : step) }
  }
  const startedAt = Number(message.id)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return message
  return {
    ...message,
    toolSteps: [...steps, {
      id: `timing-${message.id}`, type: 'turnTiming', timestamp: now,
      durationMs: Math.max(0, now - startedAt)
    }]
  }
}

export function resumeActivityDuration(message: any, now = Date.now()): any {
  const steps = Array.isArray(message.toolSteps) ? message.toolSteps : []
  const timing = steps.find((step: any) => step.type === 'turnTiming')
  const previousDuration = activityDurationMs(message) ?? 0
  const nextTiming = timing
    ? { ...timing, durationMs: previousDuration, attemptStartedAt: now }
    : { id: `timing-${message.id}`, type: 'turnTiming', timestamp: now, durationMs: previousDuration, attemptStartedAt: now }
  return { ...message, toolSteps: timing
    ? steps.map((step: any) => step === timing ? nextTiming : step)
    : [...steps, nextTiming] }
}

export function activityDurationMs(message: any): number | undefined {
  const steps = Array.isArray(message.toolSteps) ? message.toolSteps : []
  const timing = steps.find((step: any) => step.type === 'turnTiming')
  if (typeof timing?.durationMs === 'number') return timing.durationMs
  // Older messages have no completion marker; use their last recorded activity.
  const timestamps = steps.map((step: any) => Number(step.timestamp) || Number(String(step.id).match(/^step-(\d+)-/)?.[1]))
    .filter((value: number) => Number.isFinite(value) && value > 0)
  const startedAt = Number(message.id)
  return timestamps.length && Number.isFinite(startedAt) && startedAt > 0
    ? Math.max(0, Math.max(...timestamps) - startedAt) : undefined
}

export function formatActivityDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}秒`
  const remainder = seconds % 60
  return `${Math.floor(seconds / 60)}分${remainder ? `${remainder}秒` : ''}`
}

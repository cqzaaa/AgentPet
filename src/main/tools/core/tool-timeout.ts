export function resolveToolTimeout(
  manifestTimeout: number | undefined,
  args: any,
  timeoutSchema: Record<string, any> = {}
): number {
  let timeoutMs = manifestTimeout ?? 30000
  if (args && typeof args.timeout_seconds === 'number') {
    const minimum = Number(timeoutSchema.minimum) || 1
    const maximum = Number(timeoutSchema.maximum) || 3600
    timeoutMs = Math.min(Math.max(args.timeout_seconds, minimum), maximum) * 1000
  }
  return timeoutMs
}

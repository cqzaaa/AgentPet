export const DEFAULT_CONTEXT_WINDOW = 258000
export const MIN_CONTEXT_WINDOW = 32000
export const MAX_CONTEXT_WINDOW = 500000
export const SINGLE_ATTACHMENT_RATIO = 0.05
export const TOTAL_ATTACHMENT_RATIO = 0.2

export function normalizeContextWindow(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.floor(parsed)))
    : DEFAULT_CONTEXT_WINDOW
}

/**
 * Join a response fragment received before an interrupted stream with the
 * continuation returned by the recovery request. Providers sometimes repeat
 * a short suffix when continuing, so remove only an exact overlap.
 */
export function mergeStreamContinuation(prefix: string, continuation: string): string {
  if (!prefix) return continuation
  if (!continuation) return prefix

  const maximumOverlap = Math.min(prefix.length, continuation.length, 4000)
  for (let length = maximumOverlap; length > 0; length--) {
    if (prefix.slice(-length) === continuation.slice(0, length)) {
      return prefix + continuation.slice(length)
    }
  }
  return prefix + continuation
}

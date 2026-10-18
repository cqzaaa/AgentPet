/** Detect broken PDF character maps without treating ordinary scientific notation as noise. */
export function textCorruptionRatio(text: string): number {
  const visibleLength = text.replace(/\s/g, '').length
  if (!visibleLength) return 0
  const damaged = [...text.matchAll(/\uFFFD|\/G[0-9A-F]{2,4}|\(cid:\d+\)/gi)]
    .reduce((sum, match) => sum + match[0].length, 0)
  return damaged / visibleLength
}

export function hasCorruptText(text: string): boolean {
  return textCorruptionRatio(text) > 0.02
}

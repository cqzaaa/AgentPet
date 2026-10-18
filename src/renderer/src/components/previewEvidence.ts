import type { WikiEvidenceRegion } from '../../../preload/wiki-types'

// Match the viewer's rendered text, including PDF sentences split across text-layer spans.
// Keep offsets into the original nodes; never rewrite the viewer's DOM or invent a match.
export function findPreviewQuote(root: HTMLElement, quote: string): Range | null {
  const normalize = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, '')
  const query = normalize(quote)
  if (!query) return null
  const positions: Array<{ node: Text; start: number; end: number }> = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (
        !parent ||
        parent.closest(
          'script, style, button, input, textarea, select, [hidden], [aria-hidden="true"]'
        )
      ) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let current: Node | null
  while ((current = walker.nextNode())) {
    let offset = 0
    for (const character of current.textContent || '') {
      const normalized = normalize(character)
      text += normalized
      for (let index = 0; index < normalized.length; index++) {
        positions.push({ node: current as Text, start: offset, end: offset + character.length })
      }
      offset += character.length
    }
  }
  const index = text.indexOf(query)
  if (index < 0) return null
  const start = positions[index]
  const end = positions[index + query.length - 1]
  const range = document.createRange()
  range.setStart(start.node, start.start)
  range.setEnd(end.node, end.end)
  return range
}
export function rotateEvidenceRegion(
  region: WikiEvidenceRegion,
  rotation: number
): WikiEvidenceRegion {
  const { x, y, width, height } = region
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { ...region, x: 1 - y - height, y: x, width: height, height: width }
    case 180:
      return { ...region, x: 1 - x - width, y: 1 - y - height }
    case 270:
      return { ...region, x: y, y: 1 - x - width, width: height, height: width }
    default:
      return region
  }
}

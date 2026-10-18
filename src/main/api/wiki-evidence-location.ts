import { promises as fs } from 'fs'
import { PDFDocument } from 'pdf-lib'
import type { WikiEvidenceLocation, WikiEvidenceRegion } from '../../preload/wiki-types'

interface PageSize {
  width: number
  height: number
  rotation: number
}
const dimensionsCache = new Map<string, Promise<PageSize[]>>()

export function sourceRegions(sourceMeta: string, pages: PageSize[]): WikiEvidenceRegion[] {
  let sources: unknown
  try {
    sources = JSON.parse(sourceMeta).sources
  } catch {
    return []
  }
  if (!Array.isArray(sources)) return []
  return sources.flatMap((source) => {
    const size = pages[source?.page - 1]
    if (
      !size ||
      size.rotation % 360 !== 0 ||
      !Number.isInteger(source.page) ||
      !Array.isArray(source.bbox) ||
      source.bbox.length !== 4 ||
      !source.bbox.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) ||
      !['BOTTOMLEFT', 'TOPLEFT'].includes(source.coordOrigin)
    )
      return []
    const [left, top, right, bottom] = source.bbox as number[]
    const x = Math.min(left, right) / size.width
    const y =
      (source.coordOrigin === 'BOTTOMLEFT'
        ? size.height - Math.max(top, bottom)
        : Math.min(top, bottom)) / size.height
    const width = Math.abs(right - left) / size.width
    const height = Math.abs(bottom - top) / size.height
    // Reject stale/invalid geometry rather than drawing a plausible but wrong box.
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= 1 ||
      y >= 1 ||
      x + width > 1.001 ||
      y + height > 1.001
    )
      return []
    return [
      { page: source.page, x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) }
    ]
  })
}

export async function loadEvidenceLocation(
  filePath: string,
  sourceMeta: string,
  indexed: { size: number; modifiedAt: number }
): Promise<WikiEvidenceLocation> {
  const stat = await fs.stat(filePath)
  if (stat.size !== indexed.size || Math.abs(stat.mtimeMs - indexed.modifiedAt) > 1) {
    return { regions: [], reason: '文件已变更，请同步后重新定位。' }
  }
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`
  let pending = dimensionsCache.get(key)
  if (!pending) {
    pending = fs.readFile(filePath).then(async (bytes) => {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
      return pdf
        .getPages()
        .map((page) => ({ ...page.getSize(), rotation: page.getRotation().angle }))
    })
    if (dimensionsCache.size >= 8) dimensionsCache.delete(dimensionsCache.keys().next().value!)
    dimensionsCache.set(key, pending)
    void pending.catch(() => dimensionsCache.delete(key))
  }
  const regions = sourceRegions(sourceMeta, await pending)
  return { regions, ...(!regions.length ? { reason: '此证据没有可用的原页坐标。' } : {}) }
}

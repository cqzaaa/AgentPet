import { app } from 'electron'
import { createHash } from 'crypto'
import * as fs from 'fs'
import JSZip from 'jszip'
import { basename, extname, join } from 'path'

export interface DocumentMediaAsset {
  imagePath: string
  extension: string
  byteSize: number
  sourcePart: string
  role: 'figure'
  analysisStatus: 'pending'
}

export interface DocumentMediaStore {
  assetDir: string
  save: (bytes: Buffer, suggestedName: string, sourcePart: string) => Promise<DocumentMediaAsset>
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff'
}

function safeExtension(name: string): string {
  const extension = extname(name).slice(1).toLowerCase().replace('jpeg', 'jpg')
  return /^[a-z0-9]{2,5}$/.test(extension) ? extension : 'png'
}

export async function createDocumentMediaStore(filePath: string): Promise<DocumentMediaStore> {
  const stat = await fs.promises.stat(filePath)
  const assetKey = createHash('sha1')
    .update(`${filePath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 20)
  const assetDir = join(app.getPath('userData'), 'knowledge-assets', assetKey, 'images')
  await fs.promises.mkdir(assetDir, { recursive: true })

  return {
    assetDir,
    async save(bytes, suggestedName, sourcePart) {
      const digest = createHash('sha1').update(bytes).digest('hex')
      const extension = safeExtension(suggestedName)
      const stem = basename(suggestedName, extname(suggestedName))
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'image'
      const imagePath = join(assetDir, `${stem}-${digest.slice(0, 12)}.${extension}`)
      try {
        await fs.promises.access(imagePath)
      } catch {
        await fs.promises.writeFile(imagePath, bytes)
      }
      return {
        imagePath,
        extension,
        byteSize: bytes.length,
        sourcePart,
        role: 'figure',
        analysisStatus: 'pending'
      }
    }
  }
}

export async function extractOoxmlMedia(
  filePath: string,
  store: DocumentMediaStore,
  mediaRoot: 'ppt/media/' | 'xl/media/'
): Promise<Map<string, DocumentMediaAsset>> {
  const archive = await JSZip.loadAsync(await fs.promises.readFile(filePath))
  const assets = new Map<string, DocumentMediaAsset>()
  const entries = Object.values(archive.files)
    .filter(entry => !entry.dir && entry.name.startsWith(mediaRoot))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const entry of entries) {
    const bytes = await entry.async('nodebuffer')
    if (bytes.length < 128) continue
    assets.set(entry.name, await store.save(bytes, basename(entry.name), entry.name))
  }
  return assets
}

export function decodeDataImage(source: string): { bytes: Buffer; extension: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(source.trim())
  if (!match) return null
  const extension = MIME_EXTENSIONS[match[1].toLowerCase()]
  if (!extension) return null
  try {
    return { bytes: Buffer.from(match[2], 'base64'), extension }
  } catch {
    return null
  }
}

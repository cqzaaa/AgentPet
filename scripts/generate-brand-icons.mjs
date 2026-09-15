import { createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererAssets = path.join(repoRoot, 'src', 'renderer', 'src', 'assets')
const appIconSource = path.join(rendererAssets, 'agentpet-app-icon.png')

async function renderSquare(inputPath, size, paddingRatio = 0) {
  const image = await loadImage(inputPath)
  const sample = createCanvas(image.width, image.height)
  const sampleContext = sample.getContext('2d')
  sampleContext.drawImage(image, 0, 0)
  const pixels = sampleContext.getImageData(0, 0, image.width, image.height).data

  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (pixels[(y * image.width + x) * 4 + 3] > 8) {
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
  }
  if (right < left || bottom < top) throw new Error(`No visible pixels in ${inputPath}`)

  const sourceWidth = right - left + 1
  const sourceHeight = bottom - top + 1
  const padding = Math.round(size * paddingRatio)
  const targetSize = size - padding * 2
  const scale = Math.min(targetSize / sourceWidth, targetSize / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale

  const canvas = createCanvas(size, size)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    left,
    top,
    sourceWidth,
    sourceHeight,
    (size - drawWidth) / 2,
    (size - drawHeight) / 2,
    drawWidth,
    drawHeight
  )
  return canvas.toBuffer('image/png')
}

function createIco(images) {
  const headerSize = 6 + images.length * 16
  let offset = headerSize
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })

  return Buffer.concat([header, ...images.map(({ data }) => data)])
}

function createIcns(images) {
  const typeBySize = new Map([
    [16, 'icp4'],
    [32, 'icp5'],
    [64, 'icp6'],
    [128, 'ic07'],
    [256, 'ic08'],
    [512, 'ic09'],
    [1024, 'ic10']
  ])
  const chunks = images.map(({ size, data }) => {
    const chunk = Buffer.alloc(8 + data.length)
    chunk.write(typeBySize.get(size), 0, 4, 'ascii')
    chunk.writeUInt32BE(chunk.length, 4)
    data.copy(chunk, 8)
    return chunk
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}

await mkdir(path.join(repoRoot, 'build'), { recursive: true })
await mkdir(path.join(repoRoot, 'resources'), { recursive: true })

const appIcon1024 = await renderSquare(appIconSource, 1024, 0.02)
const appIcon512 = await renderSquare(appIconSource, 512, 0.02)
await writeFile(appIconSource, appIcon1024)
await writeFile(path.join(rendererAssets, 'icon.png'), appIcon512)
await writeFile(path.join(repoRoot, 'resources', 'icon.png'), appIcon1024)
await writeFile(path.join(repoRoot, 'build', 'icon.png'), appIcon512)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoImages = await Promise.all(
  icoSizes.map(async (size) => ({
    size,
    data: await renderSquare(appIconSource, size, 0.02)
  }))
)
await writeFile(path.join(repoRoot, 'build', 'icon.ico'), createIco(icoImages))

const icnsSizes = [16, 32, 64, 128, 256, 512, 1024]
const icnsImages = await Promise.all(
  icnsSizes.map(async (size) => ({
    size,
    data: await renderSquare(appIconSource, size, 0.02)
  }))
)
await writeFile(path.join(repoRoot, 'build', 'icon.icns'), createIcns(icnsImages))

const markSource = path.join(rendererAssets, 'agentpet-mark.png')
await writeFile(markSource, await renderSquare(markSource, 512, 0.04))

const sizes = await Promise.all(
  [
    appIconSource,
    path.join(repoRoot, 'resources', 'icon.png'),
    path.join(repoRoot, 'build', 'icon.png'),
    path.join(repoRoot, 'build', 'icon.ico'),
    path.join(repoRoot, 'build', 'icon.icns'),
    markSource
  ].map(async (file) => ({
    file: path.relative(repoRoot, file),
    bytes: (await readFile(file)).length
  }))
)

console.table(sizes)

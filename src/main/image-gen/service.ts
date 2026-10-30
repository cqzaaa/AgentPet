import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { extname, isAbsolute, join } from 'path'
import { loadSecureSystemLlmConfig } from '../security/secure-llm-config'
import type {
  ImageGenerationOptions,
  ImageGenerationResult
} from '../../preload/image-generation-types'

export type { ImageGenerationOptions, ImageGenerationResult } from '../../preload/image-generation-types'

interface ImageApiItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

interface ImageApiResponse {
  data?: ImageApiItem[]
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_IMAGE_MODEL = 'dall-e-3'
const DEFAULT_IMAGE_SIZE = '1024x1024'

function configuredImageModel(config: Record<string, unknown>): string | undefined {
  for (const key of ['imageModel', 'imageGenerationModel', 'imageGenModel']) {
    const value = config[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function contentTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return 'image/png'
  }
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes('jpeg')) return '.jpg'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('gif')) return '.gif'
  return '.png'
}

async function responseError(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim()
  try {
    const body = await response.text()
    if (!body) return fallback
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message
    if (typeof parsed.message === 'string') return parsed.message
    return body.slice(0, 500)
  } catch {
    return fallback
  }
}

async function readApiImage(item: ImageApiItem): Promise<{ bytes: Buffer; contentType: string }> {
  if (item.b64_json) {
    const match = item.b64_json.match(/^data:([^;,]+);base64,(.+)$/s)
    const contentType = match?.[1] || 'image/png'
    const encoded = match?.[2] || item.b64_json
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length === 0) throw new Error('图像接口返回了空的 base64 数据')
    return { bytes, contentType }
  }

  if (!item.url) throw new Error('图像接口响应中缺少 b64_json 或 url')
  let imageUrl: URL
  try {
    imageUrl = new URL(item.url)
  } catch {
    throw new Error('图像接口返回了无效的图片 URL')
  }
  if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') {
    throw new Error('图像接口返回了不受支持的图片 URL 协议')
  }

  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error(`下载生成图片失败：${await responseError(response)}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('下载到的生成图片为空')
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || 'image/png'
  return { bytes, contentType }
}

async function persistImage(bytes: Buffer, contentType: string): Promise<string> {
  const outputDir = join(app.getPath('userData'), 'generated_files', 'images')
  await mkdir(outputDir, { recursive: true })
  const filePath = join(outputDir, `${Date.now()}-${randomUUID()}${extensionForContentType(contentType)}`)
  await writeFile(filePath, bytes)
  return filePath
}

async function createRequest(
  endpoint: string,
  options: ImageGenerationOptions,
  apiKey: string,
  model: string,
  size: string
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  if (!options.imagePath) {
    headers['Content-Type'] = 'application/json'
    return fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: options.prompt.trim(), model, size, n: 1 })
    })
  }

  if (!isAbsolute(options.imagePath)) {
    throw new Error('参考图片路径必须是本地绝对路径')
  }
  const imageStats = await stat(options.imagePath)
  if (!imageStats.isFile()) throw new Error('参考图片路径不是文件')
  const imageBytes = await readFile(options.imagePath)
  const form = new FormData()
  form.append(
    'image',
    new Blob([new Uint8Array(imageBytes)], { type: contentTypeForPath(options.imagePath) }),
    `image${extname(options.imagePath) || '.png'}`
  )
  form.append('prompt', options.prompt.trim())
  form.append('model', model)
  form.append('size', size)
  form.append('n', '1')
  return fetch(endpoint, { method: 'POST', headers, body: form })
}

export async function generateImage(
  options: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  try {
    if (!options || typeof options !== 'object') {
      throw new Error('缺少图像生成参数')
    }
    if (typeof options.prompt !== 'string' || !options.prompt.trim()) {
      throw new Error('图像提示词不能为空')
    }

    const systemConfig = loadSecureSystemLlmConfig()
    const apiKey = (options.config?.apiKey ?? systemConfig.apiKey ?? '').trim()
    const baseUrl = (options.config?.baseUrl ?? systemConfig.baseUrl ?? DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, '')
    if (!baseUrl) throw new Error('未配置图像接口地址')

    const model =
      options.model?.trim() ||
      configuredImageModel(systemConfig) ||
      DEFAULT_IMAGE_MODEL
    const size = options.size?.trim() || DEFAULT_IMAGE_SIZE
    const operation = options.imagePath ? 'edits' : 'generations'
    const endpoint = `${baseUrl}/images/${operation}`
    const response = await createRequest(endpoint, options, apiKey, model, size)

    if (!response.ok) {
      const detail = await responseError(response)
      if (options.imagePath) {
        throw new Error(
          `图像编辑失败：${detail}。当前模型或服务可能不支持 /images/edits，请检查其图像编辑能力与模型配置。`
        )
      }
      throw new Error(`图像生成失败：${detail}`)
    }

    const payload = (await response.json()) as ImageApiResponse
    const item = payload.data?.[0]
    if (!item) throw new Error('图像接口响应中没有可用图片')
    const { bytes, contentType } = await readApiImage(item)
    const imagePath = await persistImage(bytes, contentType)

    return {
      success: true,
      imagePath,
      dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
      ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {})
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { extname, isAbsolute, join } from 'path'
import { loadSecureSystemLlmConfig } from '../security/secure-llm-config'
import {
  type ImageGenerationOptions,
  type ImageGenerationResult,
  filterImageModels
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
const DEFAULT_IMAGE_SIZE = '1024x1024'

// 内存短期缓存，避免频繁请求 /models 接口（30 秒有效）
let cachedModelsKey = ''
let cachedImageModels: string[] = []
let cacheTimestamp = 0

export function configuredImageModel(config: Record<string, unknown>): string | undefined {
  for (const key of ['imageModel', 'imageGenerationModel', 'imageGenModel']) {
    const value = config[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * 从指定服务端点获取并使用正则过滤出生图模型列表
 */
export async function getAvailableImageModels(
  baseUrl?: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<string[]> {
  const systemConfig = loadSecureSystemLlmConfig()
  const effectiveBaseUrl = (baseUrl ?? systemConfig.baseUrl ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
  const effectiveApiKey = (apiKey ?? systemConfig.apiKey ?? '').trim()

  if (!effectiveBaseUrl) return []

  const cacheKey = `${effectiveBaseUrl}:::${effectiveApiKey}`
  const now = Date.now()
  if (cacheKey === cachedModelsKey && now - cacheTimestamp < 30000 && cachedImageModels.length > 0) {
    return [...cachedImageModels]
  }

  try {
    const url = `${effectiveBaseUrl}/models`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (effectiveApiKey) headers['Authorization'] = `Bearer ${effectiveApiKey}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const response = await fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timeout))
    if (!response.ok) return cachedImageModels

    const data: any = await response.json()
    const allModels: string[] = []
    if (data && Array.isArray(data.data)) {
      allModels.push(...data.data.map((m: any) => (typeof m === 'string' ? m : m.id)).filter(Boolean))
    } else if (data && Array.isArray(data.models)) {
      allModels.push(...data.models.map((m: any) => (typeof m === 'string' ? m : m.name || m.id)).filter(Boolean))
    }

    const matched = filterImageModels(allModels)
    if (matched.length > 0) {
      cachedModelsKey = cacheKey
      cachedImageModels = matched
      cacheTimestamp = now
    }
    return matched
  } catch (err) {
    console.warn('获取生图模型列表失败，将使用已缓存或已配置模型:', err)
    return cachedImageModels
  }
}

/**
 * 解析并确定最终用于生成图片的模型：
 * 1. 显式指定的模型
 * 2. 系统中显式配置的生图模型
 * 3. 动态通过正则过滤服务商的模型列表，默认使用第一个
 * 4. 若均无则明确报错，绝不使用兜底模型
 */
export async function resolveImageModel(
  requestedModel?: string,
  baseUrl?: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<string> {
  const trimmed = requestedModel?.trim()
  if (trimmed) return trimmed

  const systemConfig = loadSecureSystemLlmConfig()
  const configured = configuredImageModel(systemConfig)
  if (configured) return configured

  const matched = await getAvailableImageModels(baseUrl, apiKey, signal)
  if (matched.length > 0) {
    return matched[0]
  }

  throw new Error('未检测到可用的生图模型，请在模型配置中指定生图模型，或确认当前服务商提供了包含图像生成能力（如带有 image/flux/sd 等）的模型。')
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

async function readApiImage(item: ImageApiItem, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
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

  const response = await fetch(imageUrl, { signal })
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
  size: string,
  signal?: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  if (!options.imagePath) {
    headers['Content-Type'] = 'application/json'
    return fetch(endpoint, {
      method: 'POST',
      signal,
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
  return fetch(endpoint, { method: 'POST', headers, body: form, signal })
}

export async function generateImage(
  options: ImageGenerationOptions,
  signal?: AbortSignal
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

    // 确定生图模型：用户指定 -> 系统显式配置 -> 正则过滤首个模型 -> 无则抛错（严禁全局兜底）
    const model = await resolveImageModel(options.model, baseUrl, apiKey, signal)
    const size = options.size?.trim() || DEFAULT_IMAGE_SIZE
    const operation = options.imagePath ? 'edits' : 'generations'
    const endpoint = `${baseUrl}/images/${operation}`
    const response = await createRequest(endpoint, options, apiKey, model, size, signal)

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
    const { bytes, contentType } = await readApiImage(item, signal)
    signal?.throwIfAborted()
    const imagePath = await persistImage(bytes, contentType)

    return {
      success: true,
      model,
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

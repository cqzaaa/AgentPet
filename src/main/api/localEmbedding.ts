import { pipeline, env } from '@xenova/transformers'
import { join } from 'path'
import { getActiveStorageDir } from '../tools/utils/paths'

let extractor: any = null
let isInitializing = false

// 设置本地向量模型缓存目录到统一的 AppData/agentpet/models 下
env.cacheDir = join(getActiveStorageDir(), 'models')

// 配置国内高速镜像源，防止下载连接挂起并占满 Node.js 全局网络通道，导致大模型请求排队卡死
env.remoteHost = 'https://hf-mirror.com'

/**
 * 提取文本的本地 Embedding 向量 (使用 Xenova/bge-m3)
 * 该模型支持 100+ 语言（中英文极佳），最大上下文 8192，向量输出为 1024 维。
 */
export async function getLocalEmbedding(text: string): Promise<number[] | null> {
  try {
    if (!extractor) {
      if (isInitializing) {
        console.log('[LocalEmbedding] 本地向量模型正在后台下载/初始化中，临时跳过以避免阻塞提问，降级至 API 方案')
        return null
      }
      
      // 如果没有在初始化，且 extractor 为空，说明启动初始化可能失败或未触发，我们在后台异步重新触发，本次直接降级
      console.log('[LocalEmbedding] 本地模型未就绪，已在后台异步启动初始化，本次降级至 API 方案')
      initLocalEmbedding().catch(() => {})
      return null
    }

    // 计算特征
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    const embedding = Array.from(output.data) as number[]

    // 给 CPU 一个喘息的机会，释放事件循环以防 UI 卡顿
    await new Promise((resolve) => setTimeout(resolve, 5))

    return embedding
  } catch (error) {
    console.error('[LocalEmbedding] 本地提取向量异常:', error)
    return null
  }
}

/**
 * 启动时预初始化本地向量模型（自动检查并下载）
 */
export async function initLocalEmbedding(): Promise<void> {
  if (extractor || isInitializing) return
  isInitializing = true
  try {
    console.log(`[LocalEmbedding] 启动预初始化本地向量模型，存储路径: ${env.cacheDir}`)
    
    // 首次加载会自动从 HuggingFace 镜像下载 bge-m3 量化版 ONNX 模型 (约 270MB)
    extractor = await pipeline('feature-extraction', 'Xenova/bge-m3')
    console.log('[LocalEmbedding] 启动预初始化本地 BGE-M3 向量模型成功')
  } catch (error) {
    console.error('[LocalEmbedding] 启动预初始化本地向量模型失败:', error)
  } finally {
    isInitializing = false
  }
}

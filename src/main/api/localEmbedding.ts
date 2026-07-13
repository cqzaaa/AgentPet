/**
 * 提取文本的 Embedding 向量 (已切换为云端 BGE-M3 向量接口)
 * 该服务运行在云端 Docker 容器中，最大上下文 8192，向量输出为 1024 维。
 */
export async function getLocalEmbedding(text: string): Promise<number[] | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch('http://124.222.33.171:8080/embed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: text }),
      signal: controller.signal
    })

    if (!response.ok) {
      console.error(`[Embedding] 云端 API 响应异常: ${response.status} ${response.statusText}`)
      return null
    }

    const data = (await response.json()) as any

    // 兼容返回结果：一维数组 [0.1, -0.2, ...] 或 二维数组 [[0.1, -0.2, ...]]
    if (Array.isArray(data)) {
      if (Array.isArray(data[0])) {
        return data[0] as number[]
      }
      return data as number[]
    }

    console.warn('[Embedding] 云端 API 返回的向量格式不符:', data)
    return null
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error('[Embedding] 提取向量超时熔断 (10s)')
      throw new Error('TIMEOUT')
    }
    console.error('[Embedding] 提取云端向量异常:', error)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 启动时预初始化本地向量模型
 * 现已成功切换为云端接口，此处仅做日志说明，不再加载本地 ONNX 推理模块以节省内存
 */
export async function initLocalEmbedding(): Promise<void> {
  console.log('[LocalEmbedding] 当前已启用云端向量提取 API (http://124.222.33.171:8080/embed)，无需下载与初始化本地模型权重')
}

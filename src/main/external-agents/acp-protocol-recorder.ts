import type { ExternalAgentProtocolEvent } from './types'

type AcpWireDirection = ExternalAgentProtocolEvent['direction']

/**
 * 从 JSON-RPC 2.0 报文对象中安全提取 id 字段
 * 规范允许 id 为 string、number 或 null（通知类消息不含 id）
 */
function wireMessageId(value: unknown): string | number | null | undefined {
  if (!value || typeof value !== 'object' || !('id' in value)) return undefined
  const id = (value as { id?: unknown }).id
  if (id === null) return null
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

/**
 * 从 JSON-RPC 2.0 报文对象中安全提取 method 方法名
 */
function wireMessageMethod(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('method' in value)) return undefined
  const method = (value as { method?: unknown }).method
  return typeof method === 'string' ? method : undefined
}

/** Shared message audit for object streams and stdio wire taps. */
export function createAcpProtocolRecorder(
  onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>
) {
  // 维护待响应请求队列，用于响应到达时找回对应的 method
  const pendingClientRequests = new Map<string, string>() // Client -> Agent 的请求 (id -> method)
  const pendingAgentRequests = new Map<string, string>()  // Agent -> Client 的反向请求 (id -> method)

  return async (direction: AcpWireDirection, payload: unknown, byteLength: number): Promise<void> => {
    if (!onProtocolEvent) return
    const method = wireMessageMethod(payload)
    const id = wireMessageId(payload)
    
    // 判断 JSON-RPC 2.0 报文类型：批量、通知（无 id）、请求（有 id 有 method）、响应（有 id 无 method）
    const messageType: ExternalAgentProtocolEvent['messageType'] = Array.isArray(payload)
      ? 'batch'
      : method
        ? id === undefined ? 'notification' : 'request'
        : id !== undefined ? 'response' : 'invalid'
    let correlatedMethod = method

    // 请求报文：登记进入 pending 队列
    if (messageType === 'request' && id !== undefined) {
      const requests = direction === 'client_to_agent' ? pendingClientRequests : pendingAgentRequests
      // 防止极端情况下请求泄露导致 Map 持续膨胀，限制最大容量为 1024
      if (requests.size >= 1024) requests.delete(requests.keys().next().value!)
      requests.set(String(id), method || '')
    } else if (messageType === 'response' && id !== undefined) {
      // 响应报文：反向查找最初发出的 method，实现请求-响应闭环追踪
      const requests = direction === 'client_to_agent' ? pendingAgentRequests : pendingClientRequests
      correlatedMethod = requests.get(String(id)) || undefined
      requests.delete(String(id))
    }

    await onProtocolEvent({
      protocol: 'acp-v1',
      direction,
      messageType,
      method: correlatedMethod,
      id,
      byteLength,
      payload
    })
  }
}

const BYTES_PER_TOKEN = 4

export function countTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
  if (!text) return 0
  try {
    // 快速估算 (1 token ~ 4 bytes in Chinese/English average)
    return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN)
  } catch (e) {
    return Math.ceil(text.length / 4)
  }
}

export function countMessagesTokens(messages: any[]): number {
  let total = 0
  for (const msg of messages) {
    total += Array.isArray(msg.content)
      ? msg.content.reduce((sum: number, block: any) => sum + (block?.type === 'image_url'
        // Image tokens depend on the provider/resolution, never on Base64 string length.
        ? (block.image_url?.detail === 'low' ? 256 : 2048)
        : countTokens(block?.text ?? block)), 0)
      : countTokens(msg.content || '')
    total += 4 // 消息开销
    if (msg.tool_calls) {
      total += countTokens(JSON.stringify(msg.tool_calls))
    }
  }
  return total
}

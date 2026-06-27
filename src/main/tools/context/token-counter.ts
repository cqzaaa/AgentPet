const BYTES_PER_TOKEN = 4

export function countTokens(text: string): number {
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
    total += countTokens(msg.content || '')
    total += 4 // 消息开销
    if (msg.tool_calls) {
      total += countTokens(JSON.stringify(msg.tool_calls))
    }
  }
  return total
}

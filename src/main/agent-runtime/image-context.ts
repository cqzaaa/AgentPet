import type { ChatMessage } from '../model-runtime'

const MAX_HISTORICAL_IMAGE_MESSAGES = 2
const MAX_HISTORICAL_IMAGES = 8

/** Keep recent visual references across text-only follow-ups without resending every image. */
export function retainRecentImageMessages(messages: ChatMessage[]): ChatMessage[] {
  const latestUserIndex = messages.findLastIndex(message => message.role === 'user')
  const retainedCounts = new Map<number, number>()
  let remaining = MAX_HISTORICAL_IMAGES
  for (let index = latestUserIndex - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index]
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    const count = message.content.filter(block => block?.type === 'image_url').length
    if (count === 0) continue
    const retained = Math.min(count, remaining)
    retainedCounts.set(index, retained)
    remaining -= retained
    if (retainedCounts.size >= MAX_HISTORICAL_IMAGE_MESSAGES) break
  }

  return messages.map((message, index) => {
    if (message.role !== 'user' || index === latestUserIndex || !Array.isArray(message.content)) return message
    let remainingImages = retainedCounts.get(index) || 0
    let omitted = 0
    const content = message.content.filter(block => {
      if (block?.type !== 'image_url') return true
      if (remainingImages > 0) {
        remainingImages--
        return true
      }
      omitted++
      return false
    })
    if (omitted > 0) {
      content.push({
        type: 'text',
        text: `[有 ${omitted} 张历史图片未重复注入；需要查看时请用 read_file 读取对应源文件路径，图片将通过多模态通道返回。]`
      })
    }
    return { ...message, content }
  })
}

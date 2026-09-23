import type { ChatStreamUpdate } from '../../../preload/chat-stream'

export function replyTextWithRetryBase(message: any, text: string): string {
  const base = String(message.retryBaseText || '')
  return base && text ? `${base}\n\n${text}` : base || text
}

/** Keep intermediate prose durable, and reserve message.text for the final answer. */
export function applyChatStreamUpdate(message: any, update: ChatStreamUpdate): any {
  if (!message.isThinking) return message
  if (!update.itemId) return { ...message, text: (message.text || '') + update.content }
  const steps = message.toolSteps || []
  if (update.phase === 'start' || update.phase === 'final') {
    return {
      ...message,
      text: update.phase === 'final' ? replyTextWithRetryBase(message, update.content) : String(message.retryBaseText || ''),
      toolSteps: steps.filter((step: any) => !step.isStreamingCommentary)
    }
  }
  const id = `commentary-${update.itemId}`
  const previous = steps.find((step: any) => step.id === id)
  const detail = update.phase === 'commentary'
    ? update.content
    : (previous?.detail || '') + update.content
  const remaining = steps.filter((step: any) => step.id !== id)
  if (detail) remaining.push({
    id, type: 'commentary', detail,
    timestamp: previous?.timestamp ?? update.timestamp ?? Date.now(),
    isStreamingCommentary: update.phase !== 'commentary'
  })
  // Tool events are batched separately; arrival at React is not execution order.
  remaining.sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0))
  return { ...message, toolSteps: remaining }
}

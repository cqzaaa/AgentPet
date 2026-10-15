/** Tool activity delivered to chat subscribers. callId is scoped to a model request. */
export interface ChatToolEvent {
  type: string
  callId?: string
  name?: string
  sessionId?: string
  messageId?: string | number
  timestamp?: number
  [key: string]: any
}

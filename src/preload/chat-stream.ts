/** Text updates for one model request within an agent turn. */
export interface ChatStreamUpdate {
  content: string
  sessionId?: string
  messageId?: number
  itemId?: string
  timestamp?: number
  phase?: 'start' | 'delta' | 'commentary' | 'final'
}

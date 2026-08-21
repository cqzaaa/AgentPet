export type SessionEventSource =
  | 'user'
  | 'assistant'
  | 'model'
  | 'tool'
  | 'system'
  | 'context'
  | 'subagent'

export interface SessionEventInput {
  type: string
  source: SessionEventSource
  data?: Record<string, unknown>
  turn?: number
  step?: number
  correlationId?: string
  messageId?: string | number
}

export interface SessionEventRecord extends SessionEventInput {
  sessionId: string
  seq: number
  time: number
  data: Record<string, unknown>
  payloadBytes: number
  compressed?: boolean
}

export interface SessionEventPage {
  events: SessionEventRecord[]
  hasMore: boolean
  nextBeforeSeq?: number
  total: number
  firstSeq?: number
  lastSeq?: number
}


export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | any[]
  name?: string
  tool_call_id?: string
  tool_calls?: any[]
  reasoning_content?: string // 支持思考推理过程（例如 DeepSeek R1）
  usage?: { prompt_tokens: number; completion_tokens: number }
  /** Provider response captured before Agent normalization (credentials are sanitized by the trace store). */
  raw_response?: ModelRawResponse
  raw_request?: ModelRawRequest
}

export interface ModelRawRequest {
  method: 'POST'
  url: string
  headers: Record<string, string>
  body: unknown
}

export interface ModelRawResponse {
  transport: 'json' | 'sse'
  status: number
  contentType?: string
  /** Parsed JSON body for ordinary responses. */
  body?: unknown
  /** Parsed SSE `data:` payloads in wire order; non-JSON frames remain strings. */
  events?: unknown[]
}

export interface ChatOptions {
  model: string
  temperature?: number
  maxTokens?: number
  tools?: any[]
  tool_choice?: any
  signal?: AbortSignal
}

export interface ModelProvider {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatMessage>
  chatStream?(
    messages: ChatMessage[],
    options: ChatOptions
  ): AsyncGenerator<
    | { type: 'delta'; content: string; rawPayload?: unknown }
    | { type: 'reasoning_delta'; content: string; rawPayload?: unknown }
    | { type: 'raw_request'; request: ModelRawRequest }
    | { type: 'raw_response'; response: ModelRawResponse }
    | { type: 'message'; message: ChatMessage },
    void,
    unknown
  >
}

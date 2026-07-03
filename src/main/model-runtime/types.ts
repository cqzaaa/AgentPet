export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | any[]
  name?: string
  tool_call_id?: string
  tool_calls?: any[]
  reasoning_content?: string // 支持思考推理过程（例如 DeepSeek R1）
  usage?: { prompt_tokens: number; completion_tokens: number }
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
}

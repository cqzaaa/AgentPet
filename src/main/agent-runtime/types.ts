export type AgentStepEvent =
  | { type: 'request_start'; step: number; messages: any[]; options: Record<string, any> }
  | { type: 'assistant_chunk'; step: number; content: string }
  | { type: 'assistant_message'; step: number; message: any }
  | { type: 'think'; detail: string }
  | { type: 'tool_call'; name: string; args: any; id: string; rawArguments?: string }
  | { type: 'tool_result'; name: string; result: string; modelResult?: string; callId?: string; contextTokens?: number }
  | { type: 'context_compaction'; status: 'started' | 'completed' | 'failed'; beforeTokens: number; afterTokens?: number; activeToolContextTokens?: number; archivePath?: string; removedMessages?: number; detail?: string }
  | { type: 'generated_files'; files: Array<{ name: string; path: string; size: number }>; autoPreview?: boolean }
  | { type: 'web_sources'; sources: Array<{ id: string; title: string; url: string; snippet?: string; fetchedAt: string; sourceType: 'search' | 'fetch' }> }
  | { type: 'text_delta'; content: string }
  | { type: 'text'; content: string }
  | { type: 'token'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finalResponse: string }
  | { type: 'error'; message: string }

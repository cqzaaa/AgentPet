export type AgentStepEvent =
  | { type: 'think'; detail: string }
  | { type: 'tool_call'; name: string; args: any; id: string }
  | { type: 'tool_result'; name: string; result: string; contextTokens?: number }
  | { type: 'context_compaction'; status: 'started' | 'completed' | 'failed'; beforeTokens: number; afterTokens?: number; activeToolContextTokens?: number; archivePath?: string; removedMessages?: number; detail?: string }
  | { type: 'generated_files'; files: Array<{ name: string; path: string; size: number }> }
  | { type: 'web_sources'; sources: Array<{ id: string; title: string; url: string; snippet?: string; fetchedAt: string; sourceType: 'search' | 'fetch' }> }
  | { type: 'text_delta'; content: string }
  | { type: 'text'; content: string }
  | { type: 'token'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finalResponse: string }
  | { type: 'error'; message: string }

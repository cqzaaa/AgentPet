export type AgentStepEvent =
  | { type: 'think'; detail: string }
  | { type: 'tool_call'; name: string; args: any; id: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'text'; content: string }
  | { type: 'token'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finalResponse: string }
  | { type: 'error'; message: string }

export interface ToolApi {
  name: string
  description: string
  parameters: Record<string, any>
  timeout?: number
  humanIntervention?: 'never' | 'required' | 'auto'
  /** Compatibility APIs remain executable but can be omitted from the model prompt. */
  hidden?: boolean
}

export interface SecurityPolicy {
  readOnly?: boolean
  requireApproval?: boolean
  dangerousPatterns?: RegExp[]
  safePatterns?: RegExp[]
}

export interface ToolManifest {
  identifier: string
  category: string
  meta: {
    title: string
    description: string
    avatar?: string
  }
  api: ToolApi[]
  systemRole?: string | ((context: ToolContext) => string)
  security?: SecurityPolicy
}

export interface ToolResult {
  content: string
  state?: any
  success: boolean
  error?: { message: string; name?: string }
}

export interface WebSource {
  id: string
  title: string
  url: string
  snippet?: string
  fetchedAt: string
  sourceType: 'search' | 'fetch'
}

export interface ToolTraceEvent {
  type: string
  data: Record<string, unknown>
  correlationId?: string
}

export interface ToolContext {
  workspacePath: string
  sessionId?: string
  messageId?: number
  /** Durable conversation turn that owns this tool invocation. */
  turn?: number
  /** Model tool-call id used to attach durable child workflows to their parent row. */
  toolCallId?: string
  /** UI surface that owns interactive prompts raised by this invocation. */
  interactionOrigin?: 'chat' | 'orchestration'
  taskRunId?: string
  taskStepId?: string
  isFrontend: boolean
  event?: Electron.IpcMainInvokeEvent
  sandboxMode: boolean
  abortSignal?: AbortSignal
  /** Emits durable protocol-level events for tools with an external transport. */
  traceEvent?: (event: ToolTraceEvent) => void | Promise<void>
  /** Internal Office workflows use this while producing non-user-facing intermediates. */
  suppressOfficePreview?: boolean
}

export interface IToolExecutor {
  execute(api: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult>
  getApiNames(): string[]
}

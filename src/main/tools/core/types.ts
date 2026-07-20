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

export interface ToolContext {
  workspacePath: string
  sessionId?: string
  isFrontend: boolean
  event?: Electron.IpcMainInvokeEvent
  sandboxMode: boolean
  abortSignal?: AbortSignal
}

export interface IToolExecutor {
  execute(api: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult>
  getApiNames(): string[]
}

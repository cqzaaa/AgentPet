export interface ToolApi {
  name: string
  description: string
  parameters: Record<string, any>
  timeout?: number           // 默认 30s
  humanIntervention?: 'never' | 'required' | 'auto'
}

export interface SecurityPolicy {
  readOnly?: boolean
  requireApproval?: boolean
  dangerousPatterns?: RegExp[]
  safePatterns?: RegExp[]
}

export interface ToolManifest {
  identifier: string         // 唯一标识
  category: string           // 分类
  meta: {
    title: string
    description: string
    avatar?: string          // emoji
  }
  api: ToolApi[]             // 支持的 API 列表
  systemRole?: string | ((context: ToolContext) => string)
  security?: SecurityPolicy
}

export interface ToolResult {
  content: string            // LLM 可读的结果文本
  state?: any                // 结构化数据（供 UI 使用）
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

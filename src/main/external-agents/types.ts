export type ExternalAgentId = 'claude-code' | 'gemini-cli' | 'codex' | string

export type ExternalAgentSource = 'builtin' | 'custom'

export interface ExternalAgentDefinition {
  id: ExternalAgentId
  name: string
  description: string
  source: ExternalAgentSource
  protocol: 'internal' | 'acp-v1' | 'claude-stream-json' | 'codex-app-server' | 'antigravity-json'
  executable: string
  args: string[]
  detectExecutable?: string
  executableAliases?: string[]
  env?: Record<string, string>
  enabled: boolean
}

export type ExternalAgentConnectionStatus =
  | 'unchecked'
  | 'missing'
  | 'ready'
  | 'interactive'
  | 'auth_required'
  | 'error'

export interface ExternalAgentProbeResult {
  agentId: string
  status: ExternalAgentConnectionStatus
  installed: boolean
  protocolVersion?: number
  agentInfo?: { name?: string; version?: string }
  capabilities?: Record<string, unknown>
  modes?: unknown
  configOptions?: unknown[]
  latencyMs: number
  checkedAt: number
  error?: string
  stderr?: string
}

export interface ExternalAgentListItem extends ExternalAgentDefinition {
  probe: ExternalAgentProbeResult | null
}

export interface ExternalAgentUpsertInput {
  id?: string
  name: string
  description?: string
  executable: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
}

export interface ExternalAgentRunRequest {
  agentId: string
  prompt: string
  cwd: string
  model?: string
}

export interface ExternalAgentProtocolEvent {
  protocol: ExternalAgentDefinition['protocol']
  direction: 'client_to_agent' | 'agent_to_client'
  messageType: 'request' | 'response' | 'notification' | 'batch' | 'invalid'
  method?: string
  id?: string | number | null
  byteLength: number
  payload: unknown
}

export interface ExternalAgentModel {
  id: string
  name: string
  description?: string
  source: 'configured' | 'cli' | 'cli-alias' | 'acp'
}

export interface ExternalAgentRunResult {
  agentId: string
  sessionId: string
  text: string
  stopReason: string
  artifactPaths?: string[]
  performance?: {
    elapsedMs: number
    initializeMs: number
    sessionMs: number
    firstTextMs?: number
    updateCount: number
  }
}

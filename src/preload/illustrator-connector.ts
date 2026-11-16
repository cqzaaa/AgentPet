/** Local MCP preset; launching it uses the existing main-process MCP manager. */
export const ILLUSTRATOR_CONNECTOR_ID = 'illustrator-local'
export const ILLUSTRATOR_MCP_PACKAGE = 'illustrator-mcp-server@1.14.0'

export interface LocalConnectorDetection {
  connectorId: string
  platformSupported: boolean
  installed: boolean
  running: boolean
  appName: string
  versionLabel?: string
  executablePath?: string
  detectionSource?: 'registry' | 'filesystem' | 'process'
  nodeReady: boolean
  nodeVersion?: string
  mcpConfigured: boolean
  mcpEnabled: boolean
  mcpConnected: boolean
  toolsCount: number
  checkedAt: number
}

export interface LocalConnectorConnectResult {
  success: boolean
  code: 'CONNECTED' | 'DISABLED' | 'APP_NOT_INSTALLED' | 'NODE_RUNTIME_CANCELLED' | 'CONNECT_FAILED'
  detection: LocalConnectorDetection
  config?: unknown
  error?: string
}

export interface IllustratorConnectorPreset {
  id: string
  name: string
  description: string
  type: 'stdio'
  command: string
  args: string[]
  url: string
  apiKey: string
  startupTimeout: number
  enabled: boolean
}

export function createIllustratorConnector(): IllustratorConnectorPreset {
  return {
    id: ILLUSTRATOR_CONNECTOR_ID,
    name: 'Illustrator 本地连接器',
    description: '通过 ie3jp/illustrator-mcp-server 编辑本机 Illustrator 文档；使用 AgentPet 隔离 Node 运行时，需要本机 Adobe Illustrator。',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', ILLUSTRATOR_MCP_PACKAGE],
    url: '',
    apiKey: '',
    startupTimeout: 60,
    enabled: true
  }
}

export function isIllustratorConnector(server: { id?: string; args?: string[] }): boolean {
  return server.id === ILLUSTRATOR_CONNECTOR_ID || Boolean(server.args?.some(
    arg => /^illustrator-mcp-server(?:@[^\s]+)?$/.test(arg)
  ))
}

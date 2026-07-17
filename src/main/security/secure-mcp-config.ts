import { app } from 'electron'
import { join } from 'path'
import { McpConfigStore, type RuntimeMcpConfig } from './mcp-config-store'
import { getSecretVault } from './secret-vault'

let store: McpConfigStore | null = null
let storeUserDataPath = ''

function getStore(): McpConfigStore {
  const userDataPath = app.getPath('userData')
  if (!store || storeUserDataPath !== userDataPath) {
    store = new McpConfigStore(join(userDataPath, 'system_mcp_config.json'), getSecretVault())
    storeUserDataPath = userDataPath
  }
  return store
}

export function loadSecureSystemMcpConfig(): RuntimeMcpConfig {
  return getStore().load()
}

export function saveSecureSystemMcpConfig(config: Record<string, unknown>): RuntimeMcpConfig {
  return getStore().save(config)
}

export function sanitizeSystemMcpConfig(config: RuntimeMcpConfig): RuntimeMcpConfig {
  return getStore().toRenderer(config)
}

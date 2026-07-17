import { app } from 'electron'
import { join } from 'path'
import { getSecretVault } from './secret-vault'
import { LlmConfigStore, type RuntimeLlmConfig } from './llm-config-store'

let store: LlmConfigStore | null = null
let storeUserDataPath = ''

function getStore(): LlmConfigStore {
  const userDataPath = app.getPath('userData')
  if (!store || storeUserDataPath !== userDataPath) {
    store = new LlmConfigStore(join(userDataPath, 'system_llm_config.json'), getSecretVault())
    storeUserDataPath = userDataPath
  }
  return store
}

export function loadSecureSystemLlmConfig(): RuntimeLlmConfig {
  return getStore().load()
}

export function saveSecureSystemLlmConfig(config: Record<string, unknown>): RuntimeLlmConfig {
  return getStore().save(config)
}

export function sanitizeSystemLlmConfig(config: RuntimeLlmConfig): RuntimeLlmConfig {
  return getStore().toRenderer(config)
}

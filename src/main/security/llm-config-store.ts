import { existsSync, readFileSync } from 'fs'
import { SecretVault, writeTextAtomically } from './secret-vault-core'

export const SYSTEM_LLM_API_KEY_SECRET_ID = 'system-llm-api-key'
export const SYSTEM_LLM_API_KEY_REF = `secret://${SYSTEM_LLM_API_KEY_SECRET_ID}`

export interface RuntimeLlmConfig {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens?: number
  hasApiKey: boolean
  secretMigrationPending?: boolean
  [key: string]: unknown
}

export const DEFAULT_LLM_CONFIG: RuntimeLlmConfig = {
  provider: 'gemini',
  apiKey: '',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: '',
  temperature: 0.7,
  hasApiKey: false
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function withoutRuntimeSecrets(config: JsonObject): JsonObject {
  const sanitized = { ...config }
  delete sanitized.apiKey
  delete sanitized.hasApiKey
  delete sanitized.secretMigrationPending
  delete sanitized.clearApiKey
  return sanitized
}

export class LlmConfigStore {
  constructor(
    private readonly configPath: string,
    private readonly vault: SecretVault
  ) {}

  load(): RuntimeLlmConfig {
    const stored = this.readStoredConfig()
    const merged = { ...DEFAULT_LLM_CONFIG, ...stored } as JsonObject
    const legacyApiKey = typeof stored.apiKey === 'string' ? stored.apiKey : ''
    let apiKey = ''
    let migrationPending = false

    if (legacyApiKey) {
      try {
        this.vault.setSecret(SYSTEM_LLM_API_KEY_SECRET_ID, legacyApiKey, 'System LLM API key')
        const migrated = {
          ...withoutRuntimeSecrets(merged),
          apiKeyRef: SYSTEM_LLM_API_KEY_REF
        }
        this.writeStoredConfig(migrated)
        apiKey = legacyApiKey
      } catch {
        // Preserve the legacy file and keep the key usable in memory. A later
        // launch retries migration when OS encryption becomes available.
        apiKey = legacyApiKey
        migrationPending = true
      }
    } else if (stored.apiKeyRef === SYSTEM_LLM_API_KEY_REF) {
      try {
        apiKey = this.vault.getSecret(SYSTEM_LLM_API_KEY_SECRET_ID) ?? ''
      } catch {
        migrationPending = true
      }
    }

    return {
      ...merged,
      apiKey,
      hasApiKey: apiKey.length > 0,
      ...(migrationPending ? { secretMigrationPending: true } : {})
    } as RuntimeLlmConfig
  }

  save(input: JsonObject): RuntimeLlmConfig {
    if (!isJsonObject(input)) throw new TypeError('LLM configuration must be an object')

    const stored = this.readStoredConfig()
    const currentWithoutSecrets = withoutRuntimeSecrets(stored)
    const incomingWithoutSecrets = withoutRuntimeSecrets(input)
    const shouldClear = input.clearApiKey === true
    const incomingApiKey =
      typeof input.apiKey === 'string' && input.apiKey.length > 0 ? input.apiKey : ''
    const legacyApiKey =
      typeof stored.apiKey === 'string' && stored.apiKey.length > 0 ? stored.apiKey : ''
    let apiKeyRef = stored.apiKeyRef === SYSTEM_LLM_API_KEY_REF ? SYSTEM_LLM_API_KEY_REF : undefined

    if (shouldClear) {
      this.vault.deleteSecret(SYSTEM_LLM_API_KEY_SECRET_ID)
      apiKeyRef = undefined
    } else {
      const keyToPersist = incomingApiKey || legacyApiKey
      if (keyToPersist) {
        this.vault.setSecret(SYSTEM_LLM_API_KEY_SECRET_ID, keyToPersist, 'System LLM API key')
        apiKeyRef = SYSTEM_LLM_API_KEY_REF
      }
    }

    const nextStored: JsonObject = {
      ...withoutRuntimeSecrets(DEFAULT_LLM_CONFIG),
      ...currentWithoutSecrets,
      ...incomingWithoutSecrets
    }
    delete nextStored.apiKeyRef
    if (apiKeyRef) nextStored.apiKeyRef = apiKeyRef
    this.writeStoredConfig(nextStored)
    return this.load()
  }

  toRenderer(config: RuntimeLlmConfig): RuntimeLlmConfig {
    const sanitized = withoutRuntimeSecrets(config)
    delete sanitized.apiKeyRef
    return {
      ...sanitized,
      apiKey: '',
      hasApiKey: config.apiKey.length > 0
    } as RuntimeLlmConfig
  }

  private readStoredConfig(): JsonObject {
    if (!existsSync(this.configPath)) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.configPath, 'utf8'))
    } catch {
      throw new Error('System LLM configuration is not valid JSON')
    }
    if (!isJsonObject(parsed)) throw new Error('System LLM configuration must be a JSON object')
    return parsed
  }

  private writeStoredConfig(config: JsonObject): void {
    writeTextAtomically(this.configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
}

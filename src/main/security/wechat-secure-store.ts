import { existsSync, readFileSync, unlinkSync } from 'fs'
import { SecretVault, writeTextAtomically } from './secret-vault-core'

export const WECHAT_SESSION_TOKEN_SECRET_ID = 'wechat-session-token'
export const WECHAT_LLM_API_KEY_SECRET_ID = 'wechat-llm-api-key'
const WECHAT_SESSION_TOKEN_REF = `secret://${WECHAT_SESSION_TOKEN_SECRET_ID}`
const WECHAT_LLM_API_KEY_REF = `secret://${WECHAT_LLM_API_KEY_SECRET_ID}`

type JsonObject = Record<string, unknown>

export interface RuntimeWechatLlmConfig extends JsonObject {
  provider: string
  apiKey: string
  hasApiKey: boolean
  baseUrl: string
  model: string
  temperature: number
  useSystemConfig: boolean
}

export interface RuntimeWechatSettings extends JsonObject {
  llmConfig: RuntimeWechatLlmConfig
  autoReplyText: string
  enableAutoReply: boolean
  secretMigrationPending?: boolean
}

export interface RuntimeWechatSession {
  token: string
  baseUrl: string
  secretMigrationPending?: boolean
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readJsonObject(path: string, label: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
  if (!isJsonObject(parsed)) throw new Error(`${label} must be a JSON object`)
  return parsed
}

function sanitizeLlmConfigForDisk(config: JsonObject): JsonObject {
  const sanitized = { ...config }
  delete sanitized.apiKey
  delete sanitized.hasApiKey
  delete sanitized.clearApiKey
  return sanitized
}

export class WechatSecureStore {
  constructor(
    private readonly settingsPath: string,
    private readonly sessionPath: string,
    private readonly vault: SecretVault
  ) {}

  loadSettings(defaults: RuntimeWechatSettings): RuntimeWechatSettings {
    if (!existsSync(this.settingsPath)) return { ...defaults, llmConfig: { ...defaults.llmConfig } }

    const stored = readJsonObject(this.settingsPath, 'Wechat settings')
    const storedLlm = isJsonObject(stored.llmConfig) ? stored.llmConfig : {}
    const mergedLlm = { ...defaults.llmConfig, ...storedLlm }
    const legacyApiKey = typeof storedLlm.apiKey === 'string' ? storedLlm.apiKey : ''
    let apiKey = ''
    let migrationPending = false

    if (legacyApiKey) {
      try {
        this.vault.setSecret(
          WECHAT_LLM_API_KEY_SECRET_ID,
          legacyApiKey,
          'Wechat dedicated LLM API key'
        )
        const migratedLlm = sanitizeLlmConfigForDisk(mergedLlm)
        migratedLlm.apiKeyRef = WECHAT_LLM_API_KEY_REF
        this.writeSettings({ ...stored, llmConfig: migratedLlm })
        apiKey = legacyApiKey
      } catch {
        apiKey = legacyApiKey
        migrationPending = true
      }
    } else if (storedLlm.apiKeyRef === WECHAT_LLM_API_KEY_REF) {
      try {
        apiKey = this.vault.getSecret(WECHAT_LLM_API_KEY_SECRET_ID) ?? ''
      } catch {
        migrationPending = true
      }
    }

    return {
      ...defaults,
      ...stored,
      llmConfig: {
        ...mergedLlm,
        provider:
          typeof mergedLlm.provider === 'string' ? mergedLlm.provider : defaults.llmConfig.provider,
        baseUrl:
          typeof mergedLlm.baseUrl === 'string' ? mergedLlm.baseUrl : defaults.llmConfig.baseUrl,
        model: typeof mergedLlm.model === 'string' ? mergedLlm.model : defaults.llmConfig.model,
        temperature:
          typeof mergedLlm.temperature === 'number'
            ? mergedLlm.temperature
            : defaults.llmConfig.temperature,
        useSystemConfig: mergedLlm.useSystemConfig !== false,
        apiKey,
        hasApiKey: apiKey.length > 0
      },
      autoReplyText:
        typeof stored.autoReplyText === 'string' ? stored.autoReplyText : defaults.autoReplyText,
      enableAutoReply: stored.enableAutoReply !== false,
      ...(migrationPending ? { secretMigrationPending: true } : {})
    }
  }

  saveSettings(input: JsonObject, defaults: RuntimeWechatSettings): RuntimeWechatSettings {
    if (!isJsonObject(input)) throw new TypeError('Wechat settings must be an object')
    const stored = existsSync(this.settingsPath)
      ? readJsonObject(this.settingsPath, 'Wechat settings')
      : {}
    const currentLlm = isJsonObject(stored.llmConfig) ? stored.llmConfig : {}
    const incomingLlm = isJsonObject(input.llmConfig) ? input.llmConfig : {}
    const incomingApiKey =
      typeof incomingLlm.apiKey === 'string' && incomingLlm.apiKey.length > 0
        ? incomingLlm.apiKey
        : ''
    const legacyApiKey =
      typeof currentLlm.apiKey === 'string' && currentLlm.apiKey.length > 0 ? currentLlm.apiKey : ''
    const shouldClear = incomingLlm.clearApiKey === true
    let apiKeyRef =
      currentLlm.apiKeyRef === WECHAT_LLM_API_KEY_REF ? WECHAT_LLM_API_KEY_REF : undefined

    if (shouldClear) {
      apiKeyRef = undefined
    } else {
      const keyToPersist = incomingApiKey || legacyApiKey
      if (keyToPersist) {
        this.vault.setSecret(
          WECHAT_LLM_API_KEY_SECRET_ID,
          keyToPersist,
          'Wechat dedicated LLM API key'
        )
        apiKeyRef = WECHAT_LLM_API_KEY_REF
      }
    }

    const nextLlm = {
      ...sanitizeLlmConfigForDisk(defaults.llmConfig),
      ...sanitizeLlmConfigForDisk(currentLlm),
      ...sanitizeLlmConfigForDisk(incomingLlm)
    }
    delete nextLlm.apiKeyRef
    if (apiKeyRef) nextLlm.apiKeyRef = apiKeyRef

    const nextStored: JsonObject = { ...stored, ...input, llmConfig: nextLlm }
    delete nextStored.secretMigrationPending
    this.writeSettings(nextStored)
    if (shouldClear) this.vault.deleteSecret(WECHAT_LLM_API_KEY_SECRET_ID)
    return this.loadSettings(defaults)
  }

  sanitizeSettings(settings: RuntimeWechatSettings): RuntimeWechatSettings {
    const sanitizedLlm = sanitizeLlmConfigForDisk(settings.llmConfig)
    delete sanitizedLlm.apiKeyRef
    const sanitized = { ...settings }
    delete sanitized.secretMigrationPending
    return {
      ...sanitized,
      llmConfig: {
        ...sanitizedLlm,
        provider: settings.llmConfig.provider,
        baseUrl: settings.llmConfig.baseUrl,
        model: settings.llmConfig.model,
        temperature: settings.llmConfig.temperature,
        useSystemConfig: settings.llmConfig.useSystemConfig,
        apiKey: '',
        hasApiKey: settings.llmConfig.apiKey.length > 0
      }
    }
  }

  loadSession(): RuntimeWechatSession | null {
    if (!existsSync(this.sessionPath)) return null
    const stored = readJsonObject(this.sessionPath, 'Wechat session')
    const legacyToken = typeof stored.token === 'string' ? stored.token : ''
    const baseUrl =
      typeof stored.baseUrl === 'string' ? stored.baseUrl : 'https://ilinkai.weixin.qq.com'
    let token = ''
    let migrationPending = false

    if (legacyToken) {
      try {
        this.vault.setSecret(
          WECHAT_SESSION_TOKEN_SECRET_ID,
          legacyToken,
          'Wechat bot session token'
        )
        this.writeSessionMetadata(baseUrl)
        token = legacyToken
      } catch {
        token = legacyToken
        migrationPending = true
      }
    } else if (stored.tokenRef === WECHAT_SESSION_TOKEN_REF) {
      try {
        token = this.vault.getSecret(WECHAT_SESSION_TOKEN_SECRET_ID) ?? ''
      } catch {
        migrationPending = true
      }
    }

    return { token, baseUrl, ...(migrationPending ? { secretMigrationPending: true } : {}) }
  }

  saveSession(token: string, baseUrl: string): void {
    if (!token) throw new TypeError('Wechat session token must be non-empty')
    this.vault.setSecret(WECHAT_SESSION_TOKEN_SECRET_ID, token, 'Wechat bot session token')
    this.writeSessionMetadata(baseUrl)
  }

  deleteSession(): void {
    this.vault.deleteSecret(WECHAT_SESSION_TOKEN_SECRET_ID)
    if (existsSync(this.sessionPath)) unlinkSync(this.sessionPath)
  }

  private writeSettings(settings: JsonObject): void {
    writeTextAtomically(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  }

  private writeSessionMetadata(baseUrl: string): void {
    writeTextAtomically(
      this.sessionPath,
      `${JSON.stringify(
        {
          version: 1,
          tokenRef: WECHAT_SESSION_TOKEN_REF,
          baseUrl
        },
        null,
        2
      )}\n`
    )
  }
}

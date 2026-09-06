import { existsSync, readFileSync } from 'fs'
import { SecretVault, writeTextAtomically } from './secret-vault-core'

export const SYSTEM_LLM_API_KEY_SECRET_ID = 'system-llm-api-key'
export const SYSTEM_LLM_API_KEY_REF = `secret://${SYSTEM_LLM_API_KEY_SECRET_ID}`

export interface RuntimeLlmProfile {
  id: string
  name: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens?: number
  hasApiKey: boolean
}

export interface RuntimeLlmConfig extends RuntimeLlmProfile {
  activeProfileId?: string
  profiles?: RuntimeLlmProfile[]
  [key: string]: unknown
}

export const DEFAULT_LLM_CONFIG: RuntimeLlmConfig = {
  id: 'default',
  name: 'Gemini 配置',
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

function defaultProfileName(provider: string, model: string): string {
  return model.trim() || `${provider.toUpperCase()} 配置`
}

function normalizeProfile(value: unknown, index: number): RuntimeLlmProfile | null {
  if (!isJsonObject(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider : DEFAULT_LLM_CONFIG.provider
  const model = typeof value.model === 'string' ? value.model : ''
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : ''
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : `profile-${index + 1}`,
    name: typeof value.name === 'string' && value.name.trim()
      ? value.name.trim()
      : defaultProfileName(provider, model),
    provider,
    apiKey,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    model,
    temperature: typeof value.temperature === 'number' ? value.temperature : DEFAULT_LLM_CONFIG.temperature,
    ...(typeof value.maxTokens === 'number' ? { maxTokens: value.maxTokens } : {}),
    hasApiKey: apiKey.length > 0
  }
}

export class LlmConfigStore {
  constructor(
    private readonly configPath: string,
    private readonly vault: SecretVault
  ) {}

  load(): RuntimeLlmConfig {
    const stored = this.readStoredConfig()
    const profiles = Array.isArray(stored.profiles)
      ? stored.profiles.map(normalizeProfile).filter((profile): profile is RuntimeLlmProfile => Boolean(profile))
      : []

    if (profiles.length > 0) {
      const requestedId = typeof stored.activeProfileId === 'string' ? stored.activeProfileId : ''
      const active = profiles.find(profile => profile.id === requestedId) ?? profiles[0]
      return { ...active, activeProfileId: active.id, profiles }
    }

    return this.loadLegacyConfig(stored)
  }

  save(input: JsonObject): RuntimeLlmConfig {
    if (!isJsonObject(input)) throw new TypeError('LLM configuration must be an object')

    const current = this.load()
    const currentProfiles = current.profiles?.length
      ? current.profiles
      : [this.profileFromConfig(current, 'default')]
    const profiles = Array.isArray(input.profiles)
      ? input.profiles.map(normalizeProfile).filter((profile): profile is RuntimeLlmProfile => Boolean(profile))
      : currentProfiles.map(profile => ({ ...profile }))
    if (profiles.length === 0) throw new Error('At least one LLM profile is required')

    const requestedId = typeof input.activeProfileId === 'string' ? input.activeProfileId : current.activeProfileId
    const activeProfileId = profiles.some(profile => profile.id === requestedId)
      ? requestedId as string
      : profiles[0].id
    const activeIndex = profiles.findIndex(profile => profile.id === activeProfileId)
    const active = { ...profiles[activeIndex] }
    for (const key of ['name', 'provider', 'apiKey', 'baseUrl', 'model', 'temperature', 'maxTokens'] as const) {
      if (input[key] !== undefined) (active as any)[key] = input[key]
    }
    active.hasApiKey = Boolean(active.apiKey)
    profiles[activeIndex] = active

    this.writeStoredConfig({ activeProfileId, profiles })
    return { ...active, activeProfileId, profiles }
  }

  toRenderer(config: RuntimeLlmConfig): RuntimeLlmConfig {
    return {
      ...config,
      profiles: config.profiles?.map(profile => ({ ...profile, hasApiKey: Boolean(profile.apiKey) }))
    }
  }

  private loadLegacyConfig(stored: JsonObject): RuntimeLlmConfig {
    const merged = { ...DEFAULT_LLM_CONFIG, ...stored } as RuntimeLlmConfig
    let apiKey = typeof stored.apiKey === 'string' ? stored.apiKey : ''
    if (!apiKey && stored.apiKeyRef === SYSTEM_LLM_API_KEY_REF) {
      try {
        apiKey = this.vault.getSecret(SYSTEM_LLM_API_KEY_SECRET_ID) ?? ''
      } catch {
        apiKey = ''
      }
    }
    const profile = this.profileFromConfig({
      ...merged,
      name: typeof stored.name === 'string' ? stored.name : '',
      apiKey
    }, 'default')
    return { ...profile, activeProfileId: profile.id, profiles: [profile] }
  }

  private profileFromConfig(config: RuntimeLlmConfig | JsonObject, id: string): RuntimeLlmProfile {
    const provider = typeof config.provider === 'string' ? config.provider : DEFAULT_LLM_CONFIG.provider
    const model = typeof config.model === 'string' ? config.model : ''
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey : ''
    return {
      id,
      name: typeof config.name === 'string' && config.name.trim()
        ? config.name.trim()
        : defaultProfileName(provider, model),
      provider,
      apiKey,
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : DEFAULT_LLM_CONFIG.baseUrl,
      model,
      temperature: typeof config.temperature === 'number' ? config.temperature : DEFAULT_LLM_CONFIG.temperature,
      ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
      hasApiKey: apiKey.length > 0
    }
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

import { readFileSync } from 'fs'
import type {
  WikiModelSelection,
  WikiModelSettings,
  WikiModelOption
} from '../../preload/wiki-types'
import type { RuntimeLlmConfig, RuntimeLlmProfile } from '../security/llm-config-store'
import { writeTextAtomically } from '../security/secret-vault-core'

export function parseWikiModelSelection(value: unknown): WikiModelSelection {
  if (!value || typeof value !== 'object') throw new Error('请选择有效的 Wiki 模型。')
  const selection = value as Record<string, unknown>
  if (selection.mode === 'system' || selection.mode === 'local') return { mode: selection.mode }
  if (
    selection.mode === 'profile' &&
    typeof selection.profileId === 'string' &&
    selection.profileId.trim()
  ) {
    return { mode: 'profile', profileId: selection.profileId.trim() }
  }
  throw new Error('请选择有效的 Wiki 模型。')
}

function available(profile?: RuntimeLlmProfile): boolean {
  return Boolean(profile?.model.trim() && (profile.provider === 'ollama' || profile.apiKey.trim()))
}

export class WikiModelSettingsStore {
  constructor(
    private readonly path: string,
    private readonly getSystemConfig: () => RuntimeLlmConfig | undefined
  ) {}

  private read(): WikiModelSelection {
    try {
      return parseWikiModelSelection(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'system' }
      throw new Error('Wiki 模型配置无法读取，请重新选择模型保存。')
    }
  }

  private resolve(
    selection: WikiModelSelection,
    config?: RuntimeLlmConfig
  ): RuntimeLlmConfig | undefined {
    if (selection.mode === 'local') return undefined
    if (selection.mode === 'system') return available(config) ? config : undefined
    const profiles = config?.profiles?.length ? config.profiles : config ? [config] : []
    const profile = profiles.find((entry) => entry.id === selection.profileId)
    return profile && available(profile) ? { ...profile } : undefined
  }

  getRuntimeConfig(): RuntimeLlmConfig | undefined {
    let selection: WikiModelSelection
    try {
      selection = this.read()
    } catch {
      return undefined
    }
    return this.resolve(selection, this.getSystemConfig())
  }

  getSettings(): WikiModelSettings {
    const config = this.getSystemConfig()
    let selection: WikiModelSelection
    let warning: string | undefined
    try {
      selection = this.read()
    } catch (error) {
      // Never silently use another provider when a saved selection is unreadable.
      selection = { mode: 'local' }
      warning = (error as Error).message
    }
    const effective = this.resolve(selection, config)
    const toOption = (profile: RuntimeLlmProfile): WikiModelOption => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      available: available(profile)
    })
    if (!effective && selection.mode !== 'local') {
      warning =
        selection.mode === 'profile'
          ? '所选配置已删除或缺少模型 / API Key，暂用本地规则。请重新选择或在设置中补全配置。'
          : '系统模型尚未配置完整，暂用本地规则。请在设置 → 模型配置中补全。'
    }
    return {
      selection,
      profiles: (config?.profiles?.length ? config.profiles : config ? [config] : []).map(toOption),
      effectiveModel: effective ? toOption(effective) : null,
      ...(warning ? { warning } : {})
    }
  }

  save(value: unknown): WikiModelSettings {
    const selection = parseWikiModelSelection(value)
    if (selection.mode === 'profile' && !this.resolve(selection, this.getSystemConfig())) {
      throw new Error('该模型配置不可用，请在设置 → 模型配置中补全后重试。')
    }
    // Persist only the reference; credentials continue to belong to the existing model configuration.
    writeTextAtomically(this.path, `${JSON.stringify(selection)}\n`)
    return this.getSettings()
  }
}

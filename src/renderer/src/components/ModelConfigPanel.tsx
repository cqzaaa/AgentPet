import React from 'react'
import {
  Check,
  ChevronRight,
  LoaderCircle,
  Plus,
  Plug,
  RefreshCw,
  Save,
  Trash2,
  X
} from 'lucide-react'
import type { AppStore } from '../hooks/useAppStore'
import { DEFAULT_MODELS } from '../utils/helpers'
import { getModelIcon, getProviderIcon } from '../utils/modelIcons'
import './ModelConfigPanel.css'

type ModelProfile = {
  id: string
  name: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens?: number
  hasApiKey?: boolean
}

const PROVIDERS = ['gemini', 'deepseek', 'openai', 'ollama', 'custom'] as const
const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  ollama: 'Ollama',
  custom: '自定义'
}
const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  gemini: 'Google Gemini 的 OpenAI 兼容接口',
  deepseek: 'DeepSeek 官方 API',
  openai: 'OpenAI 官方 API',
  ollama: '本机运行的 Ollama 服务',
  custom: '任意 OpenAI 兼容服务'
}
const PROVIDER_BASE_URLS: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  custom: ''
}

function profileFromConfig(config: any): ModelProfile {
  return {
    id: config.id || config.activeProfileId || 'default',
    name: config.name || config.model || `${String(config.provider || 'gemini').toUpperCase()} 配置`,
    provider: config.provider || 'gemini',
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || PROVIDER_BASE_URLS.gemini,
    model: config.model || '',
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.7,
    ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
    hasApiKey: Boolean(config.apiKey)
  }
}

function createProfile(provider: string): ModelProfile {
  const model = DEFAULT_MODELS[provider] || ''
  return {
    id: crypto.randomUUID(),
    name: model || `${PROVIDER_LABELS[provider]} 配置`,
    provider,
    apiKey: '',
    baseUrl: PROVIDER_BASE_URLS[provider],
    model,
    temperature: 0.7,
    hasApiKey: false
  }
}

interface ModelConfigPanelProps {
  store: AppStore
}

export function ModelConfigPanel({ store }: ModelConfigPanelProps): React.JSX.Element {
  const { llmConfig, saveLlmConfig, showToast } = store
  const profiles: ModelProfile[] = Array.isArray(llmConfig.profiles) && llmConfig.profiles.length > 0
    ? llmConfig.profiles
    : [profileFromConfig(llmConfig)]
  const activeProfile = profiles.find(profile => profile.id === llmConfig.activeProfileId) ?? profiles[0]
  const [draft, setDraft] = React.useState<ModelProfile>({ ...activeProfile })
  const [isDirty, setIsDirty] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [isFetchingModels, setIsFetchingModels] = React.useState(false)
  const [availableModels, setAvailableModels] = React.useState<string[]>([])
  const [modelsMessage, setModelsMessage] = React.useState('')
  const modelsRequestRef = React.useRef(0)
  const [showAddDialog, setShowAddDialog] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<ModelProfile | null>(null)
  const [testStatus, setTestStatus] = React.useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = React.useState('')
  const addDialogCloseRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    setDraft({ ...activeProfile })
    setIsDirty(false)
    setAvailableModels([])
    setModelsMessage('')
    modelsRequestRef.current += 1
    setIsFetchingModels(false)
    setTestStatus('idle')
  }, [llmConfig])

  React.useEffect(() => {
    if (!showAddDialog) return undefined
    addDialogCloseRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowAddDialog(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showAddDialog])

  const updateDraft = (patch: Partial<ModelProfile>): void => {
    if ('baseUrl' in patch || 'apiKey' in patch) {
      modelsRequestRef.current += 1
      setAvailableModels([])
      setModelsMessage('')
      setIsFetchingModels(false)
    }
    setDraft(current => ({ ...current, ...patch }))
    setIsDirty(true)
    setTestStatus('idle')
  }

  const buildPayload = (profile: ModelProfile, nextProfiles: ModelProfile[]): any => ({
    ...profile,
    hasApiKey: Boolean(profile.apiKey),
    activeProfileId: profile.id,
    profiles: nextProfiles.map(item => ({ ...item, hasApiKey: Boolean(item.apiKey) }))
  })

  const saveDraft = async (announce = true): Promise<boolean> => {
    if (!draft.name.trim()) {
      showToast('请填写配置名称', 'info')
      return false
    }
    if (!draft.baseUrl.trim()) {
      showToast('请填写 Base URL', 'info')
      return false
    }
    if (!draft.model.trim()) {
      showToast('请填写模型名称', 'info')
      return false
    }
    setIsSaving(true)
    try {
      const savedProfile = { ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), model: draft.model.trim() }
      const nextProfiles = profiles.map(profile => profile.id === savedProfile.id ? savedProfile : profile)
      const saved = await saveLlmConfig(buildPayload(savedProfile, nextProfiles))
      if (saved) {
        setDraft(savedProfile)
        setIsDirty(false)
        if (announce) showToast(`“${savedProfile.name}”已保存并启用`, 'success')
      }
      return saved
    } finally {
      setIsSaving(false)
    }
  }

  const activateProfile = async (profile: ModelProfile): Promise<void> => {
    if (profile.id === activeProfile.id) return
    if (isDirty && !(await saveDraft(false))) return
    const latestProfiles = isDirty
      ? profiles.map(item => item.id === draft.id ? { ...draft } : item)
      : profiles
    const target = latestProfiles.find(item => item.id === profile.id) ?? profile
    const saved = await saveLlmConfig(buildPayload(target, latestProfiles))
    if (saved) showToast(`已切换到“${target.name}”`, 'success')
  }

  const addProfile = async (provider: string): Promise<void> => {
    const profile = createProfile(provider)
    const nextProfiles = [...profiles, profile]
    const saved = await saveLlmConfig(buildPayload(profile, nextProfiles))
    if (saved) {
      setShowAddDialog(false)
      showToast(`已添加 ${PROVIDER_LABELS[provider]} 配置`, 'success')
    }
  }

  const deleteProfile = async (): Promise<void> => {
    if (!deleteTarget || profiles.length <= 1) return
    const nextProfiles = profiles.filter(profile => profile.id !== deleteTarget.id)
    const nextActive = deleteTarget.id === activeProfile.id ? nextProfiles[0] : activeProfile
    const saved = await saveLlmConfig(buildPayload(nextActive, nextProfiles))
    if (saved) {
      showToast(`已删除“${deleteTarget.name}”`, 'success')
      setDeleteTarget(null)
    }
  }

  const fetchModels = async (): Promise<void> => {
    const requestId = ++modelsRequestRef.current
    setIsFetchingModels(true)
    setModelsMessage('正在获取模型列表…')
    try {
      const models = await window.api.getModels({ provider: draft.provider, apiKey: draft.apiKey, baseUrl: draft.baseUrl })
      if (requestId !== modelsRequestRef.current) return
      const merged = Array.from(new Set((models || []).filter(Boolean))) as string[]
      setAvailableModels(merged)
      setModelsMessage(merged.length ? `已获取 ${merged.length} 个模型，请从列表选择或手动输入。` : '接口未返回模型，可继续手动输入并测试连接。')
      showToast(models?.length ? '模型列表已更新' : '未获取到模型，可继续手动输入', models?.length ? 'success' : 'info')
    } catch (error: any) {
      if (requestId !== modelsRequestRef.current) return
      setModelsMessage(error?.message || '获取模型列表失败，可继续手动输入并测试连接。')
      showToast(error?.message || '获取模型列表失败', 'error')
    } finally {
      if (requestId === modelsRequestRef.current) setIsFetchingModels(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setTestStatus('testing')
    setTestMessage('')
    try {
      const result = await window.api.callLLM(
        { ...draft, sessionId: 'system:test' },
        [{ role: 'user', content: 'Say "Success" in exactly one word.' }]
      )
      setTestStatus('success')
      setTestMessage(`连接成功，模型返回：${String(result).trim()}`)
    } catch (error: any) {
      setTestStatus('error')
      setTestMessage(`连接失败：${error?.message || error}`)
    }
  }

  return (
    <div className="model-config-workspace">
      <aside className="model-profile-sidebar" aria-label="模型配置列表">
        <div className="model-profile-sidebar-head">
          <div>
            <h2>模型配置</h2>
            <p>{profiles.length} 个已保存配置</p>
          </div>
          <button className="model-add-button" type="button" onClick={() => setShowAddDialog(true)}>
            <Plus size={15} aria-hidden="true" />
            添加
          </button>
        </div>

        <div className="model-profile-list">
          {profiles.map(profile => {
            const isActive = profile.id === activeProfile.id
            return (
              <div className={`model-profile-row ${isActive ? 'active' : ''}`} key={profile.id}>
                <button type="button" className="model-profile-select" onClick={() => void activateProfile(profile)}>
                  <span className="model-profile-icon-wrap">
                    <img src={getProviderIcon(profile.provider)} alt="" />
                  </span>
                  <span className="model-profile-copy">
                    <span className="model-profile-name">{profile.name}</span>
                    <span className="model-profile-meta">{PROVIDER_LABELS[profile.provider] || profile.provider} · {profile.model || '未设置模型'}</span>
                  </span>
                  {isActive ? <span className="model-active-mark"><Check size={12} aria-hidden="true" />已启用</span> : <ChevronRight size={15} aria-hidden="true" />}
                </button>
                {profiles.length > 1 && (
                  <button
                    type="button"
                    className="model-profile-delete"
                    aria-label={`删除 ${profile.name}`}
                    title="删除配置"
                    onClick={() => setDeleteTarget(profile)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <p className="model-profile-footnote">切换配置后，聊天和自动化会使用该配置。未保存的修改会在切换前保存。</p>
      </aside>

      <section className="model-profile-editor" aria-labelledby="model-profile-editor-title">
        <div className="model-profile-editor-head">
          <div className="model-profile-editor-title-wrap">
            <img src={getProviderIcon(draft.provider)} alt="" />
            <div>
              <span className="model-provider-eyebrow">{PROVIDER_LABELS[draft.provider] || draft.provider}</span>
              <h2 id="model-profile-editor-title">编辑配置</h2>
            </div>
          </div>
          <span className="model-current-chip"><span />当前启用</span>
        </div>

        <form className="model-profile-form" noValidate onSubmit={event => { event.preventDefault(); void saveDraft() }}>
          <div className="model-profile-form-scroll">
            <div className="model-form-grid">
              <label className="model-field">
                <span>配置名称</span>
                <input className="form-input" value={draft.name} onChange={event => updateDraft({ name: event.target.value })} placeholder="例如：日常对话" />
              </label>

              {draft.provider !== 'ollama' && (
                <label className="model-field model-field-full">
                  <span>API Key</span>
                  <input
                    className="form-input model-api-key-input"
                    type="text"
                    value={draft.apiKey}
                    onChange={event => updateDraft({ apiKey: event.target.value })}
                    placeholder="输入 API Key"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}

              <label className="model-field model-field-full">
                <span>Base URL</span>
                <input className="form-input" value={draft.baseUrl} onChange={event => updateDraft({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
              </label>

              <div className="model-field model-field-full">
                <span className="model-field-label-row">
                  <span>模型名称</span>
                  {DEFAULT_MODELS[draft.provider] && (
                    <button type="button" onClick={() => updateDraft({ model: DEFAULT_MODELS[draft.provider] })}>使用默认值</button>
                  )}
                </span>
                <span className="model-input-action-row">
                  <span className="model-input-with-icon">
                    <img src={getModelIcon(draft.model, draft.provider)} alt="" />
                    <input
                      className="form-input"
                      aria-label="模型名称"
                      value={draft.model}
                      onChange={event => updateDraft({ model: event.target.value })}
                      placeholder={DEFAULT_MODELS[draft.provider] || '输入模型名称'}
                    />
                  </span>
                  <button type="button" className="btn-secondary model-fetch-button" onClick={() => void fetchModels()} disabled={isFetchingModels}>
                    {isFetchingModels ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                    获取模型
                  </button>
                </span>
                <select
                  className="form-input"
                  aria-label="已获取的模型列表"
                  value={availableModels.includes(draft.model) ? draft.model : ''}
                  disabled={isFetchingModels || availableModels.length === 0}
                  onChange={event => { if (event.target.value) updateDraft({ model: event.target.value }) }}
                >
                  <option value="">{isFetchingModels ? '正在获取模型…' : availableModels.length ? `选择模型（共 ${availableModels.length} 个）` : '点击“获取模型”加载列表'}</option>
                  {availableModels.map(model => <option value={model} key={model}>{model}</option>)}
                </select>
                <span role="status">{modelsMessage}</span>
              </div>

              <label className="model-field model-field-full">
                <span className="model-field-label-row"><span>温度</span><output>{draft.temperature.toFixed(1)}</output></span>
                <input className="form-slider" type="range" min="0" max="2" step="0.1" value={draft.temperature} onChange={event => updateDraft({ temperature: Number(event.target.value) })} />
                <span className="model-slider-scale"><span>稳定</span><span>创意</span></span>
              </label>
            </div>

            {testStatus !== 'idle' && (
              <div className={`model-test-status ${testStatus}`} role="status" aria-live="polite">
                {testStatus === 'testing' ? <><LoaderCircle className="spin" size={15} aria-hidden="true" />正在测试连接…</> : testMessage}
              </div>
            )}
          </div>

          <div className="model-editor-actions">
            <span className={isDirty ? 'visible' : ''}>有未保存的修改</span>
            <button type="button" className="btn-secondary" onClick={() => void testConnection()} disabled={testStatus === 'testing'}>
              <Plug size={15} aria-hidden="true" />测试连接
            </button>
            <button type="submit" className="btn-primary" disabled={isSaving || !isDirty}>
              {isSaving ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
              {isSaving ? '保存中…' : '保存配置'}
            </button>
          </div>
        </form>
      </section>

      {showAddDialog && (
        <div className="app-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowAddDialog(false) }}>
          <div className="app-dialog model-provider-dialog" role="dialog" aria-modal="true" aria-labelledby="add-model-title">
            <div className="app-dialog-head">
              <div><span className="model-provider-eyebrow">新建配置</span><h2 id="add-model-title">选择接入类型</h2></div>
              <button ref={addDialogCloseRef} type="button" className="app-dialog-close" onClick={() => setShowAddDialog(false)} aria-label="关闭"><X size={17} /></button>
            </div>
            <p className="app-dialog-description">选择服务商后会带入推荐接口地址，你仍可在下一步修改。</p>
            <div className="model-provider-options">
              {PROVIDERS.map(provider => (
                <button type="button" key={provider} onClick={() => void addProfile(provider)}>
                  <span className="model-provider-option-icon"><img src={getProviderIcon(provider)} alt="" /></span>
                  <span><strong>{PROVIDER_LABELS[provider]}</strong><small>{PROVIDER_DESCRIPTIONS[provider]}</small></span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="app-dialog-backdrop" role="presentation">
          <div className="app-dialog model-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-model-title" aria-describedby="delete-model-description">
            <div className="app-dialog-head"><h2 id="delete-model-title">删除模型配置？</h2></div>
            <p id="delete-model-description">“{deleteTarget.name}”及其中保存的 API Key 将被删除。此操作无法撤销。</p>
            <div className="app-dialog-actions">
              <button type="button" className="btn-secondary" autoFocus onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="btn-danger" onClick={() => void deleteProfile()}><Trash2 size={15} />删除配置</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

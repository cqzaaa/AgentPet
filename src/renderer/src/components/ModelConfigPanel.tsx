import React from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Flame,
  Globe,
  Key,
  Layers,
  LoaderCircle,
  Plus,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Sliders,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type { AppStore } from '../hooks/useAppStore'
import { DEFAULT_MODELS } from '../utils/helpers'
import { getModelIcon, getProviderIcon } from '../utils/modelIcons'
import './ModelConfigPanel.css'
import { normalizeContextWindow, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW } from '../../../preload/context-policy'

type ModelProfile = {
  id: string
  name: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens?: number
  contextWindow?: number
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
    baseUrl: config.baseUrl || PROVIDER_BASE_URLS[config.provider || 'gemini'] || '',
    model: config.model || '',
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.7,
    ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
    contextWindow: normalizeContextWindow(config.contextWindow),
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

const TEMPERATURE_PRESETS = [
  { label: '0.2 精准', value: 0.2 },
  { label: '0.7 平衡', value: 0.7 },
  { label: '1.2 创意', value: 1.2 }
]

const CONTEXT_PRESETS = [
  { label: '32k', value: 32000 },
  { label: '128k', value: 128000 },
  { label: '256k', value: 256000 },
  { label: '500k', value: 500000 }
]

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

  // 交互增强状态
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [showModelDropdown, setShowModelDropdown] = React.useState(false)
  const [modelFilterQuery, setModelFilterQuery] = React.useState('')
  const modelDropdownRef = React.useRef<HTMLDivElement>(null)

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
    setShowModelDropdown(false)
    setModelFilterQuery('')
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

  // 点击外部收起模型下拉菜单
  React.useEffect(() => {
    if (!showModelDropdown) return undefined
    const handleOutsideClick = (event: MouseEvent): void => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [showModelDropdown])

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
      if (merged.length > 0) {
        setShowModelDropdown(true)
        setModelsMessage(`已获取 ${merged.length} 个模型，可直接选择或搜索`)
      } else {
        setModelsMessage('接口未返回模型列表，可手动输入模型标识')
      }
      showToast(models?.length ? `成功获取 ${models.length} 个模型` : '未获取到模型，可继续手动输入', models?.length ? 'success' : 'info')
    } catch (error: any) {
      if (requestId !== modelsRequestRef.current) return
      setModelsMessage(error?.message || '获取模型列表失败，可继续手动输入')
      showToast(error?.message || '获取模型列表失败', 'error')
    } finally {
      if (requestId === modelsRequestRef.current) setIsFetchingModels(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setTestStatus('testing')
    setTestMessage('')
    try {
      const startTime = Date.now()
      const result = await window.api.callLLM(
        { ...draft, sessionId: 'system:test' },
        [{ role: 'user', content: 'Say "Success" in exactly one word.' }]
      )
      const duration = Date.now() - startTime
      setTestStatus('success')
      setTestMessage(`连接成功（耗时 ${duration}ms），模型响应：“${String(result).trim()}”`)
    } catch (error: any) {
      setTestStatus('error')
      setTestMessage(`连接失败：${error?.message || error}`)
    }
  }

  // 过滤后的模型列表
  const filteredModels = React.useMemo(() => {
    if (!modelFilterQuery.trim()) return availableModels
    const q = modelFilterQuery.toLowerCase()
    return availableModels.filter(m => m.toLowerCase().includes(q))
  }, [availableModels, modelFilterQuery])

  // 滑块百分比计算（用于动态 Fill 效果）
  const tempPercent = Math.min(100, Math.max(0, (draft.temperature / 2) * 100))
  const currentContext = normalizeContextWindow(draft.contextWindow)
  const contextPercent = Math.min(
    100,
    Math.max(0, ((currentContext - MIN_CONTEXT_WINDOW) / (MAX_CONTEXT_WINDOW - MIN_CONTEXT_WINDOW)) * 100)
  )

  const isCurrentActive = draft.id === activeProfile.id

  return (
    <div className="model-config-workspace">
      {/* ── 左侧配置列表 (Sidebar) ── */}
      <aside className="model-profile-sidebar" aria-label="模型配置列表">
        <div className="model-profile-sidebar-head">
          <div className="model-sidebar-title-group">
            <h2>模型档案</h2>
            <span className="model-count-pill">{profiles.length} 个配置</span>
          </div>
          <button
            className="model-add-button"
            type="button"
            onClick={() => setShowAddDialog(true)}
            title="添加新的模型配置"
          >
            <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
            <span>添加</span>
          </button>
        </div>

        <div className="model-profile-list" role="list">
          {profiles.map(profile => {
            const isActive = profile.id === activeProfile.id
            const isEditingThis = profile.id === draft.id
            return (
              <div
                className={`model-profile-row ${isActive ? 'active' : ''} ${isEditingThis ? 'editing' : ''}`}
                key={profile.id}
                role="listitem"
              >
                <button
                  type="button"
                  className="model-profile-select"
                  onClick={() => void activateProfile(profile)}
                  title={`切换到 ${profile.name}`}
                >
                  <span className="model-profile-icon-wrap">
                    <img src={getProviderIcon(profile.provider)} alt={profile.provider} />
                  </span>
                  <span className="model-profile-copy">
                    <span className="model-profile-name-row">
                      <span className="model-profile-name">{profile.name}</span>
                      {isEditingThis && isDirty && (
                        <span className="model-dirty-dot" title="包含未保存的编辑" />
                      )}
                    </span>
                    <span className="model-profile-meta">
                      {PROVIDER_LABELS[profile.provider] || profile.provider}
                      <span className="meta-sep">/</span>
                      <span className="model-pill-text">{profile.model || '未指定模型'}</span>
                    </span>
                  </span>
                  {isActive ? (
                    <span className="model-active-mark">
                      <Check size={11} strokeWidth={3} aria-hidden="true" />
                      <span>已启用</span>
                    </span>
                  ) : (
                    <ChevronRight size={14} className="model-chevron-hint" aria-hidden="true" />
                  )}
                </button>
                {profiles.length > 1 && (
                  <button
                    type="button"
                    className="model-profile-delete"
                    aria-label={`删除 ${profile.name}`}
                    title="删除此配置"
                    onClick={() => setDeleteTarget(profile)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className="model-profile-footnote">
          <span>智能体与对话实时绑定激活配置。切换时将自动暂存当前编辑。</span>
        </div>
      </aside>

      {/* ── 右侧表单编辑区 (Editor) ── */}
      <section className="model-profile-editor" aria-labelledby="model-profile-editor-title">
        {/* 顶部标题栏 */}
        <div className="model-profile-editor-head">
          <div className="model-profile-editor-title-wrap">
            <div className="model-hero-icon-box">
              <img src={getProviderIcon(draft.provider)} alt="" />
            </div>
            <div className="model-hero-text">
              <div className="model-eyebrow-row">
                <span className="model-provider-eyebrow">
                  {PROVIDER_LABELS[draft.provider] || draft.provider}
                </span>
                <span className="model-eyebrow-desc">
                  {PROVIDER_DESCRIPTIONS[draft.provider] || '标准 OpenAI 协议兼容'}
                </span>
              </div>
              <h2 id="model-profile-editor-title">{draft.name || '编辑配置'}</h2>
            </div>
          </div>
          <div className="model-head-actions">
            {isCurrentActive ? (
              <span className="model-current-chip active">
                <span className="chip-glow" />
                <span>当前全局启用</span>
              </span>
            ) : (
              <button
                type="button"
                className="model-activate-btn"
                onClick={() => void activateProfile(draft)}
              >
                设为当前启用
              </button>
            )}
          </div>
        </div>

        <form className="model-profile-form" noValidate onSubmit={event => { event.preventDefault(); void saveDraft() }}>
          <div className="model-profile-form-scroll">
            {/* ── Bento 卡片 1: 基础属性与服务商 ── */}
            <div className="model-bento-card">
              <div className="model-card-header">
                <div className="card-header-title">
                  <Server size={15} className="card-icon" />
                  <h3>配置档案标识</h3>
                </div>
                <span className="card-subtitle">命名此配置以便在工作流中快速辨识</span>
              </div>
              <div className="model-card-body">
                <div className="model-field">
                  <label htmlFor="model-cfg-name" className="field-label">配置名称</label>
                  <input
                    id="model-cfg-name"
                    className="form-input elegant-input"
                    value={draft.name}
                    onChange={event => updateDraft({ name: event.target.value })}
                    placeholder="例如：主力对话 / 代码专属 / 快速分析"
                  />
                </div>
              </div>
            </div>

            {/* ── Bento 卡片 2: 连接凭证与网关 ── */}
            <div className="model-bento-card">
              <div className="model-card-header">
                <div className="card-header-title">
                  <Globe size={15} className="card-icon" />
                  <h3>网关接入与鉴权</h3>
                </div>
                <span className="card-subtitle">OpenAI 兼容端点协议与访问密钥</span>
              </div>
              <div className="model-card-body">
                {/* Base URL */}
                <div className="model-field">
                  <div className="field-label-split">
                    <label htmlFor="model-cfg-url" className="field-label">Base URL (API 端点)</label>
                    {PROVIDER_BASE_URLS[draft.provider] && draft.baseUrl !== PROVIDER_BASE_URLS[draft.provider] && (
                      <button
                        type="button"
                        className="subtle-link-btn"
                        onClick={() => updateDraft({ baseUrl: PROVIDER_BASE_URLS[draft.provider] })}
                        title="恢复官方默认端点"
                      >
                        <RotateCcw size={11} />
                        <span>恢复官方默认</span>
                      </button>
                    )}
                  </div>
                  <div className="model-input-wrapper">
                    <input
                      id="model-cfg-url"
                      className="form-input elegant-input mono-font"
                      value={draft.baseUrl}
                      onChange={event => updateDraft({ baseUrl: event.target.value })}
                      placeholder={PROVIDER_BASE_URLS[draft.provider] || 'https://api.example.com/v1'}
                      spellCheck={false}
                    />
                  </div>
                </div>

                {/* API Key */}
                {draft.provider !== 'ollama' && (
                  <div className="model-field">
                    <div className="field-label-split">
                      <label htmlFor="model-cfg-key" className="field-label">API Key</label>
                      <span className="field-hint-text">凭证已安全存储在加密容器中</span>
                    </div>
                    <div className="model-input-wrapper has-trailing-action">
                      <Key size={14} className="input-leading-icon" />
                      <input
                        id="model-cfg-key"
                        className="form-input elegant-input mono-font key-padding"
                        type={showApiKey ? 'text' : 'password'}
                        value={draft.apiKey}
                        onChange={event => updateDraft({ apiKey: event.target.value })}
                        placeholder="sk-..."
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="input-trailing-btn"
                        onClick={() => setShowApiKey(v => !v)}
                        title={showApiKey ? '隐藏 API Key' : '显示完整 API Key'}
                        aria-label={showApiKey ? '隐藏 API Key' : '显示完整 API Key'}
                      >
                        {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Bento 卡片 3: 模型与推理偏好 ── */}
            <div className="model-bento-card">
              <div className="model-card-header">
                <div className="card-header-title">
                  <Sliders size={15} className="card-icon" />
                  <h3>模型选择与推理参数</h3>
                </div>
                <span className="card-subtitle">指定具体调用模型架构与生成特征</span>
              </div>
              <div className="model-card-body">
                {/* 模型选择器 (Taste-Skill 集成式 Model Picker) */}
                <div className="model-field" ref={modelDropdownRef}>
                  <div className="field-label-split">
                    <label htmlFor="model-cfg-selector" className="field-label">模型架构 (Model ID)</label>
                    <div className="field-action-group">
                      {DEFAULT_MODELS[draft.provider] && draft.model !== DEFAULT_MODELS[draft.provider] && (
                        <button
                          type="button"
                          className="subtle-link-btn"
                          onClick={() => updateDraft({ model: DEFAULT_MODELS[draft.provider] })}
                        >
                          <Sparkles size={11} />
                          <span>填入推荐默认 ({DEFAULT_MODELS[draft.provider]})</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 组合输入栏 */}
                  <div className="model-picker-composite">
                    <div className="model-picker-input-box">
                      <span className="model-picker-brand-icon">
                        <img src={getModelIcon(draft.model, draft.provider)} alt="" />
                      </span>
                      <input
                        id="model-cfg-selector"
                        className="form-input elegant-input picker-input mono-font"
                        value={draft.model}
                        onChange={event => {
                          updateDraft({ model: event.target.value })
                          setModelFilterQuery(event.target.value)
                        }}
                        onFocus={() => {
                          if (availableModels.length > 0) setShowModelDropdown(true)
                        }}
                        placeholder={DEFAULT_MODELS[draft.provider] || '输入或选择模型，如 gpt-4o, deepseek-chat'}
                        spellCheck={false}
                      />
                      {availableModels.length > 0 && (
                        <button
                          type="button"
                          className={`model-dropdown-trigger-btn ${showModelDropdown ? 'open' : ''}`}
                          onClick={() => setShowModelDropdown(v => !v)}
                          title="切换模型列表"
                        >
                          <ChevronDown size={14} />
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      className="btn-fetch-models"
                      onClick={() => void fetchModels()}
                      disabled={isFetchingModels}
                      title="通过 API 连接自动拉取远端服务支持的模型列表"
                    >
                      {isFetchingModels ? (
                        <LoaderCircle className="spin" size={14} aria-hidden="true" />
                      ) : (
                        <RefreshCw size={14} aria-hidden="true" />
                      )}
                      <span>{isFetchingModels ? '正在获取…' : '获取模型列表'}</span>
                    </button>
                  </div>

                  {/* 状态轻量提示 */}
                  {modelsMessage && (
                    <div className="model-fetch-feedback">
                      <span className="feedback-dot" />
                      <span>{modelsMessage}</span>
                    </div>
                  )}

                  {/* 自定义模型选择下拉面板 */}
                  {showModelDropdown && availableModels.length > 0 && (
                    <div className="model-dropdown-panel" role="dialog" aria-label="可用模型列表">
                      <div className="dropdown-panel-search">
                        <Search size={13} className="panel-search-icon" />
                        <input
                          type="text"
                          className="dropdown-filter-input"
                          placeholder="快速搜索过滤模型…"
                          value={modelFilterQuery}
                          onChange={e => setModelFilterQuery(e.target.value)}
                          autoFocus
                        />
                        {modelFilterQuery && (
                          <button
                            type="button"
                            className="clear-search-btn"
                            onClick={() => setModelFilterQuery('')}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>

                      <div className="dropdown-panel-meta">
                        <span>可用模型 ({filteredModels.length} / {availableModels.length})</span>
                      </div>

                      <div className="dropdown-panel-list">
                        {filteredModels.length === 0 ? (
                          <div className="dropdown-empty-hint">
                            未找到匹配的模型“{modelFilterQuery}”
                          </div>
                        ) : (
                          filteredModels.map(m => {
                            const isSelected = draft.model === m
                            return (
                              <button
                                type="button"
                                key={m}
                                className={`dropdown-item-row ${isSelected ? 'selected' : ''}`}
                                onClick={() => {
                                  updateDraft({ model: m })
                                  setShowModelDropdown(false)
                                }}
                              >
                                <span className="dropdown-item-icon">
                                  <img src={getModelIcon(m, draft.provider)} alt="" />
                                </span>
                                <span className="dropdown-item-name">{m}</span>
                                {isSelected && (
                                  <Check size={14} className="dropdown-check-icon" strokeWidth={2.5} />
                                )}
                              </button>
                            )
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* 温度调节 */}
                <div className="model-field slider-field">
                  <div className="field-label-split">
                    <span className="slider-label-wrap">
                      <Flame size={14} className="param-icon" />
                      <label htmlFor="temp-slider" className="field-label">采样温度 (Temperature)</label>
                    </span>
                    <span className="slider-value-badge">{draft.temperature.toFixed(1)}</span>
                  </div>

                  <div className="slider-track-container">
                    <input
                      id="temp-slider"
                      className="form-slider modern-slider"
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={draft.temperature}
                      style={{
                        background: `linear-gradient(to right, var(--model-accent) 0%, var(--model-accent) ${tempPercent}%, var(--slider-track-empty) ${tempPercent}%, var(--slider-track-empty) 100%)`
                      }}
                      onChange={event => updateDraft({ temperature: Number(event.target.value) })}
                    />
                  </div>

                  <div className="slider-footer-row">
                    <div className="slider-scale-labels">
                      <span>0.0 严谨确定</span>
                      <span>1.0 均衡</span>
                      <span>2.0 发散创意</span>
                    </div>
                    <div className="preset-pill-group">
                      {TEMPERATURE_PRESETS.map(preset => (
                        <button
                          key={preset.value}
                          type="button"
                          className={`preset-pill ${Math.abs(draft.temperature - preset.value) < 0.05 ? 'active' : ''}`}
                          onClick={() => updateDraft({ temperature: preset.value })}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 上下文窗口 */}
                <div className="model-field slider-field">
                  <div className="field-label-split">
                    <span className="slider-label-wrap">
                      <Layers size={14} className="param-icon" />
                      <label htmlFor="context-slider" className="field-label">上下文窗口容量 (Context Window)</label>
                    </span>
                    <span className="slider-value-badge mono-font">
                      {(currentContext / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}k Tokens
                    </span>
                  </div>

                  <div className="slider-track-container">
                    <input
                      id="context-slider"
                      className="form-slider modern-slider"
                      type="range"
                      min={MIN_CONTEXT_WINDOW}
                      max={MAX_CONTEXT_WINDOW}
                      step="1000"
                      value={currentContext}
                      style={{
                        background: `linear-gradient(to right, var(--model-accent) 0%, var(--model-accent) ${contextPercent}%, var(--slider-track-empty) ${contextPercent}%, var(--slider-track-empty) 100%)`
                      }}
                      onChange={event => updateDraft({ contextWindow: Number(event.target.value) })}
                      aria-describedby="context-window-help"
                    />
                  </div>

                  <div className="slider-footer-row">
                    <div className="slider-scale-labels">
                      <span>32k</span>
                      <span>500k Max</span>
                    </div>
                    <div className="preset-pill-group">
                      {CONTEXT_PRESETS.map(preset => (
                        <button
                          key={preset.value}
                          type="button"
                          className={`preset-pill ${Math.abs(currentContext - preset.value) < 500 ? 'active' : ''}`}
                          onClick={() => updateDraft({ contextWindow: preset.value })}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <p id="context-window-help" className="field-desc">
                    请按模型实际支持的最大上下文合理设定。单个附件全文最多占 5%，多附件合计最多占 20%，超出时系统将自动降级为按需切片读取。
                  </p>
                </div>
              </div>
            </div>

            {/* 测试结果状态条 */}
            {testStatus !== 'idle' && (
              <div className={`model-test-banner ${testStatus}`} role="status" aria-live="polite">
                <div className="test-banner-content">
                  {testStatus === 'testing' && <LoaderCircle className="spin" size={16} />}
                  {testStatus === 'success' && <Check size={16} className="test-status-icon" strokeWidth={2.5} />}
                  {testStatus === 'error' && <X size={16} className="test-status-icon" strokeWidth={2.5} />}
                  <span className="test-banner-text">
                    {testStatus === 'testing' ? '正在连接端点并发起握手测试…' : testMessage}
                  </span>
                </div>
                {testStatus !== 'testing' && (
                  <button
                    type="button"
                    className="test-banner-close"
                    onClick={() => setTestStatus('idle')}
                    title="收起测试结果"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ── 底部操作栏 ── */}
          <footer className="model-editor-actions">
            <div className={`dirty-status-indicator ${isDirty ? 'visible' : ''}`}>
              <span className="dirty-pulse-dot" />
              <span>有未保存的修改</span>
            </div>

            <div className="actions-btn-group">
              <button
                type="button"
                className="btn-test-conn"
                onClick={() => void testConnection()}
                disabled={testStatus === 'testing'}
              >
                {testStatus === 'testing' ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : (
                  <Plug size={14} aria-hidden="true" />
                )}
                <span>{testStatus === 'testing' ? '测试中…' : '测试连接'}</span>
              </button>

              <button
                type="submit"
                className="btn-save-cfg"
                disabled={isSaving || !isDirty}
              >
                {isSaving ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : (
                  <Save size={14} aria-hidden="true" />
                )}
                <span>{isSaving ? '保存中…' : '保存配置'}</span>
              </button>
            </div>
          </footer>
        </form>
      </section>

      {/* ── 添加配置弹窗 ── */}
      {showAddDialog && (
        <div
          className="app-dialog-backdrop"
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) setShowAddDialog(false) }}
        >
          <div
            className="app-dialog model-provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-model-title"
          >
            <div className="app-dialog-head">
              <div>
                <span className="model-provider-eyebrow">新建服务接入</span>
                <h2 id="add-model-title">选择提供商类型</h2>
              </div>
              <button
                ref={addDialogCloseRef}
                type="button"
                className="app-dialog-close"
                onClick={() => setShowAddDialog(false)}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <p className="app-dialog-description">
              选择后将自动配置推荐的服务网关与官方规范，后续可任意调整。
            </p>
            <div className="model-provider-options">
              {PROVIDERS.map(provider => (
                <button
                  type="button"
                  key={provider}
                  className="provider-select-card"
                  onClick={() => void addProfile(provider)}
                >
                  <span className="model-provider-option-icon">
                    <img src={getProviderIcon(provider)} alt="" />
                  </span>
                  <span className="provider-card-copy">
                    <strong>{PROVIDER_LABELS[provider]}</strong>
                    <small>{PROVIDER_DESCRIPTIONS[provider]}</small>
                  </span>
                  <ChevronRight size={15} className="provider-card-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 删除确认弹窗 ── */}
      {deleteTarget && (
        <div className="app-dialog-backdrop" role="presentation">
          <div
            className="app-dialog model-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-model-title"
            aria-describedby="delete-model-description"
          >
            <div className="app-dialog-head">
              <h2 id="delete-model-title">确认删除配置？</h2>
            </div>
            <p id="delete-model-description">
              将永久移除配置“<strong>{deleteTarget.name}</strong>”及其关联的凭证信息。此操作无法撤销。
            </p>
            <div className="app-dialog-actions">
              <button
                type="button"
                className="btn-dialog-cancel"
                autoFocus
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-dialog-danger"
                onClick={() => void deleteProfile()}
              >
                <Trash2 size={14} />
                <span>确认删除</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

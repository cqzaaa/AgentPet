import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Cpu, LoaderCircle, RefreshCw, Sparkles, X, SlidersHorizontal } from 'lucide-react'
import type { WikiModelSelection, WikiModelSettings as Settings } from '../../../preload/wiki-types'
import { getModelIcon } from '../utils/modelIcons'
import './WikiModelSettings.css'

function selectionValue(selection: WikiModelSelection): string {
  return selection.mode === 'profile' ? `profile:${selection.profileId}` : selection.mode
}

export function WikiModelSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const request = useRef(0)
  const saving = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (saving.current) return
    const id = ++request.current
    try {
      const result = await window.api.wikiGetModelSettings()
      if (id === request.current) {
        setSettings(result)
        setError('')
      }
    } catch {
      if (id === request.current) setError('无法读取 Wiki 模型配置，请点击刷新重试。')
    } finally {
      if (id === request.current) setBusy(null)
    }
  }, [])

  const refresh = useCallback((): void => {
    if (saving.current) return
    setBusy('loading')
    setError('')
    void load()
  }, [load])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      request.current++
      window.removeEventListener('focus', refresh)
    }
  }, [load, refresh])

  // Esc 按键关闭弹窗
  useEffect(() => {
    if (!modalOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setModalOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [modalOpen])

  const save = async (value: string): Promise<void> => {
    if (saving.current || busy) return
    const selection: WikiModelSelection = value.startsWith('profile:')
      ? { mode: 'profile', profileId: value.slice(8) }
      : { mode: value === 'local' ? 'local' : 'system' }
    saving.current = true
    const id = ++request.current
    setBusy('saving')
    setError('')
    setMessage('')
    try {
      const result = await window.api.wikiSaveModelSettings(selection)
      if (id !== request.current) return
      setSettings(result)
      setMessage('已生效！下次提取实体时将采用此模型配置。')
      // 保存后平滑关闭弹窗
      setTimeout(() => {
        setModalOpen(false)
      }, 350)
    } catch {
      if (id === request.current) setError('保存失败，仍使用之前的选择。请刷新配置后重试。')
    } finally {
      saving.current = false
      if (id === request.current) setBusy(null)
    }
  }

  const selected = settings ? selectionValue(settings.selection) : ''
  const missingProfile =
    settings?.selection.mode === 'profile' &&
    !settings.profiles.some((profile) => `profile:${profile.id}` === selected)

  // 计算当前触发按钮展示的图标、名称与厂商
  let activeIcon: React.ReactNode = <Cpu size={14} className="wiki-model-btn-icon-fallback" />
  let activeTitle = '正在读取模型…'
  let activeSubtitle = ''

  if (settings) {
    if (settings.selection.mode === 'system') {
      activeTitle = '跟随系统模型'
      activeSubtitle = settings.effectiveModel ? `${settings.effectiveModel.provider} / ${settings.effectiveModel.model}` : '全局默认'
      if (settings.effectiveModel) {
        activeIcon = (
          <img
            src={getModelIcon(settings.effectiveModel.model, settings.effectiveModel.provider)}
            alt={settings.effectiveModel.provider}
            className="wiki-model-brand-icon"
          />
        )
      } else {
        activeIcon = <Sparkles size={14} className="wiki-model-btn-icon-sparkle" />
      }
    } else if (settings.selection.mode === 'local') {
      activeTitle = '仅使用本地规则'
      activeSubtitle = '离线纯规则提取'
      activeIcon = <Cpu size={14} className="wiki-model-btn-icon-local" />
    } else if (missingProfile) {
      activeTitle = '模型配置已失效'
      activeSubtitle = '请点击重新选择'
      activeIcon = <Cpu size={14} className="wiki-model-btn-icon-fallback text-danger" />
    } else {
      const matched = settings.profiles.find((p) => `profile:${p.id}` === selected)
      if (matched) {
        activeTitle = matched.name
        activeSubtitle = matched.model || matched.provider
        activeIcon = (
          <img
            src={getModelIcon(matched.model || '', matched.provider)}
            alt={matched.provider}
            className="wiki-model-brand-icon"
          />
        )
      } else {
        activeTitle = '自定义独立模型'
      }
    }
  }

  return (
    <>
      {/* 顶部常驻的触发胶囊按钮 (Taste-Skill Precision Button) */}
      <button
        type="button"
        className={`wiki-header-model-btn${modalOpen ? ' is-active' : ''}`}
        onClick={() => setModalOpen(true)}
        title="点击切换实体提取模型"
        aria-haspopup="dialog"
        aria-expanded={modalOpen}
      >
        <div className="wiki-header-model-icon-box">
          {activeIcon}
        </div>
        <div className="wiki-header-model-info">
          <span className="wiki-header-model-tag">Wiki 模型</span>
          <span className="wiki-header-model-name">
            {activeTitle}
            {activeSubtitle && <small className="wiki-header-model-sub">({activeSubtitle})</small>}
          </span>
        </div>
        <SlidersHorizontal size={12} className="wiki-header-model-arrow" />
      </button>

      {/* 独立顶层全屏居中模态弹窗 (Escape All Overflow Constraints) */}
      {modalOpen && (
        <div
          className="wiki-model-dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModalOpen(false)
          }}
        >
          <div
            className="wiki-model-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wiki-model-dialog-title"
          >
            {/* 弹窗头部 */}
            <div className="wiki-model-dialog-header">
              <div className="wiki-model-dialog-title-group">
                <div className="wiki-model-dialog-badge-icon">
                  <Sparkles size={16} />
                </div>
                <div>
                  <h3 id="wiki-model-dialog-title">选择实体提取模型</h3>
                  <p>用于解析工作区文档并构建关系网络，不影响日常聊天模型。</p>
                </div>
              </div>
              <div className="wiki-model-dialog-actions">
                <button
                  type="button"
                  className="wiki-model-dialog-refresh-btn"
                  disabled={Boolean(busy)}
                  onClick={refresh}
                  title="刷新模型配置"
                  aria-label="刷新模型配置"
                >
                  {busy ? <LoaderCircle size={14} className="wiki-spin" /> : <RefreshCw size={14} />}
                </button>
                <button
                  type="button"
                  className="wiki-model-dialog-close-btn"
                  onClick={() => setModalOpen(false)}
                  aria-label="关闭选择弹窗"
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            {/* 当前采用状态胶囊 */}
            <div className="wiki-model-dialog-effective-bar">
              <span className={`wiki-model-effective-dot${settings?.effectiveModel ? '' : ' neutral'}`} />
              <span className="wiki-model-effective-text">
                当前提取采用：
                <strong>
                  {settings?.effectiveModel
                    ? `${settings.effectiveModel.provider} / ${settings.effectiveModel.model}`
                    : '本地离线正则规则（不消耗 Token）'}
                </strong>
              </span>
            </div>

            {/* 弹窗核心选项列表 */}
            <div className="wiki-model-dialog-body">
              {/* 1. 基础模式 */}
              <div className="wiki-model-dialog-group-title">基础模式</div>
              <div className="wiki-model-options-grid">
                <div
                  role="button"
                  tabIndex={0}
                  className={`wiki-model-card-btn${selected === 'system' ? ' is-selected' : ''}`}
                  onClick={() => void save('system')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void save('system') } }}
                >
                  <div className="wiki-model-card-top-bar">
                    <div className="wiki-model-card-icon-wrap">
                      {settings?.effectiveModel ? (
                        <img
                          src={getModelIcon(settings.effectiveModel.model, settings.effectiveModel.provider)}
                          alt=""
                          className="wiki-model-brand-icon"
                        />
                      ) : (
                        <Sparkles size={16} />
                      )}
                    </div>
                    {selected === 'system' && <Check size={15} className="wiki-model-card-check" />}
                  </div>
                  <div className="wiki-model-card-content">
                    <strong>跟随系统模型</strong>
                    <p>复用全局默认的 LLM 模型与凭证进行深度实体抽取</p>
                  </div>
                </div>

                <div
                  role="button"
                  tabIndex={0}
                  className={`wiki-model-card-btn${selected === 'local' ? ' is-selected' : ''}`}
                  onClick={() => void save('local')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void save('local') } }}
                >
                  <div className="wiki-model-card-top-bar">
                    <div className="wiki-model-card-icon-wrap local">
                      <Cpu size={16} />
                    </div>
                    {selected === 'local' && <Check size={15} className="wiki-model-card-check" />}
                  </div>
                  <div className="wiki-model-card-content">
                    <strong>仅使用本地规则</strong>
                    <p>零网络请求，通过纯本地规则与词法分析快速提取核心实体</p>
                  </div>
                </div>
              </div>

              {/* 2. 已配置的独立模型 */}
              {settings && settings.profiles.length > 0 && (
                <>
                  <div className="wiki-model-dialog-group-title">已配置的独立模型</div>
                  <div className="wiki-model-profiles-list">
                    {settings.profiles.map((profile) => {
                      const optVal = `profile:${profile.id}`
                      const isSelected = selected === optVal
                      const brandIconUrl = getModelIcon(profile.model || '', profile.provider)
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          className={`wiki-model-profile-row${isSelected ? ' is-selected' : ''}${!profile.available ? ' is-disabled' : ''}`}
                          onClick={() => void save(optVal)}
                          disabled={!profile.available || Boolean(busy)}
                        >
                          <div className="wiki-model-profile-icon">
                            <img src={brandIconUrl} alt={profile.provider} />
                          </div>
                          <div className="wiki-model-profile-info">
                            <div className="wiki-model-profile-head">
                              <span className="wiki-model-profile-name">{profile.name}</span>
                              <span className="wiki-model-profile-tag">{profile.provider}</span>
                            </div>
                            <span className="wiki-model-profile-model">
                              {profile.model || '默认模型'}
                              {!profile.available && '（缺少 API Key 或模型配置）'}
                            </span>
                          </div>
                          {isSelected && <Check size={15} className="wiki-model-profile-check" />}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {/* 异常提示 */}
              {error && <div className="wiki-model-dialog-error">{error}</div>}
              {message && <div className="wiki-model-dialog-success">{message}</div>}
            </div>

            {/* 弹窗底部操作 */}
            <div className="wiki-model-dialog-footer">
              <span className="wiki-model-dialog-hint">设置后对全量 Wiki 工作区自动生效</span>
              <button
                type="button"
                className="wiki-model-dialog-confirm-btn"
                onClick={() => setModalOpen(false)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

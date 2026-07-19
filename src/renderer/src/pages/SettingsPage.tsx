import React from 'react'
import { DEFAULT_MODELS } from '../utils/helpers'
import type { AppStore } from '../hooks/useAppStore'
import { getProviderIcon, getModelIcon } from '../utils/modelIcons'
import {
  AudioLines,
  Cat,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  FolderOpen,
  MessageSquare,
  Pencil,
  Plug,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  X
} from 'lucide-react'

interface SettingsPageProps {
  store: AppStore
}

export function SettingsPage({ store }: SettingsPageProps): React.JSX.Element {
  const {
    settingsSubTab, setSettingsSubTab,
    // llm
    llmConfig, saveLlmConfig,
    showApiKey, setShowApiKey,
    showModelDropdown, setShowModelDropdown,
    isLoadingModels, availableModels,
    dropdownRef,
    handleFetchModels, handleTestConnection,
    testStatus,
    // storage
    storageInputPath, setStorageInputPath,
    actualStoragePath, storageSaveStatus,
    handleSaveStoragePath,
    // avatar
    customModelDir, setCustomModelDir,
    customModelFile, setCustomModelFile,
    avatarList, refreshAvatarsList,
    showToast,
    // tts
    ttsEnabled, setTtsEnabled,
  } = store

  // 虚拟体编辑弹窗状态
  const [showEditAvatarModal, setShowEditAvatarModal] = React.useState(false)
  const [editingAvatar, setEditingAvatar] = React.useState<any>(null)
  const [editAvatarName, setEditAvatarName] = React.useState('')
  const [editAvatarStyle, setEditAvatarStyle] = React.useState('normal')
  const [editAvatarVoice, setEditAvatarVoice] = React.useState('zh-CN-XiaoxiaoNeural')
  const [editAvatarScale, setEditAvatarScale] = React.useState(1.0)
  const [editAvatarXOffset, setEditAvatarXOffset] = React.useState(0)
  const [editAvatarYOffset, setEditAvatarYOffset] = React.useState(0)
  const [openAvatarDropdownId, setOpenAvatarDropdownId] = React.useState<string | null>(null)
  const [dropdownPos, setDropdownPos] = React.useState<{ top?: number, bottom?: number, right: number }>({ top: 0, right: 0 })
  const [apiKeyDraft, setApiKeyDraft] = React.useState('')
  const [isSavingApiKey, setIsSavingApiKey] = React.useState(false)

  const handleSaveApiKey = async (): Promise<void> => {
    if (!apiKeyDraft) {
      showToast('请输入要安全保存的 API 密钥', 'info')
      return
    }
    setIsSavingApiKey(true)
    try {
      const saved = await saveLlmConfig({ ...llmConfig, apiKey: apiKeyDraft })
      if (saved) {
        setApiKeyDraft('')
        showToast('API 密钥已使用系统凭据保护安全保存', 'success')
      }
    } finally {
      setIsSavingApiKey(false)
    }
  }

  // 点击外部/滚动/缩放时关闭下拉菜单
  React.useEffect(() => {
    if (!openAvatarDropdownId) return
    const handleClose = () => setOpenAvatarDropdownId(null)
    window.addEventListener('click', handleClose)
    window.addEventListener('scroll', handleClose, { capture: true })
    window.addEventListener('resize', handleClose)
    return () => {
      window.removeEventListener('click', handleClose)
      window.removeEventListener('scroll', handleClose, { capture: true })
      window.removeEventListener('resize', handleClose)
    }
  }, [openAvatarDropdownId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/* Sub Nav */}
      <div className="sub-tab-nav">
        <div className={`sub-tab-item ${settingsSubTab === 'keys' ? 'active' : ''}`} onClick={() => setSettingsSubTab('keys')}>
          模型配置
        </div>
        <div className={`sub-tab-item ${settingsSubTab === 'storage' ? 'active' : ''}`} onClick={() => setSettingsSubTab('storage')}>
          本地存储
        </div>
        <div className={`sub-tab-item ${settingsSubTab === 'avatar' ? 'active' : ''}`} onClick={() => setSettingsSubTab('avatar')}>
          虚拟体设置
        </div>
      </div>

      {/* Sub Panel */}
      <div className="sub-content-panel">
        {/* ── 模型配置 ── */}
        {settingsSubTab === 'keys' && (
          <div className="settings-sub-panel">
            {/* Provider Selection */}
            <div className="form-group">
              <label className="form-label">API 服务商</label>
              <div className="provider-grid">
                {['gemini', 'deepseek', 'openai', 'ollama', 'custom'].map(prov => (
                  <div
                    key={prov}
                    className={`provider-btn ${llmConfig.provider === prov ? 'active' : ''}`}
                    onClick={() => {
                      const defaults = { provider: prov, apiKey: '', hasApiKey: llmConfig.hasApiKey, baseUrl: '', model: '', temperature: llmConfig.temperature, maxTokens: undefined }
                      if (prov === 'gemini') { defaults.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai' }
                      else if (prov === 'openai') { defaults.baseUrl = 'https://api.openai.com/v1' }
                      else if (prov === 'deepseek') { defaults.baseUrl = 'https://api.deepseek.com/v1' }
                      else if (prov === 'ollama') { defaults.baseUrl = 'http://localhost:11434/v1' }
                      saveLlmConfig(defaults)
                    }}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                  >
                    <img
                      src={getProviderIcon(prov)}
                      className="provider-btn-icon"
                      alt={prov}
                      style={{ width: '16px', height: '16px', borderRadius: '3px', objectFit: 'contain' }}
                    />
                    <span>{prov.toUpperCase()}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* API Key */}
            {llmConfig.provider !== 'ollama' && (
              <div className="form-group" style={{ position: 'relative' }}>
                <label className="form-label">API 密钥 (API Key)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                  <div style={{ display: 'flex', position: 'relative', flex: 1 }}>
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      className="form-input"
                      placeholder={llmConfig.hasApiKey ? '密钥已安全保存；输入新密钥可替换' : '输入大模型提供商的 API 密钥'}
                      value={apiKeyDraft}
                      autoComplete="new-password"
                      spellCheck={false}
                      onChange={e => setApiKeyDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !isSavingApiKey) void handleSaveApiKey()
                      }}
                      style={{ flex: 1, paddingRight: '40px' }}
                    />
                    <button
                      type="button"
                      style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', userSelect: 'none', fontSize: '14px', opacity: 0.6, border: 'none', background: 'transparent', padding: 0, lineHeight: 0, color: 'currentColor' }}
                      onClick={() => setShowApiKey(!showApiKey)}
                      title={showApiKey ? '隐藏密钥' : '显示密钥'}
                      aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
                    >
                      {showApiKey
                        ? <EyeOff size={16} strokeWidth={2} aria-hidden="true" />
                        : <Eye size={16} strokeWidth={2} aria-hidden="true" />}
                    </button>
                  </div>
                  <button
                    className="btn-primary"
                    type="button"
                    disabled={!apiKeyDraft || isSavingApiKey}
                    onClick={() => void handleSaveApiKey()}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {isSavingApiKey ? '保存中…' : '安全保存'}
                  </button>
                </div>
                <div style={{ marginTop: '6px', fontSize: '11px', opacity: 0.65 }}>
                  {llmConfig.hasApiKey && <CheckCircle2 size={13} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />}
                  {llmConfig.hasApiKey ? '已保存到系统加密凭据库，页面不会回显密钥。' : '密钥不会写入 localStorage 或普通配置文件。'}
                </div>
              </div>
            )}

            {/* Base URL */}
            <div className="form-group">
              <label className="form-label">API 代理/基准接口地址 (Base URL)</label>
              <input
                type="text"
                className="form-input"
                placeholder="https://api.example.com/v1"
                value={llmConfig.baseUrl}
                onChange={e => saveLlmConfig({ ...llmConfig, baseUrl: e.target.value })}
              />
            </div>

            {/* Model name */}
            <div className="form-group" style={{ position: 'relative' }} ref={dropdownRef}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                <label className="form-label">模型名称 (Model)</label>
                {DEFAULT_MODELS[llmConfig.provider] && (
                  <span
                    style={{ fontSize: '11px', color: '#60a5fa', cursor: 'pointer', textDecoration: 'underline', fontWeight: 600 }}
                    onClick={() => saveLlmConfig({ ...llmConfig, model: DEFAULT_MODELS[llmConfig.provider] })}
                  >
                    填入默认模型 ({DEFAULT_MODELS[llmConfig.provider]})
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', position: 'relative', width: '100%' }}>
                <input
                  type="text"
                  className="form-input"
                  placeholder={DEFAULT_MODELS[llmConfig.provider] ? `例如: ${DEFAULT_MODELS[llmConfig.provider]}` : '请输入模型名称'}
                  value={llmConfig.model}
                  onChange={e => saveLlmConfig({ ...llmConfig, model: e.target.value })}
                  onClick={() => { if (!showModelDropdown) handleFetchModels() }}
                  style={{ flex: 1, paddingRight: '30px' }}
                />
                <button
                  type="button"
                  style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', opacity: 0.6, fontSize: '11px', userSelect: 'none', color: 'var(--text-muted)', border: 0, background: 'transparent', padding: 0, lineHeight: 0 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (showModelDropdown) { setShowModelDropdown(false) } else { handleFetchModels() }
                  }}
                >
                  <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>

              {showModelDropdown && (
                <div className="model-dropdown-list">
                  {isLoadingModels ? (
                    <div className="dropdown-loading-item">正在请求 models 接口获取模型...</div>
                  ) : availableModels.length > 0 ? (
                    <>
                      <div className="dropdown-section-title">可用模型列表 ({availableModels.length})</div>
                      {availableModels.map(m => (
                        <div
                          key={m}
                          className={`dropdown-item ${llmConfig.model === m ? 'active' : ''}`}
                          onClick={() => { saveLlmConfig({ ...llmConfig, model: m }); setShowModelDropdown(false) }}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                        >
                          <img
                            src={getModelIcon(m, llmConfig.provider)}
                            className="model-item-icon"
                            alt=""
                            style={{ width: '16px', height: '16px', borderRadius: '3px', flexShrink: 0, objectFit: 'contain' }}
                          />
                          <span className="model-name-text" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m}</span>
                          {m === DEFAULT_MODELS[llmConfig.provider] && <span className="default-badge" style={{ flexShrink: 0 }}>推荐默认</span>}
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="dropdown-empty-item">未获取到模型列表，可手动输入</div>
                  )}
                </div>
              )}
            </div>

            {/* Temperature */}
            <div className="form-group">
              <label className="form-label">核采样温度 (Temperature)</label>
              <div className="slider-group">
                <input
                  type="range"
                  min="0.0"
                  max="2.0"
                  step="0.1"
                  className="form-slider"
                  value={llmConfig.temperature}
                  onChange={e => saveLlmConfig({ ...llmConfig, temperature: parseFloat(e.target.value) })}
                />
                <span className="slider-val">{llmConfig.temperature.toFixed(1)}</span>
              </div>
            </div>

            {/* Actions row */}
            <div className="action-row">
              <button className="btn-primary" onClick={handleTestConnection} disabled={testStatus === 'testing'}>
                {testStatus === 'testing'
                  ? '正在连通测试...'
                  : <><Plug size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />测试大模型连接</>}
              </button>
            </div>

            {testStatus !== 'idle' && testStatus !== 'testing' && (
              <div style={{
                fontSize: '12.5px',
                color: testStatus.startsWith('连接成功') ? '#10b981' : '#f87171',
                background: testStatus.startsWith('连接成功') ? 'rgba(16,185,129,0.05)' : 'rgba(248,113,113,0.05)',
                border: `1px solid ${testStatus.startsWith('连接成功') ? 'rgba(16,185,129,0.2)' : 'rgba(248,113,113,0.2)'}`,
                padding: '10px 14px',
                borderRadius: '6px',
                marginTop: '10px',
                wordBreak: 'break-all'
              }}>
                {testStatus}
              </div>
            )}
          </div>
        )}


        {/* ── 本地存储 ── */}
        {settingsSubTab === 'storage' && (
          <div className="settings-sub-panel">
            <div className="form-desc-text">
              设置统一的顶头数据目录。系统将自动在该目录下建立并迁移您的聊天记录（chat/）、虚拟体形象（live2d/）、技能扩展包（skills/）及记忆信息（memory/）。如果留空保存，则退回默认的应用数据目录。
            </div>

            <div className="form-group">
              <label className="form-label">当前生效的物理路径</label>
              <div className="storage-path-display">{actualStoragePath || '正在加载路径信息...'}</div>
            </div>

            <div className="form-group">
              <label className="form-label">设置自定义存储路径</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  className="form-input"
                  placeholder="点击选择自定义存储路径"
                  value={storageInputPath}
                  onChange={e => setStorageInputPath(e.target.value)}
                  onClick={async () => {
                    const path = await window.api.selectDirectory({ title: '选择自定义存储路径' })
                    if (path) setStorageInputPath(path)
                  }}
                  readOnly
                  style={{ flex: 1, cursor: 'pointer' }}
                  title="点击选择自定义存储路径"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => {
                    const path = await window.api.selectDirectory({ title: '选择自定义存储路径' })
                    if (path) setStorageInputPath(path)
                  }}
                  style={{ whiteSpace: 'nowrap', padding: '0 14px', height: '38px', borderRadius: '6px', fontSize: '12.5px' }}
                >
                  <FolderOpen size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                  选择文件夹
                </button>
              </div>
            </div>

            <div className="action-row">
              <button className="btn-primary" onClick={handleSaveStoragePath}>
                <Save size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                保存路径并迁移技能包
              </button>
            </div>

            {storageSaveStatus.type !== 'idle' && (
              <div className={`test-res-box ${storageSaveStatus.type === 'success' ? 'success' : 'failed'}`}>
                {storageSaveStatus.message}
              </div>
            )}
          </div>
        )}

        {/* ── 虚拟体设置 ── */}
        {settingsSubTab === 'avatar' && (
          <div className="settings-sub-panel">
            <div className="form-desc-text">
              在这里更换挂件的 Live2D 形象。您可以点击“导入虚拟体”将外部模型拷贝归档到统一存储包中，系统会自动在此页面生成卡片列表供您一键切换。
            </div>

            {/* TTS 语音开关 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '12px 16px', marginBottom: '20px',
              background: 'var(--bg-secondary, #f8f9fa)',
              borderRadius: '8px', border: '1px solid var(--border-color, #e9ecef)'
            }}>
              <Volume2 size={17} strokeWidth={2} aria-hidden="true" />
              <span style={{ fontSize: '13px', fontWeight: 500 }}>语音朗读</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
                开启后 LLM 回复将自动朗读，声音在下方虚拟体卡片中设置
              </span>
              <div
                onClick={() => {
                  const next = !ttsEnabled
                  setTtsEnabled(next)
                  localStorage.setItem('agentpet_tts_enabled', String(next))
                }}
                style={{
                  width: '44px', height: '24px', borderRadius: '12px',
                  background: ttsEnabled ? 'var(--accent-color, #4f8cff)' : '#ccc',
                  cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
                  flexShrink: 0
                }}
              >
                <div style={{
                  width: '20px', height: '20px', borderRadius: '50%',
                  background: '#fff', position: 'absolute', top: '2px',
                  left: ttsEnabled ? '22px' : '2px',
                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                }} />
              </div>
            </div>

            <div className="action-row" style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  try {
                    const res = await window.api.selectModelDir()
                    if (res) {
                      setCustomModelDir(res.customModelDir)
                      setCustomModelFile(res.customModelFile)
                      await refreshAvatarsList()
                      showToast('虚拟体导入并启用成功！', 'success')
                    }
                  } catch (e: any) {
                    showToast(e.message || '更换虚拟体失败', 'error')
                  }
                }}
              >
                <Upload size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                导入并启用新虚拟体
              </button>
              {(customModelDir || customModelFile) && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => {
                    if (confirm('确认恢复为默认形象吗？')) {
                      await window.api.clearCustomModel()
                      setCustomModelDir('')
                      setCustomModelFile('')
                      showToast('已恢复为默认形象！', 'success')
                    }
                  }}
                >
                  <RotateCcw size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                  恢复默认形象
                </button>
              )}
            </div>

            <div className="settings-section-title" style={{ marginBottom: '16px' }}>本地形象库</div>

            <div className="avatar-table-container mcp-table-container">
              <table className="mcp-table">
                <thead>
                  <tr>
                    <th>形象标识 (图标)</th>
                    <th>虚拟体名称</th>
                    <th>语言风格</th>
                    <th>语音声音</th>
                    <th style={{ width: '100px', textAlign: 'center' }}>启用状态</th>
                    <th style={{ width: '140px', textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {avatarList.map(avatar => {
                    const isActive = avatar.isDefault ? (!customModelDir && !customModelFile) : (customModelDir === avatar.dir)
                    return (
                      <tr key={avatar.id} className="mcp-table-row">
                        <td style={{ textAlign: 'center' }}>
                          {avatar.isDefault ? (
                            <div className="avatar-avatar-box default-avatar" style={{ width: '32px', height: '32px', fontSize: '18px', margin: '0 auto' }}>
                              <Cat size={18} strokeWidth={2} aria-hidden="true" />
                            </div>
                          ) : (
                            <div className="avatar-avatar-box custom-avatar" style={{ width: '32px', height: '32px', fontSize: '14px', margin: '0 auto' }}>
                              {avatar.name.substring(0, 2).toUpperCase()}
                            </div>
                          )}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--text-color-strong)' }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span>{avatar.name}</span>
                            {avatar.isDefault && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>系统内置经典形象</span>}
                            {!avatar.isDefault && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }} title={avatar.dir}>{avatar.dir}</span>}
                          </div>
                        </td>
                        <td>
                          {avatar.languageStyle === 'cute'
                            ? <><Sparkles size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />可爱风格</>
                            : <><MessageSquare size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />常规风格</>}
                        </td>
                        <td style={{ fontSize: '12px' }}>
                          {(() => {
                            const voiceMap: Record<string, string> = {
                              'zh-CN-XiaoxiaoNeural': '萝莉甜妹',
                              'zh-CN-XiaoyiNeural': '活泼少女',
                              'zh-CN-XiaoxuanNeural': '可爱萌妹',
                              'zh-CN-XiaomoNeural': '温柔御姐',
                              'zh-CN-XiaohanNeural': '知性御姐',
                              'zh-CN-XiaoruiNeural': '成熟女王',
                              'zh-CN-XiaozhenNeural': '专业女声',
                              'zh-CN-YunxiNeural': '活力少年',
                              'zh-CN-YunjianNeural': '磁性男声',
                              'zh-CN-YunyangNeural': '新闻播音'
                            }
                            return voiceMap[avatar.voice] || avatar.voice || '萝莉甜妹'
                          })()}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`mcp-badge ${isActive ? 'configured' : 'none'}`}>
                            {isActive ? '使用中' : '未启用'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn-secondary"
                            style={{ padding: '4px 8px', fontSize: '11px' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (openAvatarDropdownId === avatar.id) {
                                setOpenAvatarDropdownId(null)
                              } else {
                                const rect = e.currentTarget.getBoundingClientRect()
                                const spaceBelow = window.innerHeight - rect.bottom
                                if (spaceBelow < 160) {
                                  // 空间不足，向上展开
                                  setDropdownPos({ bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right })
                                } else {
                                  // 空间充足，向下展开
                                  setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
                                }
                                setOpenAvatarDropdownId(avatar.id)
                              }
                            }}
                          >
                            <Settings2 size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                            设置
                            <ChevronDown size={13} strokeWidth={2} className="ui-icon-trailing" aria-hidden="true" />
                          </button>

                          {openAvatarDropdownId === avatar.id && (
                            <div
                              style={{
                                position: 'fixed',
                                top: dropdownPos.top !== undefined ? `${dropdownPos.top}px` : 'auto',
                                bottom: dropdownPos.bottom !== undefined ? `${dropdownPos.bottom}px` : 'auto',
                                right: `${dropdownPos.right}px`,
                                background: 'var(--bg-card)',
                                border: '1px solid var(--border-card)',
                                borderRadius: '6px',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                zIndex: 9999,
                                display: 'flex',
                                flexDirection: 'column',
                                minWidth: '120px',
                                overflow: 'hidden'
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {!isActive && (
                                <div
                                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px', textAlign: 'left', display: 'flex', gap: '8px', alignItems: 'center' }}
                                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-app)'}
                                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                  onClick={async () => {
                                    try {
                                      if (avatar.isDefault) {
                                        await window.api.clearCustomModel()
                                        setCustomModelDir('')
                                        setCustomModelFile('')
                                      } else {
                                        const res = await window.api.switchAvatar({ dir: avatar.dir, configFile: avatar.configFile })
                                        setCustomModelDir(res.customModelDir)
                                        setCustomModelFile(res.customModelFile)
                                      }
                                      showToast('已启用此虚拟形象！', 'success')
                                    } catch (err: any) {
                                      showToast(err.message || '切换形象失败', 'error')
                                    }
                                    setOpenAvatarDropdownId(null)
                                  }}
                                >
                                  <Check size={14} strokeWidth={2} aria-hidden="true" />
                                  启用
                                </div>
                              )}
                              <div
                                style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px', textAlign: 'left', display: 'flex', gap: '8px', alignItems: 'center' }}
                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-app)'}
                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                onClick={() => {
                                  setEditingAvatar(avatar)
                                  setEditAvatarName(avatar.name)
                                  setEditAvatarStyle(avatar.languageStyle || 'normal')
                                  setEditAvatarVoice(avatar.voice || 'zh-CN-XiaoxiaoNeural')
                                  setEditAvatarScale(avatar.scale ?? 1.0)
                                  setEditAvatarXOffset(avatar.xOffset ?? 0)
                                  setEditAvatarYOffset(avatar.yOffset ?? 0)
                                  setShowEditAvatarModal(true)
                                  setOpenAvatarDropdownId(null)
                                }}
                              >
                                <Pencil size={14} strokeWidth={2} aria-hidden="true" />
                                编辑
                              </div>
                              {!avatar.isDefault && (
                                <div
                                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px', textAlign: 'left', color: '#ef4444', borderTop: '1px solid var(--border-card)', display: 'flex', gap: '8px', alignItems: 'center' }}
                                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-app)'}
                                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                  onClick={async () => {
                                    if (confirm(`确认要彻底删除形象 [${avatar.name}] 吗？这会物理清空对应的本地模型文件夹。`)) {
                                      try {
                                        await window.api.deleteAvatar(avatar.dir)
                                        await refreshAvatarsList()
                                        showToast('形象已成功删除。', 'success')
                                      } catch (err: any) {
                                        showToast(err.message || err, 'error')
                                      }
                                    }
                                    setOpenAvatarDropdownId(null)
                                  }}
                                >
                                  <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                                  删除
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>

      {/* 虚拟体参数编辑弹窗 Modal */}
      {showEditAvatarModal && editingAvatar && (
        <div className="mcp-modal-overlay">
          <div className="mcp-modal-card" onClick={e => e.stopPropagation()}>
            <div className="mcp-modal-header">
              <div className="mcp-modal-title">
                <Pencil size={17} strokeWidth={2} aria-hidden="true" />
                <span>编辑虚拟体参数</span>
              </div>
              <button className="mcp-modal-close-btn" onClick={() => { setShowEditAvatarModal(false); setEditingAvatar(null); }} title="关闭">
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <div className="mcp-modal-body">
              <div>
                <label className="mcp-form-label">名称别名</label>
                <input
                  type="text"
                  className="mcp-input-fancy"
                  placeholder="给形象起个名字"
                  value={editAvatarName}
                  onChange={e => setEditAvatarName(e.target.value)}
                />
              </div>

              <div>
                <label className="mcp-form-label">语言风格</label>
                <select
                  className="mcp-input-fancy"
                  value={editAvatarStyle}
                  onChange={e => setEditAvatarStyle(e.target.value)}
                  style={{ cursor: 'pointer' }}
                >
                  <option value="cute">1. 可爱风格</option>
                  <option value="normal">2. 常规风格（友好）</option>
                </select>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  提示：切换后将影响大模型智能体的语言表达风格。常规为专业友好，可爱为萌系调皮。
                </div>
              </div>

              <div>
                <label className="mcp-form-label">语音声音</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <select
                    className="mcp-input-fancy"
                    value={editAvatarVoice}
                    onChange={e => setEditAvatarVoice(e.target.value)}
                    style={{ cursor: 'pointer', flex: 1 }}
                  >
                    <option value="zh-CN-XiaoxiaoNeural">萝莉甜妹 (Xiaoxiao)</option>
                    <option value="zh-CN-XiaoyiNeural">活泼少女 (Xiaoyi)</option>
                    <option value="zh-CN-XiaoxuanNeural">可爱萌妹 (Xiaoxuan)</option>
                    <option value="zh-CN-XiaomoNeural">温柔御姐 (Xiaomo)</option>
                    <option value="zh-CN-XiaohanNeural">知性御姐 (Xiaohan)</option>
                    <option value="zh-CN-XiaoruiNeural">成熟女王 (Xiaorui)</option>
                    <option value="zh-CN-XiaozhenNeural">专业女声 (Xiaozhen)</option>
                    <option value="zh-CN-YunxiNeural">活力少年 (Yunxi)</option>
                    <option value="zh-CN-YunjianNeural">磁性男声 (Yunjian)</option>
                    <option value="zh-CN-YunyangNeural">新闻播音 (Yunyang)</option>
                  </select>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={async () => {
                      try {
                        const buf = await window.api.synthesizeTts('你好呀，我是你的桌面助手！', editAvatarVoice)
                        if (buf) {
                          const blob = new Blob([buf], { type: 'audio/mp3' })
                          const url = URL.createObjectURL(blob)
                          const audio = new Audio(url)
                          audio.onended = () => URL.revokeObjectURL(url)
                          audio.play()
                        }
                      } catch (e) {
                        console.error('试听失败', e)
                      }
                    }}
                    style={{ fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    <AudioLines size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                    试听
                  </button>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  提示：选择 TTS 语音声音，开启语音后 LLM 回复将自动朗读。
                </div>
              </div>

              <div>
                <label className="mcp-form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>微调缩放比例</span>
                  <span style={{ color: 'var(--accent-color, #4f8cff)', fontWeight: 600 }}>{editAvatarScale.toFixed(2)}x</span>
                </label>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.05"
                    value={editAvatarScale}
                    onChange={e => setEditAvatarScale(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent-color, #4f8cff)' }}
                  />
                  <input
                    type="number"
                    min="0.5"
                    max="2.0"
                    step="0.05"
                    value={editAvatarScale}
                    onChange={e => {
                      const val = parseFloat(e.target.value)
                      if (!isNaN(val)) setEditAvatarScale(val)
                    }}
                    style={{ width: '65px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border-color, rgba(128,128,128,0.2))', background: 'var(--bg-card-sub, rgba(128,128,128,0.05))', color: 'var(--text-color)' }}
                  />
                </div>
              </div>

              <div>
                <label className="mcp-form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>水平位置微调 (X 轴)</span>
                  <span style={{ color: 'var(--accent-color, #4f8cff)', fontWeight: 600 }}>{editAvatarXOffset} px</span>
                </label>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <input
                    type="range"
                    min="-200"
                    max="200"
                    step="1"
                    value={editAvatarXOffset}
                    onChange={e => setEditAvatarXOffset(parseInt(e.target.value, 10))}
                    style={{ flex: 1, accentColor: 'var(--accent-color, #4f8cff)' }}
                  />
                  <input
                    type="number"
                    min="-200"
                    max="200"
                    step="1"
                    value={editAvatarXOffset}
                    onChange={e => {
                      const val = parseInt(e.target.value, 10)
                      if (!isNaN(val)) setEditAvatarXOffset(val)
                    }}
                    style={{ width: '65px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border-color, rgba(128,128,128,0.2))', background: 'var(--bg-card-sub, rgba(128,128,128,0.05))', color: 'var(--text-color)' }}
                  />
                </div>
              </div>

              <div>
                <label className="mcp-form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>垂直位置微调 (Y 轴)</span>
                  <span style={{ color: 'var(--accent-color, #4f8cff)', fontWeight: 600 }}>{editAvatarYOffset} px</span>
                </label>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <input
                    type="range"
                    min="-200"
                    max="200"
                    step="1"
                    value={editAvatarYOffset}
                    onChange={e => setEditAvatarYOffset(parseInt(e.target.value, 10))}
                    style={{ flex: 1, accentColor: 'var(--accent-color, #4f8cff)' }}
                  />
                  <input
                    type="number"
                    min="-200"
                    max="200"
                    step="1"
                    value={editAvatarYOffset}
                    onChange={e => {
                      const val = parseInt(e.target.value, 10)
                      if (!isNaN(val)) setEditAvatarYOffset(val)
                    }}
                    style={{ width: '65px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border-color, rgba(128,128,128,0.2))', background: 'var(--bg-card-sub, rgba(128,128,128,0.05))', color: 'var(--text-color)' }}
                  />
                </div>
              </div>
            </div>
            <div className="mcp-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => { setShowEditAvatarModal(false); setEditingAvatar(null); }}
                style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  if (!editAvatarName.trim()) {
                    showToast('名称不能为空！', 'error')
                    return
                  }
                  try {
                    await window.api.saveAvatarConfig({
                      id: editingAvatar.id,
                      name: editAvatarName.trim(),
                      languageStyle: editAvatarStyle,
                      voice: editAvatarVoice,
                      scale: editAvatarScale,
                      xOffset: editAvatarXOffset,
                      yOffset: editAvatarYOffset
                    })
                    await refreshAvatarsList()
                    setShowEditAvatarModal(false)
                    setEditingAvatar(null)
                    showToast('虚拟体参数已更新！', 'success')
                  } catch (err: any) {
                    showToast(err.message || '保存失败', 'error')
                  }
                }}
                style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
              >
                保存修改
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

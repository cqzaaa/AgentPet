import React from 'react'
import { DEFAULT_MODELS } from '../utils/helpers'
import type { AppStore } from '../hooks/useAppStore'

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
    // sandbox
    sandboxMode,
    handleToggleSandboxMode
  } = store

  // 虚拟体编辑弹窗状态
  const [showEditAvatarModal, setShowEditAvatarModal] = React.useState(false)
  const [editingAvatar, setEditingAvatar] = React.useState<any>(null)
  const [editAvatarName, setEditAvatarName] = React.useState('')
  const [editAvatarStyle, setEditAvatarStyle] = React.useState('normal')

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
                      let defaults = { provider: prov, apiKey: '', baseUrl: '', model: '', temperature: llmConfig.temperature, maxTokens: llmConfig.maxTokens }
                      if (prov === 'gemini') { defaults.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai' }
                      else if (prov === 'openai') { defaults.baseUrl = 'https://api.openai.com/v1' }
                      else if (prov === 'deepseek') { defaults.baseUrl = 'https://api.deepseek.com/v1' }
                      else if (prov === 'ollama') { defaults.baseUrl = 'http://localhost:11434/v1' }
                      saveLlmConfig(defaults)
                    }}
                  >
                    {prov.toUpperCase()}
                  </div>
                ))}
              </div>
            </div>

            {/* API Key */}
            {llmConfig.provider !== 'ollama' && (
              <div className="form-group" style={{ position: 'relative' }}>
                <label className="form-label">API 密钥 (API Key)</label>
                <div style={{ display: 'flex', position: 'relative', width: '100%' }}>
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="form-input"
                    placeholder="输入大模型提供商的 API 密钥"
                    value={llmConfig.apiKey}
                    onChange={e => saveLlmConfig({ ...llmConfig, apiKey: e.target.value })}
                    style={{ flex: 1, paddingRight: '40px' }}
                  />
                  <span
                    style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', userSelect: 'none', fontSize: '14px', opacity: 0.6 }}
                    onClick={() => setShowApiKey(!showApiKey)}
                    title={showApiKey ? '隐藏密钥' : '显示密钥'}
                  >
                    {showApiKey ? '👁️' : '🙈'}
                  </span>
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
                <span
                  style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', opacity: 0.6, fontSize: '11px', userSelect: 'none', color: 'var(--text-muted)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (showModelDropdown) { setShowModelDropdown(false) } else { handleFetchModels() }
                  }}
                >
                  ▼
                </span>
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
                        >
                          <span>{m}</span>
                          {m === DEFAULT_MODELS[llmConfig.provider] && <span className="default-badge">推荐默认</span>}
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
                {testStatus === 'testing' ? '正在连通测试...' : '🔌 测试大模型连接'}
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
                  📂 选择文件夹
                </button>
              </div>
            </div>

            <div className="action-row">
              <button className="btn-primary" onClick={handleSaveStoragePath}>💾 保存路径并迁移技能包</button>
            </div>

            {storageSaveStatus.type !== 'idle' && (
              <div className={`test-res-box ${storageSaveStatus.type === 'success' ? 'success' : 'failed'}`}>
                {storageSaveStatus.message}
              </div>
            )}

            <hr style={{ border: '0', borderTop: '1px solid var(--border-color, rgba(128,128,128,0.15))', margin: '24px 0' }} />

            <div className="settings-section-title" style={{ marginBottom: '12px', fontSize: '15px', fontWeight: 600 }}>安全控制</div>
            <div className="form-desc-text">
              控制 AI 助理在本地执行指令时的安全级别。开启后，任何命令执行前都需要您手动审批授权。
            </div>

            <div className="form-group" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-card-sub, rgba(128,128,128,0.04))', padding: '14px 18px', borderRadius: '8px', border: '1px solid var(--border-color, rgba(128,128,128,0.1))', marginTop: '12px' }}>
              <div style={{ paddingRight: '16px' }}>
                <div style={{ fontWeight: 600, fontSize: '13.5px', marginBottom: '4px' }}>终端命令安全沙盒模式</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted, #777)', lineHeight: 1.4 }}>开启后，AI 尝试在本地运行终端指令前会弹出系统确认框，且系统将直接拦截毁灭性高危指令。</div>
              </div>
              <label className="switch-toggle" style={{ position: 'relative', display: 'inline-block', width: '46px', height: '24px', flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={sandboxMode}
                  onChange={e => handleToggleSandboxMode(e.target.checked)}
                  style={{ opacity: 0, width: 0, height: 0 }}
                />
                <span className="slider-round-toggle" style={{
                  position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                  backgroundColor: sandboxMode ? '#10b981' : 'rgba(128,128,128,0.3)',
                  transition: '.2s', borderRadius: '24px'
                }}>
                  <span style={{
                    position: 'absolute', content: '""', height: '18px', width: '18px', left: sandboxMode ? '24px' : '4px', bottom: '3px',
                    backgroundColor: '#fff', transition: '.2s', borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.15)'
                  }} />
                </span>
              </label>
            </div>
          </div>
        )}

        {/* ── 虚拟体设置 ── */}
        {settingsSubTab === 'avatar' && (
          <div className="settings-sub-panel">
            <div className="form-desc-text">
              在这里更换挂件的 Live2D 形象。您可以点击"🎭 导入虚拟体"将外部模型拷贝归档到统一存储包中，系统会自动在此页面生成卡片列表供您一键切换。
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
                🎭 导入并启用新虚拟体
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
                  🔄 恢复默认形象
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
                    <th style={{ width: '100px', textAlign: 'center' }}>启用状态</th>
                    <th style={{ width: '230px', textAlign: 'center' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {avatarList.map(avatar => {
                    const isActive = avatar.isDefault ? (!customModelDir && !customModelFile) : (customModelDir === avatar.dir)
                    return (
                      <tr key={avatar.id} className="mcp-table-row">
                        <td style={{ textAlign: 'center' }}>
                          {avatar.isDefault ? (
                            <div className="avatar-avatar-box default-avatar" style={{ width: '32px', height: '32px', fontSize: '18px', margin: '0 auto' }}>🐱</div>
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
                          {avatar.languageStyle === 'cute' ? '🎀 可爱风格' : '📝 常规风格'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`mcp-badge ${isActive ? 'configured' : 'none'}`}>
                            {isActive ? '使用中' : '未启用'}
                          </span>
                        </td>
                        <td>
                          <div className="mcp-btn-action-group">
                            {!isActive && (
                              <button
                                type="button"
                                className="mcp-btn-action test"
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
                                }}
                              >
                                ✅ 启用
                              </button>
                            )}
                            <button
                              type="button"
                              className="mcp-btn-action edit"
                              onClick={() => {
                                setEditingAvatar(avatar)
                                setEditAvatarName(avatar.name)
                                setEditAvatarStyle(avatar.languageStyle || 'normal')
                                setShowEditAvatarModal(true)
                              }}
                            >
                              ✏️ 编辑
                            </button>
                            {!avatar.isDefault && (
                              <button
                                type="button"
                                className="mcp-btn-action delete"
                                title="删除该归档形象"
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
                                }}
                              >
                                🗑️ 删除
                              </button>
                            )}
                          </div>
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
                <span>✏️ 编辑虚拟体参数</span>
              </div>
              <button className="mcp-modal-close-btn" onClick={() => { setShowEditAvatarModal(false); setEditingAvatar(null); }}>×</button>
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
                      languageStyle: editAvatarStyle
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

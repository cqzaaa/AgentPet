import React, { useState, useEffect, useRef } from 'react'
import type { AppStore } from '../hooks/useAppStore'
import { DEFAULT_MODELS } from '../utils/helpers'

interface ControlPageProps {
  store: AppStore
}

export function ControlPage({ store }: ControlPageProps): React.JSX.Element {
  const { showToast } = store

  // 集成子 Tab 状态
  const [activeSubTab, setActiveSubTab] = useState<'wechat' | 'lark'>('wechat')

  // 微信 Bot 状态
  const [wechatState, setWechatState] = useState<any>({
    status: 'disconnected',
    qrcodeUrl: '',
    botId: '',
    messagesReceived: 0,
    messagesSent: 0,
    logs: [],
    llmConfig: {
      provider: 'gemini',
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: '',
      temperature: 0.7,
      useSystemConfig: true
    },
    autoReplyText: '你好，我是 Mao 的微信集成助手。',
    enableAutoReply: true
  })

  const [localLlmConfig, setLocalLlmConfig] = useState<any>({
    provider: 'gemini',
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    temperature: 0.7,
    useSystemConfig: true
  })

  const [autoReplyText, setAutoReplyText] = useState('你好，我是 Mao 的微信集成助手。')
  const [enableAutoReply, setEnableAutoReply] = useState(true)
  const [showApiKey, setShowApiKey] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  // 微信专属模型下拉菜单状态
  const [showWechatModelDropdown, setShowWechatModelDropdown] = useState(false)
  const [isWechatLoadingModels, setIsWechatLoadingModels] = useState(false)
  const [wechatAvailableModels, setWechatAvailableModels] = useState<string[]>([])
  const wechatDropdownRef = useRef<HTMLDivElement>(null)

  // 自动滚动日志
  const logEndRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭模型下拉框
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wechatDropdownRef.current && !wechatDropdownRef.current.contains(event.target as Node)) {
        setShowWechatModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  // 请求模型接口列表
  const handleFetchWechatModels = async () => {
    setIsWechatLoadingModels(true)
    setShowWechatModelDropdown(true)
    try {
      const list = await window.api.getModels({
        provider: localLlmConfig.provider,
        apiKey: localLlmConfig.apiKey,
        baseUrl: localLlmConfig.baseUrl
      })
      if (list && list.length > 0) {
        setWechatAvailableModels(list)
        showToast('获取微信专用模型列表成功！', 'success')
      } else {
        setWechatAvailableModels([])
        showToast('未获取到可用模型列表，可手动输入', 'info')
      }
    } catch (e: any) {
      setWechatAvailableModels([])
      showToast(e.message || '获取模型列表失败，请检查网络或配置！', 'error')
    } finally {
      setIsWechatLoadingModels(false)
    }
  }

  // 拉取主进程最新的微信状态
  const fetchWechatStatus = async () => {
    try {
      const state = await window.api.wechatGetStatus()
      if (state) {
        setWechatState(state)
        setLocalLlmConfig(state.llmConfig || {
          provider: 'gemini',
          apiKey: '',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          model: '',
          temperature: 0.7,
          useSystemConfig: true
        })
        setAutoReplyText(state.autoReplyText || '')
        setEnableAutoReply(state.enableAutoReply !== false)
      }
    } catch (e) {
      console.error('获取微信状态失败', e)
    }
  }

  useEffect(() => {
    fetchWechatStatus()

    // 订阅主进程推送的状态更新
    if (window.api.onWechatStatusUpdated) {
      const unsubscribe = window.api.onWechatStatusUpdated((data: any) => {
        if (data) {
          setWechatState(data)
          setLocalLlmConfig(data.llmConfig)
          setAutoReplyText(data.autoReplyText)
          setEnableAutoReply(data.enableAutoReply)
        }
      })
      return () => unsubscribe()
    }
    return () => {}
  }, [])

  // 监控日志更新，自动滚动
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [wechatState.logs])

  // 开始微信登录
  const handleStartLogin = async () => {
    setIsLoading(true)
    try {
      const ok = await window.api.wechatStartLogin()
      if (!ok) {
        showToast('微信 Bot 登录服务启动失败！', 'error')
      }
    } catch (err: any) {
      showToast(`启动失败: ${err.message || err}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  // 微信注销
  const handleLogout = async () => {
    if (confirm('确认断开微信 Bot 托管连接吗？这会清除您的登录会话。')) {
      setIsLoading(true)
      try {
        await window.api.wechatLogout()
        showToast('微信 Bot 已断开连接', 'info')
      } catch (err: any) {
        showToast(`注销失败: ${err.message || err}`, 'error')
      } finally {
        setIsLoading(false)
      }
    }
  }

  // 保存微信 Bot 配置
  const handleSaveWechatSettings = async () => {
    setIsLoading(true)
    try {
      const settings = {
        llmConfig: localLlmConfig,
        autoReplyText,
        enableAutoReply
      }
      const ok = await window.api.wechatSaveSettings(settings)
      if (ok) {
        showToast('微信 Bot 配置保存成功！', 'success')
        fetchWechatStatus()
      } else {
        showToast('保存微信配置失败', 'error')
      }
    } catch (err: any) {
      showToast(`保存失败: ${err.message || err}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', gap: '4px' }}>
      
      {/* ── 顶部子导航：支持微信/飞书切换 ── */}
      <div className="sub-tab-nav" style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.15))', paddingBottom: '8px' }}>
        <div 
          className={`sub-tab-item ${activeSubTab === 'wechat' ? 'active' : ''}`} 
          onClick={() => setActiveSubTab('wechat')}
          style={{ padding: '6px 16px', fontSize: '13.5px', borderRadius: '4px', cursor: 'pointer', fontWeight: activeSubTab === 'wechat' ? 600 : 'normal' }}
        >
          💬 微信 Bot 集成
        </div>
        <div 
          className={`sub-tab-item ${activeSubTab === 'lark' ? 'active' : ''}`} 
          onClick={() => setActiveSubTab('lark')}
          style={{ padding: '6px 16px', fontSize: '13.5px', borderRadius: '4px', cursor: 'pointer', fontWeight: activeSubTab === 'lark' ? 600 : 'normal' }}
        >
          🕊️ 飞书 Bot 集成
        </div>
      </div>

      {/* ── Tab 一：微信 Bot 集成内容 ── */}
      {activeSubTab === 'wechat' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(360px, 1.4fr)', gap: '20px' }}>
            
            {/* 左侧：微信 Bot 设备托管卡片 */}
            <div className="overview-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '340px' }}>
              <div>
                <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>💬 微信智能助理托管</span>
                  {wechatState.status === 'connected' && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: '#10b981', fontWeight: 'normal' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', display: 'inline-block', boxShadow: '0 0 8px #10b981' }}></span>
                      托管运行中
                    </span>
                  )}
                </div>

                {/* 未登录状态 */}
                {wechatState.status === 'disconnected' && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px', gap: '14px' }}>
                    <div style={{ fontSize: '48px', opacity: 0.8 }}>🤖</div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 600, fontSize: '14.5px', marginBottom: '4px' }}>个人号智能助理未激活</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4, maxWidth: '280px' }}>
                        使用微信官方合规的 iLink 协议，安全无风险，扫码即可开启您的宠物自动代理对话！
                      </div>
                    </div>
                    <button className="btn-primary" onClick={handleStartLogin} disabled={isLoading} style={{ marginTop: '6px', width: '180px' }}>
                      {isLoading ? '正在初始化...' : '🔌 扫码连接微信'}
                    </button>
                  </div>
                )}

                {/* 获取二维码 / 扫码中 */}
                {(wechatState.status === 'qrcode_ready' || wechatState.status === 'scanned') && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '220px', gap: '10px' }}>
                    {(() => {
                      let qrSrc = wechatState.qrcodeUrl
                      if (qrSrc && !qrSrc.startsWith('http') && !qrSrc.startsWith('data:image/')) {
                        qrSrc = `data:image/png;base64,${qrSrc}`
                      }
                      return qrSrc ? (
                        <div style={{ position: 'relative', background: '#fff', padding: '8px', borderRadius: '8px', border: '1px solid var(--border-color, rgba(128,128,128,0.2))' }}>
                          <img src={qrSrc} alt="微信登录二维码" style={{ width: '130px', height: '130px', display: 'block' }} />
                          {wechatState.status === 'scanned' && (
                            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(255, 255, 255, 0.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: '8px' }}>
                              <span style={{ fontSize: '24px', marginBottom: '8px' }}>✅</span>
                              <span style={{ fontSize: '12px', color: '#1f2937', fontWeight: 600 }}>手机微信已扫描</span>
                              <span style={{ fontSize: '11px', color: '#4b5563', marginTop: '2px' }}>请在手机上点击确认登录</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ width: '130px', height: '130px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card-sub, rgba(128,128,128,0.06))', borderRadius: '8px', border: '1px dashed var(--border-color, rgba(128,128,128,0.2))' }}>
                          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>生成二维码中...</span>
                        </div>
                      )
                    })()}
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500, textAlign: 'center' }}>
                      {wechatState.status === 'scanned' ? '等待手机微信确认授权...' : '请使用登录机器人的微信扫描上方二维码'}
                    </div>
                  </div>
                )}

                {/* 已登录状态 */}
                {wechatState.status === 'connected' && (
                  <div style={{ marginTop: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', background: 'var(--bg-card-sub, rgba(128,128,128,0.04))', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-color, rgba(128,128,128,0.1))' }}>
                      <div style={{ fontSize: '36px', width: '50px', height: '50px', borderRadius: '50%', background: 'linear-gradient(135deg, #10b981, #3b82f6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
                        💬
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '14.5px' }}>微信设备已绑定</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', wordBreak: 'break-all' }}>
                          Bot ID: {wechatState.botId}
                        </div>
                      </div>
                    </div>

                    <div className="agent-detail-grid" style={{ marginTop: '16px' }}>
                      <div className="detail-item">
                        <span className="detail-lbl">收到微信消息</span>
                        <span className="detail-val" style={{ color: '#3b82f6', fontWeight: 600 }}>{wechatState.messagesReceived} 条</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-lbl">已发出AI回复</span>
                        <span className="detail-val" style={{ color: '#10b981', fontWeight: 600 }}>{wechatState.messagesSent} 条</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 底部按钮栏 */}
              {wechatState.status === 'connected' && (
                <div style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
                  <button className="btn-secondary" onClick={handleLogout} disabled={isLoading} style={{ borderColor: 'rgba(239, 68, 68, 0.4)', color: '#ef4444', flex: 1 }}>
                    🔌 断开微信托管连接
                  </button>
                </div>
              )}
            </div>

            {/* 右侧：专属大模型及自动回复设置卡片 */}
            <div className="overview-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '340px' }}>
              <div>
                <div className="card-title">⚙️ 微信 Bot 专用大模型配置</div>

                {/* 自动回复开关 */}
                <div className="form-group" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div style={{ textAlign: 'left', flex: 1, paddingRight: '16px' }}>
                    <label className="form-label" style={{ marginBottom: '2px', display: 'block' }}>启用大模型微信自动回复</label>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>开启后，收到好友消息将利用 AI 角色自动匹配回复。</div>
                  </div>
                  <label className="switch-toggle" style={{ position: 'relative', display: 'inline-block', width: '42px', height: '22px', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={enableAutoReply}
                      onChange={e => setEnableAutoReply(e.target.checked)}
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                    <span className="slider-round-toggle" style={{
                      position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                      backgroundColor: enableAutoReply ? '#10b981' : 'rgba(128,128,128,0.3)',
                      transition: '.2s', borderRadius: '22px'
                    }}>
                      <span style={{
                        position: 'absolute', content: '""', height: '16px', width: '16px', left: enableAutoReply ? '22px' : '4px', bottom: '3px',
                        backgroundColor: '#fff', transition: '.2s', borderRadius: '50%'
                      }} />
                    </span>
                  </label>
                </div>

                {/* 是否使用电脑全局大模型配置 */}
                <div className="form-group" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div style={{ textAlign: 'left', flex: 1, paddingRight: '16px' }}>
                    <label className="form-label" style={{ marginBottom: '2px', display: 'block' }}>使用与电脑端相同的模型配置</label>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>勾选直接调用您在“设置-模型配置”中配置的主模型。</div>
                  </div>
                  <label className="switch-toggle" style={{ position: 'relative', display: 'inline-block', width: '42px', height: '22px', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={localLlmConfig.useSystemConfig}
                      onChange={e => setLocalLlmConfig({ ...localLlmConfig, useSystemConfig: e.target.checked })}
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                    <span className="slider-round-toggle" style={{
                      position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                      backgroundColor: localLlmConfig.useSystemConfig ? '#10b981' : 'rgba(128,128,128,0.3)',
                      transition: '.2s', borderRadius: '22px'
                    }}>
                      <span style={{
                        position: 'absolute', content: '""', height: '16px', width: '16px', left: localLlmConfig.useSystemConfig ? '22px' : '4px', bottom: '3px',
                        backgroundColor: '#fff', transition: '.2s', borderRadius: '50%'
                      }} />
                    </span>
                  </label>
                </div>

                {/* 微信专属模型配置输入面板（当不勾选使用系统全局配置时显示） */}
                {!localLlmConfig.useSystemConfig ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', background: 'var(--bg-card-sub, rgba(128,128,128,0.02))', border: '1px solid var(--border-color, rgba(128,128,128,0.08))', borderRadius: '6px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 2fr', gap: '8px' }}>
                      {/* 服务商 */}
                      <div>
                        <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '2px', color: 'var(--text-muted)' }}>服务商</label>
                        <select
                          className="form-input"
                          value={localLlmConfig.provider}
                          onChange={e => {
                            setLocalLlmConfig({ ...localLlmConfig, provider: e.target.value, model: DEFAULT_MODELS[e.target.value] || '' })
                            setWechatAvailableModels([])
                            setShowWechatModelDropdown(false)
                          }}
                          style={{ height: '30px', padding: '0 8px', fontSize: '12px', width: '100%' }}
                        >
                          {['gemini', 'deepseek', 'openai', 'ollama', 'custom'].map(p => (
                            <option key={p} value={p}>{p.toUpperCase()}</option>
                          ))}
                        </select>
                      </div>
                      {/* 模型名称 */}
                      <div style={{ position: 'relative' }} ref={wechatDropdownRef}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                          <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', color: 'var(--text-muted)' }}>模型名称</label>
                          {DEFAULT_MODELS[localLlmConfig.provider] && (
                            <span
                              style={{ fontSize: '10px', color: '#60a5fa', cursor: 'pointer', textDecoration: 'underline', fontWeight: 600 }}
                              onClick={() => {
                                setLocalLlmConfig({ ...localLlmConfig, model: DEFAULT_MODELS[localLlmConfig.provider] })
                                setShowWechatModelDropdown(false)
                              }}
                            >
                              默认
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', position: 'relative', width: '100%' }}>
                          <input
                            type="text"
                            className="form-input"
                            value={localLlmConfig.model}
                            onChange={e => setLocalLlmConfig({ ...localLlmConfig, model: e.target.value })}
                            onClick={() => { if (!showWechatModelDropdown) handleFetchWechatModels() }}
                            placeholder={DEFAULT_MODELS[localLlmConfig.provider] ? `例如: ${DEFAULT_MODELS[localLlmConfig.provider]}` : '请输入模型名称'}
                            style={{ height: '30px', padding: '0 8px', paddingRight: '24px', fontSize: '12px', width: '100%', flex: 1 }}
                          />
                          <span
                            style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', opacity: 0.6, fontSize: '10px', userSelect: 'none', color: 'var(--text-muted)' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (showWechatModelDropdown) { setShowWechatModelDropdown(false) } else { handleFetchWechatModels() }
                            }}
                          >
                            ▼
                          </span>
                        </div>

                        {showWechatModelDropdown && (
                          <div className="model-dropdown-list" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, maxHeight: '180px', overflowY: 'auto' }}>
                            {isWechatLoadingModels ? (
                              <div className="dropdown-loading-item" style={{ fontSize: '12px', padding: '8px', color: 'var(--text-muted)' }}>正在请求 models 接口获取模型...</div>
                            ) : wechatAvailableModels.length > 0 ? (
                              <>
                                <div className="dropdown-section-title" style={{ fontSize: '11px', padding: '4px 8px', color: 'var(--text-muted)', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>可用模型列表 ({wechatAvailableModels.length})</div>
                                {wechatAvailableModels.map(m => (
                                  <div
                                    key={m}
                                    className={`dropdown-item ${localLlmConfig.model === m ? 'active' : ''}`}
                                    onClick={() => { setLocalLlmConfig({ ...localLlmConfig, model: m }); setShowWechatModelDropdown(false) }}
                                    style={{ fontSize: '12px', padding: '6px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                                  >
                                    <span>{m}</span>
                                  </div>
                                ))}
                              </>
                            ) : (
                              <div className="dropdown-empty-item" style={{ fontSize: '12px', padding: '8px', color: 'var(--text-muted)' }}>未获取到模型列表，可手动输入</div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* API Key */}
                    {localLlmConfig.provider !== 'ollama' && (
                      <div>
                        <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '2px', color: 'var(--text-muted)' }}>API 密钥 (API Key)</label>
                        <div style={{ display: 'flex', position: 'relative' }}>
                          <input
                            type={showApiKey ? 'text' : 'password'}
                            className="form-input"
                            value={localLlmConfig.apiKey}
                            onChange={e => setLocalLlmConfig({ ...localLlmConfig, apiKey: e.target.value })}
                            placeholder="输入微信助手专属大模型密钥"
                            style={{ height: '30px', padding: '0 8px', fontSize: '12px', flex: 1, paddingRight: '30px' }}
                          />
                          <span
                            style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', fontSize: '12px', opacity: 0.6 }}
                            onClick={() => setShowApiKey(!showApiKey)}
                          >
                            {showApiKey ? '👁️' : '🙈'}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Base URL */}
                    <div>
                      <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '2px', color: 'var(--text-muted)' }}>API 代理地址 (Base URL)</label>
                      <input
                        type="text"
                        className="form-input"
                        value={localLlmConfig.baseUrl}
                        onChange={e => setLocalLlmConfig({ ...localLlmConfig, baseUrl: e.target.value })}
                        placeholder="选填，代理中转地址"
                        style={{ height: '30px', padding: '0 8px', fontSize: '12px', width: '100%' }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: '16px', background: 'var(--bg-card-sub, rgba(128,128,128,0.03))', border: '1px dashed var(--border-color, rgba(128,128,128,0.15))', borderRadius: '6px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '4px', justifyContent: 'center', height: '110px' }}>
                    <span>🔒 已同步使用系统全局模型配置</span>
                    <span style={{ fontSize: '11px', opacity: 0.8 }}>微信消息回复将直接调用“设置-模型配置”里的主模型。</span>
                  </div>
                )}

                {/* 兜底回复话术 */}
                {enableAutoReply && (
                  <div style={{ marginTop: '10px' }}>
                    <label className="form-label" style={{ marginBottom: '3px', fontSize: '12px' }}>大模型接口报错/故障时的兜底回复</label>
                    <input
                      type="text"
                      className="form-input"
                      value={autoReplyText}
                      onChange={e => setAutoReplyText(e.target.value)}
                      placeholder="如：抱歉，我现在有些忙，稍后回复您~"
                      style={{ height: '30px', padding: '0 8px', fontSize: '12px', width: '100%' }}
                    />
                  </div>
                )}
              </div>

              <div style={{ marginTop: '16px' }}>
                <button className="btn-primary" onClick={handleSaveWechatSettings} disabled={isLoading} style={{ width: '100%' }}>
                  {isLoading ? '正在保存...' : '💾 保存微信大模型与回复设置'}
                </button>
              </div>
            </div>

          </div>

          {/* 底部：流式会话交互控制台 (黑客风终端) ── */}
          <div className="overview-card full-width" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '220px' }}>
            <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>🖥️ 微信机器人运行控制台 (流式日志)</span>
              <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', fontWeight: 'normal' }}>最近 150 条交互记录</span>
            </div>

            {/* 终端风格的日志容器 */}
            <div style={{
              flex: 1,
              background: '#090d16',
              borderRadius: '6px',
              border: '1px solid #111a2e',
              padding: '12px 16px',
              fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace',
              fontSize: '12px',
              lineHeight: '1.6',
              color: '#c9d1d9',
              overflowY: 'auto',
              minHeight: '150px',
              maxHeight: '300px',
              boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)'
            }}>
              {wechatState.logs && wechatState.logs.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {[...wechatState.logs].reverse().map((log, idx) => {
                    let badgeColor = '#8b949e' // info (gray)
                    let badgeText = 'SYS'
                    let textColor = '#c9d1d9' // white

                    if (log.type === 'in') {
                      badgeColor = '#58a6ff' // blue
                      badgeText = 'REC'
                      textColor = '#79c0ff'
                    } else if (log.type === 'out') {
                      badgeColor = '#56d364' // green
                      badgeText = 'SND'
                      textColor = '#56d364'
                    }

                    return (
                      <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', wordBreak: 'break-all' }}>
                        <span style={{ color: '#8b949e', marginRight: '8px', flexShrink: 0 }}>[{log.time}]</span>
                        <span style={{
                          background: badgeColor,
                          color: '#0d1117',
                          fontSize: '9px',
                          fontWeight: 'bold',
                          padding: '0px 4px',
                          borderRadius: '3px',
                          marginRight: '8px',
                          height: '16px',
                          lineHeight: '16px',
                          display: 'inline-block',
                          flexShrink: 0
                        }}>
                          {badgeText}
                        </span>
                        <span style={{ color: textColor }}>{log.text}</span>
                      </div>
                    )
                  })}
                  <div ref={logEndRef} />
                </div>
              ) : (
                <div style={{ color: '#8b949e', fontStyle: 'italic', display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
                  &gt;_ 控制台就绪。暂无微信交互日志。
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Tab 二：飞书 Bot 集成（精美占位页） ── */}
      {activeSubTab === 'lark' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', flex: 1, animation: 'fadeIn 0.3s ease' }}>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            
            {/* 左侧：飞书应用状态（占位） */}
            <div className="overview-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '340px', borderColor: 'rgba(51, 112, 255, 0.2)' }}>
              <div>
                <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>🕊️ 飞书 AI 智能助理 (Lark Bot)</span>
                  <span style={{ background: 'rgba(51, 112, 255, 0.1)', color: '#3370ff', fontSize: '11px', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
                    即将推出
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px', gap: '14px', marginTop: '10px' }}>
                  <div style={{ fontSize: '48px', width: '70px', height: '70px', borderRadius: '50%', background: 'rgba(51, 112, 255, 0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🕊️</div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 600, fontSize: '14.5px', marginBottom: '4px', color: '#3370ff' }}>飞书企业号智能体托管</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4, maxWidth: '280px' }}>
                      支持配置飞书自建应用（App ID & App Secret），将桌面宠物 Mao 接入企业飞书工作台，实现自动化办公助手！
                    </div>
                  </div>
                </div>
              </div>

              {/* 底部禁用按钮 */}
              <div style={{ marginTop: '16px' }}>
                <button className="btn-secondary" disabled style={{ width: '100%', background: 'var(--bg-card-sub, rgba(128,128,128,0.03))', border: '1px solid var(--border-color, rgba(128,128,128,0.15))', color: 'var(--text-muted)', cursor: 'not-allowed' }}>
                  🔌 绑定飞书自建应用 (不可用)
                </button>
              </div>
            </div>

            {/* 右侧：功能概览与特性看板 */}
            <div className="overview-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '340px' }}>
              <div>
                <div className="card-title">🚀 飞书集成核心特性展示</div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                  {/* 特性 1 */}
                  <div style={{ display: 'flex', gap: '12px', background: 'rgba(51, 112, 255, 0.02)', border: '1px solid rgba(51, 112, 255, 0.06)', padding: '12px', borderRadius: '8px' }}>
                    <span style={{ fontSize: '20px' }}>⚡</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '13px', color: '#c9d1d9' }}>单聊自动答复</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>同事或外部联系人私发飞书消息，Mao 会以设定的人设口吻为您全自动解释或闲聊回复。</div>
                    </div>
                  </div>
                  {/* 特性 2 */}
                  <div style={{ display: 'flex', gap: '12px', background: 'rgba(51, 112, 255, 0.02)', border: '1px solid rgba(51, 112, 255, 0.06)', padding: '12px', borderRadius: '8px' }}>
                    <span style={{ fontSize: '20px' }}>👥</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '13px', color: '#c9d1d9' }}>群聊 @ 机器人回复</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>支持飞书群聊，当被群成员 @ 时，调用指定大模型进行多轮上下文理解和执行群助手任务。</div>
                    </div>
                  </div>
                  {/* 特性 3 */}
                  <div style={{ display: 'flex', gap: '12px', background: 'rgba(51, 112, 255, 0.02)', border: '1px solid rgba(51, 112, 255, 0.06)', padding: '12px', borderRadius: '8px' }}>
                    <span style={{ fontSize: '20px' }}>⚙️</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '13px', color: '#c9d1d9' }}>办公卡片与日程协同</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>未来支持生成飞书精美多功能消息卡片、提醒工作流及会议日程同步管理。</div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'center' }}>
                <span style={{ fontSize: '11.5px', color: '#3370ff', fontWeight: 600, letterSpacing: '0.05em' }}>
                  LARK AGENT INTEGRATION PROGRESSING • 敬请期待
                </span>
              </div>
            </div>

          </div>

          {/* 飞书控制台占位 */}
          <div className="overview-card full-width" style={{ minHeight: '150px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#090d16', border: '1px solid #111a2e' }}>
            <span style={{ color: '#3370ff', fontSize: '20px', marginBottom: '8px' }}>📡</span>
            <span style={{ color: 'rgba(51, 112, 255, 0.8)', fontFamily: 'monospace', fontSize: '12.5px' }}>
              &gt;_ 飞书网关服务监听未激活。请等待后续版本升级开启...
            </span>
          </div>

        </div>
      )}

    </div>
  )
}

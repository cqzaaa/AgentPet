import React, { useState, useEffect, useRef } from 'react'
import type { AppStore } from '../hooks/useAppStore'
import { DEFAULT_MODELS } from '../utils/helpers'

// ── 官方标准 SVG 图标组件 ──────────────────────────────────────────────────

// 微信官方 SVG 路径
const WeChatIcon = ({ size = 20, active = false }: { size?: number; active?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={active ? '#10b981' : 'currentColor'} style={{ flexShrink: 0, transition: 'fill 0.2s' }}>
    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
  </svg>
)

// 飞书官方风车折纸 SVG 路径
const FeishuIcon = ({ size = 20, active = false }: { size?: number; active?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={active ? '#3370ff' : 'currentColor'} style={{ flexShrink: 0, transition: 'fill 0.2s' }}>
    <path d="M1.967 15.352c1.708.974 3.905.789 5.378-.475l9.957-8.552a.465.465 0 0 1 .714.544l-4.524 11.238a3.102 3.102 0 0 1-3.805 1.834L1.967 15.352zM21.576 4.965a3.102 3.102 0 0 0-4.148-.283l-9.957 8.552a.465.465 0 0 0-.083.58l4.524 11.237a3.102 3.102 0 0 0 5.158 1.01l6.09-6.09a3.102 3.102 0 0 0 .584-3.159l-2.168-11.847z" />
  </svg>
)

// QQ 官方企鹅 SVG 路径
const QQIcon = ({ size = 20, active = false }: { size?: number; active?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={active ? '#1296db' : 'currentColor'} style={{ flexShrink: 0, transition: 'fill 0.2s' }}>
    <path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673" />
  </svg>
)

// Telegram 官方纸飞机 SVG 路径
const TelegramIcon = ({ size = 20, active = false }: { size?: number; active?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={active ? '#54a9eb' : 'currentColor'} style={{ flexShrink: 0, transition: 'fill 0.2s' }}>
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
)

// ── 页面组件入口 ──────────────────────────────────────────────────────────

interface ControlPageProps {
  store: AppStore
}

export function ControlPage({ store }: ControlPageProps): React.JSX.Element {
  const { showToast, setActiveTab, setActiveSessionId } = store

  // 微信/飞书/QQ/Telegram 多渠道选择状态
  const [activeChannel, setActiveChannel] = useState<'wechat' | 'feishu' | 'qq' | 'telegram'>('wechat')

  // 高级设置折叠状态
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)

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

  // 测试与微信 Bot 的通讯连接
  const handleTestBotConnection = async () => {
    setIsLoading(true)
    try {
      const state = await window.api.wechatGetStatus()
      if (state && state.status) {
        if (state.status === 'connected') {
          showToast('与微信 Bot 通讯正常，账号已连接运行中！', 'success')
        } else {
          showToast('与微信 Bot 通讯正常，但微信助手当前未登录。', 'info')
        }
      } else {
        showToast('测试连接失败：无法获取微信 Bot 的状态。', 'error')
      }
    } catch (e: any) {
      showToast(`测试连接失败: ${e.message || e}`, 'error')
    } finally {
      setIsLoading(false)
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
    if (confirm('确认断开微信 Bot 托管连接吗？这会清除您的登录会话并移除该渠道。')) {
      setIsLoading(true)
      try {
        await window.api.wechatLogout()
        showToast('微信 Bot 已断开连接，已移除此频道', 'info')
      } catch (err: any) {
        showToast(`注销失败: ${err.message || err}`, 'error')
      } finally {
        setIsLoading(false)
      }
    }
  }

  // 切换“已启用”状态。当关闭启用时，自动切断微信托管连接并保存配置；当开启时，自动保存配置。
  const handleToggleEnable = async (checked: boolean) => {
    setEnableAutoReply(checked)
    setIsLoading(true)
    try {
      if (!checked) {
        // 关闭时，立即断开微信托管连接，无需 confirm 弹框确认
        await window.api.wechatLogout()
        showToast('微信服务已关闭，已断开微信托管连接', 'info')
      } else {
        showToast('微信自动回复服务已启用', 'success')
      }
      
      // 同步把新的启用状态写入配置中
      const settings = {
        llmConfig: localLlmConfig,
        autoReplyText,
        enableAutoReply: checked
      }
      await window.api.wechatSaveSettings(settings)
      fetchWechatStatus()
    } catch (err: any) {
      showToast(`操作失败: ${err.message || err}`, 'error')
    } finally {
      setIsLoading(false)
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

  // ── WeChat 渠道渲染 ──────────────────────────────────────────────────────

  const renderWechatChannel = () => {
    const isConnected = wechatState.status === 'connected'

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', animation: 'fadeIn 0.2s ease' }}>
        {/* 顶部控制栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.15))', paddingBottom: '12px', marginBottom: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <WeChatIcon size={20} active />
            </div>
            <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>WeChat</span>
            
            {/* 状态标志及刷新 */}
            <span style={{ 
              display: 'inline-flex', 
              alignItems: 'center', 
              gap: '4px', 
              fontSize: '11px', 
              padding: '2px 8px', 
              borderRadius: '12px', 
              background: isConnected ? 'rgba(16, 185, 129, 0.12)' : 'rgba(128, 128, 128, 0.12)', 
              color: isConnected ? '#10b981' : 'var(--text-muted)',
              fontWeight: 500
            }}>
              {isConnected ? '已连接' : '未连接'}
            </span>
          </div>

          {/* 右侧已启用开关 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>已启用</span>
            <label className="switch-toggle" style={{ position: 'relative', display: 'inline-block', width: '42px', height: '22px', flexShrink: 0 }}>
              <input
                type="checkbox"
                checked={enableAutoReply}
                onChange={e => handleToggleEnable(e.target.checked)}
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
        </div>

        {/* WeChat 账户连接状态面板 */}
        {isConnected ? (
          <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-card-sub, rgba(128,128,128,0.02))', border: '1px solid var(--border-color, rgba(128,128,128,0.1))', borderRadius: '8px', padding: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--text-primary)' }}>已连接的微信账号</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  此渠道已通过二维码授权连接。凭据由系统自动管理。{wechatState.botId && `(Bot ID: ${wechatState.botId})`}
                </div>
              </div>
              <button 
                className="btn-secondary" 
                onClick={handleStartLogin} 
                disabled={isLoading}
                style={{ fontSize: '12.5px', padding: '6px 12px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '6px', height: '32px', whiteSpace: 'nowrap' }}
              >
                🔲 通过二维码重新绑定
              </button>
            </div>
            
            {/* 蓝色警告通知框 */}
            <div style={{ display: 'flex', gap: '8px', padding: '12px 16px', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.15)', borderRadius: '8px', color: '#3b82f6', fontSize: '12px', marginTop: '12px', lineHeight: '1.4' }}>
              <span style={{ fontSize: '14px', display: 'inline-block', lineHeight: 1, marginTop: '1px' }}>ℹ️</span>
              <span>如果超过 7 天没有用户发送消息，此连接将自动暂停。要恢复，请点击“通过二维码重新绑定”。</span>
            </div>

            {/* 橙色未启用自动回复警告框 */}
            {!enableAutoReply && (
              <div style={{ display: 'flex', gap: '8px', padding: '12px 16px', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: '8px', color: '#f59e0b', fontSize: '12px', marginTop: '12px', lineHeight: '1.4', fontWeight: 500 }}>
                <span style={{ fontSize: '14px', display: 'inline-block', lineHeight: 1, marginTop: '1px' }}>⚠️</span>
                <span>微信已连接，但右上角“已启用”开关未开启。当前处于非托管状态，智能助手不会自动回复好友消息。</span>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-card-sub, rgba(128,128,128,0.02))', border: '1px solid var(--border-color, rgba(128,128,128,0.1))', borderRadius: '8px', padding: '24px 16px', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
            {wechatState.status === 'disconnected' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: '40px' }}>🤖</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14.5px', color: 'var(--text-primary)' }}>个人号智能助理未激活</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', maxWidth: '300px', lineHeight: 1.4 }}>
                    使用微信官方合规的 iLink 协议，安全无风险，扫码即可开启您的宠物自动代理对话！
                  </div>
                </div>
                <button className="btn-primary" onClick={handleStartLogin} disabled={isLoading} style={{ marginTop: '8px', padding: '8px 24px', borderRadius: '6px', fontSize: '13px' }}>
                  {isLoading ? '正在初始化...' : '🔌 扫码连接微信'}
                </button>
              </div>
            )}

            {(wechatState.status === 'qrcode_ready' || wechatState.status === 'scanned') && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', textAlign: 'center' }}>
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
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>
                  {wechatState.status === 'scanned' ? '等待手机微信确认授权...' : '请使用登录机器人的微信扫描上方二维码'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 高级设置（折叠面板） */}
        <div style={{ 
          border: '1px solid var(--border-color, rgba(128,128,128,0.12))', 
          borderRadius: '8px', 
          overflow: 'hidden', 
          background: 'var(--bg-card-sub, rgba(128,128,128,0.01))',
          transition: 'all 0.3s ease'
        }}>
          <div 
            onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between', 
              padding: '12px 16px', 
              cursor: 'pointer',
              userSelect: 'none',
              background: 'var(--bg-card-sub, rgba(128,128,128,0.03))',
              borderBottom: isAdvancedOpen ? '1px solid var(--border-color, rgba(128,128,128,0.12))' : 'none',
              transition: 'background 0.2s'
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover, rgba(128,128,128,0.06))'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-card-sub, rgba(128,128,128,0.03))'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13.5px', color: 'var(--text-primary)' }}>
              <span style={{ 
                transform: isAdvancedOpen ? 'rotate(90deg)' : 'rotate(0deg)', 
                transition: 'transform 0.2s', 
                display: 'inline-block', 
                fontSize: '10px',
                color: 'var(--text-muted)' 
              }}>▶</span>
              <span>高级设置</span>
            </div>
          </div>

          {isAdvancedOpen && (
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* 是否使用与电脑端相同的模型配置 */}
              <div className="form-group" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <div style={{ textAlign: 'left', flex: 1, paddingRight: '16px' }}>
                  <label className="form-label" style={{ marginBottom: '2px', display: 'block', fontSize: '12.5px', fontWeight: 600 }}>使用与电脑端相同的模型配置</label>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', background: 'var(--bg-card-sub, rgba(128,128,128,0.01))', border: '1px solid var(--border-color, rgba(128,128,128,0.06))', borderRadius: '6px' }}>
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
                          {showApiKey ? '👁' : '🙈'}
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
                <div style={{ padding: '16px', background: 'var(--bg-card-sub, rgba(128,128,128,0.015))', border: '1px dashed var(--border-color, rgba(128,128,128,0.12))', borderRadius: '6px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '4px', justifyContent: 'center', height: '80px' }}>
                  <span>🔒 已同步使用系统全局模型配置</span>
                  <span style={{ fontSize: '11px', opacity: 0.8 }}>微信消息回复将直接调用“设置-模型配置”里的主模型。</span>
                </div>
              )}

              {/* 兜底回复话术 */}
              <div>
                <label className="form-label" style={{ marginBottom: '3px', fontSize: '12px', fontWeight: 600 }}>大模型接口报错/故障时的兜底回复</label>
                <input
                  type="text"
                  className="form-input"
                  value={autoReplyText}
                  onChange={e => setAutoReplyText(e.target.value)}
                  placeholder="如：抱歉，我现在有些忙，稍后回复您~"
                  style={{ height: '30px', padding: '0 8px', fontSize: '12px', width: '100%' }}
                />
              </div>
            </div>
          )}
        </div>

        {/* 当前活跃的微信聊天窗口 */}
        {isConnected && wechatState.activeChats && wechatState.activeChats.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>当前活跃的聊天窗口</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {wechatState.activeChats.map((chat: any) => (
                <div
                  key={chat.userId}
                  onClick={() => {
                    const sessionId = `wechat:${chat.userId}`
                    setActiveSessionId(sessionId)
                    setActiveTab('chat')
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    background: 'var(--bg-card-sub, rgba(128,128,128,0.02))',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color, rgba(128,128,128,0.08))',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--bg-card-hover, rgba(128,128,128,0.05))'
                    e.currentTarget.style.borderColor = 'var(--border-color-hover, rgba(128,128,128,0.15))'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'var(--bg-card-sub, rgba(128,128,128,0.02))'
                    e.currentTarget.style.borderColor = 'var(--border-color, rgba(128,128,128,0.08))'
                  }}
                  title="点击跳转到该微信会话"
                >
                  <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'linear-gradient(135deg, #3b82f6, #10b981)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '12px', flexShrink: 0 }}>
                    💬
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12.5px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chat.nickname}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>
                      最近消息：{new Date(chat.lastMessageTime).toLocaleString('zh-CN')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 底部动作按钮栏 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button 
              onClick={handleTestBotConnection} 
              disabled={isLoading}
              style={{ 
                padding: '8px 16px', 
                borderRadius: '6px', 
                fontSize: '13px', 
                border: '1px solid var(--border-color, rgba(128,128,128,0.2))', 
                background: 'var(--bg-card, #fff)', 
                color: 'var(--text-primary, #333)',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-menu-hover, rgba(128,128,128,0.05))'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-card, #fff)'}
            >
              🔄 测试连接
            </button>
            <button 
              className="btn-primary" 
              onClick={handleSaveWechatSettings} 
              disabled={isLoading} 
              style={{ 
                padding: '8px 16px', 
                borderRadius: '6px', 
                fontSize: '13px', 
                background: 'var(--text-primary, #000)', 
                color: 'var(--bg-card, #fff)', 
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              {isLoading ? '正在保存...' : '💾 保存配置'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── 即将推出的渠道渲染 ───────────────────────────────────────────────────

  const renderUpcomingChannel = (name: string, icon: React.ReactNode, description: string) => {
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '20px', 
        flex: 1, 
        justifyContent: 'center', 
        alignItems: 'center', 
        padding: '40px', 
        textAlign: 'center', 
        height: '100%',
        minHeight: '340px',
        animation: 'fadeIn 0.3s ease'
      }}>
        <div style={{ 
          width: '72px', 
          height: '72px', 
          borderRadius: '50%', 
          background: 'var(--bg-card-sub, rgba(128,128,128,0.06))', 
          border: '1px solid var(--border-color, rgba(128,128,128,0.1))',
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          marginBottom: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
        }}>
          {icon}
        </div>
        <div>
          <h3 style={{ fontSize: '16.5px', fontWeight: 600, color: 'var(--text-primary, #fff)', marginBottom: '8px' }}>{name} 智能通道</h3>
          <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: '380px', margin: '0 auto' }}>
            {description}
          </p>
        </div>
        <div style={{ 
          background: 'var(--bg-card-sub, rgba(128,128,128,0.04))', 
          border: '1px dashed var(--border-color, rgba(128,128,128,0.15))', 
          borderRadius: '20px', 
          padding: '6px 16px', 
          fontSize: '11px', 
          color: 'var(--primary-color, #10b981)', 
          fontWeight: 600,
          letterSpacing: '0.05em'
        }}>
          ✨ 敬请期待 • 正在研发中
        </div>
      </div>
    )
  }

  // ── 双栏主布局渲染 ────────────────────────────────────────────────────────

  return (
    <div style={{ 
      display: 'flex', 
      minHeight: '100%', 
      height: '100%', 
      gap: '20px', 
      background: 'transparent'
    }}>
      {/* 左侧渠道列表 */}
      <div style={{ 
        width: '210px', 
        flexShrink: 0, 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '6px', 
        borderRight: '1px solid var(--border-color, rgba(128,128,128,0.15))', 
        paddingRight: '16px' 
      }}>
        {/* WeChat */}
        <div 
          onClick={() => setActiveChannel('wechat')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: activeChannel === 'wechat' ? 'var(--bg-menu-hover, rgba(128,128,128,0.06))' : 'transparent',
            border: activeChannel === 'wechat' ? '1px solid var(--border-color, rgba(128,128,128,0.12))' : '1px solid transparent',
            transition: 'all 0.2s'
          }}
          className="channel-item"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <WeChatIcon size={18} active={activeChannel === 'wechat'} />
            <span style={{ fontSize: '13px', fontWeight: activeChannel === 'wechat' ? 600 : 'normal', color: activeChannel === 'wechat' ? 'var(--text-menu-active)' : 'var(--text-primary)' }}>WeChat</span>
          </div>
          {wechatState.status === 'connected' ? (
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block', boxShadow: '0 0 6px #10b981' }} title="已连接"></span>
          ) : (
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'rgba(128,128,128,0.4)', display: 'inline-block' }} title="未连接"></span>
          )}
        </div>

        {/* Feishu */}
        <div 
          onClick={() => setActiveChannel('feishu')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: activeChannel === 'feishu' ? 'var(--bg-menu-hover, rgba(128,128,128,0.06))' : 'transparent',
            border: activeChannel === 'feishu' ? '1px solid var(--border-color, rgba(128,128,128,0.12))' : '1px solid transparent',
            transition: 'all 0.2s'
          }}
          className="channel-item"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', opacity: activeChannel === 'feishu' ? 1 : 0.6 }}>
            <FeishuIcon size={18} active={activeChannel === 'feishu'} />
            <span style={{ fontSize: '13px', fontWeight: activeChannel === 'feishu' ? 600 : 'normal', color: activeChannel === 'feishu' ? 'var(--text-menu-active)' : 'var(--text-primary)' }}>Feishu</span>
          </div>
          <span style={{ fontSize: '9px', background: 'var(--bg-card-sub, rgba(128,128,128,0.1))', color: 'var(--text-muted)', padding: '1px 5px', borderRadius: '8px', zoom: 0.9 }}>即将推出</span>
        </div>

        {/* QQ */}
        <div 
          onClick={() => setActiveChannel('qq')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: activeChannel === 'qq' ? 'var(--bg-menu-hover, rgba(128,128,128,0.06))' : 'transparent',
            border: activeChannel === 'qq' ? '1px solid var(--border-color, rgba(128,128,128,0.12))' : '1px solid transparent',
            transition: 'all 0.2s'
          }}
          className="channel-item"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', opacity: activeChannel === 'qq' ? 1 : 0.6 }}>
            <QQIcon size={18} active={activeChannel === 'qq'} />
            <span style={{ fontSize: '13px', fontWeight: activeChannel === 'qq' ? 600 : 'normal', color: activeChannel === 'qq' ? 'var(--text-menu-active)' : 'var(--text-primary)' }}>QQ</span>
          </div>
          <span style={{ fontSize: '9px', background: 'var(--bg-card-sub, rgba(128,128,128,0.1))', color: 'var(--text-muted)', padding: '1px 5px', borderRadius: '8px', zoom: 0.9 }}>即将推出</span>
        </div>

        {/* Telegram */}
        <div 
          onClick={() => setActiveChannel('telegram')}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            background: activeChannel === 'telegram' ? 'var(--bg-menu-hover, rgba(128,128,128,0.06))' : 'transparent',
            border: activeChannel === 'telegram' ? '1px solid var(--border-color, rgba(128,128,128,0.12))' : '1px solid transparent',
            transition: 'all 0.2s'
          }}
          className="channel-item"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', opacity: activeChannel === 'telegram' ? 1 : 0.6 }}>
            <TelegramIcon size={18} active={activeChannel === 'telegram'} />
            <span style={{ fontSize: '13px', fontWeight: activeChannel === 'telegram' ? 600 : 'normal', color: activeChannel === 'telegram' ? 'var(--text-menu-active)' : 'var(--text-primary)' }}>Telegram</span>
          </div>
          <span style={{ fontSize: '9px', background: 'var(--bg-card-sub, rgba(128,128,128,0.1))', color: 'var(--text-muted)', padding: '1px 5px', borderRadius: '8px', zoom: 0.9 }}>即将推出</span>
        </div>
      </div>

      {/* 右侧主区域：对应选中的渠道配置 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingRight: '4px' }}>
        {activeChannel === 'wechat' && renderWechatChannel()}
        {activeChannel === 'feishu' && renderUpcomingChannel('Feishu', <FeishuIcon size={32} active />, '将桌面宠物 Mao 接入您的企业飞书工作台，实现全自动的日程规划、会议协同和企业知识库智能答复。')}
        {activeChannel === 'qq' && renderUpcomingChannel('QQ', <QQIcon size={32} active />, '接入您的 QQ 个人号或群聊，让 Mao 随时充当您群聊里的智能暖场专家、自动答读者问或个人日程备忘助手。')}
        {activeChannel === 'telegram' && renderUpcomingChannel('Telegram', <TelegramIcon size={32} active />, '绑定 Telegram Bot 服务，支持全球多语言智能沟通，将 Mao 的各种扩展 Skills 赋能给 Telegram 群组。')}
      </div>
    </div>
  )
}

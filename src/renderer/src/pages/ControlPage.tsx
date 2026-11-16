import React, { useState, useEffect, useRef } from 'react'
import type { AppStore } from '../hooks/useAppStore'
import { requestConfirmation } from '../components/confirmService'
import { DEFAULT_MODELS } from '../utils/helpers'
import { getModelIcon } from '../utils/modelIcons'
import {
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Info,
  MessageCircle,
  Plug,
  QrCode,
  RefreshCw,
  Save,
  SlidersHorizontal,
  TriangleAlert
} from 'lucide-react'
import './ControlPage.css'

// ── 官方标准 SVG 图标组件 ──────────────────────────────────────────────────

const WeChatIcon = ({ size = 20, active = false }: { size?: number; active?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={active ? '#10b981' : 'currentColor'} style={{ flexShrink: 0, transition: 'fill 0.2s' }}>
    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
  </svg>
)

const FeishuIcon = ({ size = 20, active = false }: { size?: number; active?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={active ? '#3370ff' : 'currentColor'} style={{ flexShrink: 0, transition: 'fill 0.2s' }}>
    <path d="M1.967 15.352c1.708.974 3.905.789 5.378-.475l9.957-8.552a.465.465 0 0 1 .714.544l-4.524 11.238a3.102 3.102 0 0 1-3.805 1.834L1.967 15.352zM21.576 4.965a3.102 3.102 0 0 0-4.148-.283l-9.957 8.552a.465.465 0 0 0-.083.58l4.524 11.237a3.102 3.102 0 0 0 5.158 1.01l6.09-6.09a3.102 3.102 0 0 0 .584-3.159l-2.168-11.847z" />
  </svg>
)

const QQIcon = ({ size = 20, active = false }: { size?: number; active?: boolean }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={active ? '#1296db' : 'currentColor'} style={{ flexShrink: 0, transition: 'fill 0.2s' }}>
    <path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673" />
  </svg>
)

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
  const { showToast, setActiveTab, setActiveSessionId, refreshSessions } = store

  // 微信/飞书/QQ/Telegram 多渠道选择状态
  const [activeChannel, setActiveChannel] = useState<'wechat' | 'feishu' | 'qq' | 'telegram'>('wechat')

  // 模型与话术设置折叠状态
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)

  // 复制 Bot ID 状态反馈
  const [copiedBotId, setCopiedBotId] = useState(false)

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
      hasApiKey: false,
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
    hasApiKey: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    temperature: 0.7,
    useSystemConfig: true
  })

  const [autoReplyText, setAutoReplyText] = useState('你好，我是 Mao 的微信集成助手。')
  const [enableAutoReply, setEnableAutoReply] = useState(true)
  const [showApiKey, setShowApiKey] = useState(false)
  const [wechatApiKeyDraft, setWechatApiKeyDraft] = useState('')
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
        apiKey: wechatApiKeyDraft,
        baseUrl: localLlmConfig.baseUrl,
        credentialScope: 'wechat'
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
          hasApiKey: false,
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

  // 切换“已启用”状态。当关闭启用时，自动切断微信托管连接并保存配置；当开启时，自动保存配置。
  const handleToggleEnable = async (checked: boolean) => {
    setEnableAutoReply(checked)
    setIsLoading(true)
    try {
      if (!checked) {
        await window.api.wechatLogout()
        showToast('微信服务已关闭，已断开微信托管连接', 'info')
      } else {
        showToast('微信自动回复服务已启用', 'success')
      }

      const settings = {
        llmConfig: { ...localLlmConfig, apiKey: wechatApiKeyDraft },
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
        llmConfig: { ...localLlmConfig, apiKey: wechatApiKeyDraft },
        autoReplyText,
        enableAutoReply
      }
      const ok = await window.api.wechatSaveSettings(settings)
      if (ok) {
        setWechatApiKeyDraft('')
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

  const handleClearWechatApiKey = async (): Promise<void> => {
    if (!(await requestConfirmation({
      title: '删除微信助手专属密钥？',
      description: '删除后微信托管通道将不再使用该专属密钥。',
      confirmLabel: '确认删除',
      tone: 'danger'
    }))) return
    setIsLoading(true)
    try {
      const ok = await window.api.wechatSaveSettings({
        llmConfig: { ...localLlmConfig, apiKey: '', clearApiKey: true },
        autoReplyText,
        enableAutoReply
      })
      if (ok) {
        setWechatApiKeyDraft('')
        await fetchWechatStatus()
        showToast('微信助手专属密钥已删除', 'success')
      } else {
        showToast('删除微信助手专属密钥失败', 'error')
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopyBotId = async (botId: string) => {
    try {
      await navigator.clipboard.writeText(botId)
      setCopiedBotId(true)
      setTimeout(() => setCopiedBotId(false), 1800)
    } catch {
      showToast('复制 Bot ID 失败', 'error')
    }
  }

  // ── WeChat 渠道渲染 ──────────────────────────────────────────────────────

  const renderWechatChannel = () => {
    const isConnected = wechatState.status === 'connected'
    const activeChats = isConnected && Array.isArray(wechatState.activeChats) ? wechatState.activeChats : []
    const recentLogs = Array.isArray(wechatState.logs) ? [...wechatState.logs].slice(-8).reverse() : []

    return (
      <div className="ctrl-workspace">
        {/* 顶部通道标题与托管开关 */}
        <header className="ctrl-channel-header">
          <div className="ctrl-channel-identity">
            <div className="ctrl-channel-avatar">
              <WeChatIcon size={21} active />
            </div>
            <div className="ctrl-channel-title-row">
              <h2 className="ctrl-channel-title">WeChat</h2>
              <span className={`ctrl-status-pill ${isConnected ? 'is-connected' : ''}`}>
                <span className="ctrl-status-pill-dot" aria-hidden="true" />
                {isConnected ? '已连接' : '未连接'}
              </span>
            </div>
          </div>

          <div className="ctrl-header-controls">
            <div className="ctrl-enable-control">
              <span className="ctrl-enable-label">{enableAutoReply ? '自动托管已开启' : '自动托管已暂停'}</span>
              <label className="ctrl-switch" aria-label="切换微信自动回复启用状态">
                <input
                  type="checkbox"
                  checked={enableAutoReply}
                  onChange={e => handleToggleEnable(e.target.checked)}
                />
                <span className="ctrl-switch-track">
                  <span className="ctrl-switch-thumb" />
                </span>
              </label>
            </div>
          </div>
        </header>

        {/* 账户连接与实时遥测面板 */}
        <section className="ctrl-surface">
          {isConnected ? (
            <div className="ctrl-connection-body">
              <div className="ctrl-connection-top">
                <div>
                  <h3 className="ctrl-section-heading">已连接的微信账号</h3>
                  <div className="ctrl-section-desc">
                    通过 iLink 协议扫码授权，凭据由本地安全存储管理。
                  </div>
                </div>
                <button
                  type="button"
                  className="ctrl-btn ctrl-btn-secondary"
                  onClick={handleStartLogin}
                  disabled={isLoading}
                >
                  <QrCode size={15} strokeWidth={1.75} aria-hidden="true" />
                  重新扫码绑定
                </button>
              </div>

              <div className="ctrl-telemetry-strip">
                <div className="ctrl-metric-cell">
                  <span className="ctrl-metric-label">会话凭据 / Bot ID</span>
                  <div className="ctrl-metric-value is-text">
                    <span className="ctrl-truncate" title={wechatState.botId || '未分配'}>
                      {wechatState.botId || '未分配'}
                    </span>
                    {wechatState.botId && (
                      <button
                        type="button"
                        className="ctrl-copy-btn"
                        onClick={() => void handleCopyBotId(wechatState.botId)}
                        title="复制 Bot ID"
                        aria-label="复制 Bot ID"
                      >
                        {copiedBotId
                          ? <Check size={13} strokeWidth={2} color="#10b981" aria-hidden="true" />
                          : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
                      </button>
                    )}
                  </div>
                </div>

                <div className="ctrl-metric-cell">
                  <span className="ctrl-metric-label">已接收消息</span>
                  <div className="ctrl-metric-value">{Number(wechatState.messagesReceived || 0)}</div>
                </div>

                <div className="ctrl-metric-cell">
                  <span className="ctrl-metric-label">已发送回复</span>
                  <div className="ctrl-metric-value">{Number(wechatState.messagesSent || 0)}</div>
                </div>

                <div className="ctrl-metric-cell">
                  <span className="ctrl-metric-label">活跃窗口</span>
                  <div className="ctrl-metric-value">{activeChats.length}</div>
                </div>
              </div>

              {!enableAutoReply && (
                <div className="ctrl-warning-banner">
                  <TriangleAlert size={15} strokeWidth={1.85} aria-hidden="true" />
                  <span>当前账号已连接，但右上角托管开关处于关闭状态，助手不会自动回复好友消息。</span>
                </div>
              )}

              <div className="ctrl-inline-note">
                <Info size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>超过 7 天未收到新消息时连接将自动暂停，届时重新扫码即可恢复。</span>
              </div>
            </div>
          ) : (
            <div className="ctrl-qr-stage">
              {wechatState.status === 'disconnected' && (
                <div className="ctrl-pairing-stage" style={{ width: '100%', padding: 0 }}>
                  <div className="ctrl-pairing-copy">
                    <div className="ctrl-pairing-emblem">
                      <Bot size={22} strokeWidth={1.65} aria-hidden="true" />
                    </div>
                    <div style={{ textAlign: 'left' }}>
                      <h3 className="ctrl-section-heading">个人号智能助理未激活</h3>
                      <p className="ctrl-pairing-desc">
                        使用微信官方合规的 iLink 协议，扫码授权后即可让 Mao 自动响应微信消息。
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ctrl-btn ctrl-btn-primary"
                    onClick={handleStartLogin}
                    disabled={isLoading}
                  >
                    <Plug size={15} strokeWidth={1.75} aria-hidden="true" />
                    {isLoading ? '正在初始化...' : '扫码连接微信'}
                  </button>
                </div>
              )}

              {(wechatState.status === 'qrcode_ready' || wechatState.status === 'scanned') && (
                <>
                  {(() => {
                    let qrSrc = wechatState.qrcodeUrl
                    if (qrSrc && !qrSrc.startsWith('http') && !qrSrc.startsWith('data:image/')) {
                      qrSrc = `data:image/png;base64,${qrSrc}`
                    }
                    return qrSrc ? (
                      <div className="ctrl-qr-frame">
                        <img src={qrSrc} alt="微信登录二维码" />
                        {wechatState.status === 'scanned' && (
                          <div className="ctrl-qr-overlay">
                            <CheckCircle2 size={24} strokeWidth={2} style={{ marginBottom: '6px', color: '#10b981' }} aria-hidden="true" />
                            <span style={{ fontSize: '12px', color: '#1f2937', fontWeight: 600 }}>手机微信已扫描</span>
                            <span style={{ fontSize: '11px', color: '#4b5563', marginTop: '2px' }}>请在手机上点击确认登录</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="ctrl-qr-placeholder">生成二维码中...</div>
                    )
                  })()}
                  <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', fontWeight: 500 }}>
                    {wechatState.status === 'scanned' ? '等待手机微信确认授权...' : '请使用登录机器人的微信扫描上方二维码'}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {/* 活跃会话与实时日志（非嵌套双列视图） */}
        {isConnected && (
          <section className="ctrl-ops-grid" aria-label="会话与运行日志">
            <div className="ctrl-pane">
              <div className="ctrl-pane-head">
                <span className="ctrl-pane-title">活跃聊天窗口</span>
                <span className="ctrl-pane-count">{activeChats.length}</span>
              </div>
              {activeChats.length > 0 ? (
                <div className="ctrl-chat-list">
                  {activeChats.map((chat: any) => (
                    <button
                      type="button"
                      key={chat.userId}
                      className="ctrl-chat-row"
                      onClick={() => {
                        const sessionId = `wechat:${chat.userId}`
                        window.api.ensureWechatSession(sessionId, chat.nickname).then(() => {
                          refreshSessions().then(() => {
                            setActiveSessionId(sessionId)
                            setActiveTab('chat')
                          })
                        }).catch(err => {
                          showToast(`确保微信会话失败: ${err.message || err}`, 'error')
                        })
                      }}
                      title="点击跳转到该微信会话"
                    >
                      <div className="ctrl-chat-avatar">
                        <MessageCircle size={15} strokeWidth={1.75} aria-hidden="true" />
                      </div>
                      <div className="ctrl-chat-info">
                        <div className="ctrl-chat-name">{chat.nickname}</div>
                        <div className="ctrl-chat-meta">
                          <span className="ctrl-chat-id">{chat.userId}</span>
                          <span>{new Date(chat.lastMessageTime).toLocaleString('zh-CN')}</span>
                        </div>
                      </div>
                      <ArrowUpRight size={15} strokeWidth={1.75} className="ctrl-chat-arrow" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="ctrl-empty-pane">
                  暂无活跃微信会话。当好友向此账号发送消息后，会话窗口会在此出现并支持一键接管。
                </div>
              )}
            </div>

            <div className="ctrl-pane">
              <div className="ctrl-pane-head">
                <span className="ctrl-pane-title">最近通道日志</span>
                <span className="ctrl-pane-count">{recentLogs.length}</span>
              </div>
              {recentLogs.length > 0 ? (
                <div className="ctrl-log-list">
                  {recentLogs.map((log: any, idx: number) => (
                    <div className="ctrl-log-row" key={`${log.time || ''}-${idx}`}>
                      <span className="ctrl-log-time">{log.time || '--:--'}</span>
                      <span className={`ctrl-log-dir ${log.type === 'in' ? 'is-in' : log.type === 'out' ? 'is-out' : ''}`}>
                        {log.type === 'in' ? 'IN' : log.type === 'out' ? 'OUT' : 'SYS'}
                      </span>
                      <span className="ctrl-log-text">{log.text}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ctrl-empty-pane">
                  暂无收发记录。消息到达或自动回复触发时将实时记录在此。
                </div>
              )}
            </div>
          </section>
        )}

        {/* 高级设置（开放式结构，无盒套盒） */}
        <section className="ctrl-arch-section">
          <button
            type="button"
            className="ctrl-accordion-trigger"
            onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
            aria-expanded={isAdvancedOpen}
          >
            <div className="ctrl-accordion-left">
              {isAdvancedOpen
                ? <ChevronDown size={15} strokeWidth={2} color="var(--text-muted)" aria-hidden="true" />
                : <ChevronRight size={15} strokeWidth={2} color="var(--text-muted)" aria-hidden="true" />}
              <SlidersHorizontal size={14} strokeWidth={1.75} color="var(--text-muted)" aria-hidden="true" />
              <span className="ctrl-accordion-title">模型路由与兜底设置</span>
            </div>
            <span className="ctrl-accordion-summary">
              {localLlmConfig.useSystemConfig
                ? '跟随系统全局模型'
                : `${String(localLlmConfig.provider || 'custom').toUpperCase()}${localLlmConfig.model ? ` · ${localLlmConfig.model}` : ''}`}
            </span>
          </button>

          {isAdvancedOpen && (
            <div className="ctrl-settings-body">
              <div className="ctrl-setting-row">
                <div>
                  <span className="ctrl-setting-title">使用与电脑端相同的模型配置</span>
                  <div className="ctrl-setting-hint">
                    开启后将直接调用“设置 - 模型配置”中的主模型，无需重复填写密钥。
                  </div>
                </div>
                <label className="ctrl-switch" aria-label="使用与电脑端相同的模型配置">
                  <input
                    type="checkbox"
                    checked={localLlmConfig.useSystemConfig}
                    onChange={e => setLocalLlmConfig({ ...localLlmConfig, useSystemConfig: e.target.checked })}
                  />
                  <span className="ctrl-switch-track">
                    <span className="ctrl-switch-thumb" />
                  </span>
                </label>
              </div>

              {!localLlmConfig.useSystemConfig && (
                <>
                  <div className="ctrl-form-grid">
                    <div className="ctrl-field">
                      <label className="ctrl-label" htmlFor="ctrl-wechat-provider">服务商</label>
                      <select
                        id="ctrl-wechat-provider"
                        className="ctrl-control"
                        value={localLlmConfig.provider}
                        onChange={e => {
                          setLocalLlmConfig({ ...localLlmConfig, provider: e.target.value, model: DEFAULT_MODELS[e.target.value] || '' })
                          setWechatAvailableModels([])
                          setShowWechatModelDropdown(false)
                        }}
                      >
                        {['gemini', 'deepseek', 'openai', 'ollama', 'custom'].map(p => (
                          <option key={p} value={p}>{p.toUpperCase()}</option>
                        ))}
                      </select>
                    </div>

                    <div className="ctrl-field" ref={wechatDropdownRef}>
                      <div className="ctrl-field-head">
                        <label className="ctrl-label" htmlFor="ctrl-wechat-model">模型名称</label>
                        {DEFAULT_MODELS[localLlmConfig.provider] && (
                          <button
                            type="button"
                            className="ctrl-link-btn"
                            onClick={() => {
                              setLocalLlmConfig({ ...localLlmConfig, model: DEFAULT_MODELS[localLlmConfig.provider] })
                              setShowWechatModelDropdown(false)
                            }}
                          >
                            填入默认
                          </button>
                        )}
                      </div>
                      <div className="ctrl-input-wrap">
                        <input
                          id="ctrl-wechat-model"
                          type="text"
                          className="ctrl-control has-suffix"
                          value={localLlmConfig.model}
                          onChange={e => setLocalLlmConfig({ ...localLlmConfig, model: e.target.value })}
                          onClick={() => { if (!showWechatModelDropdown) handleFetchWechatModels() }}
                          placeholder={DEFAULT_MODELS[localLlmConfig.provider] ? `例如: ${DEFAULT_MODELS[localLlmConfig.provider]}` : '请输入模型名称'}
                        />
                        <button
                          type="button"
                          className="ctrl-input-suffix"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (showWechatModelDropdown) { setShowWechatModelDropdown(false) } else { handleFetchWechatModels() }
                          }}
                          aria-label="展开模型列表"
                        >
                          <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </div>

                      {showWechatModelDropdown && (
                        <div className="ctrl-model-dropdown">
                          {isWechatLoadingModels ? (
                            <div style={{ fontSize: '12px', padding: '8px', color: 'var(--text-muted)' }}>正在请求 models 接口获取模型...</div>
                          ) : wechatAvailableModels.length > 0 ? (
                            <>
                              <div className="ctrl-dropdown-header">可用模型列表 ({wechatAvailableModels.length})</div>
                              {wechatAvailableModels.map(m => (
                                <button
                                  type="button"
                                  key={m}
                                  className={`ctrl-dropdown-item ${localLlmConfig.model === m ? 'is-selected' : ''}`}
                                  onClick={() => { setLocalLlmConfig({ ...localLlmConfig, model: m }); setShowWechatModelDropdown(false) }}
                                >
                                  <img
                                    src={getModelIcon(m, localLlmConfig.provider)}
                                    alt=""
                                    style={{ width: '14px', height: '14px', borderRadius: '3px', flexShrink: 0, objectFit: 'contain' }}
                                  />
                                  <span className="ctrl-truncate">{m}</span>
                                </button>
                              ))}
                            </>
                          ) : (
                            <div style={{ fontSize: '12px', padding: '8px', color: 'var(--text-muted)' }}>未获取到模型列表，可手动输入</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {localLlmConfig.provider !== 'ollama' && (
                    <div className="ctrl-field">
                      <label className="ctrl-label" htmlFor="ctrl-wechat-apikey">API 密钥 (API Key)</label>
                      <div className="ctrl-input-wrap">
                        <input
                          id="ctrl-wechat-apikey"
                          type={showApiKey ? 'text' : 'password'}
                          className="ctrl-control has-suffix"
                          value={wechatApiKeyDraft}
                          autoComplete="new-password"
                          spellCheck={false}
                          onChange={e => setWechatApiKeyDraft(e.target.value)}
                          placeholder={localLlmConfig.hasApiKey ? '密钥已安全保存；留空表示保持不变' : '输入微信助手专属大模型密钥'}
                        />
                        <button
                          type="button"
                          className="ctrl-input-suffix"
                          onClick={() => setShowApiKey(!showApiKey)}
                          aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
                        >
                          {showApiKey
                            ? <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
                            : <Eye size={14} strokeWidth={1.75} aria-hidden="true" />}
                        </button>
                      </div>
                      {localLlmConfig.hasApiKey && (
                        <button
                          type="button"
                          className="ctrl-danger-link"
                          onClick={() => void handleClearWechatApiKey()}
                          disabled={isLoading}
                        >
                          删除已安全保存的密钥
                        </button>
                      )}
                    </div>
                  )}

                  <div className="ctrl-field">
                    <label className="ctrl-label" htmlFor="ctrl-wechat-baseurl">API 代理地址 (Base URL)</label>
                    <input
                      id="ctrl-wechat-baseurl"
                      type="text"
                      className="ctrl-control"
                      value={localLlmConfig.baseUrl}
                      onChange={e => setLocalLlmConfig({ ...localLlmConfig, baseUrl: e.target.value })}
                      placeholder="选填，代理中转地址"
                    />
                  </div>
                </>
              )}

              <div className="ctrl-field">
                <label className="ctrl-label" htmlFor="ctrl-wechat-autoreply">大模型接口异常时的兜底回复</label>
                <input
                  id="ctrl-wechat-autoreply"
                  type="text"
                  className="ctrl-control"
                  value={autoReplyText}
                  onChange={e => setAutoReplyText(e.target.value)}
                  placeholder="如：抱歉，我现在有些忙，稍后回复您~"
                />
              </div>
            </div>
          )}
        </section>

        {/* 底部自然流式动作栏（不固定遮挡滚动区域） */}
        <footer className="ctrl-footer-actions">
          <button
            type="button"
            className="ctrl-btn ctrl-btn-secondary"
            onClick={handleTestBotConnection}
            disabled={isLoading}
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            测试连接
          </button>
          <button
            type="button"
            className="ctrl-btn ctrl-btn-primary"
            onClick={handleSaveWechatSettings}
            disabled={isLoading}
          >
            <Save size={14} strokeWidth={1.75} aria-hidden="true" />
            {isLoading ? '正在保存...' : '保存配置'}
          </button>
        </footer>
      </div>
    )
  }

  // ── 即将推出的渠道渲染 ───────────────────────────────────────────────────

  const renderUpcomingChannel = (
    name: string,
    icon: React.ReactNode,
    description: string,
    specs: Array<{ label: string; value: string }>
  ) => {
    return (
      <div className="ctrl-upcoming-panel">
        <div className="ctrl-upcoming-head">
          <div className="ctrl-upcoming-icon">{icon}</div>
          <div>
            <h2 className="ctrl-upcoming-title">{name} 智能通道</h2>
            <span className="ctrl-upcoming-tag">通道适配研发中 · 敬请期待</span>
          </div>
        </div>
        <p className="ctrl-upcoming-desc">{description}</p>
        <div className="ctrl-upcoming-spec">
          {specs.map(spec => (
            <div className="ctrl-upcoming-spec-item" key={spec.label}>
              <span className="ctrl-upcoming-spec-label">{spec.label}</span>
              <span className="ctrl-upcoming-spec-val">{spec.value}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── 双栏主布局渲染 ────────────────────────────────────────────────────────

  const isWechatConnected = wechatState.status === 'connected'

  return (
    <div className="control-page-layout">
      {/* 左侧渠道列表 */}
      <aside className="control-channel-sidebar" aria-label="订阅渠道导航">
        <div className="ctrl-rail-group">
          <div className="ctrl-rail-heading">已接入</div>
          <button
            type="button"
            onClick={() => setActiveChannel('wechat')}
            className={`ctrl-rail-item ${activeChannel === 'wechat' ? 'is-active' : ''}`}
          >
            <div className="ctrl-rail-item-main">
              <div className="ctrl-rail-icon">
                <WeChatIcon size={16} active={activeChannel === 'wechat' || isWechatConnected} />
              </div>
              <span className="ctrl-rail-name">WeChat</span>
            </div>
            <span
              className={`ctrl-status-dot ${isWechatConnected ? 'is-online' : ''}`}
              title={isWechatConnected ? '已连接' : '未连接'}
              aria-hidden="true"
            />
          </button>
        </div>

        <div className="ctrl-rail-group">
          <div className="ctrl-rail-heading">规划中</div>
          <button
            type="button"
            onClick={() => setActiveChannel('feishu')}
            className={`ctrl-rail-item is-upcoming ${activeChannel === 'feishu' ? 'is-active' : ''}`}
          >
            <div className="ctrl-rail-item-main">
              <div className="ctrl-rail-icon">
                <FeishuIcon size={16} active={activeChannel === 'feishu'} />
              </div>
              <span className="ctrl-rail-name">Feishu</span>
            </div>
            <span className="ctrl-rail-soon">待开放</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveChannel('qq')}
            className={`ctrl-rail-item is-upcoming ${activeChannel === 'qq' ? 'is-active' : ''}`}
          >
            <div className="ctrl-rail-item-main">
              <div className="ctrl-rail-icon">
                <QQIcon size={16} active={activeChannel === 'qq'} />
              </div>
              <span className="ctrl-rail-name">QQ</span>
            </div>
            <span className="ctrl-rail-soon">待开放</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveChannel('telegram')}
            className={`ctrl-rail-item is-upcoming ${activeChannel === 'telegram' ? 'is-active' : ''}`}
          >
            <div className="ctrl-rail-item-main">
              <div className="ctrl-rail-icon">
                <TelegramIcon size={16} active={activeChannel === 'telegram'} />
              </div>
              <span className="ctrl-rail-name">Telegram</span>
            </div>
            <span className="ctrl-rail-soon">待开放</span>
          </button>
        </div>
      </aside>

      {/* 右侧主区域：对应选中的渠道配置 */}
      <div className="control-channel-content">
        {activeChannel === 'wechat' && renderWechatChannel()}
        {activeChannel === 'feishu' &&
          renderUpcomingChannel(
            'Feishu',
            <FeishuIcon size={26} active />,
            '将 Mao 接入企业飞书工作台，支持群聊 @ 调度 Agent、日程协同与知识库检索回复。',
            [
              { label: '接入方式', value: 'Feishu App / Event Callback' },
              { label: '支持范围', value: '私聊 / 群聊 @ 提及' },
              { label: '当前状态', value: '接口适配中' }
            ]
          )}
        {activeChannel === 'qq' &&
          renderUpcomingChannel(
            'QQ',
            <QQIcon size={26} active />,
            '接入 QQ 个人号或群聊，支持私聊托管与群聊关键字唤醒，并在桌面端实时接管会话上下文。',
            [
              { label: '接入方式', value: 'Bot Gateway / WebSocket' },
              { label: '支持范围', value: '好友私聊 / 指定群聊' },
              { label: '当前状态', value: '接口适配中' }
            ]
          )}
        {activeChannel === 'telegram' &&
          renderUpcomingChannel(
            'Telegram',
            <TelegramIcon size={26} active />,
            '通过 BotFather Token 绑定 Telegram Bot，支持跨语言对话、斜杠指令与远程调用扩展 Skills。',
            [
              { label: '接入方式', value: 'Telegram Bot API' },
              { label: '支持范围', value: 'DM / Group / Slash Cmd' },
              { label: '当前状态', value: '接口适配中' }
            ]
          )}
      </div>
    </div>
  )
}

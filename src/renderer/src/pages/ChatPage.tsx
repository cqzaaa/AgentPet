import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { AppStore } from '../hooks/useAppStore'
import { getInternalClipboard, setInternalClipboard } from '../hooks/useAppStore'
import { ChatMessageItem } from '../components/ChatMessageItem'


interface ChatPageProps {
  store: AppStore
}

export function ChatPage({ store }: ChatPageProps): React.JSX.Element {
  const {
    llmConfig,
    activeSessMessages,
    activeSessionId,
    currentAvatarName,
    isSending,
    inputValue, setInputValue,
    chatEndRef,
    handleSendChat,
    availableModels,
    saveLlmConfig,
    attachedFiles,
    setAttachedFiles,
    handlePasteFiles,
    handleUploadFile,
    highlightedMessageId,
    setHighlightedMessageId,
    handleAbortLlm,
    isSessionSwitching,
    // SSH
    executionDevice,
    sshConnected,
    sshHost,
    sshUsername,
    handleUpdateExecutionDevice,
    handleConnectSsh,
    handleDisconnectSsh,
    showToast,
    // sandbox/permission
    activePermissionRequest,
    handleRespondPermission,
    // skills & mcp
    skillsList,
    disabledSkillNames,
    toggleSkillEnable,
    setActiveTab,
    setAgentSubTab,
    refreshSkillsAndStorage,
    refreshMcpServers,
    mcpConfig,
    saveMcpConfig
  } = store

  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const messagesBoxRef = useRef<HTMLDivElement>(null)

  // 技能与 MCP Popover 状态与 Refs
  const [showSkillsPopover, setShowSkillsPopover] = useState(false)
  const [showMcpPopover, setShowMcpPopover] = useState(false)
  const skillsPopoverRef = useRef<HTMLDivElement>(null)
  const mcpPopoverRef = useRef<HTMLDivElement>(null)

  // 搜索过滤
  const [skillsSearchKey, setSkillsSearchKey] = useState('')
  const [mcpSearchKey, setMcpSearchKey] = useState('')

  // 列表溢出检测（仅溢出时显示搜索框）
  const skillsListRef = useRef<HTMLDivElement>(null)
  const mcpListRef = useRef<HTMLDivElement>(null)
  const [skillsOverflow, setSkillsOverflow] = useState(false)
  const [mcpOverflow, setMcpOverflow] = useState(false)

  // 检测列表是否溢出
  useEffect(() => {
    if (showSkillsPopover && skillsListRef.current) {
      const el = skillsListRef.current
      setSkillsOverflow(el.scrollHeight > el.clientHeight)
    } else {
      setSkillsSearchKey('')
    }
  }, [showSkillsPopover, skillsList])

  useEffect(() => {
    if (showMcpPopover && mcpListRef.current) {
      const el = mcpListRef.current
      setMcpOverflow(el.scrollHeight > el.clientHeight)
    } else {
      setMcpSearchKey('')
    }
  }, [showMcpPopover, mcpConfig])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showSkillsPopover && skillsPopoverRef.current && !skillsPopoverRef.current.contains(event.target as Node)) {
        // 只有在点击非按钮（或者非 popover 内部）时才关闭，为了保证按钮点击切换正常，我们仅检查 popover 外部
        // 因为点击按钮时如果直接在 handleClickOutside 触发关闭，会和按钮本身的 onClick 冲突（按钮点击 -> handleClickOutside(由于非popover内) -> 关闭 -> 按钮onClick -> 打开。结果又打开了）
        // 实际上, 我们只要判断如果点击的 target 在 Popover 之外，且不在对应的 Button 内部，就将其关闭
        // 更好的办法是：如果点击了 Popover 以外的任何元素，关闭它
        const isClickOnBtn = (event.target as HTMLElement).closest('.toolbar-action-btn-skills')
        if (!isClickOnBtn) {
          setShowSkillsPopover(false)
        }
      }
      if (showMcpPopover && mcpPopoverRef.current && !mcpPopoverRef.current.contains(event.target as Node)) {
        const isClickOnBtn = (event.target as HTMLElement).closest('.toolbar-action-btn-mcp')
        if (!isClickOnBtn) {
          setShowMcpPopover(false)
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSkillsPopover, showMcpPopover])

  // 挂载时刷新技能与 MCP 状态
  useEffect(() => {
    refreshSkillsAndStorage()
    refreshMcpServers()
  }, [])

  // 搜索输入框公共样式
  const searchInputStyle: React.CSSProperties = {
    width: '100%',
    padding: '5px 8px',
    fontSize: '11.5px',
    border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
    borderRadius: '6px',
    background: 'var(--bg-input, rgba(128,128,128,0.04))',
    color: 'var(--text-color)',
    outline: 'none',
    boxSizing: 'border-box'
  }

  // MCP 服务开关切换
  const toggleMcpServerEnable = useCallback((serverId: string) => {
    const newConfig = {
      ...mcpConfig,
      servers: mcpConfig.servers.map((s: any) =>
        s.id === serverId ? { ...s, enabled: !s.enabled } : s
      )
    }
    saveMcpConfig(newConfig)
  }, [mcpConfig, saveMcpConfig])

  // 全部 MCP 服务列表（用于 popover 展示，含未启用的）
  const allMcpServers: any[] = mcpConfig?.servers || []

  const renderSkillsPopover = () => {
    const filtered = skillsSearchKey
      ? skillsList.filter(s => s.name.toLowerCase().includes(skillsSearchKey.toLowerCase()))
      : skillsList
    return (
      <div
        ref={skillsPopoverRef}
        className="chat-popover-card"
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          right: 0,
          width: '260px',
          background: 'var(--bg-card, #ffffff)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
          borderRadius: '10px',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
          zIndex: 1000,
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          animation: 'slideUpMenu 0.15s ease-out'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingBottom: '6px' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-color)' }}>🧩 已装载的技能包</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>勾选在会话中启用</span>
        </div>
        {/* 搜索框：仅在列表溢出时显示 */}
        {skillsOverflow && (
          <input
            style={searchInputStyle}
            placeholder="搜索技能..."
            value={skillsSearchKey}
            onChange={e => setSkillsSearchKey(e.target.value)}
            autoFocus
          />
        )}
        <div
          ref={skillsListRef}
          style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', padding: '2px 0' }}
        >
          {filtered.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              {skillsList.length === 0 ? '暂未安装任何技能扩展包' : '无匹配的技能'}
            </div>
          ) : (
            filtered.map(skill => {
              const isEnabled = !disabledSkillNames.includes(skill.name)
              return (
                <label
                  key={skill.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    fontSize: '12.5px',
                    cursor: 'pointer',
                    padding: '4px 6px',
                    borderRadius: '4px',
                    transition: 'background 0.15s ease',
                    userSelect: 'none'
                  }}
                  onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.04))'}
                  onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: isEnabled ? 'var(--text-color)' : 'var(--text-muted)',
                      fontWeight: isEnabled ? 500 : 400,
                      flex: 1
                    }}
                    title={skill.name}
                  >
                    {skill.name.replace(/\.zip$/i, '')}
                  </span>
                  {/* CSS Toggle Switch */}
                  <div style={{ position: 'relative', width: '28px', height: '16px', borderRadius: '8px', backgroundColor: isEnabled ? 'var(--accent-color, #4f8cff)' : 'var(--border-color, rgba(128,128,128,0.3))', transition: 'background-color 0.2s ease', flexShrink: 0 }}>
                    <div style={{
                      position: 'absolute',
                      top: '2px',
                      left: isEnabled ? '14px' : '2px',
                      width: '12px',
                      height: '12px',
                      backgroundColor: '#ffffff',
                      borderRadius: '50%',
                      transition: 'left 0.2s ease',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                    }} />
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => toggleSkillEnable(skill.name)}
                      style={{ opacity: 0, width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, margin: 0, cursor: 'pointer' }}
                    />
                  </div>
                </label>
              )
            })
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingTop: '6px', marginTop: '4px' }}>
          <button
            style={{
              width: '100%',
              padding: '6px 0',
              fontSize: '11.5px',
              fontWeight: 600,
              color: 'var(--accent-color, #4f8cff)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px'
            }}
            onClick={() => {
              setShowSkillsPopover(false)
              setActiveTab('agent')
              setAgentSubTab('skills')
            }}
          >
            ⚙️ 前往管理技能包
          </button>
        </div>
      </div>
    )
  }

  const renderMcpPopover = () => {
    const filtered = mcpSearchKey
      ? allMcpServers.filter((s: any) => s.name.toLowerCase().includes(mcpSearchKey.toLowerCase()))
      : allMcpServers
    return (
      <div
        ref={mcpPopoverRef}
        className="chat-popover-card"
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          right: 0,
          width: '260px',
          background: 'var(--bg-card, #ffffff)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
          borderRadius: '10px',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
          zIndex: 1000,
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          animation: 'slideUpMenu 0.15s ease-out'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingBottom: '6px' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-color)' }}>🔗 MCP 服务</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>勾选启用服务</span>
        </div>
        {/* 搜索框：仅在列表溢出时显示 */}
        {mcpOverflow && (
          <input
            style={searchInputStyle}
            placeholder="搜索 MCP 服务..."
            value={mcpSearchKey}
            onChange={e => setMcpSearchKey(e.target.value)}
            autoFocus
          />
        )}
        <div
          ref={mcpListRef}
          style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', padding: '2px 0' }}
        >
          {filtered.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              {allMcpServers.length === 0 ? '暂未配置任何 MCP 服务' : '无匹配的 MCP 服务'}
            </div>
          ) : (
            filtered.map((server: any) => (
              <label
                key={server.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  fontSize: '12.5px',
                  cursor: 'pointer',
                  padding: '4px 6px',
                  borderRadius: '4px',
                  transition: 'background 0.15s ease',
                  userSelect: 'none'
                }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.04))'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: server.enabled ? 'var(--text-color)' : 'var(--text-muted)',
                    fontWeight: server.enabled ? 500 : 400,
                    flex: 1
                  }}
                  title={server.name}
                >
                  {server.name}
                </span>
                {/* CSS Toggle Switch */}
                <div style={{ position: 'relative', width: '28px', height: '16px', borderRadius: '8px', backgroundColor: server.enabled ? 'var(--accent-color, #4f8cff)' : 'var(--border-color, rgba(128,128,128,0.3))', transition: 'background-color 0.2s ease', flexShrink: 0 }}>
                  <div style={{
                    position: 'absolute',
                    top: '2px',
                    left: server.enabled ? '14px' : '2px',
                    width: '12px',
                    height: '12px',
                    backgroundColor: '#ffffff',
                    borderRadius: '50%',
                    transition: 'left 0.2s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                  }} />
                  <input
                    type="checkbox"
                    checked={!!server.enabled}
                    onChange={() => toggleMcpServerEnable(server.id)}
                    style={{ opacity: 0, width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, margin: 0, cursor: 'pointer' }}
                  />
                </div>
              </label>
            ))
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border-color, rgba(128,128,128,0.12))', paddingTop: '6px', marginTop: '4px' }}>
          <button
            style={{
              width: '100%',
              padding: '6px 0',
              fontSize: '11.5px',
              fontWeight: 600,
              color: 'var(--accent-color, #4f8cff)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px'
            }}
            onClick={() => {
              setShowMcpPopover(false)
              setActiveTab('agent')
              setAgentSubTab('mcp')
            }}
          >
            ⚙️ 前往管理 MCP 服务
          </button>
        </div>
      </div>
    )
  }


  // 上下文安全额度环机制
  const [showContextTooltip, setShowContextTooltip] = useState(false)
  const contextLimit = 168000

  const currentContextTokens = useMemo(() => {
    let total = 0
    if (activeSessMessages) {
      for (const msg of activeSessMessages) {
        if (msg.sender === 'user' || msg.sender === 'agent') {
          let text = msg.text || ''
          if (msg.fileInfo && msg.fileInfo.content) {
            text += '\n' + msg.fileInfo.content
          } else if (msg.fileInfos) {
            for (const f of msg.fileInfos) {
              if (f.content) text += '\n' + f.content
            }
          }
          total += Math.max(1, Math.round(text.length * 0.5))
        }
      }
    }
    // 加入人设及系统开销预估
    total += 1500
    return total
  }, [activeSessMessages])

  const contextPercent = useMemo(() => {
    return Math.min(100, (currentContextTokens / contextLimit) * 100)
  }, [currentContextTokens])

  const handleSendIntercept = () => {
    if (currentContextTokens >= contextLimit) {
      showToast('⚠️ 上下文额度已用满，请创建新会话以继续对话！', 'error')
      return
    }
    handleSendChat()
  }

  // SSH 弹窗控制本地状态
  const [showSshModal, setShowSshModal] = useState(false)
  const [sshForm, setSshForm] = useState(() => {
    try {
      const saved = localStorage.getItem('agentpet_last_ssh_config')
      if (saved) {
        return JSON.parse(saved)
      }
    } catch (e) {
      console.error('加载缓存的 SSH 配置失败', e)
    }
    return {
      host: '',
      port: '22',
      username: 'root',
      password: '',
      authType: 'password', // 'password' | 'privateKey'
      privateKey: ''
    }
  })
  const [testSshStatus, setTestSshStatus] = useState<{ type: 'idle' | 'testing' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' })
  const [connectSshLoading, setConnectSshLoading] = useState(false)

  // 设备下拉菜单控制状态与 Ref
  const [showDeviceMenu, setShowDeviceMenu] = useState(false)
  const deviceMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(event.target as Node)) {
        setShowDeviceMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const getMenuItemStyle = (isActive: boolean) => ({
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: '12.5px',
    display: 'flex',
    alignItems: 'center',
    backgroundColor: 'transparent',
    color: isActive ? 'var(--accent-color, #4f8cff)' : 'var(--text-color)',
    fontWeight: isActive ? 600 : 400,
    transition: 'background 0.15s ease',
    userSelect: 'none' as const
  })

  const handleMenuItemMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.06))'
  }

  const handleMenuItemMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.backgroundColor = 'transparent'
  }

  // 检测是否在底部附近（阈值 100px）
  const checkScrollPosition = useCallback(() => {
    const el = messagesBoxRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollToBottom(distanceToBottom > 100)
  }, [])

  // 绑定滚动事件
  useEffect(() => {
    const el = messagesBoxRef.current
    if (!el) return
    el.addEventListener('scroll', checkScrollPosition, { passive: true })
    checkScrollPosition()
    return () => el.removeEventListener('scroll', checkScrollPosition)
  }, [checkScrollPosition])

  // 切换会话时重置滚动状态，避免"回到最新"按钮残留
  useEffect(() => {
    setShowScrollToBottom(false)
    // 会话切换后重新检测滚动位置
    requestAnimationFrame(() => checkScrollPosition())
  }, [activeSessionId, checkScrollPosition])

  // 仅在新消息条数增加时（用户发送 / agent 新消息出现），滚动到底部
  // 流式输出、工具步骤、isThinking 变化不触发此逻辑，避免打断用户翻看历史
  useEffect(() => {
    const el = messagesBoxRef.current
    if (el) {
      const timer = setTimeout(() => {
        el.scrollTop = el.scrollHeight
      }, 50)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [activeSessMessages.length])

  const scrollToBottom = () => {
    const el = messagesBoxRef.current
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }

  const handleImageContextMenu = (e: React.MouseEvent, imgSrc: string) => {
    e.preventDefault()
    if (window.api && typeof window.api.showImageContextMenu === 'function') {
      window.api.showImageContextMenu(imgSrc)
    }
  }

  // 监听定位跳转事件，平滑滚动并高亮消息
  useEffect(() => {
    if (highlightedMessageId) {
      const timer = setTimeout(() => {
        const element = document.getElementById(`msg-${highlightedMessageId}`)
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
          // 闪烁 2.5 秒后清除高亮标记
          setTimeout(() => {
            setHighlightedMessageId(null)
          }, 2500)
        }
      }, 150)
      return () => clearTimeout(timer)
    }
    return () => { }
  }, [highlightedMessageId, setHighlightedMessageId])

  useEffect(() => {
    // 全局阻止浏览器默认的拖拽打开文件行为，防止不小心把文件拖到页面空白处导致应用跳转
    const preventDefault = (e: any) => e.preventDefault()
    window.addEventListener('dragover', preventDefault)
    window.addEventListener('drop', preventDefault)
    return () => {
      window.removeEventListener('dragover', preventDefault)
      window.removeEventListener('drop', preventDefault)
    }
  }, [])

  return (
    <div className="chat-split-container">
      <div
        className="chat-main"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1 }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handlePasteFiles(e.dataTransfer.files)
          }
        }}
      >
        {/* 消息滚动列表 */}
        {/* 消息滚动列表 */}
        <div className="chat-messages-box" ref={messagesBoxRef}>
          {isSessionSwitching ? (
            <div className="chat-skeleton-container">
              <div className="skeleton-message agent">
                <div className="skeleton-header">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-name"></div>
                </div>
                <div className="skeleton-bubble long"></div>
              </div>
              <div className="skeleton-message user">
                <div className="skeleton-header">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-name"></div>
                </div>
                <div className="skeleton-bubble short"></div>
              </div>
              <div className="skeleton-message agent">
                <div className="skeleton-header">
                  <div className="skeleton-avatar"></div>
                  <div className="skeleton-name"></div>
                </div>
                <div className="skeleton-bubble medium"></div>
              </div>
            </div>
          ) : activeSessMessages.length === 0 ? (
            <div className="chat-empty-state">
              <h1 className="chat-empty-title">{currentAvatarName}, 我帮你</h1>
              <div className="chat-empty-suggestions">
                <div className="suggestion-chip" onClick={() => store.setInputValue('帮我处理一下这份文档的内容，提取关键信息')}>
                  <span className="chip-icon">📄</span>文档处理
                </div>
                <div className="suggestion-chip" onClick={() => store.setInputValue('帮我分析这组数据并生成一份可视化报告')}>
                  <span className="chip-icon">📊</span>数据分析与可视化
                </div>
                <div className="suggestion-chip" onClick={() => store.setInputValue('请为我构思一个独特的UI设计方案')}>
                  <span className="chip-icon">🎨</span>设计创意
                </div>
                <div className="suggestion-chip" onClick={() => store.setInputValue('用最佳实践编写这段代码功能')}>
                  <span className="chip-icon">💻</span>代码开发
                </div>
              </div>
            </div>
          ) : (
            <>
              {activeSessMessages.map(msg => (
                <ChatMessageItem
                  key={msg.id}
                  msg={msg}
                  currentAvatarName={currentAvatarName}
                  highlightedMessageId={highlightedMessageId}
                />
              ))}
              <div ref={chatEndRef} />
            </>
          )}
          {showScrollToBottom && (
            <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title="回到最新">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              回到最新
            </button>
          )}
        </div>

        {/* 附件在输入框上方的实时预览 */}
        {attachedFiles && attachedFiles.length > 0 && (
          <div className="input-files-preview-container" style={{ display: 'flex', gap: '8px', padding: '0 16px 8px', flexWrap: 'wrap', overflowX: 'auto' }}>
            {attachedFiles.map((file, idx) => (
              <div key={idx} className="input-file-preview" style={{ margin: 0, position: 'relative', display: 'flex', alignItems: 'center', backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '6px 12px' }}>
                {file.objectUrl ? (
                  <img
                    src={file.objectUrl}
                    alt={file.name}
                    style={{ width: '24px', height: '24px', objectFit: 'cover', borderRadius: '4px', marginRight: '8px', cursor: 'pointer' }}
                    onClick={() => setPreviewImageSrc(file.objectUrl || null)}
                  />
                ) : (
                  <span className="preview-icon" style={{ marginRight: '6px' }}>📄</span>
                )}
                <span className="preview-name" title={file.name} style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }}>{file.name}</span>
                <button className="preview-remove-btn" onClick={() => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))} title="移除文件" style={{ marginLeft: '8px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: '2px' }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* 人机协作安全核对面板 */}
        {activePermissionRequest && (
          <div className="permission-approval-card" style={{
            margin: '0 16px 12px 16px',
            background: 'var(--bg-card, #ffffff)',
            border: '1.5px solid var(--border-color, rgba(128,128,128,0.25))',
            borderRadius: '12px',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'slideUpMenu 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }}>
            {/* 头部标题区域 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 16px',
              borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.12))',
              backgroundColor: 'var(--bg-card-sub, rgba(128,128,128,0.03))'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', fontWeight: 700, color: 'var(--text-color)' }}>
                <span>🛡️ 问题</span>
              </div>
              <span className="approval-status-pulse" style={{ fontSize: '12px', color: 'var(--accent-color, #4f8cff)', fontWeight: 600 }}>
                等待核对审批...
              </span>
            </div>

            {/* 内容区域 */}
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: '13px', lineHeight: 1.5, color: 'var(--text-color)' }}>
                {(activePermissionRequest as any).warning ? (
                  <div style={{ color: '#ef4444', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                    <span style={{ transform: 'translateY(1px)' }}>⚠️</span>
                    <span>{(activePermissionRequest as any).warning}</span>
                  </div>
                ) : (
                  <div style={{ color: '#ef4444', fontWeight: 600, marginBottom: '8px' }}>
                    ⚠️ 检测到文件删除等敏感指令，系统默认不授予自动执行权限：
                  </div>
                )}

                <div style={{
                  background: 'var(--bg-card-sub, rgba(128,128,128,0.04))',
                  padding: '12px 14px',
                  borderRadius: '8px',
                  border: '1px dashed var(--border-color, rgba(128,128,128,0.25))',
                  fontFamily: 'Consolas, Monaco, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontSize: '12.5px',
                  color: 'var(--text-color-strong)'
                }}>
                  {activePermissionRequest.command || '内置 API: delete_file'}
                </div>

                {activePermissionRequest.execCwd && (
                  <div style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>📁 执行路径:</span>
                    <span style={{ fontFamily: 'monospace' }}>{activePermissionRequest.execCwd}</span>
                  </div>
                )}
              </div>

              {/* 选项卡片 (类似用户截图中的 A、B 选项) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div
                  onClick={() => handleRespondPermission(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color, rgba(128,128,128,0.15))',
                    background: 'var(--bg-card-sub, rgba(128,128,128,0.03))',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    fontSize: '13px',
                    fontWeight: 500,
                    userSelect: 'none'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#10b981'
                    e.currentTarget.style.backgroundColor = 'rgba(16,185,129,0.05)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--border-color, rgba(128,128,128,0.15))'
                    e.currentTarget.style.backgroundColor = 'var(--bg-card-sub, rgba(128,128,128,0.03))'
                  }}
                >
                  <div style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '4px',
                    border: '1px solid #10b981',
                    color: '#10b981',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    marginRight: '12px',
                    backgroundColor: 'rgba(16,185,129,0.08)'
                  }}>A</div>
                  <span style={{ color: 'var(--text-color)', fontWeight: 600 }}>确认允许执行</span>
                  <span style={{ marginLeft: 'auto', color: '#10b981', fontWeight: 'bold', fontSize: '14px' }}>&gt;</span>
                </div>

                <div
                  onClick={() => handleRespondPermission(false)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color, rgba(128,128,128,0.15))',
                    background: 'var(--bg-card-sub, rgba(128,128,128,0.03))',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    fontSize: '13px',
                    fontWeight: 500,
                    userSelect: 'none'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#ef4444'
                    e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.05)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--border-color, rgba(128,128,128,0.15))'
                    e.currentTarget.style.backgroundColor = 'var(--bg-card-sub, rgba(128,128,128,0.03))'
                  }}
                >
                  <div style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: '4px',
                    border: '1px solid #ef4444',
                    color: '#ef4444',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    marginRight: '12px',
                    backgroundColor: 'rgba(239,68,68,0.08)'
                  }}>B</div>
                  <span style={{ color: '#ef4444', fontWeight: 600 }}>取消并拦截</span>
                  <span style={{ marginLeft: 'auto', color: '#ef4444', fontWeight: 'bold', fontSize: '14px' }}>&gt;</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 现代卡片式输入控制面板 */}
        <div className="chat-control-card">
          <textarea
            className="chat-textarea-field"
            rows={2}
            placeholder={
              currentContextTokens >= contextLimit
                ? '⚠️ 上下文额度已用满，请创建新会话以继续对话！'
                : isSending
                  ? `${currentAvatarName} 正在思考中...`
                  : `输入指令并发送给 ${currentAvatarName} ...`
            }
            value={inputValue}
            disabled={isSending || currentContextTokens >= contextLimit}
            onChange={e => setInputValue(e.target.value)}
            onPaste={async e => {
              // 优先检查内部剪贴板（从消息复制的文件+文本）
              const internalClip = getInternalClipboard()
              if (internalClip && internalClip.files.length > 0) {
                e.preventDefault()
                setInternalClipboard(null)
                // 将内部剪贴板文件转为附件（复制到当前会话目录确保路径有效）
                const newAttachments = await Promise.all(internalClip.files.map(async f => {
                  const ext = f.name.split('.').pop()?.toLowerCase() || ''
                  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']
                  const isImage = imageExts.includes(ext)
                  // 将文件复制到当前会话目录，确保路径有效
                  let filePath = f.path
                  if (window.api.copyToChatFile) {
                    const result = await window.api.copyToChatFile(activeSessionId, f.path)
                    filePath = result.path
                  }
                  // 如果没有预加载内容，尝试解析文件内容
                  let content = f.content
                  if (!content && filePath) {
                    try {
                      content = await window.api.parseFileContent(filePath)
                    } catch { /* 忽略解析失败 */ }
                  }
                  return {
                    name: f.name,
                    path: filePath,
                    content,
                    objectUrl: isImage ? `local-file:///${filePath.replace(/\\/g, '/')}` : undefined
                  }
                }))
                setAttachedFiles(prev => [...prev, ...newAttachments])
                // 同时插入文本到输入框
                if (internalClip.text) {
                  setInputValue(prev => prev ? prev + internalClip.text : internalClip.text)
                }
                return
              }
              // 系统剪贴板文件（图片等）
              if (e.clipboardData.files && e.clipboardData.files.length > 0) {
                e.preventDefault()
                handlePasteFiles(e.clipboardData.files)
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSendIntercept()
              }
            }}
          />

          <div className="chat-control-toolbar">
            {/* 左侧：模型切换 */}
            <div className="toolbar-group-left" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <div className="model-dropdown-container">
                <span className="toolbar-lbl-icon">🤖</span>
                <select
                  className="model-select-inline"
                  value={llmConfig.model}
                  onChange={e => saveLlmConfig({ ...llmConfig, model: e.target.value })}
                  disabled={isSending}
                >
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {!availableModels.includes(llmConfig.model) && llmConfig.model && (
                    <option value={llmConfig.model}>{llmConfig.model} (自定义)</option>
                  )}
                  {availableModels.length === 0 && !llmConfig.model && (
                    <option value="">未加载模型</option>
                  )}
                </select>
              </div>

              {/* 执行设备选择 */}
              <div className="custom-device-select-container" style={{ position: 'relative' }} ref={deviceMenuRef}>
                <div
                  className="custom-device-trigger"
                  onClick={() => { if (!isSending) setShowDeviceMenu(!showDeviceMenu) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: 'var(--bg-card-sub, rgba(128,128,128,0.05))',
                    border: '1px solid var(--border-color, rgba(128,128,128,0.15))',
                    borderRadius: '6px',
                    padding: '0 8px',
                    fontSize: '12.5px',
                    height: '30px',
                    boxSizing: 'border-box',
                    cursor: isSending ? 'not-allowed' : 'pointer',
                    userSelect: 'none',
                    color: 'var(--text-color)',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={e => { if (!isSending) e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.06))' }}
                  onMouseLeave={e => { if (!isSending) e.currentTarget.style.backgroundColor = 'transparent' }}
                >
                  <span style={{ fontSize: '13px', display: 'flex', alignItems: 'center' }}>
                    {executionDevice === 'ssh' ? '🌐' : '💻'}
                  </span>
                  <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }}>
                    {executionDevice === 'ssh' && sshConnected ? `SSH: ${sshUsername}@${sshHost}` : '本机执行'}
                  </span>
                  <svg
                    width="10"
                    height="6"
                    viewBox="0 0 10 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      transform: showDeviceMenu ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.15s ease',
                      opacity: 0.7,
                      marginLeft: '2px'
                    }}
                  >
                    <path d="M1 1l4 4 4-4" />
                  </svg>
                </div>

                {showDeviceMenu && (
                  <div
                    className="custom-device-menu"
                    style={{
                      position: 'absolute',
                      bottom: 'calc(100% + 6px)',
                      left: 0,
                      background: 'var(--bg-card, #ffffff)',
                      border: '1px solid var(--border-color, rgba(128,128,128,0.18))',
                      borderRadius: '8px',
                      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
                      zIndex: 999,
                      minWidth: '180px',
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden',
                      padding: '4px 0',
                      animation: 'slideUpMenu 0.15s ease-out'
                    }}
                  >
                    <div
                      className={`device-menu-item ${executionDevice === 'local' ? 'active' : ''}`}
                      onClick={async () => {
                        await handleUpdateExecutionDevice('local')
                        setShowDeviceMenu(false)
                      }}
                      style={getMenuItemStyle(executionDevice === 'local')}
                      onMouseEnter={handleMenuItemMouseEnter}
                      onMouseLeave={handleMenuItemMouseLeave}
                    >
                      <span style={{ marginRight: '8px' }}>💻</span>
                      <span>本机执行</span>
                      {executionDevice === 'local' && <span style={{ marginLeft: 'auto', color: 'var(--accent-color, #4f8cff)', fontWeight: 'bold' }}>✓</span>}
                    </div>

                    {sshConnected ? (
                      <div
                        className={`device-menu-item ${executionDevice === 'ssh' ? 'active' : ''}`}
                        onClick={async () => {
                          await handleUpdateExecutionDevice('ssh')
                          setShowDeviceMenu(false)
                        }}
                        style={getMenuItemStyle(executionDevice === 'ssh')}
                        onMouseEnter={handleMenuItemMouseEnter}
                        onMouseLeave={handleMenuItemMouseLeave}
                      >
                        <span style={{ marginRight: '8px' }}>🌐</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '110px' }} title={`${sshUsername}@${sshHost}`}>
                          SSH: {sshUsername}@${sshHost}
                        </span>
                        {executionDevice === 'ssh' && <span style={{ marginLeft: 'auto', color: 'var(--accent-color, #4f8cff)', fontWeight: 'bold' }}>✓</span>}
                      </div>
                    ) : null}

                    <div
                      className="device-menu-item"
                      onClick={() => {
                        setShowSshModal(true)
                        setShowDeviceMenu(false)
                      }}
                      style={getMenuItemStyle(false)}
                      onMouseEnter={handleMenuItemMouseEnter}
                      onMouseLeave={handleMenuItemMouseLeave}
                    >
                      <span style={{ marginRight: '8px' }}>⚙️</span>
                      <span>{sshConnected ? '配置其它 SSH...' : '配置远程 SSH...'}</span>
                    </div>

                    {sshConnected && (
                      <>
                        <div style={{ height: '1px', background: 'var(--border-color, rgba(128,128,128,0.12))', margin: '4px 0' }} />
                        <div
                          className="device-menu-item disconnect"
                          onClick={async () => {
                            if (confirm('确认断开当前 SSH 连接并切换回本机执行吗？')) {
                              await handleDisconnectSsh()
                            }
                            setShowDeviceMenu(false)
                          }}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                            color: '#ef4444',
                            fontWeight: 500,
                            transition: 'background 0.15s ease'
                          }}
                          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.06))'}
                          onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          <span style={{ marginRight: '8px' }}>🔌</span>
                          <span>断开连接</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 右侧：文件上传与发送按钮 */}
            <div className="toolbar-group-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* SVG 额度环 */}
              <div
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  width: '22px',
                  height: '22px'
                }}
                onMouseEnter={() => setShowContextTooltip(true)}
                onMouseLeave={() => setShowContextTooltip(false)}
              >
                <svg width="22" height="22" viewBox="0 0 36 36">
                  <circle
                    cx="18"
                    cy="18"
                    r="15.9155"
                    fill="none"
                    stroke="var(--bg-menu-hover, rgba(128,128,128,0.12))"
                    strokeWidth="3.5"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r="15.9155"
                    fill="none"
                    stroke={contextPercent >= 100 ? '#ef4444' : contextPercent > 75 ? '#f59e0b' : '#3b82f6'}
                    strokeWidth="3.5"
                    strokeDasharray={`${contextPercent} ${100 - contextPercent}`}
                    strokeDashoffset="25"
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 0.35s ease' }}
                  />
                </svg>

                {showContextTooltip && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 'calc(100% + 10px)',
                      right: '-30px',
                      backgroundColor: 'var(--bg-card, #ffffff)',
                      border: '1.5px solid var(--border-color, rgba(128,128,128,0.25))',
                      borderRadius: '8px',
                      padding: '6px 12px',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--text-color, #1e293b)',
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                      whiteSpace: 'nowrap',
                      zIndex: 1000,
                      animation: 'slideUpMenu 0.15s ease-out'
                    }}
                  >
                    {`${contextPercent.toFixed(1)}% · ${(currentContextTokens / 1000).toFixed(1)}K / ${(contextLimit / 1000).toFixed(0)}K 上下文已使用`}
                  </div>
                )}
              </div>

              {/* 🧩 技能快捷开关按钮与 Popover */}
              <div style={{ position: 'relative' }}>
                <div
                  className="toolbar-action-btn-skills"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '0 10px',
                    height: '30px',
                    fontSize: '12px',
                    fontWeight: 600,
                    borderRadius: '6px',
                    border: '1.5px dashed var(--border-color, rgba(128,128,128,0.25))',
                    backgroundColor: showSkillsPopover ? 'var(--bg-menu-hover, rgba(128,128,128,0.08))' : 'transparent',
                    cursor: 'pointer',
                    color: 'var(--text-color)',
                    userSelect: 'none',
                    transition: 'all 0.15s ease'
                  }}
                  onClick={() => {
                    const next = !showSkillsPopover
                    setShowSkillsPopover(next)
                    setShowMcpPopover(false)
                    if (next) {
                      refreshSkillsAndStorage()
                    }
                  }}
                  onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.06))'}
                  onMouseLeave={e => {
                    if (!showSkillsPopover) e.currentTarget.style.backgroundColor = 'transparent'
                  }}
                  title="点击管理与勾选启用技能扩展包"
                >
                  <span>🧩</span>
                  <span>
                    技能 ({skillsList.filter(s => !disabledSkillNames.includes(s.name)).length}/{skillsList.length})
                  </span>
                </div>
                {showSkillsPopover && renderSkillsPopover()}
              </div>

              {/* 🔗 MCP 快捷查看按钮与 Popover */}
              <div style={{ position: 'relative' }}>
                <div
                  className="toolbar-action-btn-mcp"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '0 10px',
                    height: '30px',
                    fontSize: '12px',
                    fontWeight: 600,
                    borderRadius: '6px',
                    border: '1.5px dashed var(--border-color, rgba(128,128,128,0.25))',
                    backgroundColor: showMcpPopover ? 'var(--bg-menu-hover, rgba(128,128,128,0.08))' : 'transparent',
                    cursor: 'pointer',
                    color: 'var(--text-color)',
                    userSelect: 'none',
                    transition: 'all 0.15s ease'
                  }}
                  onClick={() => {
                    const next = !showMcpPopover
                    setShowMcpPopover(next)
                    setShowSkillsPopover(false)
                    if (next) {
                      refreshMcpServers()
                    }
                  }}
                  onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-menu-hover, rgba(128,128,128,0.06))'}
                  onMouseLeave={e => {
                    if (!showMcpPopover) e.currentTarget.style.backgroundColor = 'transparent'
                  }}
                  title="点击管理与勾选启用 MCP 服务"
                >
                  <span>🔗</span>
                  <span>
                    MCP ({allMcpServers.filter((s: any) => s.enabled).length}/{allMcpServers.length})
                  </span>
                </div>
                {showMcpPopover && renderMcpPopover()}
              </div>

              <button
                className="toolbar-action-btn upload"
                onClick={handleUploadFile}
                disabled={isSending || currentContextTokens >= contextLimit}
                title={currentContextTokens >= contextLimit ? '上下文额度已用满' : '上传文本文件以分析'}
              >
                ➕ 上传文件
              </button>

              {isSending ? (
                <button
                  className="toolbar-send-btn stop"
                  onClick={handleAbortLlm}
                  title="停止生成"
                  style={{ background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)', boxShadow: '0 2px 8px rgba(239, 68, 68, 0.2)' }}
                >
                  停止
                </button>
              ) : (
                <button
                  className="toolbar-send-btn"
                  onClick={handleSendIntercept}
                  disabled={(!inputValue.trim() && attachedFiles.length === 0) || currentContextTokens >= contextLimit}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {previewImageSrc && (
        <div
          className="fullscreen-image-preview"
          style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
          onClick={() => setPreviewImageSrc(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            handleImageContextMenu(e, previewImageSrc)
          }}
        >
          <img src={previewImageSrc} style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
        </div>
      )}

      {showSshModal && (
        <div className="ssh-modal-overlay" style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => { setShowSshModal(false); setTestSshStatus({ type: 'idle', message: '' }) }}>
          <div className="ssh-modal-card" style={{
            width: '420px', background: 'var(--bg-card, #ffffff)', border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
            borderRadius: '16px', boxShadow: '0 12px 40px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column',
            overflow: 'hidden', padding: '24px'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-color)' }}>🌐 远程 SSH 连接配置</span>
              <button disabled={connectSshLoading} onClick={() => { setShowSshModal(false); setTestSshStatus({ type: 'idle', message: '' }) }} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ flex: 2 }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>主机地址 (Host)</label>
                  <input type="text" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="192.168.1.100" value={sshForm.host} onChange={e => setSshForm(prev => ({ ...prev, host: e.target.value }))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>端口 (Port)</label>
                  <input type="number" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="22" value={sshForm.port} onChange={e => setSshForm(prev => ({ ...prev, port: e.target.value }))} />
                </div>
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>用户名 (Username)</label>
                <input type="text" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="root" value={sshForm.username} onChange={e => setSshForm(prev => ({ ...prev, username: e.target.value }))} />
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>认证方式</label>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button type="button" onClick={() => setSshForm(prev => ({ ...prev, authType: 'password' }))} style={{ flex: 1, padding: '8px', borderRadius: '6px', border: sshForm.authType === 'password' ? '1.5px solid var(--accent-color, #4f8cff)' : '1px solid var(--border-color, rgba(128,128,128,0.2))', background: sshForm.authType === 'password' ? 'rgba(79,140,255,0.08)' : 'transparent', color: sshForm.authType === 'password' ? 'var(--accent-color, #4f8cff)' : 'var(--text-muted)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>🔑 密码认证</button>
                  <button type="button" onClick={() => setSshForm(prev => ({ ...prev, authType: 'privateKey' }))} style={{ flex: 1, padding: '8px', borderRadius: '6px', border: sshForm.authType === 'privateKey' ? '1.5px solid var(--accent-color, #4f8cff)' : '1px solid var(--border-color, rgba(128,128,128,0.2))', background: sshForm.authType === 'privateKey' ? 'rgba(79,140,255,0.08)' : 'transparent', color: sshForm.authType === 'privateKey' ? 'var(--accent-color, #4f8cff)' : 'var(--text-muted)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>📝 私钥认证</button>
                </div>
              </div>

              {sshForm.authType === 'password' ? (
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>密码 (Password)</label>
                  <input type="password" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }} placeholder="输入连接密码" value={sshForm.password} onChange={e => setSshForm(prev => ({ ...prev, password: e.target.value }))} />
                </div>
              ) : (
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>PEM 私钥内容 (Private Key)</label>
                  <textarea rows={4} className="form-input" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '11px', resize: 'vertical' }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." value={sshForm.privateKey} onChange={e => setSshForm(prev => ({ ...prev, privateKey: e.target.value }))} />
                </div>
              )}
            </div>

            {testSshStatus.type !== 'idle' && (
              <div style={{
                fontSize: '12.5px', padding: '10px 12px', borderRadius: '8px', marginTop: '14px',
                color: testSshStatus.type === 'success' ? '#10b981' : testSshStatus.type === 'testing' ? '#6b7280' : '#ef4444',
                background: testSshStatus.type === 'success' ? 'rgba(16,185,129,0.06)' : testSshStatus.type === 'testing' ? 'rgba(107,114,128,0.06)' : 'rgba(239,68,68,0.06)',
                border: `1px solid ${testSshStatus.type === 'success' ? 'rgba(16,185,129,0.2)' : testSshStatus.type === 'testing' ? 'rgba(107,114,128,0.2)' : 'rgba(239,68,68,0.2)'}`
              }}>
                {testSshStatus.message}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '20px' }}>
              <button
                disabled={connectSshLoading || testSshStatus.type === 'testing'}
                onClick={async () => {
                  if (!sshForm.host.trim() || !sshForm.username.trim()) {
                    setTestSshStatus({ type: 'error', message: '主机和用户名不能为空' })
                    return
                  }
                  setTestSshStatus({ type: 'testing', message: '🔌 正在测试 SSH 连接...' })
                  try {
                    const res = await window.api.testSshConnection({
                      host: sshForm.host.trim(),
                      port: parseInt(sshForm.port) || 22,
                      username: sshForm.username.trim(),
                      password: sshForm.password || undefined,
                      privateKey: sshForm.privateKey || undefined
                    })
                    if (res.success) {
                      setTestSshStatus({ type: 'success', message: '✅ 连接测试成功！' })
                    } else {
                      setTestSshStatus({ type: 'error', message: `❌ 测试失败: ${res.message || '未知错误'}` })
                    }
                  } catch (e: any) {
                    setTestSshStatus({ type: 'error', message: `❌ 异常: ${e.message || String(e)}` })
                  }
                }}
                className="btn-secondary"
                style={{ fontSize: '13px', padding: '6px 14px', borderRadius: '6px' }}
              >
                测试连接
              </button>
              <button
                disabled={connectSshLoading || testSshStatus.type === 'testing'}
                onClick={async () => {
                  if (!sshForm.host.trim() || !sshForm.username.trim()) {
                    setTestSshStatus({ type: 'error', message: '主机和用户名不能为空' })
                    return
                  }
                  setConnectSshLoading(true)
                  setTestSshStatus({ type: 'testing', message: '🔌 正在建立 SSH 连接...' })
                  try {
                    const res = await handleConnectSsh({
                      host: sshForm.host.trim(),
                      port: parseInt(sshForm.port) || 22,
                      username: sshForm.username.trim(),
                      password: sshForm.password || undefined,
                      privateKey: sshForm.privateKey || undefined
                    })
                    if (res.success) {
                      localStorage.setItem('agentpet_last_ssh_config', JSON.stringify(sshForm))
                      showToast('🌐 成功连接远程服务器，已启用 SSH 执行！', 'success')
                      setShowSshModal(false)
                      setTestSshStatus({ type: 'idle', message: '' })
                    } else {
                      setTestSshStatus({ type: 'error', message: `❌ 连接失败: ${res.message || '连接超时'}` })
                    }
                  } catch (e: any) {
                    setTestSshStatus({ type: 'error', message: `❌ 异常: ${e.message || String(e)}` })
                  } finally {
                    setConnectSshLoading(false)
                  }
                }}
                className="btn-primary"
                style={{ fontSize: '13px', padding: '6px 14px', borderRadius: '6px' }}
              >
                {connectSshLoading ? '连接中...' : '连接并激活'}
              </button>
            </div>
          </div>
        </div>
      )}
      <style>{`
        @keyframes slideUpMenu {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .approval-status-pulse {
          animation: pulseGlow 2s infinite ease-in-out;
        }
        @keyframes pulseGlow {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

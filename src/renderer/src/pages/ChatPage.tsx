import React, { useState, useEffect, useRef, useCallback } from 'react'
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
    handleRespondPermission
  } = store

  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const messagesBoxRef = useRef<HTMLDivElement>(null)

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

  // 新消息到来时，如果已在底部则保持在底部
  useEffect(() => {
    if (!showScrollToBottom) {
      const el = messagesBoxRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
      }
    }
  }, [activeSessMessages.length, showScrollToBottom])

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
            placeholder={isSending ? `${currentAvatarName} 正在思考中...` : `输入指令并发送给 ${currentAvatarName} ...`}
            value={inputValue}
            disabled={isSending}
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
                handleSendChat()
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
            <div className="toolbar-group-right">
              <button
                className="toolbar-action-btn upload"
                onClick={handleUploadFile}
                disabled={isSending}
                title="上传文本文件以分析"
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
                  onClick={handleSendChat}
                  disabled={!inputValue.trim() && attachedFiles.length === 0}
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

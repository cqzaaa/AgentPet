import React, { useState, useRef, useEffect } from 'react'
import { useAppStore } from '../hooks/useAppStore'
import { ChatPage } from '../pages/ChatPage'
import { ControlPage } from '../pages/ControlPage'
import { AgentPage } from '../pages/AgentPage'
import { SettingsPage } from '../pages/SettingsPage'
import { OverviewIcon, SkillsIcon, SettingsIcon } from './icons/Icons'
import { LogsPage } from '../pages/LogsPage'
import iconFromImage from '../assets/icon.png'
import { RecentSessionList } from './RecentSessionList'

function LogsIcon(): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )
}

function HistoryListIcon(): React.JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="8" y1="6" x2="21" y2="6"></line>
      <line x1="8" y1="12" x2="21" y2="12"></line>
      <line x1="8" y1="18" x2="21" y2="18"></line>
      <line x1="3" y1="6" x2="3.01" y2="6"></line>
      <line x1="3" y1="12" x2="3.01" y2="12"></line>
      <line x1="3" y1="18" x2="3.01" y2="18"></line>
    </svg>
  )
}

const checkIsThinking = (s: any): boolean => {
  if (!s || !s.messages) return false
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (m.sender === 'agent') return !!m.isThinking
  }
  return false
}

export function AgentWindow(): React.JSX.Element {
  const store = useAppStore()

  const {
    theme, handleThemeToggle,
    isCollapsed, setIsCollapsed,
    activeTab, setActiveTab,
    setSettingsSubTab,
    showApiKeyModal, setShowApiKeyModal,
    sessions, activeSessionId, setActiveSessionId,
    handleCreateNewSession, handleDeleteSession, handleTogglePinSession, handleRenameSession,
    customModelFile,
    skillsList, contextRounds,
    toast,
    // sandbox
    activePermissionRequest,
    activeSessMessages,
    setHighlightedMessageId
  } = store

  const currentAvatarName = customModelFile ? customModelFile.replace(/\.model3\.json$/i, '') : 'Mao'

  // ── 标签页与窗口控制状态及逻辑 ──
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([])
  const [sessionToDeleteId, setSessionToDeleteId] = useState<string | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)

  const checkMaximized = async () => {
    if (window.api?.isAgentWindowMaximized) {
      const max = await window.api.isAgentWindowMaximized()
      setIsMaximized(max)
    }
  }

  useEffect(() => {
    checkMaximized()
    window.addEventListener('resize', checkMaximized)
    return () => window.removeEventListener('resize', checkMaximized)
  }, [])

  useEffect(() => {
    if (activeSessionId && !openSessionIds.includes(activeSessionId)) {
      setOpenSessionIds(prev => [...prev, activeSessionId])
    }
  }, [activeSessionId])

  useEffect(() => {
    const validIds = sessions.map(s => s.id)
    setOpenSessionIds(prev => prev.filter(id => validIds.includes(id)))
  }, [sessions])

  const handleCloseTab = (idToClose: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const nextTabs = openSessionIds.filter(id => id !== idToClose)
    setOpenSessionIds(nextTabs)

    if (activeSessionId === idToClose) {
      if (nextTabs.length > 0) {
        const currentIndex = openSessionIds.indexOf(idToClose)
        const nextIndex = Math.max(0, currentIndex - 1)
        const nextActiveId = nextTabs[nextIndex] || nextTabs[0]
        setActiveSessionId(nextActiveId)
        setActiveTab('chat')
      } else {
        const remainingSessions = sessions.filter(s => s.id !== idToClose)
        if (remainingSessions.length > 0) {
          setActiveSessionId(remainingSessions[0].id)
          setActiveTab('chat')
        } else {
          handleCreateNewSession()
        }
      }
    }
  }

  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false)
  const historyDropdownRef = useRef<HTMLDivElement>(null)

  // 侧边栏下方菜单组（控制/代理/日志/设置）默认收起，把空间让给最近会话
  const [menuCollapsed, setMenuCollapsed] = useState(true)
  useEffect(() => {
    // 当前不在聊天页时自动展开菜单，便于看到高亮项
    if (activeTab !== 'chat') setMenuCollapsed(false)
  }, [activeTab])

  // ── 已生成文件 & 预览面板状态 ──
  const [generatedFiles, setGeneratedFiles] = useState<{ name: string; path: string; size: number; time: string }[]>([])
  const [showFilePanel, setShowFilePanel] = useState(false)
  const [openTabs, setOpenTabs] = useState<{ name: string; path: string; size: number; time: string }[]>([])
  const [previewFile, setPreviewFile] = useState<{ name: string; path: string; size: number } | null>(null)
  const [previewContent, setPreviewContent] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const docxContainerRef = useRef<HTMLDivElement>(null)
  const sheetContainerRef = useRef<HTMLDivElement>(null)
  const [filePanelWidth, setFilePanelWidth] = useState(320)
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)
  const sheetDataRef = useRef<any[] | null>(null)
  const sheetResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 拖拽调整面板宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = dragStartXRef.current - e.clientX
      const newWidth = Math.max(240, Math.min(800, dragStartWidthRef.current + delta))
      setFilePanelWidth(newWidth)
    }
    const handleMouseUp = () => {
      isDraggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const loadGeneratedFiles = async () => {
    if (window.api?.getGeneratedFiles) {
      const files = await window.api.getGeneratedFiles(activeSessionId)
      setGeneratedFiles(files)
    }
  }

  useEffect(() => {
    loadGeneratedFiles()
    // 切换会话时重置预览状态
    setOpenTabs([])
    setPreviewFile(null)
    setPreviewContent('')
    if (window.api?.onGeneratedFileUpdated) {
      const unsub = window.api.onGeneratedFileUpdated(() => {
        loadGeneratedFiles()
        setShowFilePanel(true)
      })
      return unsub
    }
    return undefined
  }, [activeSessionId])

  // 点击文件 → 加载预览内容
  const handlePreviewFile = async (f: { name: string; path: string; size: number }) => {
    setPreviewFile(f)
    // 将文件添加到已打开的 Tab 列表（如尚未存在）
    setOpenTabs(prev => {
      if (prev.some(t => t.path === f.path)) return prev
      const fullFile = generatedFiles.find(g => g.path === f.path)
      return [...prev, fullFile || { ...f, time: '' }]
    })
    if (filePanelWidth < 380) setFilePanelWidth(420)
    setPreviewContent('')
    setPreviewLoading(true)
    sheetDataRef.current = null

    const ext = f.name.split('.').pop()?.toLowerCase() || ''
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
    if (imageExts.includes(ext)) {
      setPreviewLoading(false)
      return
    }

    try {
      if (ext === 'docx') {
        const base64 = await window.api.readFileBase64(f.path)
        // 先让容器渲染出来，再填充内容
        setPreviewLoading(false)
        // 等一帧确保 DOM 更新
        await new Promise(r => setTimeout(r, 50))
        if (base64 && docxContainerRef.current) {
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const { renderAsync } = await import('docx-preview')
          docxContainerRef.current.innerHTML = ''
          try {
            await renderAsync(bytes.buffer, docxContainerRef.current, undefined, {
              className: 'docx-preview',
              inWrapper: true,
              ignoreWidth: false,
              ignoreHeight: false,
              ignoreFonts: false,
              breakPages: false,
              ignoreLastRenderedPageBreak: true,
              trimXmlDeclaration: true
            })
            console.log('[docx-preview] rendered successfully')
          } catch (renderErr) {
            console.error('[docx-preview] render error:', renderErr)
            docxContainerRef.current.innerHTML = '<p style="color:red;padding:16px">docx 渲染失败</p>'
          }
        } else {
          console.log('[docx-preview] base64 or container missing', { hasBase64: !!base64, hasContainer: !!docxContainerRef.current })
        }
      } else if (['xlsx', 'xls'].includes(ext)) {
        const base64 = await window.api.readFileBase64(f.path)
        setPreviewLoading(false)
        await new Promise(r => setTimeout(r, 50))
        if (base64 && sheetContainerRef.current) {
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const XLSX = await import('xlsx')
          const workbook = XLSX.read(bytes.buffer, { type: 'array' })
          const sheetData = workbook.SheetNames.map(name => {
            const sheet = workbook.Sheets[name]
            const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][]
            const rows: any = {}
            json.forEach((row, ri) => {
              const cells: any = {}
              row.forEach((cell, ci) => {
                // 过滤掉模板表达式（如 ${erd.cloud.pdm...}）
                let text = String(cell ?? '').replace(/\$\{[^}]*\}/g, '').trim()
                cells[ci] = { text }
              })
              rows[ri] = { cells }
            })
            return { name, rows }
          })
          const xSpreadsheet = (await import('x-data-spreadsheet')).default
          sheetDataRef.current = sheetData
          sheetContainerRef.current.innerHTML = ''
          new xSpreadsheet(sheetContainerRef.current, {
            showToolbar: false,
            showBottomBar: true,
            view: { height: () => sheetContainerRef.current!.clientHeight, width: () => sheetContainerRef.current!.clientWidth }
          }).loadData(sheetData)
        }
      } else if (ext === 'csv') {
        setPreviewLoading(false)
        await new Promise(r => setTimeout(r, 50))
        const content = await window.api.parseFileContent(f.path)
        if (content && sheetContainerRef.current) {
          const Papa = (await import('papaparse')).default
          const parsed = Papa.parse(content, { header: false, skipEmptyLines: true })
          const rows: any = {}
            ; (parsed.data as any[][]).forEach((row, ri) => {
              const cells: any = {}
              row.forEach((cell: any, ci: number) => { cells[ci] = { text: String(cell ?? '') } })
              rows[ri] = { cells }
            })
          const xSpreadsheet = (await import('x-data-spreadsheet')).default
          const csvSheetData = [{ name: 'Sheet1', rows }]
          sheetDataRef.current = csvSheetData
          sheetContainerRef.current.innerHTML = ''
          new xSpreadsheet(sheetContainerRef.current, {
            showToolbar: false,
            showBottomBar: false,
            view: { height: () => sheetContainerRef.current!.clientHeight, width: () => sheetContainerRef.current!.clientWidth }
          }).loadData(csvSheetData)
        }
      } else {
        const content = await window.api.parseFileContent(f.path)
        setPreviewContent(content || '[文件内容为空]')
        setPreviewLoading(false)
      }
    } catch (e) {
      console.error('[preview] error:', e)
      setPreviewContent('[读取文件失败]')
      setPreviewLoading(false)
    }
  }

  const handleDeleteFile = async (f: { path: string }) => {
    await window.api.deleteGeneratedFile(f.path, activeSessionId)
    loadGeneratedFiles()
    // 从已打开的 Tab 中移除
    const remaining = openTabs.filter(t => t.path !== f.path)
    setOpenTabs(remaining)
    if (previewFile?.path === f.path) {
      if (remaining.length === 0) {
        setPreviewFile(null)
        setPreviewContent('')
      } else {
        const next = remaining[remaining.length - 1]
        handlePreviewFile(next)
      }
    }
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(event.target as Node)) {
        setShowHistoryDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  const userMessages = activeSessMessages?.filter(m => m.sender === 'user') || []

  const renderPage = (): React.JSX.Element => {
    switch (activeTab) {
      case 'chat': return <ChatPage store={store} />
      case 'control': return <ControlPage store={store} />
      case 'agent': return <AgentPage store={store} />
      case 'logs': return <LogsPage store={store} />
      case 'settings': return <SettingsPage store={store} />
      default: return <div>Overview</div>
    }
  }

  return (
    <div className={`agent-window-container ${theme}`}>
      {/* ── 1. Left Sidebar ── */}
      <div className={`agent-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
        <div>
          {/* 顶部无边框拖拽区 */}
          <div style={{ height: '16px', flexShrink: 0, WebkitAppRegion: 'drag' } as any} />
          {/* Brand/Avatar Info */}
          <div className="sidebar-brand">
            <div className="brand-left">
              <div className="brand-avatar" style={{ background: 'transparent', boxShadow: 'none' }}>
                <img src={iconFromImage} alt="icon" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', transform: 'scale(1)' }} />
              </div>
              {!isCollapsed && (
                <div className="brand-info">
                  <span className="brand-name"></span>
                  <span className="brand-status" title={currentAvatarName}>
                    <span className="status-dot-pulse"></span>
                    {currentAvatarName}
                  </span>
                </div>
              )}
            </div>
            <button className="brand-collapse-btn" onClick={() => setIsCollapsed(!isCollapsed)}>
              {isCollapsed ? '▶' : '◀'}
            </button>
          </div>

          {/* + 新会话 */}
          <div className="new-chat-btn-wrapper">
            <button className="new-chat-btn" onClick={handleCreateNewSession} title="创建新会话">
              {isCollapsed ? <span>+</span> : <span>+ 新会话</span>}
            </button>
          </div>

          {/* 最近会话列表（搜索 / 分组 / 置顶 / 重命名 / 虚拟滚动） */}
          {!isCollapsed && (
            <div className="sidebar-recent-title">
              <span>最近会话</span>
              {activePermissionRequest && (
                <span className="menu-sandbox-badge" title="有待审批的终端命令" onClick={() => setActiveTab('chat')}>●</span>
              )}
            </div>
          )}
          {!isCollapsed && (
            <RecentSessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={(id) => { setActiveSessionId(id); setActiveTab('chat') }}
              onDelete={setSessionToDeleteId}
              onTogglePin={handleTogglePinSession}
              onRename={handleRenameSession}
            />
          )}

          {/* 可折叠菜单组：控制 / 代理 / 日志 / 设置 */}
          <div
            className={`sidebar-menu-header ${menuCollapsed ? 'collapsed' : ''}`}
            onClick={() => setMenuCollapsed(!menuCollapsed)}
            title={menuCollapsed ? '展开菜单' : '收起菜单'}
          >
            <span className="sidebar-menu-arrow">{menuCollapsed ? '▸' : '▾'}</span>
            <span>菜单</span>
          </div>
          {(!menuCollapsed || isCollapsed) && (
            <div className="sidebar-menu">
              <div className={`menu-item ${activeTab === 'control' ? 'active' : ''}`} onClick={() => setActiveTab('control')} title="订阅频道">
                <div className="menu-item-left"><OverviewIcon /><span>订阅频道</span></div>
                <span className="menu-item-arrow">&gt;</span>
              </div>
              <div className={`menu-item ${activeTab === 'agent' ? 'active' : ''}`} onClick={() => setActiveTab('agent')} title="代理">
                <div className="menu-item-left"><SkillsIcon /><span>代理</span></div>
                <span className="menu-item-arrow">&gt;</span>
              </div>
              <div className={`menu-item ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')} title="日志">
                <div className="menu-item-left"><LogsIcon /><span>日志</span></div>
                <span className="menu-item-arrow">&gt;</span>
              </div>
              <div className={`menu-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')} title="设置">
                <div className="menu-item-left"><SettingsIcon /><span>设置</span></div>
                <span className="menu-item-arrow">&gt;</span>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <button className="theme-toggle-icon-btn" onClick={handleThemeToggle} title="切换主题">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </div>

      {/* ── 2. Right Content Area ── */}
      <div className="agent-content-area">
        {/* ── 自定义标题栏 (Custom Titlebar) ── */}
        <div className="window-titlebar">
          {/* 会话标签页 */}
          <div className="titlebar-tabs" onDoubleClick={() => handleCreateNewSession()}>
            {openSessionIds.map(id => {
              const session = sessions.find(s => s.id === id)
              if (!session) return null
              const isActive = activeSessionId === id && activeTab === 'chat'
              const isThinking = checkIsThinking(session)
              return (
                <div
                  key={id}
                  className={`titlebar-tab ${isActive ? 'active' : ''} ${isThinking ? 'thinking' : ''}`}
                  onClick={() => {
                    setActiveSessionId(id)
                    setActiveTab('chat')
                  }}
                >
                  {isThinking && <span className="tab-status-dot-pulse"></span>}
                  <span className="titlebar-tab-name" title={session.name}>{session.name}</span>
                  <span
                    className="titlebar-tab-close"
                    onClick={(e) => handleCloseTab(id, e)}
                    title="关闭标签页"
                  >
                    ✕
                  </span>
                </div>
              )
            })}

            <button
              className="titlebar-new-tab-btn"
              onClick={() => handleCreateNewSession()}
              title="新建会话"
            >
              +
            </button>
          </div>

          {/* 窗口控制按钮 */}
          <div className="titlebar-controls">
            <button
              className="titlebar-control-btn"
              onClick={() => window.api?.minimizeAgentWindow()}
              title="最小化"
            >
              <svg width="10" height="1" viewBox="0 0 10 1" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="0" y1="0.5" x2="10" y2="0.5" />
              </svg>
            </button>
            <button
              className="titlebar-control-btn"
              onClick={() => {
                window.api?.maximizeAgentWindow()
                setTimeout(checkMaximized, 100)
              }}
              title={isMaximized ? '向下还原' : '最大化'}
            >
              {isMaximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <rect x="1.5" y="3.5" width="5" height="5" />
                  <path d="M3.5 1.5H8.5V6.5" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <rect x="1.5" y="1.5" width="7" height="7" />
                </svg>
              )}
            </button>
            <button
              className="titlebar-control-btn close"
              onClick={() => window.api?.closeAgentWindow()}
              title="关闭"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M1.5 1.5L8.5 8.5" />
                <path d="M8.5 1.5L1.5 8.5" />
              </svg>
            </button>
          </div>
        </div>

        <div className="content-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="content-title">
              {activeTab === 'chat' && (sessions.find(s => s.id === activeSessionId)?.name || '本地安全沙箱会话')}
              {activeTab === 'control' && '订阅频道'}
              {activeTab === 'agent' && 'Agent 智能体核心系统'}
              {activeTab === 'logs' && 'Token 消耗与模型日志统计'}
              {activeTab === 'settings' && '系统设置'}
            </div>
            {activeTab !== 'chat' && (
              <div className="content-subtitle">
                {activeTab === 'control' && '配置和管理您的订阅渠道'}
                {activeTab === 'agent' && `当前扩展技能数: ${skillsList.length} | 上下文轮数: ${contextRounds}`}
                {activeTab === 'logs' && '实时监测大语言模型调用频率及 Token 开销走势'}
                {activeTab === 'settings' && '大模型与虚拟体模拟配置项'}
              </div>
            )}
          </div>

          {/* 右侧工具栏 */}
          {activeTab === 'chat' && (
            <div style={{ position: 'relative' }} ref={historyDropdownRef}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {generatedFiles.length > 0 && (
                  <button
                    className={`history-btn ${showFilePanel ? 'active' : ''}`}
                    onClick={() => { setShowFilePanel(!showFilePanel); if (showFilePanel) { setPreviewFile(null); setPreviewContent(''); setOpenTabs([]) } }}
                    title="查看已生成的文件"
                  >
                    📁 {generatedFiles.length}
                  </button>
                )}
                <button
                  className="history-btn"
                  onClick={() => setShowHistoryDropdown(!showHistoryDropdown)}
                  title="查看历史提问"
                >
                  <HistoryListIcon />
                </button>
              </div>

              {showHistoryDropdown && (
                <div className="history-dropdown">
                  <div className="history-dropdown-header">
                    历史提问 ({userMessages.length})
                  </div>
                  <div className="history-dropdown-list">
                    {userMessages.length > 0 ? (
                      userMessages.map(msg => (
                        <div
                          key={msg.id}
                          className="history-item"
                          onClick={() => {
                            setHighlightedMessageId(msg.id)
                            setShowHistoryDropdown(false)
                          }}
                          title={msg.text}
                        >
                          {msg.text}
                        </div>
                      ))
                    ) : (
                      <div className="history-empty">暂无提问记录</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div className={`content-body tab-${activeTab}`} style={{ flex: 1, minWidth: 0 }}>
            {renderPage()}
          </div>

          {/* 右侧文件面板 */}
          {showFilePanel && activeTab === 'chat' && (
            <>
              {/* 拖拽调整条 */}
              <div
                onMouseDown={(e) => {
                  e.preventDefault()
                  isDraggingRef.current = true
                  dragStartXRef.current = e.clientX
                  dragStartWidthRef.current = filePanelWidth
                  document.body.style.cursor = 'col-resize'
                  document.body.style.userSelect = 'none'
                }}
                style={{
                  width: '5px',
                  cursor: 'col-resize',
                  background: 'var(--border-color)',
                  flexShrink: 0,
                  transition: 'background 0.15s',
                  position: 'relative'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--text-muted)'}
                onMouseLeave={e => { if (!isDraggingRef.current) e.currentTarget.style.background = 'var(--border-color)' }}
              />
              <div style={{
                width: `${filePanelWidth}px`,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-card)',
                overflow: 'hidden',
                flexShrink: 0
              }}>
                {/* 面板头部 */}
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>📁 已生成的文件 ({generatedFiles.length})</span>
                  <button
                    onClick={() => { setShowFilePanel(false); setPreviewFile(null); setPreviewContent(''); setOpenTabs([]) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px' }}
                  >✕</button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  {openTabs.length > 0 ? (
                    <>
                      {/* 有已打开的 Tab 时：上方 Tab 栏 + 下方预览区域 */}
                      <div style={{
                        display: 'flex',
                        flexWrap: 'nowrap',
                        overflowX: 'auto',
                        overflowY: 'hidden',
                        flexShrink: 0,
                        gap: '2px',
                        padding: '6px 8px 0',
                        borderBottom: '1px solid var(--border-color)',
                        background: 'var(--bg-menu-hover, rgba(128,128,128,0.03))'
                      }}>
                        {openTabs.map((f) => {
                          const isActive = previewFile?.path === f.path
                          const ext = f.name.split('.').pop()?.toLowerCase() || ''
                          const extColors: Record<string, string> = {
                            docx: '#2B579A', doc: '#2B579A', pdf: '#D04423', xlsx: '#217346', xls: '#217346', csv: '#217346',
                            pptx: '#D24726', ppt: '#D24726', txt: '#6B7280', md: '#6B7280', json: '#F59E0B', xml: '#F59E0B',
                            html: '#E34C26', css: '#264DE4', js: '#F7DF1E', ts: '#3178C6', py: '#3776AB',
                            png: '#8B5CF6', jpg: '#8B5CF6', jpeg: '#8B5CF6', gif: '#8B5CF6', webp: '#8B5CF6', svg: '#8B5CF6',
                            zip: '#6B7280', rar: '#6B7280', '7z': '#6B7280'
                          }
                          const color = extColors[ext] || '#6B7280'
                          const label = ext.toUpperCase().slice(0, 4)
                          return (
                            <div
                              key={f.path}
                              onClick={() => handlePreviewFile(f)}
                              title={`${f.name} (${(f.size / 1024).toFixed(1)} KB)`}
                              style={{
                                padding: '4px 8px',
                                cursor: 'pointer',
                                borderRadius: '6px 6px 0 0',
                                border: `1px solid ${isActive ? 'var(--border-color)' : 'transparent'}`,
                                borderBottom: isActive ? '1px solid var(--bg-card)' : '1px solid transparent',
                                background: isActive ? 'var(--bg-card)' : 'transparent',
                                color: isActive ? 'var(--text-menu-active)' : 'var(--text-muted)',
                                fontSize: '11px',
                                fontWeight: isActive ? 600 : 400,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: '150px',
                                transition: 'all 0.15s',
                                marginBottom: '-1px',
                                position: 'relative' as const,
                                zIndex: isActive ? 1 : 0,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px'
                              }}
                              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--bg-menu-hover)'; e.currentTarget.style.color = 'var(--text-primary)' } }}
                              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' } }}
                            >
                              <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>
                                <svg width="16" height="18" viewBox="0 0 16 18" fill="none">
                                  <path d="M1 1C1 0.447715 1.44772 0 2 0H10L15 5V17C15 17.5523 14.5523 18 14 18H2C1.44772 18 1 17.5523 1 17V1Z" fill="#fff" stroke="#D1D5DB" strokeWidth="1" />
                                  <path d="M10 0L15 5H11C10.4477 5 10 4.55228 10 4V0Z" fill="#E5E7EB" />
                                  <rect x="0" y="12" width="16" height="6" rx="0" fill={color} />
                                  <text x="8" y="16.5" textAnchor="middle" fill="#fff" fontSize="5" fontWeight="700" fontFamily="Arial,sans-serif">{label}</text>
                                </svg>
                              </span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                              <span
                                onClick={(e) => {
                                  e.stopPropagation()
                                  // 软删除：从 Tab 列表移除
                                  const remaining = openTabs.filter(t => t.path !== f.path)
                                  setOpenTabs(remaining)
                                  if (remaining.length === 0) {
                                    // 最后一个 Tab 关闭 → 回到文件列表视图
                                    setPreviewFile(null)
                                    setPreviewContent('')
                                  } else if (previewFile?.path === f.path) {
                                    // 关闭的是当前激活的 Tab → 切换到最后一个 Tab
                                    const next = remaining[remaining.length - 1]
                                    handlePreviewFile(next)
                                  }
                                }}
                                title="关闭 Tab"
                                style={{
                                  fontSize: '10px',
                                  flexShrink: 0,
                                  opacity: 0.5,
                                  cursor: 'pointer',
                                  padding: '0 2px',
                                  borderRadius: '3px',
                                  lineHeight: 1
                                }}
                                onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(239,68,68,0.15)' }}
                                onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.background = 'transparent' }}
                              >✕</span>
                            </div>
                          )
                        })}
                      </div>

                      {/* 预览区域 */}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                        {/* 预览头部 */}
                        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                          <span title={previewFile!.name} style={{ fontSize: '11px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{previewFile!.name}</span>
                          <div style={{ display: 'flex', gap: '4px', flexShrink: 0, marginLeft: '8px' }}>
                            <button onClick={async () => { await window.api.saveGeneratedFileAs(previewFile!.path) }} title="另存为" style={{ background: 'rgba(59,130,246,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#3b82f6', fontSize: '10px' }}>💾</button>
                            <button onClick={() => handleDeleteFile(previewFile!)} title="删除" style={{ background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#ef4444', fontSize: '10px' }}>🗑</button>
                            <button onClick={() => {
                              const remaining = openTabs.filter(t => t.path !== previewFile!.path)
                              setOpenTabs(remaining)
                              if (remaining.length === 0) {
                                setPreviewFile(null); setPreviewContent('');
                              } else {
                                const next = remaining[remaining.length - 1]
                                handlePreviewFile(next)
                              }
                            }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '2px 4px' }}>✕</button>
                          </div>
                        </div>

                        {/* 预览正文 */}
                        <div ref={(el) => {
                          // 监听容器尺寸变化，动态调整预览缩放
                          if (el && previewFile) {
                            const observer = new ResizeObserver(() => {
                              // docx 缩放适配 — 使用 CSS zoom 代替 transform: scale，zoom 会改变实际布局尺寸，避免循环缩放
                              const docxEl = el.querySelector('.docx-preview-container') as HTMLElement
                              if (docxEl) {
                                docxEl.style.zoom = '1'
                                const contentWidth = docxEl.scrollWidth
                                const containerWidth = el.clientWidth
                                if (contentWidth > containerWidth) {
                                  const z = containerWidth / contentWidth
                                  docxEl.style.zoom = `${z}`
                                }
                              }
                              // xlsx/csv 表格重建适配
                              const sheetEl = el.querySelector('.sheet-preview-container') as HTMLElement
                              if (sheetEl && sheetDataRef.current) {
                                if (sheetResizeTimerRef.current) clearTimeout(sheetResizeTimerRef.current)
                                sheetResizeTimerRef.current = setTimeout(async () => {
                                  const xSpreadsheet = (await import('x-data-spreadsheet')).default
                                  sheetEl.innerHTML = ''
                                  new xSpreadsheet(sheetEl, {
                                    showToolbar: false,
                                    showBottomBar: true,
                                    view: { height: () => sheetEl.clientHeight, width: () => sheetEl.clientWidth }
                                  }).loadData(sheetDataRef.current!)
                                }, 300)
                              }
                            })
                            observer.observe(el)
                          }
                        }} style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
                          {previewLoading && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card)', zIndex: 10, color: 'var(--text-muted)', fontSize: '12px' }}>加载中...</div>
                          )}
                          {(() => {
                            const ext = previewFile!.name.split('.').pop()?.toLowerCase() || ''
                            const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
                            if (imageExts.includes(ext)) {
                              return <div style={{ padding: '12px' }}><img src={`local-file:///${previewFile!.path.replace(/\\/g, '/')}`} style={{ maxWidth: '100%', borderRadius: '6px' }} /></div>
                            }
                            if (ext === 'docx') {
                              return <div ref={docxContainerRef} className="docx-preview-container" style={{ background: '#fff' }} />
                            }
                            if (['xlsx', 'xls', 'csv'].includes(ext)) {
                              return <div ref={sheetContainerRef} style={{ width: '100%', height: '100%' }} className="sheet-preview-container" />
                            }
                            if (previewContent) {
                              return <pre style={{ margin: 0, padding: '12px', fontFamily: "'Consolas', 'Monaco', monospace", fontSize: '11.5px', lineHeight: '1.5', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{previewContent}</pre>
                            }
                            return <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', marginTop: '40px' }}>无法预览此文件类型</div>
                          })()}
                        </div>
                      </div>
                    </>
                  ) : (
                    /* 无预览文件时：垂直文件列表 */
                    <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
                      {generatedFiles.map((f, i) => {
                        const ext = f.name.split('.').pop()?.toLowerCase() || ''
                        const extColors: Record<string, string> = {
                          docx: '#2B579A', doc: '#2B579A', pdf: '#D04423', xlsx: '#217346', xls: '#217346', csv: '#217346',
                          pptx: '#D24726', ppt: '#D24726', txt: '#6B7280', md: '#6B7280', json: '#F59E0B', xml: '#F59E0B',
                          html: '#E34C26', css: '#264DE4', js: '#F7DF1E', ts: '#3178C6', py: '#3776AB',
                          png: '#8B5CF6', jpg: '#8B5CF6', jpeg: '#8B5CF6', gif: '#8B5CF6', webp: '#8B5CF6', svg: '#8B5CF6',
                          zip: '#6B7280', rar: '#6B7280', '7z': '#6B7280'
                        }
                        const color = extColors[ext] || '#6B7280'
                        const label = ext.toUpperCase().slice(0, 4)
                        return (
                          <div
                            key={i}
                            onClick={() => handlePreviewFile(f)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '8px 10px',
                              cursor: 'pointer',
                              borderRadius: '6px',
                              transition: 'background 0.15s',
                              marginBottom: '2px'
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-menu-hover)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>
                              <svg width="20" height="22" viewBox="0 0 16 18" fill="none">
                                <path d="M1 1C1 0.447715 1.44772 0 2 0H10L15 5V17C15 17.5523 14.5523 18 14 18H2C1.44772 18 1 17.5523 1 17V1Z" fill="#fff" stroke="#D1D5DB" strokeWidth="1" />
                                <path d="M10 0L15 5H11C10.4477 5 10 4.55228 10 4V0Z" fill="#E5E7EB" />
                                <rect x="0" y="12" width="16" height="6" rx="0" fill={color} />
                                <text x="8" y="16.5" textAnchor="middle" fill="#fff" fontSize="5" fontWeight="700" fontFamily="Arial,sans-serif">{label}</text>
                              </svg>
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{(f.size / 1024).toFixed(1)} KB</div>
                            </div>
                            <span
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteFile(f)
                              }}
                              title="删除文件"
                              style={{
                                fontSize: '11px',
                                opacity: 0,
                                cursor: 'pointer',
                                padding: '2px 4px',
                                borderRadius: '3px',
                                color: 'var(--text-muted)',
                                transition: 'opacity 0.15s',
                                flexShrink: 0
                              }}
                              onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(239,68,68,0.15)'; e.currentTarget.style.color = '#ef4444' }}
                              onMouseLeave={e => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
                            >🗑</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 删除会话二次确认弹框 */}
      {sessionToDeleteId && (
        <div className="mcp-modal-overlay">
          <div className="mcp-modal-card" style={{ maxWidth: '380px', width: '90%' }}>
            <div className="mcp-modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.15))' }}>
              <div className="mcp-modal-title" style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
                删除
              </div>
              <button className="mcp-modal-close-btn" style={{ fontSize: '20px' }} onClick={() => setSessionToDeleteId(null)}>×</button>
            </div>
            <div className="mcp-modal-body" style={{ padding: '24px 20px', fontSize: '13px', color: 'var(--text-secondary, #666)', lineHeight: '1.6' }}>
              您即将删除此话题，此操作无法撤销。
            </div>
            <div className="mcp-modal-footer" style={{ padding: '12px 20px 16px', display: 'flex', justifyContent: 'flex-end', gap: '12px', borderTop: 'none' }}>
              <button
                onClick={() => setSessionToDeleteId(null)}
                style={{
                  padding: '6px 18px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color, rgba(128, 128, 128, 0.2))',
                  background: 'var(--bg-card, #ffffff)',
                  color: 'var(--text-primary, #333)',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  fontWeight: 500,
                  transition: 'background 0.2s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover, rgba(128, 128, 128, 0.08))'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-card, #ffffff)'}
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (sessionToDeleteId) {
                    handleDeleteSession(sessionToDeleteId)
                    setSessionToDeleteId(null)
                  }
                }}
                style={{
                  padding: '6px 18px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#e0533c', // 珊瑚红/橙红色
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  fontWeight: 'bold',
                  boxShadow: '0 2px 6px rgba(224, 83, 60, 0.15)',
                  transition: 'filter 0.2s'
                }}
                onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.05)'}
                onMouseLeave={e => e.currentTarget.style.filter = 'none'}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API Key 引导配置弹窗 */}
      {showApiKeyModal && (
        <div 
          className="mcp-modal-overlay" 
          style={{ 
            backdropFilter: 'blur(10px)', 
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            zIndex: 99999
          }}
        >
          <style>{`
            @keyframes modalSlideIn {
              from {
                opacity: 0;
                transform: scale(0.95) translateY(10px);
              }
              to {
                opacity: 1;
                transform: scale(1) translateY(0);
              }
            }
          `}</style>
          <div 
            className="mcp-modal-card" 
            style={{ 
              maxWidth: '420px', 
              width: '90%',
              background: 'var(--bg-card, rgba(255, 255, 255, 0.85))',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid var(--border-color, rgba(255, 255, 255, 0.25))',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.15), inset 0 1px 1px rgba(255, 255, 255, 0.2)',
              borderRadius: '16px',
              animation: 'modalSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
            }}
          >
            <div className="mcp-modal-header" style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-color, rgba(128,128,128,0.15))', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="mcp-modal-title" style={{ fontSize: '16px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <span>🔑 缺少大模型配置</span>
              </div>
              <button 
                className="mcp-modal-close-btn" 
                style={{ fontSize: '20px', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }} 
                onClick={() => setShowApiKeyModal(false)}
              >
                ×
              </button>
            </div>
            <div className="mcp-modal-body" style={{ padding: '24px', fontSize: '13.5px', color: 'var(--text-secondary, #4b5563)', lineHeight: '1.6' }}>
              <p style={{ margin: 0, fontWeight: 500, color: 'var(--text-primary)' }}>
                为了体验桌宠 {currentAvatarName} 的全部智能交互功能，建议您先配置大模型 API 密钥。
              </p>
              <p style={{ margin: '10px 0 0 0', fontSize: '12.5px', color: 'var(--text-muted, #6b7280)' }}>
                未配置 Key 状态下将无法开启 AI 聊天、代码编写、定时运行、系统操作等核心功能。
              </p>
            </div>
            <div className="mcp-modal-footer" style={{ padding: '16px 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: '12px', borderTop: 'none', background: 'transparent' }}>
              <button
                onClick={() => setShowApiKeyModal(false)}
                style={{
                  padding: '8px 18px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color, rgba(128, 128, 128, 0.2))',
                  background: 'transparent',
                  color: 'var(--text-primary, #374151)',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  fontWeight: 500,
                  transition: 'all 0.2s'
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--bg-hover, rgba(128, 128, 128, 0.08))'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                暂不配置
              </button>
              <button
                onClick={() => {
                  setShowApiKeyModal(false)
                  setActiveTab('settings')
                  setSettingsSubTab('keys')
                }}
                style={{
                  padding: '8px 20px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #4f8cff 0%, #3b82f6 100%)',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  fontWeight: 'bold',
                  boxShadow: '0 4px 12px rgba(79, 140, 255, 0.3)',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.filter = 'brightness(1.08)'
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(79, 140, 255, 0.4)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.filter = 'none'
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(79, 140, 255, 0.3)'
                }}
              >
                前往配置 API Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Toast */}
      {toast && (
        <div className={`global-toast-notification ${toast.type}`}>
          <span className="toast-icon">
            {toast.type === 'success' && '✨'}
            {toast.type === 'error' && '❌'}
            {toast.type === 'info' && '💡'}
          </span>
          <span className="toast-message">{toast.message}</span>
        </div>
      )}

    </div>
  )
}

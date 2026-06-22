import React, { useState, useRef, useEffect, useCallback } from 'react'
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

export function AgentWindow(): React.JSX.Element {
  const store = useAppStore()

  const {
    theme, handleThemeToggle,
    isCollapsed, setIsCollapsed,
    activeTab, setActiveTab,
    sessions, activeSessionId, setActiveSessionId,
    handleCreateNewSession, handleDeleteSession, handleTogglePinSession, handleRenameSession,
    llmConfig,
    customModelFile,
    skillsList, contextRounds,
    toast,
    // sandbox
    activePermissionRequest,
    activeSessMessages,
    setHighlightedMessageId
  } = store

  const currentAvatarName = customModelFile ? customModelFile.replace(/\.model3\.json$/i, '') : 'Mao'

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
  const [previewHtml, setPreviewHtml] = useState<string>('')
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
    setPreviewHtml('')
    if (window.api?.onGeneratedFileUpdated) {
      const unsub = window.api.onGeneratedFileUpdated(() => {
        loadGeneratedFiles()
        setShowFilePanel(true)
      })
      return unsub
    }
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
    setPreviewHtml('')
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
          ;(parsed.data as any[][]).forEach((row, ri) => {
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
        setPreviewHtml('')
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
      case 'chat': return <ChatPage store={store} generatedFiles={generatedFiles} onDeleteFile={handleDeleteFile} />
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
          {/* Brand/Avatar Info */}
          <div className="sidebar-brand">
            <div className="brand-left">
              <div className="brand-avatar" style={{ background: 'transparent', boxShadow: 'none' }}>
                <img src={iconFromImage} alt="icon" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', transform: 'scale(1)' }} />
              </div>
              {!isCollapsed && (
                <div className="brand-info">
                  <span className="brand-name">agentself</span>
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
              onDelete={handleDeleteSession}
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
              <div className={`menu-item ${activeTab === 'control' ? 'active' : ''}`} onClick={() => setActiveTab('control')} title="控制">
                <div className="menu-item-left"><OverviewIcon /><span>控制</span></div>
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
          {!isCollapsed && (
            <div className="footer-widget-status">
              <div className="footer-stat-row">
                <span>状态</span>
                <span className="footer-stat-val" style={{ color: '#10b981' }}>● 激活</span>
              </div>
              <div className="footer-stat-row">
                <span>模式</span>
                <span className="footer-stat-val">
                  {llmConfig.provider === 'ollama' ? 'Ollama' : (llmConfig.apiKey ? '大模型云服务' : '模拟对话模式')}
                </span>
              </div>
            </div>
          )}
          <button className="theme-toggle-btn" onClick={handleThemeToggle} style={{ width: '100%' }} title="切换主题">
            {theme === 'dark' ? '☀️ 切换为浅色主题' : '🌙 切换为深色主题'}
          </button>
        </div>
      </div>

      {/* ── 2. Right Content Area ── */}
      <div className="agent-content-area">
        <div className="content-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="content-title">
              {activeTab === 'chat' && (sessions.find(s => s.id === activeSessionId)?.name || '本地安全沙箱会话')}
              {activeTab === 'control' && '集成第三方服务'}
              {activeTab === 'agent' && 'Agent 智能体核心系统'}
              {activeTab === 'logs' && 'Token 消耗与模型日志统计'}
              {activeTab === 'settings' && '系统设置与外部集成'}
            </div>
            <div className="content-subtitle">
              {activeTab === 'chat' && `当前使用模型：${llmConfig.model || '未定义'}`}
              {activeTab === 'control' && '配置三方Bot'}
              {activeTab === 'agent' && `当前扩展技能数: ${skillsList.length} | 上下文轮数: ${contextRounds}`}
              {activeTab === 'logs' && '实时监测大语言模型调用频率及 Token 开销走势'}
              {activeTab === 'settings' && '大模型与微信消息集成模拟配置项'}
            </div>
          </div>

          {/* 右侧工具栏 */}
          {activeTab === 'chat' && (
            <div style={{ position: 'relative' }} ref={historyDropdownRef}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {generatedFiles.length > 0 && (
                  <button
                    className={`history-btn ${showFilePanel ? 'active' : ''}`}
                    onClick={() => { setShowFilePanel(!showFilePanel); if (showFilePanel) { setPreviewFile(null); setPreviewContent(''); setPreviewHtml(''); setOpenTabs([]) } }}
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
                  onClick={() => { setShowFilePanel(false); setPreviewFile(null); setPreviewContent(''); setPreviewHtml(''); setOpenTabs([]) }}
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
                      {openTabs.map((f, i) => {
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
                                <path d="M1 1C1 0.447715 1.44772 0 2 0H10L15 5V17C15 17.5523 14.5523 18 14 18H2C1.44772 18 1 17.5523 1 17V1Z" fill="#fff" stroke="#D1D5DB" strokeWidth="1"/>
                                <path d="M10 0L15 5H11C10.4477 5 10 4.55228 10 4V0Z" fill="#E5E7EB"/>
                                <rect x="0" y="12" width="16" height="6" rx="0" fill={color}/>
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
                                  setPreviewHtml('')
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
                        <span title={previewFile.name} style={{ fontSize: '11px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{previewFile.name}</span>
                        <div style={{ display: 'flex', gap: '4px', flexShrink: 0, marginLeft: '8px' }}>
                          <button onClick={async () => { await window.api.saveGeneratedFileAs(previewFile.path) }} title="另存为" style={{ background: 'rgba(59,130,246,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#3b82f6', fontSize: '10px' }}>💾</button>
                          <button onClick={() => handleDeleteFile(previewFile)} title="删除" style={{ background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#ef4444', fontSize: '10px' }}>🗑</button>
                          <button onClick={() => {
                            const remaining = openTabs.filter(t => t.path !== previewFile.path)
                            setOpenTabs(remaining)
                            if (remaining.length === 0) {
                              setPreviewFile(null); setPreviewContent(''); setPreviewHtml('')
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
                            // docx 缩放适配
                            const docxEl = el.querySelector('.docx-preview-container') as HTMLElement
                            if (docxEl && docxEl.scrollWidth > el.clientWidth) {
                              const scale = el.clientWidth / docxEl.scrollWidth
                              docxEl.style.transform = `scale(${Math.min(1, scale)})`
                              docxEl.style.transformOrigin = 'top left'
                              docxEl.style.width = `${100 / Math.min(1, scale)}%`
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
                          const ext = previewFile.name.split('.').pop()?.toLowerCase() || ''
                          const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
                          if (imageExts.includes(ext)) {
                            return <div style={{ padding: '12px' }}><img src={`local-file:///${previewFile.path.replace(/\\/g, '/')}`} style={{ maxWidth: '100%', borderRadius: '6px' }} /></div>
                          }
                          if (ext === 'docx') {
                            return <div ref={docxContainerRef} className="docx-preview-container" style={{ background: '#fff', transformOrigin: 'top left' }} />
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
                              <path d="M1 1C1 0.447715 1.44772 0 2 0H10L15 5V17C15 17.5523 14.5523 18 14 18H2C1.44772 18 1 17.5523 1 17V1Z" fill="#fff" stroke="#D1D5DB" strokeWidth="1"/>
                              <path d="M10 0L15 5H11C10.4477 5 10 4.55228 10 4V0Z" fill="#E5E7EB"/>
                              <rect x="0" y="12" width="16" height="6" rx="0" fill={color}/>
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

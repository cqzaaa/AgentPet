/* eslint-disable react-hooks/set-state-in-effect */
import React, { Suspense, lazy, useState, useRef, useEffect, useMemo } from 'react'
import { useAppStore, useAppStoreRaw } from '../hooks/useAppStore'
import type { Session } from '../hooks/useAppStore'
import { ChatControllerProvider } from '../hooks/useChatController'
import { OverviewIcon, SkillsIcon, SettingsIcon } from './icons/Icons'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleX,
  Copy,
  KeyRound,
  Lightbulb,
  List,
  Minus,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  ScrollText,
  Square,
  Sun,
  Workflow,
  X
} from 'lucide-react'
import { useRpaStore } from '../rpa/useRpaStore'
import iconFromImage from '../assets/icon.png'
import { RecentSessionList } from './RecentSessionList'

const ChatPage = lazy(() => import('../pages/ChatPage').then(module => ({ default: module.ChatPage })))
const ControlPage = lazy(() => import('../pages/ControlPage').then(module => ({ default: module.ControlPage })))
const AgentPage = lazy(() => import('../pages/AgentPage').then(module => ({ default: module.AgentPage })))
const SettingsPage = lazy(() => import('../pages/SettingsPage').then(module => ({ default: module.SettingsPage })))
const LogsPage = lazy(() => import('../pages/LogsPage').then(module => ({ default: module.LogsPage })))
const RpaPage = lazy(() => import('../rpa/RpaPage').then(module => ({ default: module.RpaPage })))
const FilePreviewPanel = lazy(() =>
  import('./FilePreviewPanel').then(module => ({ default: module.FilePreviewPanel }))
)

function PageLoadingFallback(): React.JSX.Element {
  return <div className="page-loading-placeholder" aria-hidden="true" />
}

type FunctionPageId = 'control' | 'agent' | 'rpa' | 'logs' | 'settings'

type WorkspaceTab =
  | { key: string; kind: 'session'; sessionId: string }
  | { key: string; kind: 'page'; pageId: FunctionPageId; detailId?: string }

const FUNCTION_PAGE_LABELS: Record<FunctionPageId, string> = {
  control: '订阅频道',
  agent: '代理',
  rpa: 'RPA 任务',
  logs: '日志',
  settings: '设置'
}

const AGENT_SUB_TAB_LABELS: Record<string, string> = {
  skills: '技能加入',
  memory: '记忆控制',
  cron: '定时任务',
  mcp: 'MCP 服务'
}

const SETTINGS_SUB_TAB_LABELS: Record<string, string> = {
  keys: '模型配置',
  storage: '存储管理',
  avatar: '虚拟体'
}

const isFunctionPage = (tab: string): tab is FunctionPageId =>
  Object.prototype.hasOwnProperty.call(FUNCTION_PAGE_LABELS, tab)

const checkIsThinking = (s: Session | undefined): boolean => {
  if (!s || !s.messages) return false
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (m.sender === 'agent') return !!m.isThinking
  }
  return false
}

function getSessionPreview(session: Session): string {
  const messages = session.messages || []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.sender === 'system' || message.isThinking) continue
    const text = (message.text || '')
      .replace(/```[\s\S]*?```/g, '[代码]')
      .replace(/[-*_`#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text.slice(0, 40)
    const fileNames = Array.isArray(message.fileInfos)
      ? message.fileInfos.map((file: { name?: string }) => file.name).filter(Boolean)
      : []
    if (fileNames.length > 0) return `附件：${fileNames.join('、')}`
    if (message.fileInfo?.name) return `附件：${message.fileInfo.name}`
  }
  return (session.contextSummary || '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

/** Keeps the shell stable while only the active agent message text is growing. */
function createShellSessionsSelector(): (state: { sessions: Session[] }) => Session[] {
  let cachedSessions: Session[] = []
  let cachedSignatures: string[] = []
  return (state: { sessions: Session[] }) => {
    const sessions = state.sessions
    const signatures = sessions.map(session => [
      session.id,
      session.name,
      session.pinned ? '1' : '0',
      session.createdAt || session.time,
      checkIsThinking(session) ? '1' : '0',
      getSessionPreview(session)
    ].join('\u0000'))
    if (
      signatures.length === cachedSignatures.length &&
      signatures.every((signature, index) => signature === cachedSignatures[index])
    ) {
      return cachedSessions
    }
    cachedSessions = sessions
    cachedSignatures = signatures
    return sessions
  }
}

export function AgentWindow(): React.JSX.Element {
  const store = useAppStore()
  const selectShellSessions = useMemo(() => createShellSessionsSelector(), [])

  // 使用 Zustand 细粒度选择器订阅状态以阻止全局无用重渲染
  const theme = useAppStoreRaw(state => state.theme)
  const isCollapsed = useAppStoreRaw(state => state.isCollapsed)
  const activeTab = useAppStoreRaw(state => state.activeTab)
  const agentSubTab = useAppStoreRaw(state => state.agentSubTab)
  const settingsSubTab = useAppStoreRaw(state => state.settingsSubTab)
  const showApiKeyModal = useAppStoreRaw(state => state.showApiKeyModal)
  const sessions = useAppStoreRaw(selectShellSessions)
  const activeSessionId = useAppStoreRaw(state => state.activeSessionId)
  const customModelFile = useAppStoreRaw(state => state.customModelFile)
  const skillsList = useAppStoreRaw(state => state.skillsList)
  const contextRounds = useAppStoreRaw(state => state.contextRounds)
  const toast = useAppStoreRaw(state => state.toast)
  const activePermissionRequest = useAppStoreRaw(state => state.activePermissionRequest)
  const generatedFiles = useAppStoreRaw(state => state.generatedFiles)
  const openTabs = useAppStoreRaw(state => state.openTabs)
  const showFilePanel = useAppStoreRaw(state => state.showFilePanel)
  const isSessionsInitialized = useAppStoreRaw(state => state.isSessionsInitialized)
  const rpaTasks = useRpaStore(state => state.tasks)
  const activeRpaTaskId = useRpaStore(state => state.activeTaskId)
  const selectRpaTask = useRpaStore(state => state.selectTask)
  const sessionsById = useMemo(
    () => new Map(sessions.map(session => [session.id, session])),
    [sessions]
  )
  const rpaTasksById = useMemo(
    () => new Map(rpaTasks.map(task => [task.id, task])),
    [rpaTasks]
  )
  const visibleFileCount = useMemo(
    () => new Set([...generatedFiles, ...openTabs].map(file => file.path)).size,
    [generatedFiles, openTabs]
  )

  // 派生状态从 Zustand 中获取
  const activeSession = sessionsById.get(activeSessionId) || sessions[0] || { messages: [] }
  const activeSessMessages = activeSession.messages || []

  const [showSplash, setShowSplash] = useState(true)
  const [splashFadeOut, setSplashFadeOut] = useState(false)
  const [isMinDelayPassed, setIsMinDelayPassed] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsMinDelayPassed(true)
    }, 1200)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (isMinDelayPassed && isSessionsInitialized) {
      setSplashFadeOut(true)
      const destroyTimer = setTimeout(() => {
        setShowSplash(false)
      }, 400)
      return () => clearTimeout(destroyTimer)
    }
    return undefined
  }, [isMinDelayPassed, isSessionsInitialized])

  const {
    handleThemeToggle,
    setIsCollapsed,
    setActiveTab,
    setSettingsSubTab,
    setShowApiKeyModal,
    setActiveSessionId,
    handleCreateNewSession,
    handleDeleteSession,
    handleTogglePinSession,
    handleRenameSession,
    setHighlightedMessageId,
    setShowFilePanel,
    setPreviewFile,
    setOpenTabs
  } = store

  const currentAvatarName = customModelFile ? customModelFile.replace(/\.model3\.json$/i, '') : 'Mao'

  const chatActions = useMemo(() => ({
    setInputValue: store.setInputValue,
    handleSendChat: store.handleSendChat,
    saveLlmConfig: store.saveLlmConfig,
    setAttachedFiles: store.setAttachedFiles,
    handlePasteFiles: store.handlePasteFiles,
    handleUploadFile: store.handleUploadFile,
    setHighlightedMessageId: store.setHighlightedMessageId,
    handleAbortLlm: store.handleAbortLlm,
    handleUpdateExecutionDevice: store.handleUpdateExecutionDevice,
    handleConnectSsh: store.handleConnectSsh,
    handleDisconnectSsh: store.handleDisconnectSsh,
    showToast: store.showToast,
    handleRespondPermission: store.handleRespondPermission,
    toggleSkillEnable: store.toggleSkillEnable,
    setActiveTab: store.setActiveTab,
    setAgentSubTab: store.setAgentSubTab,
    refreshSkillsAndStorage: store.refreshSkillsAndStorage,
    refreshMcpServers: store.refreshMcpServers,
    saveMcpConfig: store.saveMcpConfig,
    handlePreviewFile: store.handlePreviewFile,
    setShowFilePanel: store.setShowFilePanel
  }), [
    store.setInputValue,
    store.handleSendChat,
    store.saveLlmConfig,
    store.setAttachedFiles,
    store.handlePasteFiles,
    store.handleUploadFile,
    store.setHighlightedMessageId,
    store.handleAbortLlm,
    store.handleUpdateExecutionDevice,
    store.handleConnectSsh,
    store.handleDisconnectSsh,
    store.showToast,
    store.handleRespondPermission,
    store.toggleSkillEnable,
    store.setActiveTab,
    store.setAgentSubTab,
    store.refreshSkillsAndStorage,
    store.refreshMcpServers,
    store.saveMcpConfig,
    store.handlePreviewFile,
    store.setShowFilePanel
  ])

  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false)
  const historyDropdownRef = useRef<HTMLDivElement>(null)

  // 侧边栏下方菜单组（控制/代理/日志/设置）默认收起，把空间让给最近会话
  const [menuCollapsed, setMenuCollapsed] = useState(true)
  useEffect(() => {
    if (activeTab !== 'chat') setMenuCollapsed(false)
  }, [activeTab])

  const [isMaximized, setIsMaximized] = useState(false)

  const checkMaximized = async (): Promise<void> => {
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

  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([])
  const [sessionToDeleteId, setSessionToDeleteId] = useState<string | null>(null)
  const [hiddenTabKeys, setHiddenTabKeys] = useState<string[]>([])
  const [showTabOverflowMenu, setShowTabOverflowMenu] = useState(false)
  const tabsViewportRef = useRef<HTMLDivElement>(null)
  const tabElementRefs = useRef(new Map<string, HTMLDivElement>())
  const tabOverflowMenuRef = useRef<HTMLDivElement>(null)

  const getWorkspaceTabLabel = (tab: WorkspaceTab): string => {
    if (tab.kind === 'session') {
      return sessionsById.get(tab.sessionId)?.name || '新会话'
    }
    if (tab.pageId === 'rpa' && tab.detailId) {
      return `RPA-${rpaTasksById.get(tab.detailId)?.name || '未知任务'}`
    }
    if (tab.pageId === 'agent') {
      return `代理-${AGENT_SUB_TAB_LABELS[agentSubTab] || '技能加入'}`
    }
    if (tab.pageId === 'settings') {
      return `设置-${SETTINGS_SUB_TAB_LABELS[settingsSubTab] || '模型配置'}`
    }
    return FUNCTION_PAGE_LABELS[tab.pageId]
  }

  const workspaceTabLabelSignature = workspaceTabs
    .map(tab => `${tab.key}:${getWorkspaceTabLabel(tab)}`)
    .join('\u0000')

  const activeWorkspaceKey = activeTab === 'chat'
    ? `session:${activeSessionId}`
    : activeTab === 'rpa' && activeRpaTaskId
      ? `page:rpa:${activeRpaTaskId}`
      : `page:${activeTab}`

  useEffect(() => {
    if (activeTab === 'chat' && activeSessionId) {
      const key = `session:${activeSessionId}`
      setWorkspaceTabs(prev => prev.some(tab => tab.key === key)
        ? prev
        : [...prev, { key, kind: 'session', sessionId: activeSessionId }])
    }
  }, [activeSessionId, activeTab])

  useEffect(() => {
    if (isFunctionPage(activeTab)) {
      const detailId = activeTab === 'rpa' ? activeRpaTaskId || undefined : undefined
      const key = detailId ? `page:${activeTab}:${detailId}` : `page:${activeTab}`
      setWorkspaceTabs(prev => prev.some(tab => tab.key === key)
        ? prev
        : [...prev, { key, kind: 'page', pageId: activeTab, detailId }])
    }
  }, [activeRpaTaskId, activeTab])

  useEffect(() => {
    const validIds = new Set(sessions.map(s => s.id))
    setWorkspaceTabs(prev => {
      const next = prev.filter(tab => tab.kind === 'page' || validIds.has(tab.sessionId))
      return next.length === prev.length ? prev : next
    })
  }, [sessions])

  const activateWorkspaceTab = (tab: WorkspaceTab): void => {
    if (tab.kind === 'session') {
      setActiveSessionId(tab.sessionId)
      setActiveTab('chat')
    } else if (tab.pageId === 'rpa') {
      void selectRpaTask(tab.detailId || null).then(() => setActiveTab('rpa'))
    } else {
      setActiveTab(tab.pageId)
    }
  }

  const handleCloseTab = (keyToClose: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    const currentIndex = workspaceTabs.findIndex(tab => tab.key === keyToClose)
    const closingTab = workspaceTabs[currentIndex]
    if (!closingTab) return

    const isClosingActive = closingTab.key === activeWorkspaceKey
    const nextTabs = workspaceTabs.filter(tab => tab.key !== keyToClose)
    setWorkspaceTabs(nextTabs)

    if (isClosingActive) {
      const nextTab = nextTabs[Math.min(currentIndex, nextTabs.length - 1)]
      if (nextTab) {
        activateWorkspaceTab(nextTab)
      } else if (sessions.length > 0) {
        setActiveSessionId(sessions[0].id)
        setActiveTab('chat')
      } else {
        handleCreateNewSession()
      }
    }
  }

  useEffect(() => {
    const viewport = tabsViewportRef.current
    if (!viewport) return undefined

    let frameId = 0
    const updateHiddenTabs = (): void => {
      cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(() => {
        const viewportRect = viewport.getBoundingClientRect()
        const nextHiddenKeys = workspaceTabs
          .filter(tab => {
            const element = tabElementRefs.current.get(tab.key)
            if (!element) return false
            const rect = element.getBoundingClientRect()
            return rect.left < viewportRect.left - 1 || rect.right > viewportRect.right + 1
          })
          .map(tab => tab.key)
        setHiddenTabKeys(prev => (
          prev.length === nextHiddenKeys.length && prev.every((key, index) => key === nextHiddenKeys[index])
            ? prev
            : nextHiddenKeys
        ))
      })
    }

    updateHiddenTabs()
    const resizeObserver = new ResizeObserver(updateHiddenTabs)
    resizeObserver.observe(viewport)
    viewport.addEventListener('scroll', updateHiddenTabs, { passive: true })
    return () => {
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      viewport.removeEventListener('scroll', updateHiddenTabs)
    }
  }, [workspaceTabs, workspaceTabLabelSignature])

  useEffect(() => {
    const viewport = tabsViewportRef.current
    const activeElement = tabElementRefs.current.get(activeWorkspaceKey)
    if (!viewport || !activeElement) return

    const frameId = requestAnimationFrame(() => {
      const viewportRect = viewport.getBoundingClientRect()
      const activeRect = activeElement.getBoundingClientRect()
      if (activeRect.left < viewportRect.left) {
        viewport.scrollLeft -= viewportRect.left - activeRect.left
      } else if (activeRect.right > viewportRect.right) {
        viewport.scrollLeft += activeRect.right - viewportRect.right
      }
    })
    return () => cancelAnimationFrame(frameId)
  }, [activeWorkspaceKey, workspaceTabs])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      if (tabOverflowMenuRef.current && !tabOverflowMenuRef.current.contains(event.target as Node)) {
        setShowTabOverflowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (hiddenTabKeys.length === 0) setShowTabOverflowMenu(false)
  }, [hiddenTabKeys])


  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
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
    let page: React.JSX.Element
    switch (activeTab) {
      case 'chat': page = <ChatControllerProvider actions={chatActions}><ChatPage /></ChatControllerProvider>; break
      case 'control': page = <ControlPage store={store} />; break
      case 'agent': page = <AgentPage store={store} />; break
      case 'logs': page = <LogsPage store={store} />; break
      case 'settings': page = <SettingsPage store={store} />; break
      case 'rpa': page = <RpaPage />; break
      default: page = <div>Overview</div>
    }
    return <Suspense fallback={<PageLoadingFallback />}>{page}</Suspense>
  }

  const hiddenTabKeySet = new Set(hiddenTabKeys)
  const hiddenTabs = workspaceTabs.filter(tab => hiddenTabKeySet.has(tab.key))

  return (
    <div className={`agent-window-container ${theme}`}>
      {/* ── 1. Left Sidebar ── */}
      <div className={`agent-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
        <div>
          {/* 顶部无边框拖拽区 */}
          <div style={{ height: '16px', flexShrink: 0, WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string }} />
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
              {isCollapsed
                ? <PanelLeftOpen size={16} strokeWidth={2} aria-hidden="true" />
                : <PanelLeftClose size={16} strokeWidth={2} aria-hidden="true" />}
            </button>
          </div>

          {/* + 新会话 */}
          <div className="new-chat-btn-wrapper">
            <button className="new-chat-btn" onClick={handleCreateNewSession} title="创建新会话">
              <Plus size={17} strokeWidth={2} aria-hidden="true" />
              {!isCollapsed && <span>新会话</span>}
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
            <span className="sidebar-menu-arrow">
              {menuCollapsed
                ? <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
                : <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />}
            </span>
            <span>菜单</span>
          </div>
          {(!menuCollapsed || isCollapsed) && (
            <div className="sidebar-menu">
              <div className={`menu-item ${activeTab === 'control' ? 'active' : ''}`} onClick={() => setActiveTab('control')} title="订阅频道">
                <div className="menu-item-left"><OverviewIcon /><span>订阅频道</span></div>
                <ChevronRight className="menu-item-arrow" size={14} strokeWidth={2} aria-hidden="true" />
              </div>
              <div className={`menu-item ${activeTab === 'agent' ? 'active' : ''}`} onClick={() => setActiveTab('agent')} title="代理">
                <div className="menu-item-left"><SkillsIcon /><span>代理</span></div>
                <ChevronRight className="menu-item-arrow" size={14} strokeWidth={2} aria-hidden="true" />
              </div>
              <div
                className={`menu-item ${activeTab === 'rpa' ? 'active' : ''}`}
                onClick={() => { void selectRpaTask(null).then(() => setActiveTab('rpa')) }}
                title="RPA 任务"
              >
                <div className="menu-item-left"><Workflow size={18} strokeWidth={2} aria-hidden="true" /><span>RPA 任务</span></div>
                <ChevronRight className="menu-item-arrow" size={14} strokeWidth={2} aria-hidden="true" />
              </div>
              <div className={`menu-item ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')} title="日志">
                <div className="menu-item-left"><ScrollText size={18} strokeWidth={2} aria-hidden="true" /><span>日志</span></div>
                <ChevronRight className="menu-item-arrow" size={14} strokeWidth={2} aria-hidden="true" />
              </div>
              <div className={`menu-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')} title="设置">
                <div className="menu-item-left"><SettingsIcon /><span>设置</span></div>
                <ChevronRight className="menu-item-arrow" size={14} strokeWidth={2} aria-hidden="true" />
              </div>
            </div>
          )}
        </div>

        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <button className="theme-toggle-icon-btn" onClick={handleThemeToggle} title="切换主题">
            {theme === 'dark'
              ? <Sun size={18} strokeWidth={2} aria-hidden="true" />
              : <Moon size={18} strokeWidth={2} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* ── 2. Right Content Area ── */}
      <div className="agent-content-area">
        {/* ── 自定义标题栏 (Custom Titlebar) ── */}
        <div className="window-titlebar">
          <div className="titlebar-tabs-shell">
          <div ref={tabsViewportRef} className="titlebar-tabs" onDoubleClick={() => handleCreateNewSession()}>
            {workspaceTabs.map(tab => {
              const session = tab.kind === 'session'
                ? sessionsById.get(tab.sessionId)
                : undefined
              if (tab.kind === 'session' && !session) return null
              const isActive = tab.key === activeWorkspaceKey
              const isThinking = tab.kind === 'session' && checkIsThinking(session)
              const label = getWorkspaceTabLabel(tab)
              return (
                <div
                  key={tab.key}
                  ref={element => {
                    if (element) tabElementRefs.current.set(tab.key, element)
                    else tabElementRefs.current.delete(tab.key)
                  }}
                  className={`titlebar-tab ${tab.kind === 'page' ? 'function-tab' : ''} ${isActive ? 'active' : ''} ${isThinking ? 'thinking' : ''}`}
                  onClick={() => activateWorkspaceTab(tab)}
                >
                  {isThinking && <span className="tab-status-dot-pulse"></span>}
                  <span className="titlebar-tab-name" title={label}>{label}</span>
                  <span
                    className="titlebar-tab-close"
                    onClick={(e) => handleCloseTab(tab.key, e)}
                    title="关闭标签页"
                  >
                    <X size={12} strokeWidth={2} aria-hidden="true" />
                  </span>
                </div>
              )
            })}

            <button
              className="titlebar-new-tab-btn"
              onClick={() => handleCreateNewSession()}
              title="新建会话"
            >
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          {hiddenTabs.length > 0 && (
            <div className="titlebar-tab-overflow" ref={tabOverflowMenuRef}>
              <button
                className={`titlebar-tab-overflow-btn ${showTabOverflowMenu ? 'active' : ''}`}
                onClick={() => setShowTabOverflowMenu(prev => !prev)}
                title={`还有 ${hiddenTabs.length} 个标签`}
                aria-label="显示更多标签"
                aria-expanded={showTabOverflowMenu}
              >
                <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              {showTabOverflowMenu && (
                <div className="titlebar-tab-overflow-menu">
                  {hiddenTabs.map(tab => (
                    <div
                      key={tab.key}
                      className={`titlebar-tab-overflow-item ${tab.key === activeWorkspaceKey ? 'active' : ''}`}
                      onClick={() => {
                        activateWorkspaceTab(tab)
                        setShowTabOverflowMenu(false)
                      }}
                    >
                      <span title={getWorkspaceTabLabel(tab)}>{getWorkspaceTabLabel(tab)}</span>
                      <span
                        className="titlebar-tab-overflow-close"
                        onClick={event => {
                          handleCloseTab(tab.key, event)
                          setShowTabOverflowMenu(false)
                        }}
                        title="关闭标签页"
                      >
                        <X size={12} strokeWidth={2} aria-hidden="true" />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="titlebar-drag-region" aria-hidden="true" />
          </div>

          {/* 窗口控制按钮 */}
          <div className="titlebar-controls">
            <button
              className="titlebar-control-btn"
              onClick={() => window.api?.minimizeAgentWindow()}
              title="最小化"
            >
              <Minus size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              className="titlebar-control-btn"
              onClick={() => {
                window.api?.maximizeAgentWindow()
                setTimeout(checkMaximized, 100)
              }}
              title={isMaximized ? '向下还原' : '最大化'}
            >
              {isMaximized
                ? <Copy size={11} strokeWidth={1.6} aria-hidden="true" />
                : <Square size={10} strokeWidth={1.6} aria-hidden="true" />}
            </button>
            <button
              className="titlebar-control-btn close"
              onClick={() => window.api?.closeAgentWindow()}
              title="关闭"
            >
              <X size={12} strokeWidth={1.6} aria-hidden="true" />
            </button>
          </div>
        </div>

        {activeTab !== 'rpa' && (
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
                <button
                  className={`history-btn ${showFilePanel ? 'active' : ''}`}
                  onClick={() => {
                    setShowFilePanel(!showFilePanel)
                    if (showFilePanel) {
                      setPreviewFile(null)
                      setOpenTabs([])
                    }
                  }}
                  title={showFilePanel ? '关闭文件预览区域' : '打开文件预览区域'}
                  aria-label={showFilePanel ? '关闭文件预览区域' : '打开文件预览区域'}
                >
                  {showFilePanel
                    ? <PanelRightClose size={18} strokeWidth={2} aria-hidden="true" />
                    : <PanelRightOpen size={18} strokeWidth={2} aria-hidden="true" />}
                  {visibleFileCount > 0 && <span>{visibleFileCount}</span>}
                </button>
                <button
                  className="history-btn"
                  onClick={() => setShowHistoryDropdown(!showHistoryDropdown)}
                  title="查看历史提问"
                >
                  <List size={18} strokeWidth={2} aria-hidden="true" />
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
        )}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div className={`content-body tab-${activeTab}`} style={{ flex: 1, minWidth: 0 }}>
            {renderPage()}
          </div>

          {/* 右侧文件面板 */}
          {showFilePanel && activeTab === 'chat' && (
            <Suspense fallback={<PageLoadingFallback />}>
              <FilePreviewPanel store={store} />
            </Suspense>
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
              <button className="mcp-modal-close-btn" onClick={() => setSessionToDeleteId(null)} title="关闭">
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
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
                <KeyRound size={18} strokeWidth={2} aria-hidden="true" />
                <span>缺少大模型配置</span>
              </div>
              <button
                className="mcp-modal-close-btn"
                style={{ fontSize: '20px', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                onClick={() => setShowApiKeyModal(false)}
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
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
        <div
          className={`global-toast-notification ${toast.type} ${activePermissionRequest ? 'has-approval' : ''}`}
          role="button"
          tabIndex={0}
          title="点击回到 AgentPet"
          onClick={() => window.api?.openAgentWindow?.()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              window.api?.openAgentWindow?.()
            }
          }}
        >
          <span className="toast-icon">
            {toast.type === 'success' && <CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" />}
            {toast.type === 'error' && <CircleX size={18} strokeWidth={2} aria-hidden="true" />}
            {toast.type === 'info' && <Lightbulb size={18} strokeWidth={2} aria-hidden="true" />}
          </span>
          <span className="toast-message">{toast.message}</span>
        </div>
      )}

      {/* 全局初始化过渡页面 */}
      {showSplash && (
        <div className={`splash-container ${splashFadeOut ? 'fade-out' : ''}`}>
          <div className="splash-title">AgentPet</div>
        </div>
      )}

    </div>
  )
}

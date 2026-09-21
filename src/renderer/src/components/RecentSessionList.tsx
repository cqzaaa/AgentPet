import React, { useState, useMemo, useRef, useEffect } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import type { Session } from '../hooks/useAppStore'
import {
  ChevronRight,
  FolderOpen,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X
} from 'lucide-react'

// ── 分组定义 ──────────────────────────────────────────────────
type TimeGroupKey = 'today' | 'yesterday' | 'thisWeek' | 'earlier'
type GroupKey = 'pinned' | 'projects' | TimeGroupKey

const GROUP_LABELS: Record<GroupKey, string> = {
  pinned: '置顶',
  projects: '项目',
  today: '今天',
  yesterday: '昨天',
  thisWeek: '这周',
  earlier: '更早'
}

const TIME_GROUP_ORDER: TimeGroupKey[] = ['today', 'yesterday', 'thisWeek', 'earlier']

function getSessionUpdatedTime(session: Session): string {
  const messages = session.messages || []
  for (let index = messages.length - 1; index >= 0; index--) {
    const messageTime = messages[index]?.time
    if (typeof messageTime === 'string' && messageTime.trim()) return messageTime
  }
  return session.time || session.createdAt || ''
}

function parseSessionTime(rawTime: string): Date | null {
  if (!rawTime) return null
  const direct = new Date(rawTime)
  if (!Number.isNaN(direct.getTime())) return direct
  const local = new Date(rawTime.replace(/-/g, '/'))
  return Number.isNaN(local.getTime()) ? null : local
}

function getTimeGroup(session: Session): TimeGroupKey {
  const date = parseSessionTime(getSessionUpdatedTime(session))
  if (!date) return 'earlier'

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sessionDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((today.getTime() - sessionDay.getTime()) / 86400000)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'

  const dayOfWeek = today.getDay() || 7
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - dayOfWeek + 1)
  if (sessionDay >= weekStart) return 'thisWeek'
  return 'earlier'
}

// 取最后一条非系统消息作为预览
function getPreview(s: Session): string {
  const msgs = s.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.sender === 'system' || m.isThinking) continue
    const text = (m.text || '')
      .replace(/```[\s\S]*?```/g, '[代码]')
      .replace(/[-*_`#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) {
      const fileNames = Array.isArray(m.fileInfos)
        ? m.fileInfos.map((file: { name?: string }) => file.name).filter(Boolean)
        : []
      if (fileNames.length > 0) return `附件：${fileNames.join('、')}`
      if (m.fileInfo?.name) return `附件：${m.fileInfo.name}`
      continue
    }
    return text.length > 40 ? text.slice(0, 40) + '…' : text
  }
  return (s.contextSummary || '').replace(/\s+/g, ' ').trim()
}

function checkIsThinking(s: Session): boolean {
  const msgs = s.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.sender === 'agent') return !!m.isThinking
  }
  return false
}

function getDisplayTitle(session: Session): string {
  const storedName = String(session.name || '')
  if (!storedName.endsWith('...')) return storedName
  const firstUserMessage = session.messages?.find((message) => message?.sender === 'user')
  const sourceText = String(firstUserMessage?.text || '').replace(/\s+/g, ' ').trim()
  if (!sourceText) return storedName
  return sourceText
}

// 扁平化的渲染单元
type RenderRow =
  | { type: 'header'; key: string; groupKey: GroupKey; label: string }
  | { type: 'workspace'; key: string; path: string; count: number }
  | { type: 'showMore'; key: string; groupId: string; remaining: number }
  | { type: 'item'; key: string; session: Session }

interface Props {
  sessions: Session[]
  activeSessionId: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string) => void
  onRename: (id: string, name: string) => void
}

function getWorkspaceName(path: string): string {
  const segments = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  return segments[segments.length - 1] || path
}

export function RecentSessionList(props: Props): React.JSX.Element {
  const {
    sessions,
    activeSessionId,
    onSelect,
    onDelete,
    onTogglePin,
    onRename
  } = props

  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<GroupKey, boolean>>({
    pinned: true,
    projects: true,
    today: true,
    yesterday: true,
    thisWeek: true,
    earlier: true
  })
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>({})
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Record<string, boolean>>({})

  const toggleGroup = (g: GroupKey): void => {
    if (!collapsedGroups[g]) {
      setExpandedSessionGroups((previous) => {
        if (g === 'pinned') return { ...previous, pinned: false }
        if (g === 'projects') {
          return Object.fromEntries(
            Object.entries(previous).map(([key, value]) => [
              key,
              key.startsWith('workspace:') ? false : value
            ])
          )
        }
        return { ...previous, [`time:${g}`]: false }
      })
    }
    setCollapsedGroups((previous) => ({
      ...previous,
      [g]: !previous[g]
    }))
  }

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    sessionId: string
  } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const hasLocatedInitialSessionRef = useRef(false)

  useEffect(() => {
    if (!activeSessionId || hasLocatedInitialSessionRef.current) return
    const activeSession = sessions.find((session) => session.id === activeSessionId)
    if (!activeSession) return
    const frame = requestAnimationFrame(() => {
      hasLocatedInitialSessionRef.current = true
      const targetGroup: GroupKey = activeSession.pinned
        ? 'pinned'
        : activeSession.workspacePath
          ? 'projects'
          : getTimeGroup(activeSession)
      setCollapsedGroups((previous) => ({ ...previous, [targetGroup]: false }))

      if (activeSession.workspacePath) {
        setCollapsedWorkspaces((previous) => ({
          ...previous,
          [activeSession.workspacePath as string]: false
        }))
      }

      const activeListId = activeSession.pinned
        ? 'pinned'
        : activeSession.workspacePath
          ? `workspace:${activeSession.workspacePath}`
          : `time:${getTimeGroup(activeSession)}`
      setExpandedSessionGroups((previous) => ({ ...previous, [activeListId]: true }))

    })
    return () => cancelAnimationFrame(frame)
  }, [activeSessionId, sessions])

  // 搜索过滤
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(
      (s) => (s.name || '').toLowerCase().includes(q) || getPreview(s).toLowerCase().includes(q)
    )
  }, [sessions, searchQuery])

  // 分组并扁平化
  const rows = useMemo<RenderRow[]>(() => {
    const hasQuery = searchQuery.trim().length > 0
    // 搜索时不显示分组标题，只保留置顶排序
    if (hasQuery) {
      return filteredSessions.map((s) => ({
        type: 'item' as const,
        key: `item-${s.id}`,
        session: s
      }))
    }
    const pinnedSessions: Session[] = []
    const workspaceBuckets = new Map<string, Session[]>()
    const chatSessions: Session[] = []
    for (const s of filteredSessions) {
      if (s.pinned) {
        pinnedSessions.push(s)
      } else if (s.workspacePath) {
        const workspaceSessions = workspaceBuckets.get(s.workspacePath) || []
        workspaceSessions.push(s)
        workspaceBuckets.set(s.workspacePath, workspaceSessions)
      } else {
        chatSessions.push(s)
      }
    }
    const out: RenderRow[] = []
    const appendSessions = (groupId: string, groupedSessions: Session[]): void => {
      const visibleSessions = expandedSessionGroups[groupId]
        ? groupedSessions
        : groupedSessions.slice(0, 5)
      for (const session of visibleSessions) {
        out.push({ type: 'item', key: `item-${session.id}`, session })
      }
      if (!expandedSessionGroups[groupId] && groupedSessions.length > 5) {
        out.push({
          type: 'showMore',
          key: `show-more-${groupId}`,
          groupId,
          remaining: groupedSessions.length - 5
        })
      }
    }
    out.push({
      type: 'header',
      key: 'header-pinned',
      groupKey: 'pinned',
      label: GROUP_LABELS.pinned
    })
    if (!collapsedGroups.pinned) {
      appendSessions('pinned', pinnedSessions)
    }

    out.push({
      type: 'header',
      key: 'header-projects',
      groupKey: 'projects',
      label: GROUP_LABELS.projects
    })
    if (!collapsedGroups.projects) {
      for (const [path, workspaceSessions] of workspaceBuckets) {
        out.push({
          type: 'workspace',
          key: `workspace-${path}`,
          path,
          count: workspaceSessions.length
        })
        if (!collapsedWorkspaces[path]) {
          appendSessions(`workspace:${path}`, workspaceSessions)
        }
      }
    }

    const timeBuckets: Record<TimeGroupKey, Session[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      earlier: []
    }
    for (const session of chatSessions) {
      timeBuckets[getTimeGroup(session)].push(session)
    }
    for (const timeGroup of TIME_GROUP_ORDER) {
      out.push({
        type: 'header',
        key: `header-${timeGroup}`,
        groupKey: timeGroup,
        label: GROUP_LABELS[timeGroup]
      })
      if (collapsedGroups[timeGroup]) continue
      appendSessions(`time:${timeGroup}`, timeBuckets[timeGroup])
    }
    return out
  }, [filteredSessions, searchQuery, collapsedGroups, collapsedWorkspaces, expandedSessionGroups])

  useEffect(() => {
    if (searchQuery.trim()) return
    const activeIndex = rows.findIndex(
      (row) => row.type === 'item' && row.session.id === activeSessionId
    )
    if (activeIndex < 0) return
    const frame = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: activeIndex, align: 'center', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeSessionId, rows, searchQuery])

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  // 重命名时聚焦输入框
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const handleContextMenu = (e: React.MouseEvent, sessionId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId })
  }

  const startRename = (session: Session): void => {
    setRenamingId(session.id)
    setRenamingValue(session.name || '')
    setContextMenu(null)
  }

  const commitRename = (): void => {
    if (renamingId) {
      onRename(renamingId, renamingValue)
    }
    setRenamingId(null)
    setRenamingValue('')
  }

  const cancelRename = (): void => {
    setRenamingId(null)
    setRenamingValue('')
  }

  const renderRow = (index: number): React.ReactNode => {
    const row = rows[index]
    if (row.type === 'showMore') {
      return (
        <button
          type="button"
          className="recent-show-more"
          onClick={() =>
            setExpandedSessionGroups((previous) => ({ ...previous, [row.groupId]: true }))
          }
        >
          展开显示
          <span>+{row.remaining}</span>
        </button>
      )
    }
    if (row.type === 'workspace') {
      const isCollapsed = Boolean(collapsedWorkspaces[row.path])
      return (
        <button
          type="button"
          className="workspace-group-header"
          title={row.path}
          onClick={() =>
            {
              if (!isCollapsed) {
                setExpandedSessionGroups((previous) => ({
                  ...previous,
                  [`workspace:${row.path}`]: false
                }))
              }
              setCollapsedWorkspaces((previous) => ({
                ...previous,
                [row.path]: !previous[row.path]
              }))
            }
          }
          aria-expanded={!isCollapsed}
        >
          <FolderOpen
            className="workspace-group-icon"
            size={16}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="workspace-group-name">{getWorkspaceName(row.path)}</span>
        </button>
      )
    }
    if (row.type === 'header') {
      const isCollapsed = collapsedGroups[row.groupKey]
      return (
        <div className="recent-group-header">
          <button
            type="button"
            className="recent-group-toggle"
            onClick={() => toggleGroup(row.groupKey)}
            aria-expanded={!isCollapsed}
          >
            <span>{row.label}</span>
            <span className="recent-group-arrow">
              <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
            </span>
          </button>
        </div>
      )
    }
    const s = row.session
    const isActive = s.id === activeSessionId
    const isRenaming = renamingId === s.id
    const displayTitle = getDisplayTitle(s)
    const isThinking = checkIsThinking(s)
    const sessionCopy = (
      <>
        {isThinking && <span className="recent-dot" title="正在处理" aria-label="正在处理" />}
        {s.pinned && (
          <span className="recent-pin-icon" title="已置顶">
            <Pin size={11} strokeWidth={1.8} aria-hidden="true" />
          </span>
        )}
        <div className="recent-meta">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="recent-rename-input"
              value={renamingValue}
              onChange={(e) => setRenamingValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename()
                else if (e.key === 'Escape') cancelRename()
              }}
              onBlur={commitRename}
              aria-label="会话名称"
              maxLength={50}
            />
          ) : (
            <span className="recent-title" title={displayTitle}>
              {s.id.startsWith('wechat:') && <span className="recent-source-badge">微信</span>}
              {displayTitle}
            </span>
          )}
        </div>
      </>
    )
    return (
      <div
        className={`recent-item ${isActive ? 'active' : ''} ${s.pinned ? 'pinned' : ''} ${s.workspacePath && !s.pinned ? 'workspace-session' : ''} ${isThinking ? 'thinking' : ''}`}
        title={s.workspacePath ? `${displayTitle}\n${s.workspacePath}` : displayTitle}
      >
        {isRenaming ? (
          <div className="recent-item-main is-renaming">{sessionCopy}</div>
        ) : (
          <button
            type="button"
            className="recent-item-main"
            onClick={() => onSelect(s.id)}
            onContextMenu={(e) => handleContextMenu(e, s.id)}
            onDoubleClick={() => startRename(s)}
            aria-current={isActive ? 'page' : undefined}
          >
            {sessionCopy}
          </button>
        )}
        {!isRenaming && (
          <button
            type="button"
            className="recent-delete-btn"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(s.id)
            }}
            title="删除会话"
            aria-label={`删除会话：${s.name}`}
          >
            <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="recent-list-wrapper" ref={containerRef}>
      <div className="recent-search-wrapper">
        <Search className="recent-search-icon" size={14} strokeWidth={1.8} aria-hidden="true" />
        <input
          ref={searchInputRef}
          className="recent-search-input"
          type="search"
          aria-label="搜索会话"
          placeholder="搜索会话"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            type="button"
            className="recent-search-clear"
            onClick={() => {
              setSearchQuery('')
              searchInputRef.current?.focus()
            }}
            title="清除搜索"
            aria-label="清除搜索"
          >
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="sidebar-recent-container">
        {rows.length === 0 ? (
          <div className="recent-empty">{searchQuery ? '未找到匹配的会话' : '暂无会话'}</div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={rows}
            itemContent={renderRow}
            style={{ height: '100%' }}
            computeItemKey={(_, row) => (row as RenderRow).key}
            defaultItemHeight={32}
            increaseViewportBy={{ top: 100, bottom: 100 }}
          />
        )}
      </div>

      {contextMenu && (
        <div
          className="recent-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const target = sessions.find((s) => s.id === contextMenu.sessionId)
            if (!target) return null
            const isWechat = target.id.startsWith('wechat:')
            return (
              <>
                {!isWechat && (
                  <button
                    type="button"
                    className="recent-context-item"
                    onClick={() => {
                      onTogglePin(target.id)
                      setContextMenu(null)
                    }}
                  >
                    {target.pinned ? (
                      <PinOff size={14} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Pin size={14} strokeWidth={2} aria-hidden="true" />
                    )}
                    {target.pinned ? '取消置顶' : '置顶'}
                  </button>
                )}
                <button
                  type="button"
                  className="recent-context-item"
                  onClick={() => startRename(target)}
                >
                  <Pencil size={14} strokeWidth={2} aria-hidden="true" />
                  重命名
                </button>
                <div className="recent-context-divider"></div>
                <button
                  type="button"
                  className="recent-context-item danger"
                  onClick={() => {
                    onDelete(target.id)
                    setContextMenu(null)
                  }}
                >
                  <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                  删除
                </button>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

import React, { useState, useMemo, useRef, useEffect } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { Session } from '../hooks/useAppStore'
import { ChevronDown, ChevronRight, Pencil, Pin, PinOff, Trash2, X } from 'lucide-react'

// ── 分组定义 ──────────────────────────────────────────────────
type GroupKey = 'pinned' | 'today' | 'yesterday' | 'thisWeek' | 'earlier'

const GROUP_LABELS: Record<GroupKey, string> = {
  pinned: '置顶',
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  earlier: '更早'
}

const GROUP_ORDER: GroupKey[] = ['pinned', 'today', 'yesterday', 'thisWeek', 'earlier']

// 将 "yyyy-MM-dd HH:mm:ss" 解析为当天 0 点的 Date
function parseSessionDate(time: string): Date | null {
  if (!time || time.length < 10) return null
  const d = new Date(time.replace(/-/g, '/'))
  if (isNaN(d.getTime())) return null
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function getGroupKey(s: Session): GroupKey {
  if (s.pinned) return 'pinned'
  const d = parseSessionDate(s.createdAt || s.time)
  if (!d) return 'earlier'
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffDays = Math.round((today.getTime() - d.getTime()) / 86400000)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays <= 7) return 'thisWeek'
  return 'earlier'
}

// 取最后一条非系统消息作为预览
function getPreview(s: Session): string {
  const msgs = s.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.sender === 'system' || m.isThinking) continue
    let text = (m.text || '').replace(/```[\s\S]*?```/g, '[代码]').replace(/[*_`#>\-]/g, '').replace(/\s+/g, ' ').trim()
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

// 扁平化的渲染单元
type RenderRow =
  | { type: 'header'; key: string; groupKey: GroupKey; label: string }
  | { type: 'item'; key: string; session: Session }

interface Props {
  sessions: Session[]
  activeSessionId: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string) => void
  onRename: (id: string, name: string) => void
}

export function RecentSessionList(props: Props): React.JSX.Element {
  const { sessions, activeSessionId, onSelect, onDelete, onTogglePin, onRename } = props

  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<GroupKey, boolean>>({
    pinned: false,
    today: false,
    yesterday: true,
    thisWeek: true,
    earlier: true
  })

  const toggleGroup = (g: GroupKey) => {
    setCollapsedGroups(prev => ({
      ...prev,
      [g]: !prev[g]
    }))
  }

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // 搜索过滤
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(s => (s.name || '').toLowerCase().includes(q) || getPreview(s).toLowerCase().includes(q))
  }, [sessions, searchQuery])

  // 分组并扁平化
  const rows = useMemo<RenderRow[]>(() => {
    const hasQuery = searchQuery.trim().length > 0
    // 搜索时不显示分组标题，只保留置顶排序
    if (hasQuery) {
      return filteredSessions.map(s => ({ type: 'item' as const, key: `item-${s.id}`, session: s }))
    }
    const buckets: Record<GroupKey, Session[]> = { pinned: [], today: [], yesterday: [], thisWeek: [], earlier: [] }
    for (const s of filteredSessions) {
      // 置顶的归到 pinned，其余按时间
      const k = getGroupKey(s)
      buckets[k].push(s)
    }
    const out: RenderRow[] = []
    for (const g of GROUP_ORDER) {
      if (buckets[g].length === 0) continue
      out.push({ type: 'header', key: `header-${g}`, groupKey: g, label: GROUP_LABELS[g] })
      if (!collapsedGroups[g]) {
        for (const s of buckets[g]) {
          out.push({ type: 'item', key: `item-${s.id}`, session: s })
        }
      }
    }
    return out
  }, [filteredSessions, searchQuery, collapsedGroups])

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
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
    if (row.type === 'header') {
      const isCollapsed = collapsedGroups[row.groupKey]
      return (
        <div
          className="recent-group-header"
          onClick={() => toggleGroup(row.groupKey)}
        >
          <span className="recent-group-arrow">
            {isCollapsed
              ? <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
              : <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />}
          </span>
          <span>{row.label}</span>
        </div>
      )
    }
    const s = row.session
    const isActive = s.id === activeSessionId
    const isRenaming = renamingId === s.id
    const preview = getPreview(s)
    const isThinking = checkIsThinking(s)
    return (
      <div
        className={`recent-item ${isActive ? 'active' : ''} ${s.pinned ? 'pinned' : ''} ${isThinking ? 'thinking' : ''}`}
        onClick={() => { if (!isRenaming) onSelect(s.id) }}
        onContextMenu={(e) => handleContextMenu(e, s.id)}
        onDoubleClick={() => startRename(s)}
        title={s.name}
      >
        <span className="recent-dot"></span>
        {s.pinned && <span className="recent-pin-icon" title="已置顶"><Pin size={12} strokeWidth={2} aria-hidden="true" /></span>}
        <div className="recent-meta">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="recent-rename-input"
              value={renamingValue}
              onChange={(e) => setRenamingValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') cancelRename()
              }}
              onBlur={commitRename}
              maxLength={50}
            />
          ) : (
            <>
              <span className="recent-title" title={s.name}>
                {s.id.startsWith('wechat:') && (
                  <span style={{
                    display: 'inline-block',
                    fontSize: '10px',
                    padding: '1px 5px',
                    borderRadius: '4px',
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#10b981',
                    marginRight: '6px',
                    fontWeight: 600,
                    verticalAlign: 'middle',
                    lineHeight: '1.2'
                  }}>
                    微信
                  </span>
                )}
                {s.name}
              </span>
              <span className="recent-preview" title={preview}>{preview || '暂无消息'}</span>
            </>
          )}
        </div>
        {!isRenaming && (
          <button
            className="recent-delete-btn"
            onClick={(e) => { e.stopPropagation(); onDelete(s.id) }}
            title="删除会话"
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
        <input
          className="recent-search-input"
          type="text"
          placeholder="搜索会话..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="recent-search-clear" onClick={() => setSearchQuery('')} title="清除搜索">
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="sidebar-recent-container">
        {rows.length === 0 ? (
          <div className="recent-empty">{searchQuery ? '未找到匹配的会话' : '暂无会话'}</div>
        ) : (
          <Virtuoso
            data={rows}
            itemContent={renderRow}
            style={{ height: '100%' }}
            computeItemKey={(_, row) => (row as RenderRow).key}
            defaultItemHeight={56}
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
            const target = sessions.find(s => s.id === contextMenu.sessionId)
            if (!target) return null
            const isWechat = target.id.startsWith('wechat:')
            return (
              <>
                {!isWechat && (
                  <div
                    className="recent-context-item"
                    onClick={() => { onTogglePin(target.id); setContextMenu(null) }}
                  >
                    {target.pinned
                      ? <PinOff size={14} strokeWidth={2} aria-hidden="true" />
                      : <Pin size={14} strokeWidth={2} aria-hidden="true" />}
                    {target.pinned ? '取消置顶' : '置顶'}
                  </div>
                )}
                <div
                  className="recent-context-item"
                  onClick={() => startRename(target)}
                >
                  <Pencil size={14} strokeWidth={2} aria-hidden="true" />
                  重命名
                </div>
                <div className="recent-context-divider"></div>
                <div
                  className="recent-context-item danger"
                  onClick={() => { onDelete(target.id); setContextMenu(null) }}
                >
                  <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                  删除
                </div>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

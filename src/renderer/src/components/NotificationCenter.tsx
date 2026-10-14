import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Bell,
  CheckCheck,
  Trash2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  CalendarClock,
  Sparkles,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStoreRaw, type AppNotification } from '../hooks/useAppStore'
import { Tooltip } from './Tooltip'
import './NotificationCenter.css'

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}分钟前`
  const date = new Date(timestamp)
  const isToday = new Date().toDateString() === date.toDateString()
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  if (isToday) return `${hours}:${minutes}`
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

export function NotificationCenter(): React.JSX.Element {
  const {
    notifications = [],
    markNotificationRead,
    markAllNotificationsRead,
    removeNotification,
    clearAllNotifications,
    cronTasks = [],
    setSelectedCronLogDetails,
    theme = 'light'
  } = useAppStoreRaw(useShallow(state => ({
    notifications: state.notifications,
    markNotificationRead: state.markNotificationRead,
    markAllNotificationsRead: state.markAllNotificationsRead,
    removeNotification: state.removeNotification,
    clearAllNotifications: state.clearAllNotifications,
    cronTasks: state.cronTasks,
    setSelectedCronLogDetails: state.setSelectedCronLogDetails,
    theme: state.theme
  })))

  const [isOpen, setIsOpen] = useState(false)
  const [activeFilter, setActiveFilter] = useState<'all' | 'task' | 'system'>('all')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const unreadCount = useMemo(() => {
    return notifications.filter(n => !n.read).length
  }, [notifications])

  const filteredNotifications = useMemo(() => {
    return notifications.filter(n => {
      if (activeFilter === 'task') return n.type === 'task'
      if (activeFilter === 'system') return n.type === 'system' || n.type === 'alert' || n.type === 'agent'
      return true
    })
  }, [notifications, activeFilter])

  // 计算弹窗对齐位置
  const updatePosition = () => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    // 面板向下展开，稍微偏移留出呼吸感
    const top = rect.bottom + 8
    // 尽量靠左对齐，但防止超出屏幕
    let left = rect.left - 4
    if (left + 360 > window.innerWidth - 12) {
      left = window.innerWidth - 372
    }
    if (left < 12) left = 12
    setPopoverPos({ top, left })
  }

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isOpen) {
      updatePosition()
      setIsOpen(true)
    } else {
      setIsOpen(false)
    }
  }

  // 监听窗口缩放与按键关闭
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }

    const handleResize = () => {
      updatePosition()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [isOpen])

  const toggleExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleItemClick = (item: AppNotification) => {
    if (!item.read) {
      markNotificationRead(item.id)
    }
    // 如果是定时任务相关通知，不跳转页面，直接原地弹出任务执行详情 Modal
    if (item.type === 'task' && item.metadata?.taskId) {
      const taskId = item.metadata.taskId
      const logId = item.metadata.logId

      // 如果当前已有任务数据，直接同步定位打开详情弹窗
      const task = cronTasks.find(t => t.id === taskId)
      let log = (task && logId && task.logs?.find(l => l.id === logId)) || (task?.logs && task.logs[task.logs.length - 1])
      if (!log && item.content) {
        log = {
          id: logId || `log_${item.id}`,
          time: formatTime(item.createdAt),
          status: item.status === 'error' ? 'failed' : 'success',
          message: item.title,
          messages: [
            {
              id: Date.now() - 1000,
              sender: 'user',
              text: task?.action ? `执行定时任务指令: ${task.action}` : item.title,
              time: formatTime(item.createdAt)
            },
            {
              id: Date.now(),
              sender: 'agent',
              text: item.content,
              time: formatTime(item.createdAt)
            }
          ]
        }
      }
      if (log && typeof setSelectedCronLogDetails === 'function') {
        setSelectedCronLogDetails(log)
      }
      setIsOpen(false)
    }
  }

  const getStatusIcon = (item: AppNotification) => {
    if (item.status === 'success') {
      return <CheckCircle2 size={15} strokeWidth={2.2} />
    }
    if (item.status === 'error') {
      return <AlertCircle size={15} strokeWidth={2.2} />
    }
    if (item.status === 'warning') {
      return <AlertTriangle size={15} strokeWidth={2.2} />
    }
    if (item.type === 'task') {
      return <CalendarClock size={15} strokeWidth={2} />
    }
    return <Info size={15} strokeWidth={2} />
  }

  const portalTarget = typeof document !== 'undefined'
    ? (document.querySelector<HTMLElement>('.agent-window-container') || document.body)
    : null

  return (
    <>
      <Tooltip content={unreadCount > 0 ? `通知中心 (${unreadCount}条未读)` : '通知中心'} placement="bottom">
        <button
          ref={triggerRef}
          type="button"
          className={`notification-center-trigger ${isOpen ? 'active' : ''}`}
          onClick={handleToggle}
          aria-label="打开通知中心"
        >
          <Bell size={14} strokeWidth={2} />
          {unreadCount > 0 && (
            unreadCount > 9 ? (
              <span className="notification-badge">9+</span>
            ) : (
              <span className="notification-badge-dot" />
            )
          )}
        </button>
      </Tooltip>

      {isOpen && portalTarget && createPortal(
        <>
          <div
            className="notification-popover-backdrop"
            onClick={() => setIsOpen(false)}
          />
          <section
            ref={panelRef}
            className={`notification-popover-panel ${theme}`}
            style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
            onClick={e => e.stopPropagation()}
            aria-label="通知中心面板"
          >
            {/* Header */}
            <div className="notification-panel-header">
              <div className="notification-header-title-group">
                <span className="notification-header-title">通知中心</span>
                {notifications.length > 0 && (
                  <span className="notification-header-pill">
                    {unreadCount > 0 ? `${unreadCount} 未读` : `${notifications.length} 全部`}
                  </span>
                )}
              </div>
              <div className="notification-header-actions">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="notification-action-btn"
                    onClick={() => markAllNotificationsRead()}
                    title="全部标记为已读"
                  >
                    <CheckCheck size={14} />
                    <span>全部已读</span>
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    type="button"
                    className="notification-action-btn danger"
                    onClick={() => clearAllNotifications()}
                    title="清空所有通知"
                  >
                    <Trash2 size={13} />
                    <span>清空</span>
                  </button>
                )}
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="notification-filter-tabs">
              <button
                type="button"
                className={`notification-tab-btn ${activeFilter === 'all' ? 'active' : ''}`}
                onClick={() => setActiveFilter('all')}
              >
                全部 ({notifications.length})
              </button>
              <button
                type="button"
                className={`notification-tab-btn ${activeFilter === 'task' ? 'active' : ''}`}
                onClick={() => setActiveFilter('task')}
              >
                任务 ({notifications.filter(n => n.type === 'task').length})
              </button>
              <button
                type="button"
                className={`notification-tab-btn ${activeFilter === 'system' ? 'active' : ''}`}
                onClick={() => setActiveFilter('system')}
              >
                系统 ({notifications.filter(n => n.type !== 'task').length})
              </button>
            </div>

            {/* Notification List */}
            <div className="notification-list">
              {filteredNotifications.length === 0 ? (
                <div className="notification-empty-state">
                  <div className="notification-empty-icon-wrap">
                    <Sparkles size={20} strokeWidth={1.8} />
                  </div>
                  <div className="notification-empty-title">暂无通知</div>
                </div>
              ) : (
                filteredNotifications.map(item => {
                  const isExpanded = expandedIds.has(item.id)
                  const iconStatus = item.status || (item.type === 'task' ? 'task' : 'info')
                  return (
                    <div
                      key={item.id}
                      className={`notification-item ${!item.read ? 'unread' : ''} ${isExpanded ? 'expanded' : ''}`}
                      onClick={() => handleItemClick(item)}
                    >
                      <div className={`notification-item-icon-box ${iconStatus}`}>
                        {getStatusIcon(item)}
                      </div>
                      <div className="notification-item-content">
                        <div className="notification-item-top">
                          <span className="notification-item-title" title={item.title}>
                            {item.title}
                          </span>
                          <span className="notification-item-time">
                            {formatTime(item.createdAt)}
                          </span>
                        </div>
                        {item.content && (
                          <div
                            className="notification-item-desc"
                            onClick={e => toggleExpand(item.id, e)}
                            title={isExpanded ? '点击收起' : '点击展开全部内容'}
                          >
                            {item.content}
                          </div>
                        )}
                        {item.type === 'task' && (
                          <span className="notification-item-tag">定时自动化任务</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="notification-item-delete"
                        onClick={e => {
                          e.stopPropagation()
                          removeNotification(item.id)
                        }}
                        title="删除该条通知"
                        aria-label="删除该条通知"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </section>
        </>,
        portalTarget
      )}
    </>
  )
}

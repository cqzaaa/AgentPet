import React, { useState, useRef, useEffect } from 'react'
import { useAppStore } from '../hooks/useAppStore'
import { ChatPage } from '../pages/ChatPage'
import { ControlPage } from '../pages/ControlPage'
import { AgentPage } from '../pages/AgentPage'
import { SettingsPage } from '../pages/SettingsPage'
import { ChatIcon, OverviewIcon, SkillsIcon, SettingsIcon } from './icons/Icons'
import { LogsPage } from '../pages/LogsPage'
import iconFromImage from '../assets/icon.png'

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
    handleCreateNewSession, handleDeleteSession,
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
          {/* Brand/Avatar Info */}
          <div className="sidebar-brand">
            <div className="brand-left">
              <div className="brand-avatar" style={{ background: 'transparent', boxShadow: 'none' }}>
                <img src={iconFromImage} alt="icon" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', transform: 'scale(1)' }} />
              </div>
              {!isCollapsed && (
                <div className="brand-info">
                  <span className="brand-name">agentself</span>
                  <span className="brand-status">
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

          {/* 最近会话滚动列表 */}
          {!isCollapsed && <div className="sidebar-recent-title">最近会话</div>}
          {!isCollapsed && (
            <div className="sidebar-recent-container">
              {sessions.map(session => (
                <div
                  key={session.id}
                  className={`recent-item ${activeSessionId === session.id ? 'active' : ''}`}
                  onClick={() => { setActiveSessionId(session.id); setActiveTab('chat') }}
                  title={session.name}
                >
                  <span className="recent-dot"></span>
                  <div className="recent-meta">
                    <span className="recent-title">{session.name}</span>
                    <span className="recent-time">{session.time}</span>
                  </div>
                  <button
                    className="recent-delete-btn"
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id) }}
                    title="删除会话"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Menu Items */}
          <div className="sidebar-menu">
            <div className={`menu-item ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')} title="会话">
              <div className="menu-item-left">
                <ChatIcon />
                <span>聊天</span>
                {activePermissionRequest && (
                  <span className="menu-sandbox-badge" title="有待审批的终端命令">●</span>
                )}
              </div>
              <span className="menu-item-arrow">&gt;</span>
            </div>
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
        <div className={`content-body tab-${activeTab}`}>
          {renderPage()}
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

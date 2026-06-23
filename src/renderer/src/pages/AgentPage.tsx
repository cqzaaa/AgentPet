import React from 'react'
import { formatBytes } from '../utils/helpers'
import type { AppStore } from '../hooks/useAppStore'
import { ChatMessageItem } from '../components/ChatMessageItem'

interface AgentPageProps {
  store: AppStore
}

export function AgentPage({ store }: AgentPageProps): React.JSX.Element {
  const {
    agentSubTab, setAgentSubTab,
    // skills
    skillsList, skillsPath,
    handleSkillsPathClick, handleImportSkill, handleDeleteSkill,
    // memory
    autoSaveHistory, setAutoSaveHistory,
    contextRounds, setContextRounds,
    activeSessionId, setSessions,
    currentAvatarName,
    // cron
    cronTasks,
    handleToggleCronTask, handleDeleteCronTask, handleClearCronLogs, handleAddCronTask, handleEditCronTask,
    selectedTaskForLog, setSelectedTaskForLog,
    selectedCronLogDetails, setSelectedCronLogDetails,
    // mcp
    mcpConfig, saveMcpConfig, showToast
  } = store

  const [mcpNewName, setMcpNewName] = React.useState('')
  const [mcpNewUrl, setMcpNewUrl] = React.useState('')
  const [mcpNewApiKey, setMcpNewApiKey] = React.useState('')
  const [mcpNewType, setMcpNewType] = React.useState<'stream' | 'sse' | 'auto'>('stream')
  const [showAddMcpForm, setShowAddMcpForm] = React.useState(false)

  // 编辑弹窗相关状态
  const [showEditModal, setShowEditModal] = React.useState(false)
  const [editingServer, setEditingServer] = React.useState<any>(null)
  const [editName, setEditName] = React.useState('')
  const [editUrl, setEditUrl] = React.useState('')
  const [editApiKey, setEditApiKey] = React.useState('')
  const [editType, setEditType] = React.useState<'stream' | 'sse' | 'auto'>('stream')

  // MCP 测试结果弹框状态
  const [showTestResultModal, setShowTestResultModal] = React.useState(false)
  const [testResultData, setTestResultData] = React.useState<any>(null)
  const [testResultServerName, setTestResultServerName] = React.useState('')

  // 定时任务编辑/新增状态
  const [showCronModal, setShowCronModal] = React.useState(false)
  const [editingCron, setEditingCron] = React.useState<any>(null)
  const [cronName, setCronName] = React.useState('')
  const [cronHours, setCronHours] = React.useState<number>(0)
  const [cronMinutes, setCronMinutes] = React.useState<number>(1)
  const [cronSeconds, setCronSeconds] = React.useState<number>(0)
  const [cronAction, setCronAction] = React.useState('')
  const [openDropdownId, setOpenDropdownId] = React.useState<string | null>(null)

  // 点击空白处关闭下拉菜单
  React.useEffect(() => {
    const handleClick = () => setOpenDropdownId(null)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [])

  const formatInterval = (totalSeconds: number) => {
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    let res = ''
    if (h > 0) res += `${h}小时 `
    if (m > 0) res += `${m}分钟 `
    if (s > 0 || (h === 0 && m === 0)) res += `${s}秒`
    return res.trim()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sub Nav */}
      <div className="sub-tab-nav">
        <div className={`sub-tab-item ${agentSubTab === 'skills' ? 'active' : ''}`} onClick={() => setAgentSubTab('skills')}>
          技能加入
        </div>
        <div className={`sub-tab-item ${agentSubTab === 'memory' ? 'active' : ''}`} onClick={() => setAgentSubTab('memory')}>
          记忆控制
        </div>
        <div className={`sub-tab-item ${agentSubTab === 'cron' ? 'active' : ''}`} onClick={() => setAgentSubTab('cron')}>
          定时任务
        </div>
        <div className={`sub-tab-item ${agentSubTab === 'mcp' ? 'active' : ''}`} onClick={() => setAgentSubTab('mcp')}>
          MCP 服务
        </div>
      </div>

      {/* Sub Panel */}
      <div className="sub-content-panel">
        {/* ── 技能加入 ── */}
        {agentSubTab === 'skills' && (
          <div>
            <div className="skills-action-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span
                className="storage-path-display"
                style={{ flex: 1, marginRight: '16px', border: '1px solid var(--border-card)', cursor: 'pointer' }}
                onClick={handleSkillsPathClick}
                title="点击选择新的存放路径"
              >
                📁 存放路径: {skillsPath || '正在加载技能目录...'}
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-secondary" onClick={() => window.api.openSkillsFolder()}>
                  打开目录
                </button>
                <button className="btn-primary" onClick={handleImportSkill}>
                  导入技能包 (.zip)
                </button>
              </div>
            </div>

            <div className="skills-table-wrapper">
              {skillsList.length > 0 ? (
                <table className="skills-table">
                  <thead>
                    <tr>
                      <th>技能包名称</th>
                      <th>文件格式</th>
                      <th>文件大小</th>
                      <th>导入日期</th>
                      <th style={{ textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillsList.map(skill => (
                      <tr key={skill.name}>
                        <td style={{ fontWeight: 600 }}>{skill.name}</td>
                        <td><span className="skill-zip-badge">ZIP</span></td>
                        <td>{formatBytes(skill.size)}</td>
                        <td>{new Date(skill.mtime).toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="delete-btn" onClick={() => handleDeleteSkill(skill.name)}>
                            🗑️ 卸载
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty-state">
                  本地没有已加载的 ZIP 技能包。请点击"导入技能包"选择 ZIP 压缩文件。
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 记忆控制 ── */}
        {agentSubTab === 'memory' && (
          <div className="settings-sub-panel" style={{ maxWidth: '900px' }}>
            <div className="settings-section-title">会话持久化控制</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-title">自动保存聊天历史</span>
                <span className="settings-row-desc">关闭后，关闭应用后会话记录将被自动清除。</span>
              </div>
              <input
                type="checkbox"
                id="autosave-switch"
                className="switch-checkbox"
                checked={autoSaveHistory}
                style={{ transform: 'scale(1.2)', cursor: 'pointer' }}
                onChange={e => {
                  setAutoSaveHistory(e.target.checked)
                  localStorage.setItem('agentpet_autosave', String(e.target.checked))
                }}
              />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-title">单次会话记忆上下文轮数</span>
                <span className="settings-row-desc">发送给大模型的前置聊天深度，当前轮数：{contextRounds} 轮对答。</span>
              </div>
              <select
                className="form-select"
                value={contextRounds}
                onChange={e => {
                  const val = Number(e.target.value)
                  setContextRounds(val)
                  localStorage.setItem('agentpet_context_rounds', String(val))
                }}
              >
                <option value="5">5 轮</option>
                <option value="10">10 轮</option>
                <option value="20">20 轮</option>
                <option value="50">50 轮</option>
              </select>
            </div>

            <div className="settings-section-title">本地存储清空</div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-title">清空当前会话缓存</span>
                <span className="settings-row-desc">清空当前选中会话的历史消息。</span>
              </div>
              <button
                className="delete-btn"
                style={{ border: '1px solid rgba(248,113,113,0.3)', padding: '6px 12px', borderRadius: '6px' }}
                onClick={() => {
                  if (confirm('确认清空当前会话历史吗？')) {
                    setSessions(prev => prev.map(s => {
                      if (s.id === activeSessionId) {
                        return {
                          ...s,
                          messages: [{ id: 1, sender: 'agent', text: '本会话记录已清空。', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]
                        }
                      }
                      return s
                    }))
                  }
                }}
              >
                🚨 清除当前
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-title">清空所有会话记录缓存</span>
                <span className="settings-row-desc">删除所有会话并还原为默认的空白会话。</span>
              </div>
              <button
                className="delete-btn"
                style={{ border: '1px solid rgba(248,113,113,0.3)', padding: '6px 12px', borderRadius: '6px' }}
                onClick={() => {
                  if (confirm('确认清除所有会话记录吗？')) {
                    const defaultSess = [{
                      id: 'agent:main:dashboard:default',
                      name: '新会话',
                      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                      messages: [{ id: 1, sender: 'agent', text: `会话记录已彻底清空。${currentAvatarName} 核心记忆已重置。`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]
                    }]
                    setSessions(defaultSess)
                    store.setActiveSessionId('agent:main:dashboard:default')
                  }
                }}
              >
                🚨 清空所有
              </button>
            </div>
          </div>
        )}

        {/* ── 定时任务 ── */}
        {agentSubTab === 'cron' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div className="settings-section-title" style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
                已配置的定时任务 ({cronTasks.length})
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setEditingCron(null)
                  setCronName('')
                  setCronHours(0)
                  setCronMinutes(1)
                  setCronSeconds(0)
                  setCronAction('')
                  setShowCronModal(true)
                }}
                style={{ height: '28px', padding: '0 12px', fontSize: '12px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                ➕ 新增任务
              </button>
            </div>

            <div className="skills-table-wrapper" style={{ overflow: 'visible' }}>
              <table className="cron-table" style={{ overflow: 'visible' }}>
                <thead>
                  <tr>
                    <th>任务名称</th>
                    <th>执行间隔</th>
                    <th>最近触发时间</th>
                    <th>触发次数</th>
                    <th>状态</th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {cronTasks.map(task => (
                    <tr key={task.id}>
                      <td style={{ fontWeight: 600 }}>{task.name}</td>
                      <td>{formatInterval(task.interval)}</td>
                      <td>{task.lastTriggered}</td>
                      <td><span className="cron-badge-trigger">{task.triggerCount} 次</span></td>
                      <td>
                        <span style={{ color: task.isActive ? '#10b981' : '#f87171', fontWeight: 'bold' }}>
                          {task.isActive ? '运行中' : '已暂停'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', position: 'relative' }}>
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '11px', marginRight: '8px' }}
                          onClick={() => {
                            const latestTask = cronTasks.find(t => t.id === task.id)
                            setSelectedTaskForLog(latestTask || task)
                          }}
                        >
                          📋 日志
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '11px' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpenDropdownId(openDropdownId === task.id ? null : task.id)
                          }}
                        >
                          ⚙️ 操作 ▾
                        </button>
                        
                        {openDropdownId === task.id && (
                          <div
                            style={{
                              position: 'absolute',
                              top: '100%',
                              right: '0',
                              marginTop: '4px',
                              background: 'var(--bg-card)',
                              border: '1px solid var(--border-card)',
                              borderRadius: '6px',
                              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                              zIndex: 10,
                              display: 'flex',
                              flexDirection: 'column',
                              minWidth: '100px',
                              overflow: 'hidden'
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div 
                              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px', textAlign: 'left', display: 'flex', gap: '8px', alignItems: 'center' }}
                              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-app)'}
                              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                              onClick={() => {
                                setEditingCron(task)
                                setCronName(task.name)
                                setCronHours(Math.floor(task.interval / 3600))
                                setCronMinutes(Math.floor((task.interval % 3600) / 60))
                                setCronSeconds(task.interval % 60)
                                setCronAction(task.action || '')
                                setShowCronModal(true)
                                setOpenDropdownId(null)
                              }}
                            >
                              ✏️ 编辑
                            </div>
                            <div 
                              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px', textAlign: 'left', display: 'flex', gap: '8px', alignItems: 'center' }}
                              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-app)'}
                              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                              onClick={() => {
                                handleToggleCronTask(task.id)
                                setOpenDropdownId(null)
                              }}
                            >
                              {task.isActive ? '⏸ 暂停' : '▶ 启动'}
                            </div>
                            {task.name !== '系统画像提纯与经验沉淀' && (
                              <div 
                                style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px', textAlign: 'left', color: '#ef4444', borderTop: '1px solid var(--border-card)', display: 'flex', gap: '8px', alignItems: 'center' }}
                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-app)'}
                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                onClick={() => {
                                  handleDeleteCronTask(task.id)
                                  setOpenDropdownId(null)
                                }}
                              >
                                🗑 移除
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 定时任务日志详情 Modal */}
            {selectedTaskForLog && (
              <div className="cron-modal-overlay" style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
              }}>
                <div className="cron-modal-content" style={{
                  width: '560px',
                  maxHeight: '80%',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-card)',
                  borderRadius: '12px',
                  padding: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)'
                }}>
                  {/* Modal Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--border-card)', paddingBottom: '12px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)' }}>
                      ⏰ 定时任务日志: {selectedTaskForLog.name}
                    </h3>
                    <button
                      onClick={() => {
                        setSelectedTaskForLog(null)
                        setSelectedCronLogDetails(null)
                      }}
                      style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '18px' }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Modal Body */}
                  <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px', minHeight: '200px', maxHeight: '400px' }}>
                    <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                      <strong>触发周期</strong>：每 {selectedTaskForLog.interval} 秒一次 | <strong>当前累计触发</strong>：{selectedTaskForLog.triggerCount} 次
                      <br />
                      <strong>动作指令</strong>：<code style={{ background: 'var(--bg-app)', padding: '2px 6px', borderRadius: '4px', display: 'inline-block', marginTop: '4px' }}>{selectedTaskForLog.action || '无'}</code>
                    </div>

                    <h4 style={{ margin: '16px 0 8px 0', fontSize: '13px', fontWeight: '600' }}>📄 执行历史日志</h4>

                    {selectedTaskForLog.logs && selectedTaskForLog.logs.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {selectedTaskForLog.logs.map((log: any) => {
                          let statusText = '🟢 成功'
                          let borderLeftColor = '#10b981'
                          if (log.status === 'failed') {
                            statusText = '🔴 失败'
                            borderLeftColor = '#ef4444'
                          } else if (log.status === 'running') {
                            statusText = '⏳ 执行中'
                            borderLeftColor = '#3b82f6'
                          }

                          return (
                            <div key={log.id} style={{
                              padding: '10px 12px',
                              background: 'var(--bg-app)',
                              borderLeft: `3px solid ${borderLeftColor}`,
                              borderRadius: '4px',
                              fontSize: '12px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between'
                            }}>
                              <div style={{ flex: 1, marginRight: '16px' }}>
                                <div style={{ display: 'flex', gap: '8px', color: 'var(--text-secondary)', marginBottom: '4px', fontSize: '11px' }}>
                                  <span style={{ fontWeight: '600' }}>{statusText}</span>
                                  <span>•</span>
                                  <span>{log.time}</span>
                                </div>
                                <div style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{log.message}</div>
                              </div>
                              <button
                                type="button"
                                className="btn-secondary"
                                style={{ padding: '4px 8px', fontSize: '11px', flexShrink: 0 }}
                                onClick={() => setSelectedCronLogDetails(log)}
                                disabled={!log.messages || log.messages.length === 0}
                                title={(!log.messages || log.messages.length === 0) ? "该日志未记录详细执行交互" : "查看执行详情"}
                              >
                                📋 详情
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="empty-state" style={{ padding: '40px 0', fontSize: '12px' }}>
                        暂无触发执行日志。
                      </div>
                    )}
                  </div>

                  {/* Modal Footer */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', borderTop: '1px solid var(--border-card)', paddingTop: '16px' }}>
                    <button
                      className="delete-btn"
                      style={{ border: '1px solid rgba(248,113,113,0.3)', padding: '6px 12px', borderRadius: '6px', fontSize: '12.5px' }}
                      onClick={async () => {
                        if (confirm('确认清空该任务的执行日志吗？')) {
                          await handleClearCronLogs(selectedTaskForLog.id)
                          setSelectedTaskForLog(prev => prev ? { ...prev, logs: [] } : null)
                          setSelectedCronLogDetails(null)
                        }
                      }}
                      disabled={!selectedTaskForLog.logs || selectedTaskForLog.logs.length === 0}
                    >
                      🗑 清空日志
                    </button>
                    <button
                      className="btn-primary"
                      style={{ padding: '6px 16px', borderRadius: '6px', fontSize: '12.5px' }}
                      onClick={() => {
                        setSelectedTaskForLog(null)
                        setSelectedCronLogDetails(null)
                      }}
                    >
                      关闭
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 二级 Modal: 定时任务执行详情 Chat 页面 */}
            {selectedCronLogDetails && (
              <div className="cron-modal-overlay" style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1001
              }}>
                <div className="cron-modal-content" style={{
                  width: '650px',
                  height: '80%',
                  maxHeight: '650px',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-card)',
                  borderRadius: '12px',
                  padding: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)'
                }}>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--border-card)', paddingBottom: '12px' }}>
                    <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '600', color: 'var(--text-primary)' }}>
                      📋 任务执行详情 ({selectedCronLogDetails.time})
                    </h3>
                    <button
                      onClick={() => setSelectedCronLogDetails(null)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '18px' }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Chat Content Body */}
                  <div className="chat-messages-box" style={{ flex: 1, overflowY: 'auto', marginBottom: '20px', paddingRight: '4px', background: 'var(--bg-content)', borderRadius: '8px', padding: '16px' }}>
                    {selectedCronLogDetails.messages && selectedCronLogDetails.messages.map((msg: any) => (
                      <ChatMessageItem
                        key={msg.id}
                        msg={msg}
                        currentAvatarName={currentAvatarName}
                      />
                    ))}
                  </div>

                  {/* Footer */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-card)', paddingTop: '16px' }}>
                    <button
                      className="btn-primary"
                      style={{ padding: '6px 20px', borderRadius: '6px', fontSize: '12.5px' }}
                      onClick={() => setSelectedCronLogDetails(null)}
                    >
                      确定
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 新增/编辑定时任务 Modal */}
            {showCronModal && (
              <div className="cron-modal-overlay" style={{
                position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(8px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1002
              }}>
                <div className="mcp-modal-card" onClick={e => e.stopPropagation()} style={{ width: '450px' }}>
                  <div className="mcp-modal-header">
                    <div className="mcp-modal-title">
                      <span>{editingCron ? '✏️ 编辑定时任务' : '➕ 新增定时任务'}</span>
                    </div>
                    <button className="mcp-modal-close-btn" onClick={() => setShowCronModal(false)}>×</button>
                  </div>
                  <div className="mcp-modal-body">
                    <div style={{ marginBottom: '12px' }}>
                      <label className="mcp-form-label">任务名称</label>
                      <input
                        type="text"
                        className="mcp-input-fancy"
                        placeholder="如：定时清理日志、系统状态巡检"
                        value={cronName}
                        onChange={e => setCronName(e.target.value)}
                        disabled={editingCron?.name === '系统画像提纯与经验沉淀'}
                        style={editingCron?.name === '系统画像提纯与经验沉淀' ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
                      />
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                      <label className="mcp-form-label">执行频率</label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
                          <input type="number" min="0" className="mcp-input-fancy" placeholder="小时" value={cronHours || ''} onChange={e => setCronHours(Number(e.target.value) || 0)} />
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>时</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
                          <input type="number" min="0" max="59" className="mcp-input-fancy" placeholder="分钟" value={cronMinutes || ''} onChange={e => setCronMinutes(Number(e.target.value) || 0)} />
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>分</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
                          <input type="number" min="0" max="59" className="mcp-input-fancy" placeholder="秒" value={cronSeconds || ''} onChange={e => setCronSeconds(Number(e.target.value) || 0)} />
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>秒</span>
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="mcp-form-label">动作指令 / 提示词</label>
                      <textarea
                        className="mcp-input-fancy"
                        style={{ minHeight: '80px', resize: 'vertical', ...(editingCron?.name === '系统画像提纯与经验沉淀' ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
                        placeholder="给助手的执行指令，例如：检查当前系统 CPU 状态"
                        value={cronAction}
                        onChange={e => setCronAction(e.target.value)}
                        disabled={editingCron?.name === '系统画像提纯与经验沉淀'}
                      />
                    </div>
                  </div>
                  <div className="mcp-modal-footer">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setShowCronModal(false)}
                      style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={async () => {
                        if (!cronName.trim()) {
                          showToast('请填写任务名称', 'error')
                          return
                        }
                        if (!cronAction.trim()) {
                          showToast('请填写动作指令/提示词', 'error')
                          return
                        }
                        const totalInterval = cronHours * 3600 + cronMinutes * 60 + cronSeconds
                        if (totalInterval < 5) {
                          showToast('执行频率不能少于 5 秒', 'error')
                          return
                        }
                        
                        if (editingCron) {
                          await handleEditCronTask(editingCron.id, {
                            name: cronName.trim(),
                            interval: totalInterval,
                            action: cronAction.trim()
                          })
                        } else {
                          await handleAddCronTask({
                            name: cronName.trim(),
                            interval: totalInterval,
                            action: cronAction.trim(),
                            isActive: true
                          })
                        }
                        setShowCronModal(false)
                      }}
                      style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
                    >
                      保存任务
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── MCP 服务 ── */}
        {agentSubTab === 'mcp' && (
          <div className="settings-sub-panel">
            <div className="form-desc-text" style={{ marginBottom: '12px' }}>
              配置并管理 Model Context Protocol (MCP) 服务列表。大模型及微信助手可自动并发连接并调用列表中处于启用状态的所有工具。
            </div>

            <div style={{ background: 'var(--bg-card-sub, rgba(128,128,128,0.02))', padding: '14px 18px', borderRadius: '8px', border: '1px solid var(--border-color, rgba(128,128,128,0.1))', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '2px', color: 'var(--text-color-strong)' }}>💡 发现更多外部 MCP 服务</div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>探索由开发者社区提供的丰富工具包</div>
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <a href="https://mcpmarket.cn/" target="_blank" rel="noreferrer" style={{ fontSize: '12.5px', color: '#3b82f6', textDecoration: 'none', fontWeight: 500 }}>
                  🇨🇳 MCP 中文市场 ↗
                </a>
                <span style={{ color: 'rgba(128,128,128,0.3)', fontSize: '12px' }}>|</span>
                <a href="https://www.modelscope.cn/mcp" target="_blank" rel="noreferrer" style={{ fontSize: '12.5px', color: '#3b82f6', textDecoration: 'none', fontWeight: 500 }}>
                  🔮 魔塔 ↗
                </a>
              </div>
            </div>

            {/* MCP 服务列表区 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div className="settings-section-title" style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
                已连接的服务列表 ({(mcpConfig?.servers || []).length})
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowAddMcpForm(true)}
                style={{ height: '28px', padding: '0 12px', fontSize: '12px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                ➕ 添加自定义
              </button>
            </div>

            <div className="mcp-glass-card">
              {(mcpConfig?.servers || []).length === 0 ? (
                <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-muted, #888)', fontSize: '13px' }}>
                  👻 暂无已添加的服务，请通过右上角"添加自定义"按钮添加。
                </div>
              ) : (
                <div className="mcp-table-container">
                  <table className="mcp-table">
                    <thead>
                      <tr>
                        <th style={{ width: '150px' }}>服务名称</th>
                        <th>终结点地址 (Endpoint)</th>
                        <th style={{ width: '100px', textAlign: 'center' }}>协议类型</th>
                        <th style={{ width: '100px', textAlign: 'center' }}>鉴权密钥</th>
                        <th style={{ width: '90px', textAlign: 'center' }}>启用状态</th>
                        <th style={{ width: '230px', textAlign: 'center' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(mcpConfig.servers).map((server: any) => (
                        <tr key={server.id} className="mcp-table-row">
                          <td style={{ fontWeight: 600, color: 'var(--text-color-strong)' }}>
                            {server.name}
                          </td>
                          <td>
                            <span className="mcp-url-text" title={server.url}>
                              {server.url}
                            </span>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span className={`mcp-badge ${server.type === 'sse' ? 'none' : 'configured'}`}>
                              {server.type === 'stream' ? 'Stream' : server.type === 'sse' ? 'SSE' : server.type === 'auto' ? '自动' : 'Stream'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span className={`mcp-badge ${server.apiKey ? 'configured' : 'none'}`}>
                              {server.apiKey ? '已配置' : '无'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <div className="mcp-switch-container">
                              <label className="mcp-switch-label">
                                <input
                                  type="checkbox"
                                  checked={server.enabled}
                                  onChange={e => {
                                    const newServers = mcpConfig.servers.map((s: any) => s.id === server.id ? { ...s, enabled: e.target.checked } : s)
                                    saveMcpConfig({ servers: newServers })
                                  }}
                                />
                                <span className="mcp-switch-slider" />
                              </label>
                            </div>
                          </td>
                          <td>
                            <div className="mcp-btn-action-group">
                              <button
                                type="button"
                                className="mcp-btn-action test"
                                onClick={async () => {
                                  try {
                                    showToast(`正在测试连接 [${server.name}]...`, 'info')
                                    const res = await window.api.testMcpServer({
                                      url: server.url,
                                      apiKey: server.apiKey,
                                      type: server.type || 'stream'
                                    })
                                    setTestResultData(res)
                                    setTestResultServerName(server.name)
                                    setShowTestResultModal(true)
                                  } catch (err: any) {
                                    alert(`❌ 测试异常：\n${err.message || err}`)
                                  }
                                }}
                              >
                                🔌 测试
                              </button>
                              <button
                                type="button"
                                className="mcp-btn-action edit"
                                onClick={() => {
                                  setEditingServer(server)
                                  setEditName(server.name)
                                  setEditUrl(server.url)
                                  setEditApiKey(server.apiKey || '')
                                  setEditType(server.type || 'stream')
                                  setShowEditModal(true)
                                }}
                              >
                                ✏️ 编辑
                              </button>
                              <button
                                type="button"
                                className="mcp-btn-action delete"
                                onClick={() => {
                                  if (confirm(`确认要删除 [${server.name}] 服务吗？`)) {
                                    const newServers = mcpConfig.servers.filter((s: any) => s.id !== server.id)
                                    saveMcpConfig({ servers: newServers })
                                    showToast(`已删除 [${server.name}] 服务。`, 'success')
                                  }
                                }}
                              >
                                🗑️ 删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 编辑弹窗 Modal */}
      {showEditModal && editingServer && (
        <div className="mcp-modal-overlay">
          <div className="mcp-modal-card" onClick={e => e.stopPropagation()}>
            <div className="mcp-modal-header">
              <div className="mcp-modal-title">
                <span>✏️ 编辑 MCP 服务</span>
              </div>
              <button className="mcp-modal-close-btn" onClick={() => { setShowEditModal(false); setEditingServer(null); }}>×</button>
            </div>
            <div className="mcp-modal-body">
              <div>
                <label className="mcp-form-label">服务名称</label>
                <input
                  type="text"
                  className="mcp-input-fancy"
                  placeholder="如：Bing搜索"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                />
              </div>

              <div>
                <label className="mcp-form-label">SSE Endpoint 地址</label>
                <input
                  type="text"
                  className="mcp-input-fancy"
                  placeholder="https://mcpmarket.cn/mcp/..."
                  value={editUrl}
                  onChange={e => setEditUrl(e.target.value)}
                />
              </div>

              <div>
                <label className="mcp-form-label">API 鉴权密钥 (Token) - 可选</label>
                <input
                  type="password"
                  className="mcp-input-fancy"
                  placeholder="默认留空"
                  value={editApiKey}
                  onChange={e => setEditApiKey(e.target.value)}
                />
              </div>

              <div>
                <label className="mcp-form-label">传输协议类型</label>
                <select
                  className="mcp-input-fancy"
                  value={editType}
                  onChange={e => setEditType(e.target.value as any)}
                  style={{ cursor: 'pointer' }}
                >
                  <option value="stream">Streamable HTTP (推荐)</option>
                  <option value="sse">Server-Sent Events</option>
                  <option value="auto">自动探测</option>
                </select>
              </div>
            </div>
            <div className="mcp-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => { setShowEditModal(false); setEditingServer(null); }}
                style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  if (!editName.trim() || !editUrl.trim()) {
                    showToast('请完整填写服务名称和地址！', 'error')
                    return
                  }
                  const newServers = mcpConfig.servers.map((s: any) =>
                    s.id === editingServer.id
                      ? { ...s, name: editName.trim(), url: editUrl.trim(), apiKey: editApiKey.trim(), type: editType }
                      : s
                  )
                  saveMcpConfig({ servers: newServers })
                  setShowEditModal(false)
                  setEditingServer(null)
                  showToast('服务配置已更新并重新连接！', 'success')
                }}
                style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
              >
                保存修改
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新增弹窗 Modal */}
      {showAddMcpForm && (
        <div className="mcp-modal-overlay">
          <div className="mcp-modal-card" onClick={e => e.stopPropagation()}>
            <div className="mcp-modal-header">
              <div className="mcp-modal-title">
                <span>➕ 新增 MCP 服务配置</span>
              </div>
              <button className="mcp-modal-close-btn" onClick={() => {
                setShowAddMcpForm(false)
                setMcpNewName('')
                setMcpNewUrl('')
                setMcpNewApiKey('')
                setMcpNewType('stream')
              }}>×</button>
            </div>
            <div className="mcp-modal-body">
              <div>
                <label className="mcp-form-label">服务名称</label>
                <input
                  type="text"
                  className="mcp-input-fancy"
                  placeholder="如：自定义服务、我的数据库助手"
                  value={mcpNewName}
                  onChange={e => setMcpNewName(e.target.value)}
                />
              </div>

              <div>
                <label className="mcp-form-label">SSE Endpoint 地址</label>
                <input
                  type="text"
                  className="mcp-input-fancy"
                  placeholder="https://mcpmarket.cn/mcp/..."
                  value={mcpNewUrl}
                  onChange={e => setMcpNewUrl(e.target.value)}
                />
              </div>

              <div>
                <label className="mcp-form-label">API 鉴权密钥 (Token) - 可选</label>
                <input
                  type="password"
                  className="mcp-input-fancy"
                  placeholder="默认留空"
                  value={mcpNewApiKey}
                  onChange={e => setMcpNewApiKey(e.target.value)}
                />
              </div>

              <div>
                <label className="mcp-form-label">传输协议类型</label>
                <select
                  className="mcp-input-fancy"
                  value={mcpNewType}
                  onChange={e => setMcpNewType(e.target.value as any)}
                  style={{ cursor: 'pointer' }}
                >
                  <option value="stream">Streamable HTTP (推荐)</option>
                  <option value="sse">Server-Sent Events</option>
                  <option value="auto">自动探测</option>
                </select>
              </div>
            </div>
            <div className="mcp-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowAddMcpForm(false)
                  setMcpNewName('')
                  setMcpNewUrl('')
                  setMcpNewApiKey('')
                  setMcpNewType('stream')
                }}
                style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  if (!mcpNewName.trim() || !mcpNewUrl.trim()) {
                    showToast('请完整填写服务名称和地址！', 'error')
                    return
                  }
                  const servers = mcpConfig?.servers || []
                  const newServers = [...servers, {
                    id: `mcp-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
                    name: mcpNewName.trim(),
                    url: mcpNewUrl.trim(),
                    apiKey: mcpNewApiKey.trim(),
                    type: mcpNewType,
                    enabled: true
                  }]
                  saveMcpConfig({ servers: newServers })

                  setShowAddMcpForm(false)
                  setMcpNewName('')
                  setMcpNewUrl('')
                  setMcpNewApiKey('')
                  setMcpNewType('stream')
                  showToast('已成功添加新 MCP 服务！', 'success')
                }}
                style={{ fontSize: '12.5px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer' }}
              >
                保存并连接
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MCP 测试结果弹框 */}
      {showTestResultModal && testResultData && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0,0,0,0.7)',
            zIndex: 99998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer'
          }}
          onClick={() => setShowTestResultModal(false)}
        >
          <div
            style={{
              width: '80vw',
              maxWidth: '900px',
              height: '80vh',
              backgroundColor: 'var(--color-bg-primary, #fff)',
              borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              cursor: 'default'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹框头部 */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '16px 20px',
                borderBottom: '1px solid var(--color-border, #e0e0e0)',
                backgroundColor: 'var(--color-bg-secondary, #f5f5f5)'
              }}
            >
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                🔌 MCP 测试结果 - {testResultServerName}
              </h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(testResultData, null, 2))
                    showToast('已复制到剪贴板', 'success')
                  }}
                  style={{
                    background: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)',
                    border: 'none',
                    color: '#fff',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  📋 复制全部
                </button>
                <button
                  onClick={() => setShowTestResultModal(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    cursor: 'pointer',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    color: 'var(--color-text-primary, #333)'
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* 弹框内容 */}
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '20px'
              }}
            >
              {/* 测试状态 */}
              <div
                style={{
                  marginBottom: '16px',
                  padding: '12px 16px',
                  backgroundColor: testResultData.success ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                  border: `1px solid ${testResultData.success ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
                  borderRadius: '8px',
                  fontSize: '13px'
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '8px', color: testResultData.success ? '#10b981' : '#ef4444' }}>
                  {testResultData.success ? '✅ 测试成功' : '❌ 测试失败'}
                </div>
                {testResultData.protocol && <div>协议: {testResultData.protocol}</div>}
                {testResultData.error && <div>错误: {testResultData.error}</div>}
                {testResultData.toolsSize && (
                  <div>
                    工具定义大小: {testResultData.toolsSize.charCount.toLocaleString()} 字符
                    (~{testResultData.toolsSize.estimatedTokens.toLocaleString()} tokens)
                  </div>
                )}
              </div>

              {/* 工具列表 */}
              {testResultData.tools && testResultData.tools.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <div
                    style={{
                      fontWeight: 600,
                      marginBottom: '8px',
                      fontSize: '14px',
                      color: 'var(--color-text-primary, #333)'
                    }}
                  >
                    🔧 工具列表 (共 {testResultData.tools.length} 个)
                  </div>
                  <div
                    style={{
                      border: '1px solid var(--color-border, #e0e0e0)',
                      borderRadius: '8px',
                      overflow: 'hidden'
                    }}
                  >
                    {testResultData.tools.map((tool: any, idx: number) => (
                      <div
                        key={idx}
                        style={{
                          padding: '12px 16px',
                          borderBottom: idx < testResultData.tools.length - 1 ? '1px solid var(--color-border, #e0e0e0)' : 'none',
                          backgroundColor: 'var(--color-bg-secondary, #f8f9fa)'
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: '13px',
                            marginBottom: '4px',
                            color: '#3b82f6'
                          }}
                        >
                          {tool.name}
                        </div>
                        <div
                          style={{
                            fontSize: '12px',
                            color: 'var(--color-text-secondary, #666)',
                            marginBottom: '8px'
                          }}
                        >
                          {tool.description || '无描述'}
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            fontSize: '11px',
                            lineHeight: '1.4',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontFamily: 'monospace',
                            backgroundColor: 'var(--color-bg-code, #f0f0f0)',
                            padding: '8px',
                            borderRadius: '4px',
                            maxHeight: '150px',
                            overflow: 'auto'
                          }}
                        >
                          {JSON.stringify(tool.inputSchema || {}, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 完整 JSON 响应 */}
              <div>
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: '8px',
                    fontSize: '14px',
                    color: 'var(--color-text-primary, #333)'
                  }}
                >
                  📄 完整 JSON 响应
                </div>
                <pre
                  style={{
                    margin: 0,
                    fontSize: '12px',
                    lineHeight: '1.5',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'monospace',
                    backgroundColor: 'var(--color-bg-code, #f0f0f0)',
                    padding: '16px',
                    borderRadius: '8px',
                    maxHeight: '400px',
                    overflow: 'auto',
                    border: '1px solid var(--color-border, #e0e0e0)'
                  }}
                >
                  {JSON.stringify(testResultData, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

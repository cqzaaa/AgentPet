import React, { useState } from 'react'
import { formatBytes } from '../utils/helpers'
import type { AppStore } from '../hooks/useAppStore'
import { ChatMessageItem } from '../components/ChatMessageItem'

interface AgentPageProps {
  store: AppStore
}

export function AgentPage({ store }: AgentPageProps): React.JSX.Element {
  const [selectedTaskForLog, setSelectedTaskForLog] = useState<any>(null)
  const [selectedCronLogDetails, setSelectedCronLogDetails] = useState<any>(null)

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
    handleToggleCronTask, handleDeleteCronTask, handleClearCronLogs
  } = store

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
                          messages: [{ id: 1, sender: 'agent', text: '本会话记录已清空。喵~', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]
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
                      messages: [{ id: 1, sender: 'agent', text: `会话记录已彻底清空。${currentAvatarName} 核心记忆已重置，喵~`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]
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
            <div className="cron-info-banner" style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '16px',
              background: 'rgba(59, 130, 246, 0.08)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              borderRadius: '8px',
              marginBottom: '20px',
              color: 'var(--text-secondary)',
              fontSize: '13px',
              lineHeight: '1.5'
            }}>
              <span style={{ fontSize: '24px' }}>🤖</span>
              <div>
                <strong>定时任务已托管</strong><br />
                为了确保人设一致性与操作安全，本页面禁止手动创建定时任务。请移步到 <strong>对话/Chat</strong> 页面，对大模型发出指令（例如：“帮我创建一个每30秒检测一次系统CPU负载状态的定时任务”）来让助手为您创建！
              </div>
            </div>

            <div className="skills-table-wrapper">
              <table className="cron-table">
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
                      <td>{task.interval} 秒</td>
                      <td>{task.lastTriggered}</td>
                      <td><span className="cron-badge-trigger">{task.triggerCount} 次</span></td>
                      <td>
                        <span style={{ color: task.isActive ? '#10b981' : '#f87171', fontWeight: 'bold' }}>
                          {task.isActive ? '运行中' : '已暂停'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
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
                          style={{ padding: '4px 8px', fontSize: '11px', marginRight: '8px' }}
                          onClick={() => handleToggleCronTask(task.id)}
                        >
                          {task.isActive ? '⏸ 暂停' : '▶ 启动'}
                        </button>
                        <button type="button" className="delete-btn" onClick={() => handleDeleteCronTask(task.id)}>
                          🗑 移除
                        </button>
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
          </div>
        )}
      </div>
    </div>
  )
}

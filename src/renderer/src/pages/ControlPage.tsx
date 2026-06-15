import React from 'react'
import { formatSeconds } from '../utils/helpers'
import type { AppStore } from '../hooks/useAppStore'

interface ControlPageProps {
  store: AppStore
}

export function ControlPage({ store }: ControlPageProps): React.JSX.Element {
  const { systemInfo, skillsList } = store

  return (
    <div className="overview-grid">
      {/* Left Card: Agent Profile */}
      <div className="overview-card">
        <div className="card-title">🤖 智能体 Mao 状态</div>
        <div className="agent-overview-profile">
          <div className="agent-large-avatar">🐱</div>
          <div className="agent-profile-info">
            <div className="agent-profile-name">Mao</div>
            <div className="agent-profile-quote">" 正在倾听您的指令，控制 OpenClaw 准备完毕。 "</div>
          </div>
        </div>
        <div className="agent-detail-grid">
          <div className="detail-item">
            <span className="detail-lbl">亲密度</span>
            <span className="detail-val" style={{ color: '#ec4899' }}>98% (信任)</span>
          </div>
          <div className="detail-item">
            <span className="detail-lbl">神经网络内核</span>
            <span className="detail-val">V2.1.0</span>
          </div>
          <div className="detail-item">
            <span className="detail-lbl">技能扩展数</span>
            <span className="detail-val">{skillsList.length}</span>
          </div>
          <div className="detail-item">
            <span className="detail-lbl">状态</span>
            <span className="detail-val" style={{ color: '#10b981' }}>在线就绪</span>
          </div>
        </div>
      </div>

      {/* Right Card: Resource usage */}
      <div className="overview-card">
        <div className="card-title">📊 本地电脑资源占用</div>
        {systemInfo ? (
          <>
            <div className="metric-container">
              <div className="metric-header">
                <span className="metric-label">CPU 占用率</span>
                <span>{systemInfo.cpuUsage}%</span>
              </div>
              <div className="metric-bar">
                <div className="metric-fill cpu" style={{ width: `${systemInfo.cpuUsage}%` }}></div>
              </div>
            </div>

            <div className="metric-container" style={{ marginTop: '20px' }}>
              <div className="metric-header">
                <span className="metric-label">内存 占用率</span>
                <span>
                  {Math.round(((systemInfo.totalMem - systemInfo.freeMem) / systemInfo.totalMem) * 100)}%
                  ({((systemInfo.totalMem - systemInfo.freeMem) / 1024 / 1024 / 1024).toFixed(1)} GB / {(systemInfo.totalMem / 1024 / 1024 / 1024).toFixed(1)} GB)
                </span>
              </div>
              <div className="metric-bar">
                <div
                  className="metric-fill mem"
                  style={{ width: `${Math.round(((systemInfo.totalMem - systemInfo.freeMem) / systemInfo.totalMem) * 100)}%` }}
                ></div>
              </div>
            </div>
          </>
        ) : (
          <div style={{ color: '#64748b', fontSize: '13px' }}>正在获取系统硬件占用数据...</div>
        )}
      </div>

      {/* Full Width Card: System info */}
      <div className="overview-card full-width">
        <div className="card-title">💻 计算机系统配置与载荷</div>
        {systemInfo ? (
          <div className="sys-info-table">
            <div className="sys-info-row">
              <span className="sys-info-lbl">处理器型号</span>
              <span className="sys-info-val">{systemInfo.cpuModel} ({systemInfo.cpuCount} 核)</span>
            </div>
            <div className="sys-info-row">
              <span className="sys-info-lbl">操作系统</span>
              <span className="sys-info-val">{systemInfo.platform} ({systemInfo.release})</span>
            </div>
            <div className="sys-info-row">
              <span className="sys-info-lbl">智能体运行时间</span>
              <span className="sys-info-val">{formatSeconds(systemInfo.uptime)}</span>
            </div>
            <div className="sys-info-row">
              <span className="sys-info-lbl">计算机开机时间</span>
              <span className="sys-info-val">{formatSeconds(systemInfo.sysUptime)}</span>
            </div>
          </div>
        ) : (
          <div style={{ color: '#64748b', fontSize: '13px' }}>正在加载系统参数...</div>
        )}
      </div>
    </div>
  )
}

import React, { useState, useMemo } from 'react'
import { type AppStore, useAppStoreRaw } from '../hooks/useAppStore'
import { BarChart3, Search, Trash2 } from 'lucide-react'

interface LogsPageProps {
  store: AppStore
}

export function LogsPage({ store }: LogsPageProps): React.JSX.Element {
  const {
    tokenLogs,
    handleClearTokenLogs,
    showToast,
    setActiveTab,
    setActiveSessionId,
    setHighlightedMessageId
  } = store
  const sessions = useAppStoreRaw(state => state.sessions)

  // 1. 时间范围筛选状态：'24h' | '7d' | 'all'，默认 '7d'
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | 'all'>('7d')

  // 是否有总数据
  const hasTotalData = tokenLogs.length > 0

  // 2. 根据选定时间范围过滤数据
  const activeLogs = useMemo(() => {
    const now = Date.now()
    return tokenLogs.filter(log => {
      if (timeRange === '24h') {
        return now - log.timestamp <= 24 * 3600 * 1000
      }
      if (timeRange === '7d') {
        return now - log.timestamp <= 7 * 24 * 3600 * 1000
      }
      return true // 'all'
    })
  }, [tokenLogs, timeRange])

  const hasData = activeLogs.length > 0

  // 状态：用于存储当前折线图 hover 的点索引
  const [hoveredPointIdx, setHoveredPointIdx] = useState<number | null>(null)

  // ── 统计数值计算 ───────────────────────────────────────────────
  const stats = useMemo(() => {
    let totalPrompt = 0
    let totalCompletion = 0
    let totalCalls = activeLogs.length

    activeLogs.forEach(log => {
      totalPrompt += log.promptTokens || 0
      totalCompletion += log.completionTokens || 0
    })

    return {
      totalPrompt,
      totalCompletion,
      totalTokens: totalPrompt + totalCompletion,
      totalCalls
    }
  }, [activeLogs])

  // ── 环形图数据计算（模型占比）────────────────────────────────────
  const modelDistribution = useMemo(() => {
    if (!hasData) return []
    const modelMap: Record<string, { total: number; color: string; provider: string }> = {}

    const colors = ['#60a5fa', '#06b6d4', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899']
    let colorIdx = 0

    activeLogs.forEach(log => {
      const modelName = log.model
      if (!modelMap[modelName]) {
        modelMap[modelName] = {
          total: 0,
          provider: log.provider,
          color: colors[colorIdx % colors.length]
        }
        colorIdx++
      }
      modelMap[modelName].total += log.totalTokens
    })

    const totalAll = Object.values(modelMap).reduce((sum, curr) => sum + curr.total, 0) || 1

    return Object.entries(modelMap)
      .map(([name, data]) => ({
        name,
        provider: data.provider,
        total: data.total,
        percentage: (data.total / totalAll) * 100,
        color: data.color
      }))
      .sort((a, b) => b.total - a.total)
  }, [activeLogs, hasData])

  // ── 最近 10 次调用走势折线图计算 ──────────────────────────────────
  const trendData = useMemo(() => {
    if (!hasData) return null
    // 截取当前时间范围内的最近 10 次记录并按时间升序排列用于绘图
    const records = activeLogs.slice(-10)

    const maxVal = Math.max(...records.map(r => Math.max(r.promptTokens, r.completionTokens))) || 100
    const yMaxLimit = Math.ceil(maxVal * 1.15)

    const width = 460
    const height = 140
    const paddingLeft = 45
    const paddingRight = 15
    const paddingTop = 15
    const paddingBottom = 25

    const chartWidth = width - paddingLeft - paddingRight
    const chartHeight = height - paddingTop - paddingBottom

    const pointsPrompt: { x: number; y: number }[] = []
    const pointsCompletion: { x: number; y: number }[] = []

    records.forEach((rec, idx) => {
      const stepX = records.length > 1 ? chartWidth / (records.length - 1) : chartWidth
      const x = paddingLeft + idx * stepX

      const yPrompt = paddingTop + chartHeight - ((rec.promptTokens || 0) / yMaxLimit) * chartHeight
      const yCompletion = paddingTop + chartHeight - ((rec.completionTokens || 0) / yMaxLimit) * chartHeight

      pointsPrompt.push({ x, y: yPrompt })
      pointsCompletion.push({ x, y: yCompletion })
    })

    let pathPromptStr = ''
    let areaPromptStr = ''
    let pathCompletionStr = ''
    let areaCompletionStr = ''

    if (records.length > 0) {
      pathPromptStr = `M ${pointsPrompt[0].x} ${pointsPrompt[0].y} `
      areaPromptStr = `M ${pointsPrompt[0].x} ${paddingTop + chartHeight} L ${pointsPrompt[0].x} ${pointsPrompt[0].y} `

      for (let i = 1; i < pointsPrompt.length; i++) {
        pathPromptStr += `L ${pointsPrompt[i].x} ${pointsPrompt[i].y} `
        areaPromptStr += `L ${pointsPrompt[i].x} ${pointsPrompt[i].y} `
      }
      areaPromptStr += `L ${pointsPrompt[pointsPrompt.length - 1].x} ${paddingTop + chartHeight} Z`

      pathCompletionStr = `M ${pointsCompletion[0].x} ${pointsCompletion[0].y} `
      areaCompletionStr = `M ${pointsCompletion[0].x} ${paddingTop + chartHeight} L ${pointsCompletion[0].x} ${pointsCompletion[0].y} `

      for (let i = 1; i < pointsCompletion.length; i++) {
        pathCompletionStr += `L ${pointsCompletion[i].x} ${pointsCompletion[i].y} `
        areaCompletionStr += `L ${pointsCompletion[i].x} ${pointsCompletion[i].y} `
      }
      areaCompletionStr += `L ${pointsCompletion[pointsCompletion.length - 1].x} ${paddingTop + chartHeight} Z`
    }

    return {
      width,
      height,
      paddingLeft,
      paddingRight,
      paddingTop,
      paddingBottom,
      chartWidth,
      chartHeight,
      records,
      pointsPrompt,
      pointsCompletion,
      pathPromptStr,
      areaPromptStr,
      pathCompletionStr,
      areaCompletionStr,
      yMaxLimit
    }
  }, [activeLogs, hasData])

  // 格式化时间戳 (精确格式)
  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    const secs = String(d.getSeconds()).padStart(2, '0')
    return `${d.getMonth() + 1}/${d.getDate()} ${hours}:${mins}:${secs}`
  }

  // 格式化 X 轴刻度时分
  const formatTimeX = (ts: number): string => {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }

  // 点击跳转定位功能
  const handleLocateChat = (sessId: string, msgId: number) => {
    const sessionExists = sessions.some(s => s.id === sessId)
    if (!sessionExists) {
      showToast('关联会话已被删除，无法定位消息', 'error')
      return
    }
    setActiveSessionId(sessId)
    setHighlightedMessageId(msgId)
    setActiveTab('chat')
    showToast('正在为您定位到该条消息...', 'success')
  }

  // 绘制圆环路径的计算
  const ringCircumference = 251.32
  let ringAccumOffset = 0

  // ── 如果没有任何历史数据，显示精美的空白占位状态 ─────────────────────
  if (!hasTotalData) {
    return (
      <div className="logs-empty-state">
        <div className="empty-glow-box">
          <span className="empty-icon"><BarChart3 size={34} strokeWidth={1.8} aria-hidden="true" /></span>
        </div>
        <h3 className="empty-title">暂无 Token 消耗日志</h3>
        <p className="empty-desc">
          当前大模型调用历史为空。请在“聊天”窗口中发送消息与桌面智能体对话交互，产生的 Token 消耗和模型日志将实时生成高端分析图表展示在这里。
        </p>
      </div>
    )
  }

  return (
    <div className="logs-page-container animate-fade-in">
      {/* 时间筛选器选项卡 */}
      <div className="time-filter-wrapper">
        <div className="time-filter-tabs">
          <button
            className={`filter-tab ${timeRange === '24h' ? 'active' : ''}`}
            onClick={() => setTimeRange('24h')}
          >
            最近 24 小时
          </button>
          <button
            className={`filter-tab ${timeRange === '7d' ? 'active' : ''}`}
            onClick={() => setTimeRange('7d')}
          >
            最近 7 天
          </button>
          <button
            className={`filter-tab ${timeRange === 'all' ? 'active' : ''}`}
            onClick={() => setTimeRange('all')}
          >
            全部历史
          </button>
        </div>
      </div>

      {/* ── 1. 统计卡片格 ────────────────────────────────────────── */}
      <div className="stats-cards-grid">
        <div className="stat-glow-card total">
          <span className="card-label">累计消耗总 Token</span>
          <span className="card-number">{stats.totalTokens.toLocaleString()}</span>
          <div className="card-sub-info">
            <span>包含输入词与生成词</span>
          </div>
          <div className="card-deco-glow"></div>
        </div>
        <div className="stat-glow-card prompt">
          <span className="card-label">Prompt 提示词 Token</span>
          <span className="card-number cyan-text">{stats.totalPrompt.toLocaleString()}</span>
          <div className="card-sub-info">
            <span>占比 {(stats.totalTokens > 0 ? (stats.totalPrompt / stats.totalTokens) * 100 : 0).toFixed(1)}%</span>
          </div>
        </div>
        <div className="stat-glow-card completion">
          <span className="card-label">生成词 Token</span>
          <span className="card-number rose-text">{stats.totalCompletion.toLocaleString()}</span>
          <div className="card-sub-info">
            <span>占比 {(stats.totalTokens > 0 ? (stats.totalCompletion / stats.totalTokens) * 100 : 0).toFixed(1)}%</span>
          </div>
        </div>
        <div className="stat-glow-card calls">
          <span className="card-label">累计大模型调用次数</span>
          <span className="card-number purple-text">{stats.totalCalls}</span>
          <div className="card-sub-info">
            <span>平均单次 {(stats.totalCalls > 0 ? Math.round(stats.totalTokens / stats.totalCalls) : 0).toLocaleString()} tks</span>
          </div>
        </div>
      </div>

      {/* ── 2. 图表双栏 ─────────────────────────────────────────── */}
      <div className="charts-double-row">

        {/* A. 折线走势图 */}
        <div className="chart-box-card trend-chart-wrapper">
          <div className="chart-card-header">
            <span className="chart-card-title">Token 消耗走势 (最近10次)</span>
            <div className="chart-legends">
              <span className="legend-item"><span className="legend-dot cyan"></span>输入</span>
              <span className="legend-item"><span className="legend-dot rose"></span>输出</span>
            </div>
          </div>
          <div className="chart-card-body">
            {trendData ? (
              <div style={{ position: 'relative', width: '100%' }}>
                <svg viewBox={`0 0 ${trendData.width} ${trendData.height}`} className="trend-svg">
                  <defs>
                    <linearGradient id="gradient-prompt" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="gradient-completion" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
                    </linearGradient>
                  </defs>

                  {/* 背景网格虚线 (横向虚线 Y 轴网格线) */}
                  <line x1={trendData.paddingLeft} y1={trendData.paddingTop} x2={trendData.width - trendData.paddingRight} y2={trendData.paddingTop} stroke="var(--border-color)" strokeDasharray="4 4" strokeWidth="1" />
                  <line x1={trendData.paddingLeft} y1={trendData.paddingTop + trendData.chartHeight * 0.5} x2={trendData.width - trendData.paddingRight} y2={trendData.paddingTop + trendData.chartHeight * 0.5} stroke="var(--border-color)" strokeDasharray="4 4" strokeWidth="1" />

                  {/* X 轴底线 (横向实线) */}
                  <line x1={trendData.paddingLeft} y1={trendData.paddingTop + trendData.chartHeight} x2={trendData.width - trendData.paddingRight} y2={trendData.paddingTop + trendData.chartHeight} stroke="var(--text-muted)" strokeWidth="1.5" />

                  {/* Y 轴刻度文字 */}
                  <text x={trendData.paddingLeft - 8} y={trendData.paddingTop + 4} textAnchor="end" className="axis-text">{trendData.yMaxLimit}</text>
                  <text x={trendData.paddingLeft - 8} y={trendData.paddingTop + trendData.chartHeight * 0.5 + 4} textAnchor="end" className="axis-text">{Math.round(trendData.yMaxLimit * 0.5)}</text>
                  <text x={trendData.paddingLeft - 8} y={trendData.paddingTop + trendData.chartHeight + 4} textAnchor="end" className="axis-text">0</text>

                  {/* 渐变面积填充 */}
                  <path d={trendData.areaPromptStr} fill="url(#gradient-prompt)" />
                  <path d={trendData.areaCompletionStr} fill="url(#gradient-completion)" />

                  {/* 折线路径 */}
                  <path d={trendData.pathPromptStr} fill="none" stroke="#06b6d4" strokeWidth="2.5" strokeLinecap="round" />
                  <path d={trendData.pathCompletionStr} fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" />

                  {/* 交互数据描点与 X 轴 Tick */}
                  {trendData.pointsPrompt.map((p, idx) => {
                    const rec = trendData.records[idx]
                    const isHovered = hoveredPointIdx === idx
                    return (
                      <g key={`dots-${idx}`} onMouseEnter={() => setHoveredPointIdx(idx)} onMouseLeave={() => setHoveredPointIdx(null)}>
                        {/* 隐形的大范围触发器，提供良好的鼠标交互体验 */}
                        <circle cx={p.x} cy={p.y} r="14" fill="transparent" style={{ cursor: 'pointer' }} />
                        <circle cx={p.x} cy={p.y} r={isHovered ? '6' : '3.5'} fill="#08090d" stroke="#06b6d4" strokeWidth={isHovered ? '3' : '2'} style={{ transition: 'all 0.15s ease' }} />
                        <circle cx={trendData.pointsCompletion[idx].x} cy={trendData.pointsCompletion[idx].y} r={isHovered ? '6' : '3.5'} fill="#08090d" stroke="#60a5fa" strokeWidth={isHovered ? '3' : '2'} style={{ transition: 'all 0.15s ease' }} />

                        {/* X 轴竖线短刻度 (Ticks) */}
                        <line x1={p.x} y1={trendData.paddingTop + trendData.chartHeight} x2={p.x} y2={trendData.paddingTop + trendData.chartHeight + 4} stroke="var(--text-muted)" strokeWidth="1.2" />

                        {/* X 轴精确时间刻度时分标注 */}
                        <text x={p.x} y={trendData.paddingTop + trendData.chartHeight + 16} textAnchor="middle" className={`axis-text ${isHovered ? 'active' : ''}`}>
                          {formatTimeX(rec.timestamp)}
                        </text>
                      </g>
                    )
                  })}
                </svg>

                {/* 动态 HTML Tooltip，定位在鼠标悬浮的对应数据点上 */}
                {hoveredPointIdx !== null && trendData.records[hoveredPointIdx] && (
                  <div
                    className="chart-tooltip-bubble"
                    style={{
                      position: 'absolute',
                      left: `${trendData.pointsPrompt[hoveredPointIdx].x}px`,
                      bottom: '50px',
                      transform: 'translateX(-50%)'
                    }}
                  >
                    <div className="tooltip-title">{trendData.records[hoveredPointIdx].model}</div>
                    <div className="tooltip-row">
                      <span className="dot cyan"></span>
                      <span>输入: {trendData.records[hoveredPointIdx].promptTokens}</span>
                    </div>
                    <div className="tooltip-row">
                      <span className="dot rose"></span>
                      <span>输出: {trendData.records[hoveredPointIdx].completionTokens}</span>
                    </div>
                    <div className="tooltip-total">
                      <span>总计: {trendData.records[hoveredPointIdx].totalTokens}</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-placeholder-chart">该时间段内暂无走势数据</div>
            )}
          </div>
        </div>

        {/* B. 模型占比环形图 */}
        <div className="chart-box-card ratio-chart-wrapper">
          <div className="chart-card-header">
            <span className="chart-card-title">模型消耗总份额占比</span>
          </div>
          <div className="chart-card-body ratio-body-row">
            {modelDistribution.length > 0 ? (
              <>
                <div className="ring-chart-svg-container">
                  <svg width="110" height="110" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="40" fill="transparent" stroke="var(--border-card)" strokeWidth="6" />
                    {modelDistribution.map((item, idx) => {
                      const offset = (ringAccumOffset / 100) * ringCircumference
                      ringAccumOffset += item.percentage
                      return (
                        <circle
                          key={`ring-segment-${idx}`}
                          cx="50"
                          cy="50"
                          r="40"
                          fill="transparent"
                          stroke={item.color}
                          strokeWidth="9"
                          strokeDasharray={`${(item.percentage / 100) * ringCircumference} ${ringCircumference}`}
                          strokeDashoffset={-offset}
                          transform="rotate(-90 50 50)"
                          strokeLinecap={item.percentage > 4 ? 'round' : 'butt'}
                          style={{
                            transition: 'stroke-dasharray 0.5s ease',
                            filter: 'drop-shadow(0px 0px 3px rgba(0,0,0,0.3))'
                          }}
                        />
                      )
                    })}
                    <circle cx="50" cy="50" r="32" fill="var(--bg-content)" />
                    <text x="50" y="48" textAnchor="middle" fill="var(--text-muted)" fontSize="9" fontWeight="600">模型</text>
                    <text x="50" y="60" textAnchor="middle" fill="var(--text-primary)" fontSize="10" fontWeight="700">份额比例</text>
                  </svg>
                </div>

                <div className="ring-legends-list">
                  {modelDistribution.map((item, idx) => (
                    <div key={`legend-${idx}`} className="legend-row-item">
                      <div className="legend-row-left">
                        <span className="legend-color-dot" style={{ backgroundColor: item.color, boxShadow: `0 0 6px ${item.color}` }}></span>
                        <div className="legend-model-info">
                          <span className="legend-model-name" title={item.name}>{item.name}</span>
                          <span className="legend-model-prov">{item.provider.toUpperCase()}</span>
                        </div>
                      </div>
                      <div className="legend-row-right">
                        <span className="legend-tk">{item.total.toLocaleString()}</span>
                        <span className="legend-pct">{item.percentage.toFixed(1)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-placeholder-chart">该时间段内暂无大模型占比数据</div>
            )}
          </div>
        </div>

      </div>

      {/* ── 3. 日志明细列表 ────────────────────────────────────────── */}
      <div className="logs-table-box-card">
        <div className="table-card-header">
          <span className="table-card-title">Token 历史调用明细记录</span>
          <div className="table-card-actions">
            <button className="btn-clear-logs" onClick={handleClearTokenLogs}>
              <Trash2 size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
              清空日志
            </button>
          </div>
        </div>
        <div className="table-card-body">
          <div className="logs-table-container">
            <table>
              <thead>
                <tr>
                  <th>调用时间</th>
                  <th>提供商</th>
                  <th>使用大模型</th>
                  <th>Prompt 输入</th>
                  <th>Completion 生成</th>
                  <th>总 Token 消耗</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {activeLogs.slice().reverse().map((log) => (
                  <tr key={log.id}>
                    <td className="time-td">{formatTime(log.timestamp)}</td>
                    <td>
                      <span className={`provider-badge ${log.provider}`}>
                        {log.provider}
                      </span>
                    </td>
                    <td className="model-td" title={log.model}>{log.model}</td>
                    <td className="num-td">{log.promptTokens.toLocaleString()}</td>
                    <td className="num-td">{log.completionTokens.toLocaleString()}</td>
                    <td className="num-td total-td">{log.totalTokens.toLocaleString()}</td>
                    <td>
                      {log.sessionId && log.messageId ? (
                        <button
                          className="btn-locate-chat"
                          onClick={() => handleLocateChat(log.sessionId!, log.messageId!)}
                          title="跳转并定位至具体聊天消息"
                        >
                          <Search size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                          定位对话
                        </button>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>未绑定消息</span>
                      )}
                    </td>
                  </tr>
                ))}
                {activeLogs.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                      当前选定时间段内暂无大模型调用记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

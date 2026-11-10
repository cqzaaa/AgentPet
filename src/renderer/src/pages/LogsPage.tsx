import React, { useState, useMemo } from 'react'
import { type AppStore, useAppStoreRaw } from '../hooks/useAppStore'
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Clock3,
  Cpu,
  Gauge,
  MessageSquare,
  Search,
  Trash2,
  X
} from 'lucide-react'

interface LogsPageProps {
  store: AppStore
}

/** 清理提问文本中的附带文件路径尾注，保留干净的用户原始提问 */
function cleanUserQuestionText(rawText: unknown): string {
  if (typeof rawText !== 'string') return ''
  const withoutAttachmentBlock = rawText.split(/\n*---\s*\[附带文件:/)[0] || rawText
  return withoutAttachmentBlock.replace(/\s+/g, ' ').trim()
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
  const sessions = useAppStoreRaw((state) => state.sessions)

  // 1. 时间范围筛选状态：'24h' | '7d' | 'all'，默认 '7d'
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | 'all'>('7d')
  // 2. 明细表搜索与模型筛选
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedModelFilter, setSelectedModelFilter] = useState<string>('all')
  // 3. 折线图与环形图交互高亮状态
  const [hoveredPointIdx, setHoveredPointIdx] = useState<number | null>(null)
  const [hoveredModelName, setHoveredModelName] = useState<string | null>(null)

  const hasTotalData = tokenLogs.length > 0

  // 会话与提问内容快速解析索引
  const sessionLookup = useMemo(() => {
    const nameMap = new Map<string, string>()
    const questionByReplyId = new Map<string, { question: string; targetMsgId: number }>()
    const userMsgsBySession = new Map<
      string,
      Array<{ id: number; text: string; timestamp: number }>
    >()

    sessions.forEach((sess) => {
      nameMap.set(sess.id, sess.name || '未命名会话')
      const msgs = Array.isArray(sess.messages) ? sess.messages : []
      let lastUserMsg: { id: number; text: string } | null = null
      const userList: Array<{ id: number; text: string; timestamp: number }> = []

      for (const msg of msgs) {
        const msgId = Number(msg?.id)
        if (msg?.sender === 'user') {
          const cleaned = cleanUserQuestionText(msg?.text)
          if (cleaned) {
            lastUserMsg = { id: Number.isFinite(msgId) ? msgId : 0, text: cleaned }
            if (Number.isFinite(msgId)) {
              userList.push({ id: msgId, text: cleaned, timestamp: msgId })
              questionByReplyId.set(`${sess.id}:${msgId}`, {
                question: cleaned,
                targetMsgId: msgId
              })
            }
          }
        } else if (msg?.sender === 'agent' && Number.isFinite(msgId) && lastUserMsg) {
          questionByReplyId.set(`${sess.id}:${msgId}`, {
            question: lastUserMsg.text,
            targetMsgId: msgId
          })
        }
      }

      userMsgsBySession.set(sess.id, userList)
    })

    const resolveLogContext = (log: {
      sessionId?: string
      messageId?: number
      timestamp: number
    }): { sessionName: string; questionText: string; locateMessageId?: number } => {
      if (!log.sessionId) {
        return { sessionName: '未关联会话', questionText: '' }
      }
      const sessionName = nameMap.get(log.sessionId) || '已归档会话'

      // 1. 优先通过 sessionId + messageId 精确匹配对应轮次的用户提问
      if (log.messageId !== undefined) {
        const exact = questionByReplyId.get(`${log.sessionId}:${log.messageId}`)
        if (exact) {
          return {
            sessionName,
            questionText: exact.question,
            locateMessageId: log.messageId
          }
        }
      }

      // 2. 回退：按调用时间戳匹配该会话中最近的一条用户提问
      const userList = userMsgsBySession.get(log.sessionId)
      if (userList && userList.length > 0) {
        let best = userList[userList.length - 1]
        for (let i = userList.length - 1; i >= 0; i--) {
          if (userList[i].timestamp <= log.timestamp + 5000) {
            best = userList[i]
            break
          }
        }
        return {
          sessionName,
          questionText: best.text,
          locateMessageId: log.messageId || best.id
        }
      }

      return {
        sessionName,
        questionText: sessionName !== '已归档会话' && sessionName !== '未命名会话' ? sessionName : '',
        locateMessageId: log.messageId
      }
    }

    return { nameMap, resolveLogContext }
  }, [sessions])

  // 根据选定时间范围过滤数据
  const activeLogs = useMemo(() => {
    const now = Date.now()
    return tokenLogs.filter((log) => {
      if (timeRange === '24h') {
        return now - log.timestamp <= 24 * 3600 * 1000
      }
      if (timeRange === '7d') {
        return now - log.timestamp <= 7 * 24 * 3600 * 1000
      }
      return true
    })
  }, [tokenLogs, timeRange])

  const hasData = activeLogs.length > 0

  // ── 深度统计指标计算 ───────────────────────────────────────────────
  const stats = useMemo(() => {
    let totalPrompt = 0
    let totalCompletion = 0
    const totalCalls = activeLogs.length
    let peakTokens = 0
    let peakModel = ''
    const perCallTotals: number[] = []
    const sessionTotals = new Map<string, { tokens: number; calls: number; lastMsgId?: number }>()

    activeLogs.forEach((log) => {
      const prompt = log.promptTokens || 0
      const completion = log.completionTokens || 0
      const total = prompt + completion
      totalPrompt += prompt
      totalCompletion += completion
      perCallTotals.push(total)

      if (total > peakTokens) {
        peakTokens = total
        peakModel = log.model || 'unknown'
      }

      if (log.sessionId) {
        const prev = sessionTotals.get(log.sessionId) || { tokens: 0, calls: 0 }
        prev.tokens += total
        prev.calls += 1
        if (log.messageId) prev.lastMsgId = log.messageId
        sessionTotals.set(log.sessionId, prev)
      }
    })

    const totalTokens = totalPrompt + totalCompletion
    const promptRatio = totalTokens > 0 ? (totalPrompt / totalTokens) * 100 : 0
    const completionRatio = totalTokens > 0 ? (totalCompletion / totalTokens) * 100 : 0
    const avgTokens = totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0
    const avgPrompt = totalCalls > 0 ? Math.round(totalPrompt / totalCalls) : 0
    const avgCompletion = totalCalls > 0 ? Math.round(totalCompletion / totalCalls) : 0

    // 计算中位数 P50
    let medianTokens = 0
    if (perCallTotals.length > 0) {
      const sorted = [...perCallTotals].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      medianTokens =
        sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    }

    const ioMultiplier =
      totalCompletion > 0 ? (totalPrompt / totalCompletion).toFixed(1) : totalPrompt > 0 ? '∞' : '0'

    type TopSessionSummary = {
      id: string
      name: string
      tokens: number
      calls: number
      share: number
      lastMsgId?: number
    }
    let topSession: TopSessionSummary | null = null

    for (const [sessId, val] of sessionTotals.entries()) {
      if (!topSession || val.tokens > topSession.tokens) {
        topSession = {
          id: sessId,
          name: sessionLookup.nameMap.get(sessId) || '历史已归档会话',
          tokens: val.tokens,
          calls: val.calls,
          share: totalTokens > 0 ? (val.tokens / totalTokens) * 100 : 0,
          lastMsgId: val.lastMsgId
        }
      }
    }

    return {
      totalPrompt,
      totalCompletion,
      totalTokens,
      totalCalls,
      promptRatio,
      completionRatio,
      avgTokens,
      avgPrompt,
      avgCompletion,
      medianTokens,
      peakTokens,
      peakModel,
      ioMultiplier,
      activeSessionCount: sessionTotals.size,
      topSession
    }
  }, [activeLogs, sessionLookup.nameMap])

  // ── 环形图数据计算（模型占比 + 调用次数 + 单次均值）─────────────────────
  const modelDistribution = useMemo(() => {
    if (!hasData) return []
    const modelMap: Record<
      string,
      {
        total: number
        prompt: number
        completion: number
        calls: number
        color: string
        provider: string
      }
    > = {}

    const colors = ['#4d73f0', '#0ea5e9', '#10b981', '#f59e0b', '#64748b', '#ec4899']
    let colorIdx = 0

    activeLogs.forEach((log) => {
      const modelName = log.model || 'unknown'
      if (!modelMap[modelName]) {
        modelMap[modelName] = {
          total: 0,
          prompt: 0,
          completion: 0,
          calls: 0,
          provider: log.provider || 'custom',
          color: colors[colorIdx % colors.length]
        }
        colorIdx++
      }
      modelMap[modelName].total += log.totalTokens || 0
      modelMap[modelName].prompt += log.promptTokens || 0
      modelMap[modelName].completion += log.completionTokens || 0
      modelMap[modelName].calls += 1
    })

    const totalAll = Object.values(modelMap).reduce((sum, curr) => sum + curr.total, 0) || 1

    return Object.entries(modelMap)
      .map(([name, data]) => ({
        name,
        provider: data.provider,
        total: data.total,
        calls: data.calls,
        avgPerCall: Math.round(data.total / data.calls),
        percentage: (data.total / totalAll) * 100,
        color: data.color
      }))
      .sort((a, b) => b.total - a.total)
  }, [activeLogs, hasData])

  // ── 最近 12 次调用走势折线图计算 ──────────────────────────────────
  const trendData = useMemo(() => {
    if (!hasData) return null
    const records = activeLogs.slice(-12)

    const maxVal =
      Math.max(...records.map((r) => Math.max(r.promptTokens || 0, r.completionTokens || 0))) || 100
    const yMaxLimit = Math.ceil(maxVal * 1.12)

    const width = 540
    const height = 164
    const paddingLeft = 48
    const paddingRight = 16
    const paddingTop = 14
    const paddingBottom = 26

    const chartWidth = width - paddingLeft - paddingRight
    const chartHeight = height - paddingTop - paddingBottom
    const baselineY = paddingTop + chartHeight

    const pointsPrompt: { x: number; y: number }[] = []
    const pointsCompletion: { x: number; y: number }[] = []

    records.forEach((rec, idx) => {
      const stepX = records.length > 1 ? chartWidth / (records.length - 1) : chartWidth / 2
      const x = records.length > 1 ? paddingLeft + idx * stepX : paddingLeft + chartWidth / 2

      const yPrompt = baselineY - ((rec.promptTokens || 0) / yMaxLimit) * chartHeight
      const yCompletion = baselineY - ((rec.completionTokens || 0) / yMaxLimit) * chartHeight

      pointsPrompt.push({ x, y: yPrompt })
      pointsCompletion.push({ x, y: yCompletion })
    })

    const buildSmoothPath = (pts: { x: number; y: number }[]): string => {
      if (pts.length === 0) return ''
      if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
      for (let i = 0; i < pts.length - 1; i++) {
        const curr = pts[i]
        const next = pts[i + 1]
        const cpx1 = curr.x + (next.x - curr.x) * 0.42
        const cpy1 = curr.y
        const cpx2 = curr.x + (next.x - curr.x) * 0.58
        const cpy2 = next.y
        d += ` C ${cpx1.toFixed(1)} ${cpy1.toFixed(1)}, ${cpx2.toFixed(1)} ${cpy2.toFixed(1)}, ${next.x.toFixed(1)} ${next.y.toFixed(1)}`
      }
      return d
    }

    const pathPromptStr = buildSmoothPath(pointsPrompt)
    const pathCompletionStr = buildSmoothPath(pointsCompletion)

    const areaPromptStr =
      pointsPrompt.length > 1
        ? `${pathPromptStr} L ${pointsPrompt[pointsPrompt.length - 1].x.toFixed(1)} ${baselineY} L ${pointsPrompt[0].x.toFixed(1)} ${baselineY} Z`
        : ''
    const areaCompletionStr =
      pointsCompletion.length > 1
        ? `${pathCompletionStr} L ${pointsCompletion[pointsCompletion.length - 1].x.toFixed(1)} ${baselineY} L ${pointsCompletion[0].x.toFixed(1)} ${baselineY} Z`
        : ''

    const avgPromptY =
      stats.avgPrompt > 0 && stats.avgPrompt <= yMaxLimit
        ? baselineY - (stats.avgPrompt / yMaxLimit) * chartHeight
        : null

    return {
      width,
      height,
      paddingLeft,
      paddingRight,
      paddingTop,
      paddingBottom,
      chartWidth,
      chartHeight,
      baselineY,
      records,
      pointsPrompt,
      pointsCompletion,
      pathPromptStr,
      areaPromptStr,
      pathCompletionStr,
      areaCompletionStr,
      yMaxLimit,
      avgPromptY
    }
  }, [activeLogs, hasData, stats.avgPrompt])

  // 明细表过滤结果（含预解析的提问内容与会话名）
  const filteredTableLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return activeLogs
      .map((log) => {
        const context = sessionLookup.resolveLogContext(log)
        return {
          ...log,
          sessionName: context.sessionName,
          questionText: context.questionText,
          locateMessageId: context.locateMessageId
        }
      })
      .filter((item) => {
        if (selectedModelFilter !== 'all' && item.model !== selectedModelFilter) {
          return false
        }
        if (!q) return true
        return (
          item.model.toLowerCase().includes(q) ||
          item.provider.toLowerCase().includes(q) ||
          item.sessionName.toLowerCase().includes(q) ||
          item.questionText.toLowerCase().includes(q)
        )
      })
      .reverse()
  }, [activeLogs, searchQuery, selectedModelFilter, sessionLookup])

  // 格式化紧凑数值
  const formatCompactNumber = (val: number): string => {
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`
    if (val >= 10_000) return `${(val / 1_000).toFixed(1)}k`
    if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`
    return String(val)
  }

  // 格式化时间戳
  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    const secs = String(d.getSeconds()).padStart(2, '0')
    return `${month}-${day} ${hours}:${mins}:${secs}`
  }

  // 格式化 X 轴刻度时分
  const formatTimeX = (ts: number): string => {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }

  // 点击跳转定位功能
  const handleLocateChat = (sessId: string, msgId?: number): void => {
    const sessionExists = sessions.some((s) => s.id === sessId)
    if (!sessionExists) {
      showToast('关联会话已被删除，无法定位消息', 'error')
      return
    }
    setActiveSessionId(sessId)
    if (msgId) setHighlightedMessageId(msgId)
    setActiveTab('chat')
    showToast('正在为您定位到关联对话...', 'success')
  }

  // 圆环参数
  const ringRadius = 40
  const ringCircumference = 2 * Math.PI * ringRadius
  let ringAccumOffset = 0

  const activeHoveredModel = useMemo(() => {
    if (!hoveredModelName) return modelDistribution[0] || null
    return modelDistribution.find((m) => m.name === hoveredModelName) || modelDistribution[0] || null
  }, [hoveredModelName, modelDistribution])

  return (
    <div className="logs-workspace-page animate-fade-in">
      <div className="logs-scroll-body">
        {!hasTotalData ? (
          <div className="logs-empty-state">
            <div className="empty-glow-box">
              <span className="empty-icon">
                <BarChart3 size={30} strokeWidth={1.7} aria-hidden="true" />
              </span>
            </div>
            <h3 className="empty-title">暂无 Token 消耗日志</h3>
            <p className="empty-desc">
              当前大模型调用历史为空。在「聊天」窗口中与桌面智能体交互后，产生的上下文输入、生成词消耗及模型分布将实时汇总于此。
            </p>
          </div>
        ) : (
          <div className="logs-page-container">
            {/* ── 0. 紧凑型内联控制栏 ── */}
            <div className="logs-compact-toolbar">
              <div className="toolbar-status-summary">
                <span className="status-pulse-dot" aria-hidden="true" />
                <span className="toolbar-summary-text">
                  当前窗口共记录 <strong>{stats.totalCalls.toLocaleString()}</strong> 次调用，涉及{' '}
                  <strong>{stats.activeSessionCount}</strong> 个会话与{' '}
                  <strong>{modelDistribution.length}</strong> 个模型
                </span>
              </div>

              <div className="logs-hero-controls">
                <div className="time-filter-tabs" role="tablist" aria-label="时间范围筛选">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={timeRange === '24h'}
                    className={`filter-tab ${timeRange === '24h' ? 'active' : ''}`}
                    onClick={() => setTimeRange('24h')}
                  >
                    最近 24 小时
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={timeRange === '7d'}
                    className={`filter-tab ${timeRange === '7d' ? 'active' : ''}`}
                    onClick={() => setTimeRange('7d')}
                  >
                    最近 7 天
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={timeRange === 'all'}
                    className={`filter-tab ${timeRange === 'all' ? 'active' : ''}`}
                    onClick={() => setTimeRange('all')}
                  >
                    全部历史
                  </button>
                </div>

                <button
                  type="button"
                  className="btn-clear-logs"
                  onClick={handleClearTokenLogs}
                  title="清空所有历史 Token 统计日志"
                >
                  <Trash2 size={13.5} strokeWidth={1.9} aria-hidden="true" />
                  <span>清空日志</span>
                </button>
              </div>
            </div>

            {/* ── 1. 深度遥测 Bento 指标矩阵 ── */}
            <section className="logs-bento-metrics" aria-label="Token 核心诊断指标">
              <article className="stat-glow-card primary-metric">
                <div className="metric-card-top">
                  <span className="card-label">累计总吞吐量 (Total Tokens)</span>
                  <span className="metric-pill">读写比 {stats.ioMultiplier} : 1</span>
                </div>

                <div className="primary-metric-value-row">
                  <span className="card-number primary-number">
                    {stats.totalTokens.toLocaleString()}
                  </span>
                  <span className="metric-unit">({formatCompactNumber(stats.totalTokens)})</span>
                </div>

                <div className="token-composition-bar" aria-hidden="true">
                  <div
                    className="composition-segment prompt"
                    style={{ width: `${Math.max(stats.promptRatio, stats.totalTokens > 0 ? 3 : 50)}%` }}
                  />
                  <div
                    className="composition-segment completion"
                    style={{
                      width: `${Math.max(stats.completionRatio, stats.totalTokens > 0 ? 3 : 50)}%`
                    }}
                  />
                </div>

                <div className="composition-legend-row">
                  <span className="composition-meta">
                    <i className="dot prompt" />
                    Prompt 输入 <strong>{formatCompactNumber(stats.totalPrompt)}</strong> (
                    {stats.promptRatio.toFixed(1)}%)
                  </span>
                  <span className="composition-meta">
                    <i className="dot completion" />
                    Completion 输出 <strong>{formatCompactNumber(stats.totalCompletion)}</strong> (
                    {stats.completionRatio.toFixed(1)}%)
                  </span>
                </div>
              </article>

              <div className="secondary-metrics-grid">
                <article className="stat-glow-card">
                  <div className="metric-card-top">
                    <span className="card-label">单次调用负载 (Avg / P50)</span>
                    <Gauge size={14} strokeWidth={1.8} className="metric-icon prompt" />
                  </div>
                  <div className="metric-dual-row">
                    <span className="card-number">{stats.avgTokens.toLocaleString()}</span>
                    <span className="metric-inline-tag">tks / 次</span>
                  </div>
                  <div className="metric-breakdown-list">
                    <div className="breakdown-item">
                      <span>中位数 (P50)</span>
                      <strong>{stats.medianTokens.toLocaleString()}</strong>
                    </div>
                    <div className="breakdown-item">
                      <span>单次峰值 (Max)</span>
                      <strong className="highlight-val">{stats.peakTokens.toLocaleString()}</strong>
                    </div>
                  </div>
                </article>

                <article className="stat-glow-card">
                  <div className="metric-card-top">
                    <span className="card-label">单次平均读写构成</span>
                    <Activity size={14} strokeWidth={1.8} className="metric-icon completion" />
                  </div>
                  <div className="metric-dual-row">
                    <span className="card-number">{stats.avgPrompt.toLocaleString()}</span>
                    <span className="metric-inline-tag">平均输入</span>
                  </div>
                  <div className="metric-breakdown-list">
                    <div className="breakdown-item">
                      <span>平均生成输出</span>
                      <strong>{stats.avgCompletion.toLocaleString()} tks</strong>
                    </div>
                    <div className="breakdown-item">
                      <span>主力模型</span>
                      <strong className="truncate-text" title={modelDistribution[0]?.name || '-'}>
                        {modelDistribution[0]?.name || '-'}
                      </strong>
                    </div>
                  </div>
                </article>

                <article className="stat-glow-card">
                  <div className="metric-card-top">
                    <span className="card-label">最高消耗会话归因</span>
                    <MessageSquare size={14} strokeWidth={1.8} className="metric-icon calls" />
                  </div>
                  {stats.topSession ? (
                    <>
                      <div className="top-session-title-row">
                        <span className="top-session-name" title={stats.topSession.name}>
                          {stats.topSession.name}
                        </span>
                        {sessions.some((s) => s.id === stats.topSession!.id) && (
                          <button
                            type="button"
                            className="top-session-jump-btn"
                            onClick={() =>
                              handleLocateChat(stats.topSession!.id, stats.topSession!.lastMsgId)
                            }
                            title="跳转到该高消耗会话"
                          >
                            <ArrowUpRight size={12} strokeWidth={2.2} />
                          </button>
                        )}
                      </div>
                      <div className="metric-breakdown-list">
                        <div className="breakdown-item">
                          <span>累计消耗 ({stats.topSession.calls} 次)</span>
                          <strong>{formatCompactNumber(stats.topSession.tokens)} tks</strong>
                        </div>
                        <div className="breakdown-item">
                          <span>占总开销比例</span>
                          <strong className="highlight-val">
                            {stats.topSession.share.toFixed(1)}%
                          </strong>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="metric-dual-row">
                        <span className="card-number">{stats.totalCalls.toLocaleString()}</span>
                        <span className="metric-inline-tag">总调用</span>
                      </div>
                      <div className="metric-breakdown-list">
                        <div className="breakdown-item">
                          <span>关联会话记录</span>
                          <strong>未绑定特定会话</strong>
                        </div>
                      </div>
                    </>
                  )}
                </article>
              </div>
            </section>

            {/* ── 2. 图表双栏 ─────────────────────────────────────────── */}
            <section className="charts-double-row" aria-label="趋势与模型份额图表">
              <article className="chart-box-card trend-chart-wrapper">
                <div className="chart-card-header">
                  <div>
                    <span className="chart-card-title">单次调用消耗走势与均值基线</span>
                    <span className="chart-card-subtitle">
                      最近 {trendData ? trendData.records.length : 0} 次请求采样 · 虚线为平均输入基线 (
                      {formatCompactNumber(stats.avgPrompt)})
                    </span>
                  </div>
                  <div className="chart-legends">
                    <span className="legend-item">
                      <span className="legend-dot cyan"></span>输入
                    </span>
                    <span className="legend-item">
                      <span className="legend-dot rose"></span>输出
                    </span>
                  </div>
                </div>

                <div className="chart-card-body">
                  {trendData ? (
                    <div className="trend-chart-stage">
                      <svg
                        viewBox={`0 0 ${trendData.width} ${trendData.height}`}
                        className="trend-svg"
                      >
                        <defs>
                          <linearGradient id="gradient-prompt" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#4d73f0" stopOpacity="0.22" />
                            <stop offset="100%" stopColor="#4d73f0" stopOpacity="0.0" />
                          </linearGradient>
                          <linearGradient id="gradient-completion" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.18" />
                            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.0" />
                          </linearGradient>
                        </defs>

                        {[0, 0.5, 1].map((ratio, idx) => {
                          const y = trendData.paddingTop + trendData.chartHeight * ratio
                          const val = Math.round(trendData.yMaxLimit * (1 - ratio))
                          return (
                            <g key={`grid-${idx}`}>
                              <line
                                x1={trendData.paddingLeft}
                                y1={y}
                                x2={trendData.width - trendData.paddingRight}
                                y2={y}
                                stroke="var(--border-color)"
                                strokeDasharray={ratio === 1 ? undefined : '3 3'}
                                strokeWidth={ratio === 1 ? '1.2' : '1'}
                              />
                              <text
                                x={trendData.paddingLeft - 8}
                                y={y + 3.5}
                                textAnchor="end"
                                className="axis-text"
                              >
                                {formatCompactNumber(val)}
                              </text>
                            </g>
                          )
                        })}

                        {trendData.avgPromptY !== null && (
                          <line
                            x1={trendData.paddingLeft}
                            y1={trendData.avgPromptY}
                            x2={trendData.width - trendData.paddingRight}
                            y2={trendData.avgPromptY}
                            stroke="#4d73f0"
                            strokeDasharray="4 4"
                            strokeWidth="1"
                            opacity="0.4"
                          />
                        )}

                        {trendData.areaPromptStr && (
                          <path d={trendData.areaPromptStr} fill="url(#gradient-prompt)" />
                        )}
                        {trendData.areaCompletionStr && (
                          <path d={trendData.areaCompletionStr} fill="url(#gradient-completion)" />
                        )}

                        <path
                          d={trendData.pathPromptStr}
                          fill="none"
                          stroke="#4d73f0"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                        />
                        <path
                          d={trendData.pathCompletionStr}
                          fill="none"
                          stroke="#0ea5e9"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />

                        {hoveredPointIdx !== null && trendData.pointsPrompt[hoveredPointIdx] && (
                          <line
                            x1={trendData.pointsPrompt[hoveredPointIdx].x}
                            y1={trendData.paddingTop}
                            x2={trendData.pointsPrompt[hoveredPointIdx].x}
                            y2={trendData.baselineY}
                            stroke="var(--text-muted)"
                            strokeDasharray="2 2"
                            strokeWidth="1"
                            opacity="0.55"
                          />
                        )}

                        {trendData.pointsPrompt.map((p, idx) => {
                          const rec = trendData.records[idx]
                          const isHovered = hoveredPointIdx === idx
                          const compPt = trendData.pointsCompletion[idx]
                          return (
                            <g
                              key={`dots-${idx}`}
                              onMouseEnter={() => setHoveredPointIdx(idx)}
                              onMouseLeave={() => setHoveredPointIdx(null)}
                            >
                              <rect
                                x={p.x - 16}
                                y={trendData.paddingTop}
                                width="32"
                                height={trendData.chartHeight + 20}
                                fill="transparent"
                                style={{ cursor: 'pointer' }}
                              />
                              <circle
                                cx={p.x}
                                cy={p.y}
                                r={isHovered ? '5' : '3.2'}
                                className="trend-node-dot prompt"
                              />
                              <circle
                                cx={compPt.x}
                                cy={compPt.y}
                                r={isHovered ? '4.5' : '2.8'}
                                className="trend-node-dot completion"
                              />

                              <text
                                x={p.x}
                                y={trendData.baselineY + 16}
                                textAnchor="middle"
                                className={`axis-text ${isHovered ? 'active' : ''}`}
                              >
                                {formatTimeX(rec.timestamp)}
                              </text>
                            </g>
                          )
                        })}
                      </svg>

                      {hoveredPointIdx !== null && trendData.records[hoveredPointIdx] && (
                        <div
                          className="chart-tooltip-bubble"
                          style={{
                            left: `${Math.min(
                              Math.max(
                                (trendData.pointsPrompt[hoveredPointIdx].x / trendData.width) * 100,
                                16
                              ),
                              84
                            )}%`
                          }}
                        >
                          <div className="tooltip-header">
                            <span className="tooltip-title">
                              {trendData.records[hoveredPointIdx].model}
                            </span>
                            <span className="tooltip-time">
                              {formatTimeX(trendData.records[hoveredPointIdx].timestamp)}
                            </span>
                          </div>
                          <div className="tooltip-row">
                            <span className="dot cyan"></span>
                            <span>输入</span>
                            <strong>
                              {trendData.records[hoveredPointIdx].promptTokens.toLocaleString()}
                            </strong>
                          </div>
                          <div className="tooltip-row">
                            <span className="dot rose"></span>
                            <span>输出</span>
                            <strong>
                              {trendData.records[hoveredPointIdx].completionTokens.toLocaleString()}
                            </strong>
                          </div>
                          <div className="tooltip-total">
                            <span>单次合计</span>
                            <strong>
                              {trendData.records[hoveredPointIdx].totalTokens.toLocaleString()} tks
                            </strong>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="empty-placeholder-chart">该时间段内暂无走势数据</div>
                  )}
                </div>
              </article>

              <article className="chart-box-card ratio-chart-wrapper">
                <div className="chart-card-header">
                  <div>
                    <span className="chart-card-title">模型份额与调用频次</span>
                    <span className="chart-card-subtitle">
                      点击模型可筛选下方明细 · 显示调用次数与次均开销
                    </span>
                  </div>
                </div>

                <div className="chart-card-body ratio-body-row">
                  {modelDistribution.length > 0 ? (
                    <>
                      <div className="ring-chart-svg-container">
                        <svg width="120" height="120" viewBox="0 0 100 100">
                          <circle
                            cx="50"
                            cy="50"
                            r={ringRadius}
                            fill="transparent"
                            stroke="var(--border-color)"
                            strokeWidth="7"
                          />
                          {modelDistribution.map((item, idx) => {
                            const offset = (ringAccumOffset / 100) * ringCircumference
                            ringAccumOffset += item.percentage
                            const isActive = activeHoveredModel?.name === item.name
                            return (
                              <circle
                                key={`ring-segment-${idx}`}
                                cx="50"
                                cy="50"
                                r={ringRadius}
                                fill="transparent"
                                stroke={item.color}
                                strokeWidth={isActive ? '9.5' : '7.5'}
                                strokeDasharray={`${Math.max(
                                  (item.percentage / 100) * ringCircumference,
                                  1.5
                                )} ${ringCircumference}`}
                                strokeDashoffset={-offset}
                                transform="rotate(-90 50 50)"
                                strokeLinecap="butt"
                                style={{
                                  transition: 'stroke-width 0.2s ease, opacity 0.2s ease',
                                  opacity: hoveredModelName && !isActive ? 0.45 : 1,
                                  cursor: 'pointer'
                                }}
                                onMouseEnter={() => setHoveredModelName(item.name)}
                                onMouseLeave={() => setHoveredModelName(null)}
                              />
                            )
                          })}
                          <circle cx="50" cy="50" r="30" fill="var(--bg-card)" />
                          <text
                            x="50"
                            y="45"
                            textAnchor="middle"
                            fill="var(--text-muted)"
                            fontSize="7.2"
                            fontWeight="600"
                          >
                            {activeHoveredModel ? `${activeHoveredModel.calls} 次调用` : '份额占比'}
                          </text>
                          <text
                            x="50"
                            y="58"
                            textAnchor="middle"
                            fill="var(--text-primary)"
                            fontSize="11"
                            fontWeight="750"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {activeHoveredModel
                              ? `${activeHoveredModel.percentage.toFixed(1)}%`
                              : '100%'}
                          </text>
                        </svg>
                      </div>

                      <div className="ring-legends-list">
                        {modelDistribution.map((item, idx) => {
                          const isSelected = selectedModelFilter === item.name
                          return (
                            <button
                              type="button"
                              key={`legend-${idx}`}
                              className={`legend-row-item ${isSelected ? 'selected' : ''}`}
                              onMouseEnter={() => setHoveredModelName(item.name)}
                              onMouseLeave={() => setHoveredModelName(null)}
                              onClick={() =>
                                setSelectedModelFilter((prev) =>
                                  prev === item.name ? 'all' : item.name
                                )
                              }
                              title={`点击筛选 ${item.name} 的调用记录`}
                            >
                              <div className="legend-row-top">
                                <div className="legend-row-left">
                                  <span
                                    className="legend-color-dot"
                                    style={{ backgroundColor: item.color }}
                                  />
                                  <span className="legend-model-name">{item.name}</span>
                                  <span className="legend-model-prov">
                                    {item.calls}次 · 均{formatCompactNumber(item.avgPerCall)}
                                  </span>
                                </div>
                                <div className="legend-row-right">
                                  <span className="legend-tk">{formatCompactNumber(item.total)}</span>
                                  <span className="legend-pct">{item.percentage.toFixed(1)}%</span>
                                </div>
                              </div>
                              <div className="legend-progress-track" aria-hidden="true">
                                <div
                                  className="legend-progress-fill"
                                  style={{
                                    width: `${Math.max(item.percentage, 2)}%`,
                                    backgroundColor: item.color
                                  }}
                                />
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="empty-placeholder-chart">该时间段内暂无大模型占比数据</div>
                  )}
                </div>
              </article>
            </section>

            {/* ── 3. 日志明细列表（严格列宽对齐 + 展示真实提问内容） ──────────────── */}
            <section className="logs-table-box-card" aria-label="Token 历史调用明细记录">
              <div className="table-card-header">
                <div className="table-title-group">
                  <Cpu size={14} strokeWidth={2} className="table-header-icon" aria-hidden="true" />
                  <span className="table-card-title">调用明细记录</span>
                  <span className="table-record-count">{filteredTableLogs.length} 条</span>
                  {selectedModelFilter !== 'all' && (
                    <button
                      type="button"
                      className="active-model-filter-chip"
                      onClick={() => setSelectedModelFilter('all')}
                    >
                      <span>模型: {selectedModelFilter}</span>
                      <X size={11} strokeWidth={2.2} aria-hidden="true" />
                    </button>
                  )}
                </div>

                <div className="table-card-actions">
                  <div className="logs-search-input-wrap">
                    <Search size={13} strokeWidth={2} className="search-icon" aria-hidden="true" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索提问内容、模型或会话..."
                      aria-label="搜索提问内容、模型或会话"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        className="clear-search-btn"
                        onClick={() => setSearchQuery('')}
                        aria-label="清除搜索"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="table-card-body">
                <div className="logs-table-container">
                  <table className="logs-aligned-table">
                    <colgroup>
                      <col style={{ width: '132px' }} />
                      <col style={{ width: '215px' }} />
                      <col />
                      <col style={{ width: '104px' }} />
                      <col style={{ width: '104px' }} />
                      <col style={{ width: '124px' }} />
                      <col style={{ width: '96px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>调用时间</th>
                        <th>模型与渠道</th>
                        <th>会话提问内容</th>
                        <th className="num-col">Prompt 输入</th>
                        <th className="num-col">Completion 输出</th>
                        <th className="num-col">总消耗 & 负载</th>
                        <th className="action-col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTableLogs.map((log) => {
                        const loadPercent =
                          stats.peakTokens > 0
                            ? Math.min(Math.round((log.totalTokens / stats.peakTokens) * 100), 100)
                            : 0
                        const isHighLoad =
                          stats.avgTokens > 0 && log.totalTokens >= stats.avgTokens * 1.35

                        const primaryQuestion =
                          log.questionText ||
                          (log.sessionName !== '未关联会话' ? log.sessionName : '系统后台调用 / 未记录提问文本')
                        const showSubSession =
                          Boolean(log.questionText) &&
                          log.sessionName &&
                          log.sessionName !== '未关联会话' &&
                          log.sessionName !== log.questionText

                        return (
                          <tr key={log.id}>
                            <td className="time-td">
                              <div className="time-cell-inner">
                                <Clock3
                                  size={12}
                                  strokeWidth={1.8}
                                  className="row-time-icon"
                                  aria-hidden="true"
                                />
                                <span>{formatTime(log.timestamp)}</span>
                              </div>
                            </td>
                            <td>
                              <div className="model-cell-stack">
                                <span className="model-td" title={log.model}>
                                  {log.model}
                                </span>
                                <span className={`provider-badge ${log.provider}`}>
                                  {log.provider}
                                </span>
                              </div>
                            </td>
                            <td className="question-td">
                              <div
                                className="question-cell-stack"
                                title={
                                  showSubSession
                                    ? `提问：${primaryQuestion}\n所属会话：${log.sessionName}`
                                    : primaryQuestion
                                }
                              >
                                <span
                                  className={`question-main-text ${log.questionText ? '' : 'muted'}`}
                                >
                                  {primaryQuestion}
                                </span>
                                {showSubSession && (
                                  <span className="question-sub-session">
                                    会话: {log.sessionName}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="num-td">{log.promptTokens.toLocaleString()}</td>
                            <td className="num-td">{log.completionTokens.toLocaleString()}</td>
                            <td className="num-td total-td">
                              <div className="total-cell-with-bar">
                                <span className={isHighLoad ? 'high-load-num' : ''}>
                                  {log.totalTokens.toLocaleString()}
                                </span>
                                <div className="row-load-bar-track" aria-hidden="true">
                                  <div
                                    className={`row-load-bar-fill ${isHighLoad ? 'high' : ''}`}
                                    style={{ width: `${Math.max(loadPercent, 4)}%` }}
                                  />
                                </div>
                              </div>
                            </td>
                            <td className="action-td">
                              {log.sessionId ? (
                                <button
                                  type="button"
                                  className="btn-locate-chat"
                                  onClick={() =>
                                    handleLocateChat(log.sessionId!, log.locateMessageId)
                                  }
                                  title="跳转并定位至该条对话消息"
                                >
                                  <span>定位对话</span>
                                  <ArrowUpRight size={12.5} strokeWidth={2} aria-hidden="true" />
                                </button>
                              ) : (
                                <span className="unbound-msg-label">未绑定</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                      {filteredTableLogs.length === 0 && (
                        <tr>
                          <td colSpan={7} className="empty-table-row">
                            当前筛选条件下暂无匹配的模型调用记录
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

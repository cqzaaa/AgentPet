import React, { useState, useMemo } from 'react'
import { type AppStore, useAppStoreRaw } from '../hooks/useAppStore'
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Flame,
  Gauge,
  Layers,
  MessageSquare,
  Sparkles,
  Trash2,
  TrendingUp,
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

  // 1. 时间范围筛选：'24h' | '7d' | 'all'，默认 '7d'
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | 'all'>('7d')
  // 2. 跨图表模型联动筛选
  const [selectedModelFilter, setSelectedModelFilter] = useState<string>('all')
  // 3. 走势图模式：'area' (平滑面积曲线) | 'bar' (堆叠柱状图)
  const [chartMode, setChartMode] = useState<'area' | 'bar'>('area')
  // 4. 走势图与环形图交互高亮状态
  const [hoveredPointIdx, setHoveredPointIdx] = useState<number | null>(null)
  const [hoveredModelName, setHoveredModelName] = useState<string | null>(null)

  const hasTotalData = tokenLogs.length > 0

  // 会话与提问内容快速解析索引（用于走势图采样点检视与 Top 会话卡片）
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

  // 按时间窗口过滤的基础日志
  const timeWindowLogs = useMemo(() => {
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

  // 叠加模型筛选后的活跃日志（驱动全页指标与图表联动）
  const activeLogs = useMemo(() => {
    if (selectedModelFilter === 'all') return timeWindowLogs
    return timeWindowLogs.filter((log) => (log.model || 'unknown') === selectedModelFilter)
  }, [timeWindowLogs, selectedModelFilter])

  const hasData = activeLogs.length > 0

  // ── 1. 深度统计指标计算 ───────────────────────────────────────────────
  const stats = useMemo(() => {
    let totalPrompt = 0
    let totalCompletion = 0
    const totalCalls = activeLogs.length
    let peakTokens = 0
    let peakModel = ''
    const perCallTotals: number[] = []
    const sessionTotals = new Map<
      string,
      {
        tokens: number
        prompt: number
        completion: number
        calls: number
        lastMsgId?: number
        lastQuestion?: string
      }
    >()

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
        const prev = sessionTotals.get(log.sessionId) || {
          tokens: 0,
          prompt: 0,
          completion: 0,
          calls: 0
        }
        prev.tokens += total
        prev.prompt += prompt
        prev.completion += completion
        prev.calls += 1
        if (log.messageId) prev.lastMsgId = log.messageId
        const ctx = sessionLookup.resolveLogContext(log)
        if (ctx.questionText) prev.lastQuestion = ctx.questionText
        sessionTotals.set(log.sessionId, prev)
      }
    })

    const totalTokens = totalPrompt + totalCompletion
    const promptRatio = totalTokens > 0 ? (totalPrompt / totalTokens) * 100 : 0
    const completionRatio = totalTokens > 0 ? (totalCompletion / totalTokens) * 100 : 0
    const avgTokens = totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0
    const avgPrompt = totalCalls > 0 ? Math.round(totalPrompt / totalCalls) : 0
    const avgCompletion = totalCalls > 0 ? Math.round(totalCompletion / totalCalls) : 0

    // 计算中位数 P50 与 P90 分位数
    let medianTokens = 0
    let p90Tokens = 0
    if (perCallTotals.length > 0) {
      const sorted = [...perCallTotals].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      medianTokens =
        sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      const p90Idx = Math.min(Math.floor(sorted.length * 0.9), sorted.length - 1)
      p90Tokens = sorted[p90Idx]
    }

    const ioMultiplier =
      totalCompletion > 0 ? (totalPrompt / totalCompletion).toFixed(1) : totalPrompt > 0 ? '∞' : '0'

    type SessionRankItem = {
      id: string
      name: string
      tokens: number
      prompt: number
      completion: number
      calls: number
      share: number
      promptShareInSession: number
      lastMsgId?: number
      lastQuestion?: string
    }

    const rankedSessions: SessionRankItem[] = Array.from(sessionTotals.entries())
      .map(([sessId, val]) => ({
        id: sessId,
        name: sessionLookup.nameMap.get(sessId) || '历史已归档会话',
        tokens: val.tokens,
        prompt: val.prompt,
        completion: val.completion,
        calls: val.calls,
        share: totalTokens > 0 ? (val.tokens / totalTokens) * 100 : 0,
        promptShareInSession: val.tokens > 0 ? (val.prompt / val.tokens) * 100 : 50,
        lastMsgId: val.lastMsgId,
        lastQuestion: val.lastQuestion
      }))
      .sort((a, b) => b.tokens - a.tokens)

    const topSession = rankedSessions[0] || null

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
      p90Tokens,
      peakTokens,
      peakModel,
      ioMultiplier,
      activeSessionCount: sessionTotals.size,
      topSession,
      topSessionsList: rankedSessions.slice(0, 5)
    }
  }, [activeLogs, sessionLookup])

  // ── 2. 模型份额环形图计算（基于时间窗口全集，保持筛选入口始终可见）───────
  const modelDistribution = useMemo(() => {
    if (timeWindowLogs.length === 0) return []
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

    const colors = ['#4d73f0', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']
    let colorIdx = 0

    timeWindowLogs.forEach((log) => {
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
        prompt: data.prompt,
        completion: data.completion,
        promptRatio: data.total > 0 ? (data.prompt / data.total) * 100 : 50,
        calls: data.calls,
        avgPerCall: Math.round(data.total / data.calls),
        percentage: (data.total / totalAll) * 100,
        color: data.color
      }))
      .sort((a, b) => b.total - a.total)
  }, [timeWindowLogs])

  // ── 3. 全量 X 轴压缩调用走势与堆叠图计算（一次看完当前时间范围全部调用）──────
  const trendData = useMemo(() => {
    if (!hasData) return null
    const records = activeLogs.map((r) => {
      const ctx = sessionLookup.resolveLogContext(r)
      return {
        ...r,
        sessionName: ctx.sessionName,
        questionText: ctx.questionText,
        locateMessageId: ctx.locateMessageId
      }
    })

    const maxVal =
      chartMode === 'bar'
        ? Math.max(...records.map((r) => (r.promptTokens || 0) + (r.completionTokens || 0))) || 100
        : Math.max(...records.map((r) => Math.max(r.promptTokens || 0, r.completionTokens || 0))) ||
          100
    const yMaxLimit = Math.ceil(maxVal * 1.14)

    const width = 620
    const height = 158
    const paddingLeft = 44
    const paddingRight = 14
    const paddingTop = 16
    const paddingBottom = 22

    const chartWidth = width - paddingLeft - paddingRight
    const chartHeight = height - paddingTop - paddingBottom
    const baselineY = paddingTop + chartHeight

    const pointsPrompt: { x: number; y: number }[] = []
    const pointsCompletion: { x: number; y: number }[] = []
    const bars: {
      x: number
      barWidth: number
      promptHeight: number
      completionHeight: number
      yPromptTop: number
      yCompletionTop: number
    }[] = []

    let peakIdx = 0
    let maxRecordTotal = -1

    const barWidth = Math.min(20, Math.max(1.8, (chartWidth / records.length) * 0.68))

    records.forEach((rec, idx) => {
      const stepX = records.length > 1 ? chartWidth / (records.length - 1) : chartWidth / 2
      const x =
        chartMode === 'bar'
          ? paddingLeft + (idx + 0.5) * (chartWidth / records.length)
          : records.length > 1
            ? paddingLeft + idx * stepX
            : paddingLeft + chartWidth / 2

      const promptVal = rec.promptTokens || 0
      const compVal = rec.completionTokens || 0
      const totalVal = promptVal + compVal

      if (totalVal > maxRecordTotal) {
        maxRecordTotal = totalVal
        peakIdx = idx
      }

      const yPrompt = baselineY - (promptVal / yMaxLimit) * chartHeight
      const yCompletion = baselineY - (compVal / yMaxLimit) * chartHeight

      pointsPrompt.push({ x, y: yPrompt })
      pointsCompletion.push({ x, y: yCompletion })

      const promptH = (promptVal / yMaxLimit) * chartHeight
      const compH = (compVal / yMaxLimit) * chartHeight
      const yPromptTop = baselineY - promptH
      const yCompletionTop = yPromptTop - compH

      bars.push({
        x,
        barWidth,
        promptHeight: Math.max(promptH, promptVal > 0 ? 1.5 : 0),
        completionHeight: Math.max(compH, compVal > 0 ? 1.5 : 0),
        yPromptTop,
        yCompletionTop
      })
    })

    const buildPath = (pts: { x: number; y: number }[]): string => {
      if (pts.length === 0) return ''
      if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
      // 采样点较少时使用三次贝塞尔平滑曲线，全量密集压缩时使用高保真折线防过冲
      if (pts.length <= 36) {
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
      return pts
        .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
        .join(' ')
    }

    const pathPromptStr = buildPath(pointsPrompt)
    const pathCompletionStr = buildPath(pointsCompletion)

    const areaPromptStr =
      pointsPrompt.length > 1
        ? `${pathPromptStr} L ${pointsPrompt[pointsPrompt.length - 1].x.toFixed(1)} ${baselineY} L ${pointsPrompt[0].x.toFixed(1)} ${baselineY} Z`
        : ''
    const areaCompletionStr =
      pointsCompletion.length > 1
        ? `${pathCompletionStr} L ${pointsCompletion[pointsCompletion.length - 1].x.toFixed(1)} ${baselineY} L ${pointsCompletion[0].x.toFixed(1)} ${baselineY} Z`
        : ''

    const refAvgVal = chartMode === 'bar' ? stats.avgTokens : stats.avgPrompt
    const avgLineY =
      refAvgVal > 0 && refAvgVal <= yMaxLimit
        ? baselineY - (refAvgVal / yMaxLimit) * chartHeight
        : null

    // 生成均匀分布的 X 轴刻度索引（最多 6 个刻度点，覆盖首尾全周期）
    const tickIndices: number[] = []
    const totalCount = records.length
    if (totalCount <= 6) {
      for (let i = 0; i < totalCount; i++) tickIndices.push(i)
    } else {
      const steps = 5
      for (let s = 0; s <= steps; s++) {
        tickIndices.push(Math.round((s * (totalCount - 1)) / steps))
      }
    }

    const spanMs =
      totalCount > 1 ? Math.abs(records[totalCount - 1].timestamp - records[0].timestamp) : 0
    const showDateOnAxis = spanMs > 20 * 3600 * 1000

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
      bars,
      peakIdx,
      pathPromptStr,
      areaPromptStr,
      pathCompletionStr,
      areaCompletionStr,
      yMaxLimit,
      avgLineY,
      refAvgVal,
      tickIndices,
      showDateOnAxis
    }
  }, [activeLogs, hasData, stats.avgPrompt, stats.avgTokens, chartMode, sessionLookup])

  // ── 4. 单次请求负载分布直方图（Token Bucket Distribution）────────────
  const loadBuckets = useMemo(() => {
    const buckets = [
      {
        id: 'light',
        label: '轻量交互',
        range: '< 1k tks',
        count: 0,
        tokens: 0,
        color: '#10b981'
      },
      {
        id: 'standard',
        label: '标准上下文',
        range: '1k – 4k',
        count: 0,
        tokens: 0,
        color: '#0ea5e9'
      },
      {
        id: 'heavy',
        label: '高载上下文',
        range: '4k – 12k',
        count: 0,
        tokens: 0,
        color: '#4d73f0'
      },
      {
        id: 'extreme',
        label: '超长窗口',
        range: '> 12k tks',
        count: 0,
        tokens: 0,
        color: '#f59e0b'
      }
    ]

    activeLogs.forEach((log) => {
      const total = (log.promptTokens || 0) + (log.completionTokens || 0)
      if (total < 1000) {
        buckets[0].count += 1
        buckets[0].tokens += total
      } else if (total < 4000) {
        buckets[1].count += 1
        buckets[1].tokens += total
      } else if (total < 12000) {
        buckets[2].count += 1
        buckets[2].tokens += total
      } else {
        buckets[3].count += 1
        buckets[3].tokens += total
      }
    })

    const maxCount = Math.max(...buckets.map((b) => b.count), 1)
    const totalCalls = activeLogs.length || 1

    return buckets.map((b) => ({
      ...b,
      shareOfCalls: (b.count / totalCalls) * 100,
      barHeightRatio: b.count > 0 ? Math.max((b.count / maxCount) * 100, 12) : 4
    }))
  }, [activeLogs])

  // 格式化紧凑数值
  const formatCompactNumber = (val: number): string => {
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`
    if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`
    return String(val)
  }

  // 格式化 X 轴刻度（跨天自动附带月/日，同日显示时/分）
  const formatTimeX = (ts: number, includeDate: boolean): string => {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    if (!includeDate) return `${hh}:${mm}`
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${month}/${day} ${hh}:${mm}`
  }

  // 格式化完整月日时分
  const formatFullTime = (ts: number): string => {
    const d = new Date(ts)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${month}-${day} ${hh}:${mm}:${ss}`
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
  const ringRadius = 41
  const ringCircumference = 2 * Math.PI * ringRadius
  let ringAccumOffset = 0

  const activeHoveredModel = useMemo(() => {
    if (hoveredModelName) {
      return modelDistribution.find((m) => m.name === hoveredModelName) || modelDistribution[0] || null
    }
    if (selectedModelFilter !== 'all') {
      return (
        modelDistribution.find((m) => m.name === selectedModelFilter) ||
        modelDistribution[0] ||
        null
      )
    }
    return modelDistribution[0] || null
  }, [hoveredModelName, selectedModelFilter, modelDistribution])

  // 走势图底部实时检视的采样记录（默认展示悬停点，未悬停时展示最新一次调用）
  const inspectedRecord = useMemo(() => {
    if (!trendData || trendData.records.length === 0) return null
    const safeIdx =
      hoveredPointIdx !== null && trendData.records[hoveredPointIdx]
        ? hoveredPointIdx
        : trendData.records.length - 1
    return {
      record: trendData.records[safeIdx],
      index: safeIdx,
      isPeak: safeIdx === trendData.peakIdx
    }
  }, [trendData, hoveredPointIdx])

  // 在全量压缩走势图上通过鼠标横向移动平滑定位任意一次历史调用
  const handleTrendMouseMove = (e: React.MouseEvent<SVGRectElement>): void => {
    if (!trendData || trendData.records.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const idx =
      chartMode === 'bar'
        ? Math.min(
            trendData.records.length - 1,
            Math.floor(ratio * trendData.records.length)
          )
        : Math.round(ratio * (trendData.records.length - 1))
    setHoveredPointIdx(idx)
  }

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
                  当前视图共 <strong>{stats.totalCalls.toLocaleString()}</strong> 次调用 · 涉及{' '}
                  <strong>{stats.activeSessionCount}</strong> 个会话与{' '}
                  <strong>{modelDistribution.length}</strong> 个模型
                </span>
                {selectedModelFilter !== 'all' && (
                  <button
                    type="button"
                    className="active-model-filter-chip"
                    onClick={() => setSelectedModelFilter('all')}
                    title="点击清除模型筛选，恢复全部模型视图"
                  >
                    <span>聚焦模型: {selectedModelFilter}</span>
                    <X size={11} strokeWidth={2.3} aria-hidden="true" />
                  </button>
                )}
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
                  <span className="card-label">累计总吞吐量</span>
                  <span className="metric-pill">读写比 {stats.ioMultiplier} : 1</span>
                </div>

                <div className="primary-metric-value-row">
                  <span className="card-number primary-number">
                    {stats.totalTokens.toLocaleString()}
                  </span>
                  <span className="metric-unit">{formatCompactNumber(stats.totalTokens)} tks</span>
                </div>

                <div className="token-composition-bar" aria-hidden="true">
                  <div
                    className="composition-segment prompt"
                    style={{
                      width: `${Math.max(stats.promptRatio, stats.totalTokens > 0 ? 3 : 50)}%`
                    }}
                  />
                  <div
                    className="composition-segment completion"
                    style={{
                      width: `${Math.max(stats.completionRatio, stats.totalTokens > 0 ? 3 : 50)}%`
                    }}
                  />
                </div>

                <div className="composition-legend-grid">
                  <div className="composition-stat-box">
                    <span className="composition-meta-label">
                      <i className="dot prompt" />
                      Prompt 输入
                    </span>
                    <div className="composition-meta-val">
                      <strong>{formatCompactNumber(stats.totalPrompt)}</strong>
                      <small>{stats.promptRatio.toFixed(1)}%</small>
                    </div>
                  </div>
                  <div className="composition-stat-box">
                    <span className="composition-meta-label">
                      <i className="dot completion" />
                      Completion 输出
                    </span>
                    <div className="composition-meta-val">
                      <strong>{formatCompactNumber(stats.totalCompletion)}</strong>
                      <small>{stats.completionRatio.toFixed(1)}%</small>
                    </div>
                  </div>
                </div>
              </article>

              <div className="secondary-metrics-grid">
                <article className="stat-glow-card">
                  <div className="metric-card-top">
                    <span className="card-label">单次调用负载</span>
                    <Gauge size={14} strokeWidth={1.8} className="metric-icon prompt" />
                  </div>
                  <div className="metric-dual-row">
                    <span className="card-number">{stats.avgTokens.toLocaleString()}</span>
                    <span className="metric-inline-tag">均 tks/次</span>
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
                    <span className="card-label">单次读写均值</span>
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
                    <span className="card-label">最高消耗会话</span>
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
                          <span>累计 ({stats.topSession.calls} 次)</span>
                          <strong>{formatCompactNumber(stats.topSession.tokens)} tks</strong>
                        </div>
                        <div className="breakdown-item">
                          <span>占总开销比</span>
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
                          <span>关联会话</span>
                          <strong>未绑定会话</strong>
                        </div>
                      </div>
                    </>
                  )}
                </article>
              </div>
            </section>

            {/* ── 2. 主视觉双栏：全量 X 轴压缩走势图 + 模型份额环形图 ─────────── */}
            <section className="charts-double-row" aria-label="趋势与模型份额图表">
              <article className="chart-box-card trend-chart-wrapper">
                <div className="chart-card-header">
                  <div>
                    <div className="chart-title-with-badge">
                      <span className="chart-card-title">单次调用消耗走势与基线</span>
                      <span className="chart-sample-badge">
                        全量 {trendData ? trendData.records.length : 0} 次调用
                      </span>
                    </div>
                    <span className="chart-card-subtitle">
                      虚线为{chartMode === 'bar' ? '单次总均值' : '平均输入'}基线 (
                      {formatCompactNumber(trendData?.refAvgVal || 0)}) · 沿 X 轴滑动或点击可检视任意调用
                    </span>
                  </div>

                  <div className="chart-header-right">
                    <div className="chart-legends">
                      <span className="legend-item">
                        <span className="legend-dot cyan"></span>输入
                      </span>
                      <span className="legend-item">
                        <span className="legend-dot rose"></span>输出
                      </span>
                    </div>

                    <div className="chart-mode-switch" role="group" aria-label="图表视图模式">
                      <button
                        type="button"
                        className={`mode-switch-btn ${chartMode === 'area' ? 'active' : ''}`}
                        onClick={() => setChartMode('area')}
                        title="平滑面积曲线视图"
                      >
                        <TrendingUp size={12} strokeWidth={2} />
                        <span>曲线</span>
                      </button>
                      <button
                        type="button"
                        className={`mode-switch-btn ${chartMode === 'bar' ? 'active' : ''}`}
                        onClick={() => setChartMode('bar')}
                        title="读写堆叠柱状视图"
                      >
                        <BarChart3 size={12} strokeWidth={2} />
                        <span>堆叠</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className="chart-card-body trend-card-body">
                  {trendData ? (
                    <>
                      <div className="trend-chart-stage">
                        <svg
                          viewBox={`0 0 ${trendData.width} ${trendData.height}`}
                          className="trend-svg"
                        >
                          <defs>
                            <linearGradient id="gradient-prompt" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#4d73f0" stopOpacity="0.28" />
                              <stop offset="100%" stopColor="#4d73f0" stopOpacity="0.0" />
                            </linearGradient>
                            <linearGradient id="gradient-completion" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.22" />
                              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.0" />
                            </linearGradient>
                            <linearGradient id="bar-grad-prompt" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#4d73f0" stopOpacity="0.92" />
                              <stop offset="100%" stopColor="#4d73f0" stopOpacity="0.65" />
                            </linearGradient>
                            <linearGradient id="bar-grad-completion" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.95" />
                              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.72" />
                            </linearGradient>
                          </defs>

                          {/* 水平网格线、Y 轴刻度与底部 X 轴基线 */}
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
                                  strokeWidth={ratio === 1 ? '1.15' : '1'}
                                />
                                <text
                                  x={trendData.paddingLeft - 7}
                                  y={y + 3.5}
                                  textAnchor="end"
                                  className="axis-text"
                                >
                                  {formatCompactNumber(val)}
                                </text>
                              </g>
                            )
                          })}

                          {/* 均值基线 */}
                          {trendData.avgLineY !== null && (
                            <g>
                              <line
                                x1={trendData.paddingLeft}
                                y1={trendData.avgLineY}
                                x2={trendData.width - trendData.paddingRight}
                                y2={trendData.avgLineY}
                                stroke="#4d73f0"
                                strokeDasharray="4 4"
                                strokeWidth="1.1"
                                opacity="0.45"
                              />
                              <rect
                                x={trendData.width - trendData.paddingRight - 46}
                                y={Math.max(trendData.avgLineY - 14, 2)}
                                width="46"
                                height="12.5"
                                rx="4"
                                fill="var(--bg-card)"
                                stroke="rgba(77, 115, 240, 0.3)"
                                strokeWidth="0.8"
                              />
                              <text
                                x={trendData.width - trendData.paddingRight - 23}
                                y={Math.max(trendData.avgLineY - 5.2, 10.5)}
                                textAnchor="middle"
                                className="avg-line-tag-text"
                              >
                                AVG {formatCompactNumber(trendData.refAvgVal)}
                              </text>
                            </g>
                          )}

                          {chartMode === 'area' ? (
                            <>
                              {trendData.areaPromptStr && (
                                <path d={trendData.areaPromptStr} fill="url(#gradient-prompt)" />
                              )}
                              {trendData.areaCompletionStr && (
                                <path
                                  d={trendData.areaCompletionStr}
                                  fill="url(#gradient-completion)"
                                />
                              )}

                              <path
                                d={trendData.pathPromptStr}
                                fill="none"
                                stroke="#4d73f0"
                                strokeWidth={trendData.records.length > 60 ? '1.6' : '2.1'}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d={trendData.pathCompletionStr}
                                fill="none"
                                stroke="#0ea5e9"
                                strokeWidth={trendData.records.length > 60 ? '1.4' : '1.8'}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </>
                          ) : (
                            /* 堆叠柱状图模式 */
                            trendData.bars.map((bar, idx) => {
                              const isHovered = hoveredPointIdx === idx
                              const dimmed = hoveredPointIdx !== null && !isHovered
                              return (
                                <g
                                  key={`bar-group-${idx}`}
                                  style={{
                                    opacity: dimmed ? 0.42 : 1,
                                    transition: 'opacity 120ms ease'
                                  }}
                                >
                                  {bar.promptHeight > 0 && (
                                    <rect
                                      x={bar.x - bar.barWidth / 2}
                                      y={bar.yPromptTop}
                                      width={bar.barWidth}
                                      height={bar.promptHeight}
                                      rx={bar.barWidth > 5 ? '2' : '0.8'}
                                      fill="url(#bar-grad-prompt)"
                                    />
                                  )}
                                  {bar.completionHeight > 0 && (
                                    <rect
                                      x={bar.x - bar.barWidth / 2}
                                      y={bar.yCompletionTop}
                                      width={bar.barWidth}
                                      height={Math.max(bar.completionHeight - 0.8, 1.2)}
                                      rx={bar.barWidth > 5 ? '2' : '0.8'}
                                      fill="url(#bar-grad-completion)"
                                    />
                                  )}
                                </g>
                              )
                            })
                          )}

                          {/* 悬停垂直参考准星 */}
                          {hoveredPointIdx !== null && trendData.pointsPrompt[hoveredPointIdx] && (
                            <line
                              x1={trendData.pointsPrompt[hoveredPointIdx].x}
                              y1={trendData.paddingTop}
                              x2={trendData.pointsPrompt[hoveredPointIdx].x}
                              y2={trendData.baselineY}
                              stroke="var(--logs-accent)"
                              strokeDasharray="2.5 2.5"
                              strokeWidth="1.1"
                              opacity="0.65"
                            />
                          )}

                          {/* 峰值标记徽章 */}
                          {trendData.records.length > 2 &&
                            trendData.pointsPrompt[trendData.peakIdx] && (
                              <g className="peak-callout-group" pointerEvents="none">
                                {(() => {
                                  const pkIdx = trendData.peakIdx
                                  const pkX = Math.min(
                                    Math.max(
                                      trendData.pointsPrompt[pkIdx].x,
                                      trendData.paddingLeft + 26
                                    ),
                                    trendData.width - trendData.paddingRight - 26
                                  )
                                  const pkY =
                                    chartMode === 'bar'
                                      ? trendData.bars[pkIdx].yCompletionTop
                                      : Math.min(
                                          trendData.pointsPrompt[pkIdx].y,
                                          trendData.pointsCompletion[pkIdx].y
                                        )
                                  const badgeY = Math.max(pkY - 16, 2)
                                  return (
                                    <>
                                      <rect
                                        x={pkX - 24}
                                        y={badgeY}
                                        width="48"
                                        height="13.5"
                                        rx="4"
                                        fill="rgba(245, 158, 11, 0.14)"
                                        stroke="rgba(245, 158, 11, 0.45)"
                                        strokeWidth="0.9"
                                      />
                                      <text
                                        x={pkX}
                                        y={badgeY + 9.4}
                                        textAnchor="middle"
                                        className="peak-badge-svg-text"
                                      >
                                        MAX {formatCompactNumber(trendData.records[pkIdx].totalTokens)}
                                      </text>
                                    </>
                                  )
                                })()}
                              </g>
                            )}

                          {/* 关键采样节点圆点（少量调用时全部显示，大量调用时显示首尾、峰值与当前悬停点） */}
                          {chartMode === 'area' &&
                            trendData.pointsPrompt.map((p, idx) => {
                              const isHovered = hoveredPointIdx === idx
                              const shouldRenderDot =
                                trendData.records.length <= 28 ||
                                isHovered ||
                                idx === 0 ||
                                idx === trendData.records.length - 1 ||
                                idx === trendData.peakIdx
                              if (!shouldRenderDot) return null
                              const compPt = trendData.pointsCompletion[idx]
                              return (
                                <g key={`dots-${idx}`} pointerEvents="none">
                                  <circle
                                    cx={p.x}
                                    cy={p.y}
                                    r={isHovered ? '4.8' : '2.8'}
                                    className="trend-node-dot prompt"
                                  />
                                  <circle
                                    cx={compPt.x}
                                    cy={compPt.y}
                                    r={isHovered ? '4.2' : '2.4'}
                                    className="trend-node-dot completion"
                                  />
                                </g>
                              )
                            })}

                          {/* 底部 X 轴均匀时间刻度（自适应全周期压缩） */}
                          {trendData.tickIndices.map((idx) => {
                            const pt = trendData.pointsPrompt[idx]
                            const rec = trendData.records[idx]
                            if (!pt || !rec) return null
                            const isFirst = idx === 0
                            const isLast = idx === trendData.records.length - 1 && idx > 0
                            return (
                              <text
                                key={`xtick-${idx}`}
                                x={pt.x}
                                y={trendData.baselineY + 14}
                                textAnchor={isFirst ? 'start' : isLast ? 'end' : 'middle'}
                                className={`axis-text ${hoveredPointIdx === idx ? 'active' : ''}`}
                              >
                                {formatTimeX(rec.timestamp, trendData.showDateOnAxis)}
                              </text>
                            )
                          })}

                          {/* 全宽平滑交互热区：鼠标沿 X 轴滑动即可检视任意一次调用并点击定位 */}
                          <rect
                            x={trendData.paddingLeft}
                            y={trendData.paddingTop}
                            width={trendData.chartWidth}
                            height={trendData.chartHeight + 18}
                            fill="transparent"
                            style={{ cursor: 'pointer' }}
                            onMouseMove={handleTrendMouseMove}
                            onMouseLeave={() => setHoveredPointIdx(null)}
                            onClick={() => {
                              if (inspectedRecord?.record.sessionId) {
                                handleLocateChat(
                                  inspectedRecord.record.sessionId,
                                  inspectedRecord.record.locateMessageId
                                )
                              }
                            }}
                          />
                        </svg>

                        {/* 悬浮详情气泡（向上穿透卡片边界，不遮挡折线图画布） */}
                        {hoveredPointIdx !== null && trendData.records[hoveredPointIdx] && (
                          <div
                            className="chart-tooltip-bubble"
                            style={{
                              left: `${Math.max(
                                (trendData.pointsPrompt[hoveredPointIdx].x / trendData.width) * 100,
                                14
                              )}%`
                            }}
                          >
                            <div className="tooltip-header">
                              <span className="tooltip-title">
                                {trendData.records[hoveredPointIdx].model}
                              </span>
                              <span className="tooltip-time">
                                {formatFullTime(trendData.records[hoveredPointIdx].timestamp)}
                              </span>
                            </div>
                            {trendData.records[hoveredPointIdx].questionText && (
                              <div className="tooltip-question-preview">
                                “{trendData.records[hoveredPointIdx].questionText}”
                              </div>
                            )}
                            <div className="tooltip-row">
                              <span className="dot cyan"></span>
                              <span>Prompt 输入</span>
                              <strong>
                                {trendData.records[hoveredPointIdx].promptTokens.toLocaleString()}
                              </strong>
                            </div>
                            <div className="tooltip-row">
                              <span className="dot rose"></span>
                              <span>Completion 输出</span>
                              <strong>
                                {trendData.records[
                                  hoveredPointIdx
                                ].completionTokens.toLocaleString()}
                              </strong>
                            </div>
                            <div className="tooltip-total">
                              <span>单次总消耗</span>
                              <strong>
                                {trendData.records[hoveredPointIdx].totalTokens.toLocaleString()} tks
                              </strong>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 底部采样检视栏（Inspector Strip） */}
                      {inspectedRecord && (
                        <div className="trend-inspector-strip">
                          <div className="inspector-left">
                            <span className="inspector-badge">
                              {hoveredPointIdx !== null
                                ? `#${inspectedRecord.index + 1}/${trendData.records.length}`
                                : '最新调用'}
                            </span>
                            <span className="inspector-model">{inspectedRecord.record.model}</span>
                            <span className="inspector-divider">·</span>
                            <span
                              className="inspector-question"
                              title={
                                inspectedRecord.record.questionText ||
                                inspectedRecord.record.sessionName
                              }
                            >
                              {inspectedRecord.record.questionText
                                ? `提问：${inspectedRecord.record.questionText}`
                                : `会话：${inspectedRecord.record.sessionName}`}
                            </span>
                          </div>
                          <div className="inspector-right">
                            <span className="inspector-tokens">
                              <strong>{inspectedRecord.record.totalTokens.toLocaleString()}</strong>{' '}
                              tks
                            </span>
                            {inspectedRecord.record.sessionId && (
                              <button
                                type="button"
                                className="inspector-jump-btn"
                                onClick={() =>
                                  handleLocateChat(
                                    inspectedRecord.record.sessionId!,
                                    inspectedRecord.record.locateMessageId
                                  )
                                }
                              >
                                <span>定位对话</span>
                                <ArrowUpRight size={11} strokeWidth={2.2} />
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="empty-placeholder-chart">该时间段内暂无走势数据</div>
                  )}
                </div>
              </article>

              {/* 右卡：模型份额环形图与读写构成列表 */}
              <article className="chart-box-card ratio-chart-wrapper">
                <div className="chart-card-header">
                  <div>
                    <span className="chart-card-title">模型份额与调用频次</span>
                    <span className="chart-card-subtitle">
                      点击模型可联动全页图表筛选 · 展示调用次数与读写构成
                    </span>
                  </div>
                </div>

                <div className="chart-card-body ratio-body-row">
                  {modelDistribution.length > 0 ? (
                    <>
                      <div className="ring-chart-svg-container">
                        <svg width="118" height="118" viewBox="0 0 100 100">
                          <circle
                            cx="50"
                            cy="50"
                            r={ringRadius}
                            fill="transparent"
                            stroke="var(--border-color)"
                            strokeWidth="7.5"
                          />
                          {modelDistribution.map((item, idx) => {
                            const offset = (ringAccumOffset / 100) * ringCircumference
                            ringAccumOffset += item.percentage
                            const isActive = activeHoveredModel?.name === item.name
                            const segLen = Math.max(
                              (item.percentage / 100) * ringCircumference -
                                (modelDistribution.length > 1 ? 1.4 : 0),
                              1.5
                            )
                            return (
                              <circle
                                key={`ring-segment-${idx}`}
                                cx="50"
                                cy="50"
                                r={ringRadius}
                                fill="transparent"
                                stroke={item.color}
                                strokeWidth={isActive ? '10' : '7.8'}
                                strokeDasharray={`${segLen} ${ringCircumference}`}
                                strokeDashoffset={-offset}
                                transform="rotate(-90 50 50)"
                                strokeLinecap="butt"
                                style={{
                                  transition: 'stroke-width 0.2s ease, opacity 0.2s ease',
                                  opacity:
                                    (hoveredModelName || selectedModelFilter !== 'all') && !isActive
                                      ? 0.38
                                      : 1,
                                  cursor: 'pointer'
                                }}
                                onMouseEnter={() => setHoveredModelName(item.name)}
                                onMouseLeave={() => setHoveredModelName(null)}
                                onClick={() =>
                                  setSelectedModelFilter((prev) =>
                                    prev === item.name ? 'all' : item.name
                                  )
                                }
                              />
                            )
                          })}
                          <circle cx="50" cy="50" r="30.5" fill="var(--bg-card)" />
                          <text
                            x="50"
                            y="43"
                            textAnchor="middle"
                            fill="var(--text-muted)"
                            fontSize="6.8"
                            fontWeight="650"
                          >
                            {activeHoveredModel ? `${activeHoveredModel.calls} 次调用` : '份额占比'}
                          </text>
                          <text
                            x="50"
                            y="55.5"
                            textAnchor="middle"
                            fill="var(--text-primary)"
                            fontSize="11.5"
                            fontWeight="780"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {activeHoveredModel
                              ? `${activeHoveredModel.percentage.toFixed(1)}%`
                              : '100%'}
                          </text>
                          <text
                            x="50"
                            y="65"
                            textAnchor="middle"
                            fill="var(--text-muted)"
                            fontSize="6.2"
                            fontWeight="600"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {activeHoveredModel
                              ? `${formatCompactNumber(activeHoveredModel.total)} tks`
                              : ''}
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
                              title={`点击聚焦查看 ${item.name} 的图表数据`}
                            >
                              <div className="legend-row-top">
                                <div className="legend-row-left">
                                  <span
                                    className="legend-color-dot"
                                    style={{ backgroundColor: item.color }}
                                  />
                                  <span className="legend-model-name" title={item.name}>
                                    {item.name}
                                  </span>
                                </div>
                                <span className="legend-pct">{item.percentage.toFixed(1)}%</span>
                              </div>
                              <div className="legend-row-sub">
                                <span>
                                  {item.calls} 次 · 均 {formatCompactNumber(item.avgPerCall)}/次
                                </span>
                                <span className="legend-tk">
                                  {formatCompactNumber(item.total)} tks
                                </span>
                              </div>
                              <div className="legend-progress-track" aria-hidden="true">
                                <div
                                  className="legend-progress-fill"
                                  style={{
                                    width: `${Math.max(item.percentage, 3)}%`,
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

            {/* ── 3. 深度分布双栏：Top 会话消耗堆叠排行 + 单次负载量级直方图 ── */}
            <section className="charts-bottom-row" aria-label="会话消耗排行与负载量级分布">
              {/* 左卡：Top 会话 Token 消耗横向堆叠图 */}
              <article className="chart-box-card session-rank-card">
                <div className="chart-card-header">
                  <div>
                    <div className="chart-title-with-badge">
                      <Flame size={14} strokeWidth={2} className="section-title-icon flame" />
                      <span className="chart-card-title">高消耗会话排行与读写构成</span>
                    </div>
                    <span className="chart-card-subtitle">
                      按会话聚合累计 Token 消耗 Top 5 · 双色条展示输入与输出占比
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

                <div className="session-rank-list">
                  {stats.topSessionsList.length > 0 ? (
                    stats.topSessionsList.map((sess, idx) => {
                      const maxSessTokens = stats.topSessionsList[0]?.tokens || 1
                      const barScale = Math.max((sess.tokens / maxSessTokens) * 100, 8)
                      const promptW = Math.max(sess.promptShareInSession, 6)
                      const compW = Math.max(100 - sess.promptShareInSession, 6)
                      const canJump = sessions.some((s) => s.id === sess.id)

                      return (
                        <div key={sess.id} className="session-rank-item">
                          <div className="session-rank-top">
                            <div className="session-rank-title-wrap">
                              <span className={`session-rank-idx ${idx === 0 ? 'top1' : ''}`}>
                                0{idx + 1}
                              </span>
                              <span className="session-rank-name" title={sess.name}>
                                {sess.name}
                              </span>
                              <span className="session-rank-calls">{sess.calls} 次调用</span>
                            </div>

                            <div className="session-rank-metrics">
                              <span className="session-rank-tokens">
                                {formatCompactNumber(sess.tokens)} tks
                              </span>
                              <span className="session-rank-share">{sess.share.toFixed(1)}%</span>
                              {canJump && (
                                <button
                                  type="button"
                                  className="session-rank-jump"
                                  onClick={() => handleLocateChat(sess.id, sess.lastMsgId)}
                                  title="定位至该会话"
                                >
                                  <ArrowUpRight size={11.5} strokeWidth={2.2} />
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="session-stacked-bar-track" aria-hidden="true">
                            <div
                              className="session-stacked-bar-group"
                              style={{ width: `${barScale}%` }}
                            >
                              <div
                                className="session-bar-seg prompt"
                                style={{ width: `${promptW}%` }}
                              />
                              <div
                                className="session-bar-seg completion"
                                style={{ width: `${compW}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      )
                    })
                  ) : (
                    <div className="empty-placeholder-chart">暂无关联会话的消耗排行数据</div>
                  )}
                </div>
              </article>

              {/* 右卡：单次请求负载量级分布直方图（带 X 轴量级刻度） */}
              <article className="chart-box-card load-dist-card">
                <div className="chart-card-header">
                  <div>
                    <div className="chart-title-with-badge">
                      <Layers size={14} strokeWidth={2} className="section-title-icon layers" />
                      <span className="chart-card-title">单次请求负载量级分布</span>
                    </div>
                    <span className="chart-card-subtitle">
                      按单次 Token 规模统计调用频次分布 · 识别长上下文重度请求占比
                    </span>
                  </div>
                  <span className="p90-pill-badge">
                    <Sparkles size={11} strokeWidth={2} />
                    <span>P90: {formatCompactNumber(stats.p90Tokens)}</span>
                  </span>
                </div>

                <div className="load-histogram-body">
                  <div className="histogram-columns-grid">
                    {loadBuckets.map((bucket) => (
                      <div key={bucket.id} className="histogram-col-item">
                        <div className="histogram-col-top-meta">
                          <strong className="histogram-col-count">{bucket.count} 次</strong>
                          <span className="histogram-col-pct">
                            {bucket.shareOfCalls.toFixed(0)}%
                          </span>
                        </div>

                        <div className="histogram-bar-well" aria-hidden="true">
                          <div
                            className="histogram-bar-fill"
                            style={{
                              height: `${bucket.barHeightRatio}%`,
                              backgroundColor: bucket.color
                            }}
                          />
                        </div>

                        <div className="histogram-col-footer">
                          <span className="histogram-bucket-label">{bucket.label}</span>
                          <span className="histogram-bucket-range">{bucket.range}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="load-dist-summary-bar">
                    <div className="dist-summary-stat">
                      <span>中位负载 (P50)</span>
                      <strong>{stats.medianTokens.toLocaleString()} tks</strong>
                    </div>
                    <div className="dist-summary-stat">
                      <span>高分位负载 (P90)</span>
                      <strong>{stats.p90Tokens.toLocaleString()} tks</strong>
                    </div>
                    <div className="dist-summary-stat">
                      <span>历史单次峰值</span>
                      <strong className="peak-text">{stats.peakTokens.toLocaleString()} tks</strong>
                    </div>
                  </div>
                </div>
              </article>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

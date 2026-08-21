import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import {
  Activity,
  Bot,
  Box,
  BrainCircuit,
  ChevronRight,
  CircleAlert,
  Clock3,
  GitBranch,
  Search,
  Sparkles,
  TerminalSquare,
  UserRound,
  X
} from 'lucide-react'
import { useAppStoreRaw } from '../hooks/useAppStore'
import './TrajectoryPage.css'

type TraceSource = 'user' | 'assistant' | 'model' | 'tool' | 'system' | 'context' | 'subagent'

interface TraceEvent {
  sessionId: string
  seq: number
  time: number
  type: string
  source: TraceSource
  turn?: number
  step?: number
  correlationId?: string
  messageId?: string
  data: Record<string, any>
  payloadBytes: number
  compressed?: boolean
}

type FilterId = 'all' | 'model' | 'tool' | 'context' | 'subagent' | 'errors'

const PAGE_SIZE = 260
const FILTERS: Array<{ id: FilterId; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'model', label: '模型' },
  { id: 'tool', label: '工具' },
  { id: 'context', label: '上下文' },
  { id: 'subagent', label: '子 Agent' },
  { id: 'errors', label: '异常' }
]

function typesForFilter(filter: FilterId): string[] | undefined {
  if (filter === 'model') return ['request/header', 'request/start', 'assistant/chunk', 'assistant/message', 'assistant/reasoning', 'usage/tokens']
  if (filter === 'tool') return ['tool/call', 'tool/result', 'artifact/generated']
  if (filter === 'context') return ['user/message', 'compaction/started', 'compaction/completed', 'compaction/failed']
  if (filter === 'errors') return ['error']
  return undefined
}

function sourcesForFilter(filter: FilterId): TraceSource[] | undefined {
  return filter === 'subagent' ? ['subagent'] : undefined
}

function matchesFilter(event: TraceEvent, filter: FilterId): boolean {
  if (filter === 'all') return true
  if (filter === 'subagent') return event.type.startsWith('subagent/')
  const types = typesForFilter(filter)
  return Boolean(types?.includes(event.type))
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(item => typeof item === 'string' ? item : item?.text || '').filter(Boolean).join('\n')
}

function eventSummary(event: TraceEvent): string {
  const data = event.data || {}
  if (data.truncated) return String(data.preview || '大型负载，选择后读取完整内容')
  if (event.type === 'user/message') return textFromContent(data.message?.content) || '用户输入进入本轮上下文'
  if (event.type === 'request/header') return `${data.header?.provider || ''} / ${data.header?.model || ''} · ${Array.isArray(data.header?.tools) ? data.header.tools.length : 0} 个工具`
  if (event.type === 'request/start') return `${data.messageCount || 0} 条消息进入模型请求`
  if (event.type === 'assistant/chunk') return String(data.content || '')
  if (event.type === 'assistant/message') return textFromContent(data.message?.content) || `${data.message?.tool_calls?.length || 0} 个工具调用`
  if (event.type === 'assistant/reasoning') return String(data.detail || '')
  if (event.type === 'tool/call') return `${data.name || '工具'}(${compactJson(data.arguments)})`
  if (event.type === 'tool/result') return String(data.displayResult || data.modelResult || '工具执行完成')
  if (event.type === 'usage/tokens') return `输入 ${data.promptTokens || 0} · 输出 ${data.completionTokens || 0} tokens`
  if (event.type.startsWith('subagent/')) return `${data.action || event.type.slice(9)} · ${data.run?.title || data.taskRunId || ''}`
  if (event.type.startsWith('compaction/')) return `${data.beforeTokens || 0} → ${data.afterTokens || '—'} tokens`
  if (event.type === 'turn/start') return `${data.provider || ''} ${data.model || ''}`.trim() || '开始执行'
  if (event.type === 'turn/end') return `结束原因：${data.reason || 'completed'}`
  if (event.type === 'error') return String(data.message || '执行异常')
  if (event.type === 'artifact/generated') return `${Array.isArray(data.files) ? data.files.length : 0} 个产物`
  return compactJson(data)
}

function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text.length > 280 ? `${text.slice(0, 280)}…` : text
  } catch {
    return String(value ?? '')
  }
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    'turn/start': 'Turn 开始',
    'turn/end': 'Turn 结束',
    'user/message': '用户输入',
    'request/header': '请求配置',
    'request/start': '模型请求',
    'assistant/chunk': '流式输出',
    'assistant/message': '模型回复',
    'assistant/reasoning': '推理过程',
    'tool/call': '工具调用',
    'tool/result': '工具结果',
    'usage/tokens': 'Token 用量',
    'artifact/generated': '生成产物',
    error: '执行异常'
  }
  if (type.startsWith('subagent/')) return '子 Agent'
  if (type.startsWith('compaction/')) return '上下文压缩'
  return labels[type] || type
}

function category(event: TraceEvent): string {
  if (event.type === 'error') return 'error'
  if (event.type.startsWith('tool/') || event.type === 'artifact/generated') return 'tool'
  if (event.type.startsWith('subagent/')) return 'subagent'
  if (event.type.startsWith('compaction/')) return 'context'
  if (event.type === 'user/message') return 'user'
  if (event.type.startsWith('assistant/')) return event.type === 'assistant/reasoning' ? 'reasoning' : 'assistant'
  if (event.type.startsWith('request/') || event.type === 'usage/tokens') return 'model'
  return 'system'
}

function timelineLane(event: TraceEvent): 0 | 1 | 2 {
  const kind = category(event)
  if (kind === 'tool' || kind === 'subagent') return 2
  if (kind === 'model' || kind === 'assistant' || kind === 'reasoning' || kind === 'error') return 1
  return 0
}

function timelineDuration(events: TraceEvent[], index: number): number {
  const event = events[index]
  if (event.type === 'tool/call') {
    const result = events.slice(index + 1).find(candidate =>
      candidate.type === 'tool/result' && candidate.correlationId === event.correlationId)
    return result ? Math.max(0, result.time - event.time) : 0
  }
  if (event.type === 'request/start') {
    const result = events.slice(index + 1).find(candidate =>
      candidate.type === 'assistant/message' && candidate.step === event.step)
    return result ? Math.max(0, result.time - event.time) : 0
  }
  if (event.type === 'assistant/chunk') {
    return Math.max(0, (events[index + 1]?.time || event.time) - event.time)
  }
  return 0
}

function EventIcon({ event }: { event: TraceEvent }): React.JSX.Element {
  const kind = category(event)
  if (kind === 'user') return <UserRound size={15} />
  if (kind === 'tool') return <TerminalSquare size={15} />
  if (kind === 'subagent') return <GitBranch size={15} />
  if (kind === 'reasoning') return <BrainCircuit size={15} />
  if (kind === 'assistant') return <Sparkles size={15} />
  if (kind === 'model') return <Bot size={15} />
  if (kind === 'error') return <CircleAlert size={15} />
  if (kind === 'context') return <Box size={15} />
  return <Activity size={15} />
}

function formatClock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

export function TrajectoryPage(): React.JSX.Element {
  const activeSessionId = useAppStoreRaw(state => state.activeSessionId) as string
  const sessions = useAppStoreRaw(state => state.sessions) as any[]
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [filter, setFilter] = useState<FilterId>('all')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim())
  const [selected, setSelected] = useState<TraceEvent | null>(null)
  const [selectedFull, setSelectedFull] = useState<TraceEvent | null>(null)
  const [followTail, setFollowTail] = useState(true)
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(() => new Set())
  const latestTurnRef = useRef<number | undefined>(undefined)

  const activeSession = sessions.find(session => session.id === activeSessionId)

  const loadTail = useCallback(async () => {
    if (!activeSessionId) return
    setLoading(true)
    try {
      const page = await window.api.getSessionEvents(activeSessionId, {
        limit: PAGE_SIZE,
        types: typesForFilter(filter),
        sources: sourcesForFilter(filter),
        search: deferredQuery || undefined
      })
      const nextEvents: TraceEvent[] = (page?.events || []).filter((event: TraceEvent) => matchesFilter(event, filter))
      const loadedTurns = [...new Set(nextEvents.flatMap((event: TraceEvent) =>
        event.turn === undefined ? [] : [event.turn]))]
      const latestTurn = loadedTurns[loadedTurns.length - 1]
      latestTurnRef.current = latestTurn
      setCollapsedTurns(new Set(loadedTurns.filter(turn => turn !== latestTurn)))
      setEvents(nextEvents)
      setTotal(Number(page?.total || 0))
      setHasMore(Boolean(page?.hasMore))
      setSelected(current => current && nextEvents.some((event: TraceEvent) => event.seq === current.seq) ? current : null)
    } finally {
      setLoading(false)
    }
  }, [activeSessionId, deferredQuery, filter])

  useEffect(() => { void loadTail() }, [loadTail])

  useEffect(() => window.api.onSessionEventsAppended((appended: TraceEvent[]) => {
    const sessionEvents = appended.filter(event => event.sessionId === activeSessionId)
    if (sessionEvents.length === 0) return
    const appendedTurn = [...sessionEvents].reverse().find(event => event.turn !== undefined)?.turn
    if (appendedTurn !== undefined && appendedTurn !== latestTurnRef.current) {
      const previousLatest = latestTurnRef.current
      latestTurnRef.current = appendedTurn
      setCollapsedTurns(current => {
        const next = new Set(current)
        if (previousLatest !== undefined) next.add(previousLatest)
        next.delete(appendedTurn)
        return next
      })
    }
    setTotal(current => current + sessionEvents.length)
    const normalizedQuery = deferredQuery.toLocaleLowerCase()
    const visible = sessionEvents.filter(event => {
      const searchText = `${event.type}\n${eventSummary(event)}`.toLocaleLowerCase()
      return matchesFilter(event, filter) && (!normalizedQuery || searchText.includes(normalizedQuery))
    })
    if (visible.length === 0) return
    setEvents(current => {
      const known = new Set(current.map(item => item.seq))
      const novel = visible.filter(event => !known.has(event.seq))
      if (novel.length === 0) return current
      const next = [...current, ...novel]
      const overflow = Math.max(0, next.length - 2_000)
      return overflow > 0 ? next.slice(overflow) : next
    })
  }), [activeSessionId, deferredQuery, filter])

  useEffect(() => {
    setSelectedFull(selected)
    if (!selected?.data?.truncated) return
    let active = true
    window.api.getSessionEvent(selected.sessionId, selected.seq).then(event => {
      if (active && event) setSelectedFull(event)
    }).catch(console.error)
    return () => { active = false }
  }, [selected])

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || events.length === 0) return
    setLoadingOlder(true)
    try {
      const page = await window.api.getSessionEvents(activeSessionId, {
        beforeSeq: events[0].seq,
        limit: PAGE_SIZE,
        types: typesForFilter(filter),
        sources: sourcesForFilter(filter),
        search: deferredQuery || undefined
      })
      const older = (page?.events || []).filter((event: TraceEvent) => matchesFilter(event, filter))
      if (older.length > 0) {
        setEvents(current => [...older, ...current])
      }
      setHasMore(Boolean(page?.hasMore))
    } finally {
      setLoadingOlder(false)
    }
  }, [activeSessionId, deferredQuery, events, filter, hasMore, loadingOlder])

  const metrics = useMemo(() => {
    let tools = 0
    let requests = 0
    let errors = 0
    let promptTokens = 0
    let completionTokens = 0
    for (const event of events) {
      if (event.type === 'tool/call') tools += 1
      if (event.type === 'request/start') requests += 1
      if (event.type === 'error') errors += 1
      if (event.type === 'usage/tokens') {
        promptTokens += Number(event.data?.promptTokens || 0)
        completionTokens += Number(event.data?.completionTokens || 0)
      }
    }
    const first = events[0]?.time
    const last = events[events.length - 1]?.time
    return { tools, requests, errors, promptTokens, completionTokens, duration: first && last ? last - first : 0 }
  }, [events])

  const turnSummaries = useMemo(() => {
    const summaries = new Map<number, { count: number; start: number; end: number }>()
    for (const event of events) {
      if (event.turn === undefined) continue
      const current = summaries.get(event.turn)
      if (current) {
        current.count += 1
        current.end = event.time
      } else {
        summaries.set(event.turn, { count: 1, start: event.time, end: event.time })
      }
    }
    return summaries
  }, [events])
  const turns = turnSummaries.size
  const visibleEvents = useMemo(() => {
    const seenTurns = new Set<number>()
    return events.filter(event => {
      if (event.turn === undefined) return true
      const firstInTurn = !seenTurns.has(event.turn)
      seenTurns.add(event.turn)
      return firstInTurn || !collapsedTurns.has(event.turn)
    })
  }, [collapsedTurns, events])
  const selectedIndex = selected ? events.findIndex(event => event.seq === selected.seq) : -1
  const selectedDuration = selectedIndex >= 0 && selectedIndex < events.length - 1
    ? events[selectedIndex + 1].time - events[selectedIndex].time
    : 0

  return (
    <div className="trajectory-page">
      <header className="trajectory-header">
        <div className="trajectory-title-block">
          <h1>执行轨迹</h1>
          <p>{activeSession?.name || '当前会话'} · {total.toLocaleString()} 个耐久事件</p>
        </div>
        <div className="trajectory-metrics" aria-label="轨迹摘要">
          <div><strong>{turns}</strong><span>轮次</span></div>
          <div><strong>{metrics.requests}</strong><span>请求</span></div>
          <div><strong>{metrics.tools}</strong><span>工具</span></div>
          <div className={metrics.errors ? 'metric-error' : ''}><strong>{metrics.errors}</strong><span>异常</span></div>
          <div><strong>{formatDuration(metrics.duration)}</strong><span>已加载时长</span></div>
        </div>
      </header>

      <section className="trajectory-overview" aria-label="事件时间概览">
        <div className="timeline-plot">
          <div className="timeline-labels" aria-hidden="true">
            <span>输入</span>
            <span>模型</span>
            <span>工具</span>
          </div>
          <div
            className="timeline-track"
            onClick={(pointer) => {
              if (events.length === 0) return
              const rect = pointer.currentTarget.getBoundingClientRect()
              const fraction = Math.min(1, Math.max(0, (pointer.clientX - rect.left) / Math.max(1, rect.width)))
              const start = events[0].time
              const end = events[events.length - 1].time
              const targetTime = start + fraction * Math.max(1, end - start)
              const nearest = events.reduce((best, candidate) =>
                Math.abs(candidate.time - targetTime) < Math.abs(best.time - targetTime) ? candidate : best)
              setSelected(nearest)
            }}
            title={events.length > 0 ? `${formatClock(events[0].time)} → ${formatClock(events[events.length - 1].time)}` : '暂无时间数据'}
          >
            {events.map((event, index) => {
              if (index > 0 && events[index - 1].turn === event.turn) return null
              const start = events[0]?.time || 0
              const span = Math.max(1, (events[events.length - 1]?.time || 0) - start)
              return <i key={`turn-${event.seq}`} className="timeline-turn-boundary" style={{ left: `${((event.time - start) / span) * 100}%` }} />
            })}
            {events.map((event, index) => {
              const start = events[0]?.time || 0
              const span = Math.max(1, (events[events.length - 1]?.time || 0) - start)
              const duration = timelineDuration(events, index)
              const left = ((event.time - start) / span) * 100
              const width = (duration / span) * 100
              return (
                <button
                  key={event.seq}
                  className={`timeline-span lane-${timelineLane(event)} kind-${category(event)} ${duration === 0 ? 'point' : ''} ${selected?.seq === event.seq ? 'selected' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${eventLabel(event.type)}\n${formatClock(event.time)}${duration ? ` · ${formatDuration(duration)}` : ''}`}
                  onClick={(pointer) => { pointer.stopPropagation(); setSelected(event) }}
                />
              )
            })}
          </div>
        </div>
      </section>

      <div className="trajectory-toolbar">
        <div className="trajectory-filter-tabs">
          {FILTERS.map(item => (
            <button key={item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>
          ))}
        </div>
        <label className="trajectory-search">
          <Search size={14} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事件、工具或输出" />
          {query && <button onClick={() => setQuery('')} aria-label="清空搜索"><X size={13} /></button>}
        </label>
      </div>

      <main className={`trajectory-workspace ${selected ? 'with-inspector' : ''}`}>
        <section className="trajectory-ledger" aria-label="事件账本">
          {loading ? (
            <div className="trajectory-loading"><span />正在读取事件流…</div>
          ) : events.length === 0 ? (
            <div className="trajectory-empty">
              <div className="empty-orbit"><Activity size={28} /></div>
              <h2>这段会话还没有轨迹</h2>
              <p>发送下一条消息后，请求、工具、推理和子 Agent 调度会按发生顺序出现在这里。</p>
            </div>
          ) : (
            <Virtuoso
              className="trajectory-virtuoso"
              data={visibleEvents}
              computeItemKey={(_index, event) => event.seq}
              startReached={() => { if (hasMore) void loadOlder() }}
              followOutput={followTail ? 'smooth' : false}
              atBottomStateChange={setFollowTail}
              increaseViewportBy={{ top: 400, bottom: 600 }}
              components={{
                Header: () => hasMore || loadingOlder
                  ? <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '正在读取…' : '载入更早事件'}</button>
                  : <div className="ledger-origin">SESSION ORIGIN</div>
              }}
              itemContent={(index, event) => {
                const previous = index > 0 ? visibleEvents[index - 1] : undefined
                const turnChanged = previous?.turn !== event.turn && event.turn !== undefined
                const stepChanged = previous?.step !== event.step && event.step !== undefined
                const turnCollapsed = event.turn !== undefined && collapsedTurns.has(event.turn)
                const turnSummary = event.turn === undefined ? undefined : turnSummaries.get(event.turn)
                return (
                  <div className={`trace-row-shell ${turnChanged ? 'turn-start' : ''} ${turnCollapsed ? 'turn-collapsed' : ''}`}>
                    {turnChanged && (
                      <button
                        className={`trace-turn-rule ${turnCollapsed ? 'collapsed' : ''}`}
                        aria-expanded={!turnCollapsed}
                        onClick={() => {
                          if (event.turn === undefined) return
                          setCollapsedTurns(current => {
                            const next = new Set(current)
                            if (next.has(event.turn!)) next.delete(event.turn!)
                            else next.add(event.turn!)
                            return next
                          })
                        }}
                      >
                        <ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" />
                        <span>TURN {String(event.turn).padStart(2, '0')}</span>
                        {turnSummary && <small>{turnSummary.count} 个事件 · {formatDuration(turnSummary.end - turnSummary.start)}</small>}
                        <i />
                      </button>
                    )}
                    {!turnCollapsed && (
                      <>
                        {stepChanged && <div className="trace-step-marker">STEP {event.step}</div>}
                        <button
                          className={`trace-row kind-${category(event)} ${selected?.seq === event.seq ? 'selected' : ''}`}
                          onClick={() => setSelected(event)}
                        >
                          <span className="trace-rail"><i /><b /></span>
                          <span className="trace-seq">{String(event.seq).padStart(4, '0')}</span>
                          <span className="trace-icon"><EventIcon event={event} /></span>
                          <span className="trace-main">
                            <span className="trace-row-title">
                              <strong>{eventLabel(event.type)}</strong>
                              <code>{event.type}</code>
                            </span>
                            <span className="trace-summary">{eventSummary(event)}</span>
                          </span>
                          <span className="trace-meta">
                            <time>{formatClock(event.time)}</time>
                            {event.payloadBytes > 0 && <small>{formatBytes(event.payloadBytes)}</small>}
                          </span>
                          <ChevronRight className="trace-chevron" size={15} />
                        </button>
                      </>
                    )}
                  </div>
                )
              }}
            />
          )}
        </section>

        {selected && (
          <aside className="trajectory-inspector" aria-label="事件详情">
            <div className="inspector-head">
              <div className={`inspector-symbol kind-${category(selected)}`}><EventIcon event={selected} /></div>
              <div><span>EVENT {String(selected.seq).padStart(4, '0')}</span><h2>{eventLabel(selected.type)}</h2></div>
              <button onClick={() => setSelected(null)} aria-label="关闭详情"><X size={16} /></button>
            </div>

            <div className="inspector-facts">
              <div><span>发生时间</span><strong>{formatClock(selected.time)}</strong></div>
              <div><span>至下一事件</span><strong>{selectedDuration ? formatDuration(selectedDuration) : '—'}</strong></div>
              <div><span>来源</span><strong>{selected.source}</strong></div>
              <div><span>负载</span><strong>{formatBytes(selected.payloadBytes)}</strong></div>
            </div>

            <div className="inspector-section">
              <h3>位置</h3>
              <div className="inspector-location">
                <span>Session</span><code>{selected.sessionId}</code>
                <span>Turn / Step</span><code>{selected.turn ?? '—'} / {selected.step ?? '—'}</code>
                <span>Correlation</span><code>{selected.correlationId || '—'}</code>
              </div>
            </div>

            <div className="inspector-section inspector-payload">
              <h3>原始事件负载 {selected.compressed && <em>GZIP</em>}</h3>
              {selected.data?.truncated && selectedFull?.seq === selected.seq && selectedFull.data?.truncated ? (
                <div className="payload-loading">正在解压完整负载…</div>
              ) : (
                <pre>{JSON.stringify(selectedFull?.seq === selected.seq ? selectedFull.data : selected.data, null, 2)}</pre>
              )}
            </div>

            {(selected.type === 'usage/tokens' || metrics.promptTokens + metrics.completionTokens > 0) && (
              <div className="inspector-token-strip">
                <Clock3 size={14} />
                Loaded window · {(metrics.promptTokens + metrics.completionTokens).toLocaleString()} tokens
              </div>
            )}
          </aside>
        )}
      </main>
    </div>
  )
}

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso } from 'react-virtuoso'
import {
  Activity,
  Bot,
  Box,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  Copy,
  GitBranch,
  Maximize2,
  Minimize2,
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
  if (filter === 'model') return ['request/start', 'model/request', 'model/response', 'assistant/chunk', 'assistant/message', 'assistant/reasoning', 'assistant/reasoning_chunk', 'usage/tokens']
  if (filter === 'tool') return ['tool/call', 'tool/result', 'mcp/connection', 'mcp/request', 'mcp/response', 'mcp/error', 'artifact/generated']
  if (filter === 'context') return ['user/message', 'compaction/started', 'compaction/completed', 'compaction/failed']
  if (filter === 'errors') return ['error', 'mcp/error']
  return undefined
}

function sourcesForFilter(filter: FilterId): TraceSource[] | undefined {
  return filter === 'subagent' ? ['subagent'] : undefined
}

function matchesFilter(event: TraceEvent, filter: FilterId): boolean {
  if (event.type === 'request/header') return false
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

function mcpTransportLabel(value: unknown): string {
  if (value === 'streamable-http' || value === 'stream') return 'Streamable HTTP'
  if (value === 'sse') return 'SSE'
  if (value === 'auto') return 'Auto'
  return value ? String(value) : '协议待定'
}

function remoteHttpUrl(event: TraceEvent, events: TraceEvent[]): string {
  const accept = (value: unknown): string => {
    const url = typeof value === 'string' ? value.trim() : ''
    return /^https?:\/\//i.test(url) ? url : ''
  }
  if (event.type === 'model/request') return accept(event.data?.request?.url)
  if (event.type === 'model/response') {
    const request = events.find(candidate =>
      candidate.type === 'model/request' && candidate.correlationId === event.correlationId)
    return accept(request?.data?.request?.url)
  }
  if (event.type.startsWith('mcp/')) return accept(event.data?.server?.endpoint)
  if (event.type === 'tool/call' && (event.data?.name === 'browser_navigate' || event.data?.name === 'web_fetch')) {
    return accept(event.data?.arguments?.url)
  }
  if (event.type === 'tool/result') {
    const request = events.find(candidate =>
      candidate.type === 'tool/call' &&
      candidate.correlationId === event.correlationId &&
      (candidate.data?.name === 'browser_navigate' || candidate.data?.name === 'web_fetch'))
    return accept(request?.data?.arguments?.url)
  }
  return ''
}

function eventSummary(event: TraceEvent): string {
  const data = event.data || {}
  if (data.truncated) return String(data.preview || '大型负载，选择后读取完整内容')
  if (event.type === 'user/message') return textFromContent(data.message?.content) || '用户输入进入本轮上下文'
  if (event.type === 'request/start') return `${data.messageCount || 0} 条消息完成上下文准备`
  if (event.type === 'model/request') {
    const request = data.request || {}
    const body = request.body || {}
    return `${request.method || 'POST'} · ${body.model || ''} · ${Array.isArray(body.messages) ? body.messages.length : 0} 条消息`
  }
  if (event.type === 'model/response') {
    const response = data.response || {}
    const units = Array.isArray(response.events) ? `${response.events.length} 个 SSE 数据帧` : 'JSON 响应体'
    return `${response.status || '—'} · ${units}`
  }
  if (event.type === 'assistant/chunk') return String(data.content || '')
  if (event.type === 'assistant/message') return textFromContent(data.message?.content) || `${data.message?.tool_calls?.length || 0} 个工具调用`
  if (event.type === 'assistant/reasoning') return String(data.detail || '')
  if (event.type === 'assistant/reasoning_chunk') return String(data.detail || '')
  if (event.type === 'tool/call') return `${data.name || '工具'}(${compactJson(data.arguments)})`
  if (event.type === 'tool/result') return String(data.displayResult || data.modelResult || '工具执行完成')
  if (event.type === 'mcp/connection') {
    if (data.status === 'ready') return `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.server?.transport)} · 连接就绪 · ${data.toolsCount || 0} 个工具`
    if (data.status === 'fallback') return `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.from)} 失败，回退 ${mcpTransportLabel(data.to)}`
    return `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.server?.configuredTransport)} · 正在建立连接`
  }
  if (event.type === 'mcp/request') {
    const method = data.request?.method || 'tools/call'
    return data.phase === 'connection'
      ? `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.server?.transport)} · 初始化阶段 · ${method}`
      : `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.server?.transport)} · ${method} · 第 ${data.attempt || 1} 次`
  }
  if (event.type === 'mcp/response') {
    if (data.phase === 'connection') return `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.server?.transport)} · ${data.requestMethod || '初始化'} 响应`
    return `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.server?.transport)} · 返回 ${Array.isArray(data.response?.result?.content) ? data.response.result.content.length : 0} 段内容`
  }
  if (event.type === 'mcp/error') return `${data.server?.name || 'MCP'} · ${mcpTransportLabel(data.server?.transport || data.server?.configuredTransport)} · ${data.error?.message || '请求失败'}`
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
    'request/start': '请求上下文准备',
    'model/request': '模型网络请求',
    'model/response': '模型网络响应',
    'assistant/chunk': '流式输出',
    'assistant/message': '模型回复',
    'assistant/reasoning': '推理过程',
    'assistant/reasoning_chunk': '实时推理',
    'tool/call': '工具调用',
    'tool/result': '工具结果',
    'mcp/connection': 'MCP 连接',
    'mcp/request': 'MCP 请求报文',
    'mcp/response': 'MCP 返回报文',
    'mcp/error': 'MCP 请求异常',
    'usage/tokens': 'Token 用量',
    'artifact/generated': '生成产物',
    error: '执行异常'
  }
  if (type.startsWith('subagent/')) return '子 Agent'
  if (type.startsWith('compaction/')) return '上下文压缩'
  return labels[type] || type
}

function eventBoundary(type: string): { kind: 'request' | 'response' | 'internal'; label: string } {
  if (type === 'model/request') return { kind: 'request', label: '网络请求' }
  if (type === 'model/response') return { kind: 'response', label: '网络响应' }
  if (type === 'mcp/request') return { kind: 'request', label: 'MCP 请求' }
  if (type === 'mcp/response') return { kind: 'response', label: 'MCP 响应' }
  return { kind: 'internal', label: '内部事件' }
}

function category(event: TraceEvent): string {
  if (event.type === 'error' || event.type === 'mcp/error') return 'error'
  if (event.type.startsWith('tool/') || event.type.startsWith('mcp/') || event.type === 'artifact/generated') return 'tool'
  if (event.type.startsWith('subagent/')) return 'subagent'
  if (event.type.startsWith('compaction/')) return 'context'
  if (event.type === 'user/message') return 'user'
  if (event.type.startsWith('assistant/')) return event.type.startsWith('assistant/reasoning') ? 'reasoning' : 'assistant'
  if (event.type.startsWith('request/') || event.type.startsWith('model/') || event.type === 'usage/tokens') return 'model'
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
  if (event.type === 'mcp/request') {
    const result = events.slice(index + 1).find(candidate =>
      (candidate.type === 'mcp/response' || candidate.type === 'mcp/error') &&
      candidate.correlationId === event.correlationId &&
      candidate.data?.attempt === event.data?.attempt)
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

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object'
}

function collectContainerPaths(value: unknown, path = '$', paths = new Set<string>()): Set<string> {
  if (!isContainer(value)) return paths
  paths.add(path)
  Object.entries(value).forEach(([key, child]) => collectContainerPaths(child, `${path}.${key}`, paths))
  return paths
}

function initiallyExpandedPaths(value: unknown, path = '$', depth = 0, paths = new Set<string>()): Set<string> {
  if (!isContainer(value)) return paths
  if (depth <= 2) paths.add(path)
  Object.entries(value).forEach(([key, child]) => initiallyExpandedPaths(child, `${path}.${key}`, depth + 1, paths))
  return paths
}

function isConsumedPayloadPath(type: string, path: string[]): boolean {
  const leaf = path[path.length - 1]
  const providerField = leaf === 'content' || leaf === 'reasoning_content'
  const providerPayload = providerField && path.includes('choices') && (path.includes('message') || path.includes('delta'))
  if (type === 'model/response') return providerPayload
  if (type === 'assistant/chunk') return path.join('.') === 'content' || providerPayload
  if (type === 'assistant/reasoning' || type === 'assistant/reasoning_chunk') {
    return path.join('.') === 'detail' || providerPayload
  }
  if (type === 'assistant/message') {
    return path[0] === 'message' && (leaf === 'content' || leaf === 'reasoning_content' || leaf === 'tool_calls')
  }
  if (type === 'user/message') return path[0] === 'message' && leaf === 'content'
  if (type === 'tool/call') return leaf === 'name' || leaf === 'arguments'
  if (type === 'tool/result') return leaf === 'displayResult' || leaf === 'modelResult'
  if (type === 'mcp/request') return path[0] === 'request'
  if (type === 'mcp/response') return path[0] === 'response'
  return false
}

function JsonPrimitive({ value }: { value: unknown }): React.JSX.Element {
  if (typeof value === 'string') return <span className="json-string">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="json-boolean">{String(value)}</span>
  if (value === null) return <span className="json-null">null</span>
  return <span>{String(value)}</span>
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (window.api?.copyText) {
    window.api.copyText(value)
    return
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Fall through to the selection-based compatibility path.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('复制 JSON 失败')
}

function JsonTreeNode({
  value,
  label,
  path,
  eventType,
  expanded,
  onToggle
}: {
  value: unknown
  label?: string
  path: string[]
  eventType: string
  expanded: Set<string>
  onToggle: (path: string) => void
}): React.JSX.Element {
  const pathKey = path.length ? `$.${path.join('.')}` : '$'
  const consumed = isConsumedPayloadPath(eventType, path)
  if (!isContainer(value)) {
    return (
      <div className={`json-tree-leaf ${consumed ? 'frontend-consumed' : ''}`} role="treeitem">
        {label !== undefined && <span className="json-key">{label}:</span>}
        <JsonPrimitive value={value} />
      </div>
    )
  }

  const open = expanded.has(pathKey)
  const entries = Object.entries(value)
  const opening = Array.isArray(value) ? '[' : '{'
  const closing = Array.isArray(value) ? ']' : '}'
  return (
    <div className={`json-tree-branch ${consumed ? 'frontend-consumed' : ''}`} role="treeitem">
      <button className="json-tree-toggle" onClick={() => onToggle(pathKey)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label !== undefined && <span className="json-key">{label}:</span>}
        <span className="json-bracket">{opening}</span>
        {!open && <span className="json-folded">{entries.length} 项</span>}
        {!open && <span className="json-bracket">{closing}</span>}
      </button>
      {open && (
        <div className="json-tree-children" role="group">
          {entries.map(([key, child]) => (
            <JsonTreeNode
              key={`${pathKey}.${key}`}
              value={child}
              label={key}
              path={[...path, key]}
              eventType={eventType}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
          <div className="json-tree-close">{closing}</div>
        </div>
      )}
    </div>
  )
}

function StructuredPayload({ value, eventType }: { value: unknown; eventType: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => initiallyExpandedPaths(value))
  const [copied, setCopied] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const treeRef = useRef<HTMLDivElement>(null)
  const horizontalAxisRef = useRef<HTMLDivElement>(null)
  const [horizontalMetrics, setHorizontalMetrics] = useState({ content: 0, viewport: 0 })
  const toggle = (path: string): void => setExpanded(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  useEffect(() => {
    if (!fullscreen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [fullscreen])

  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    const update = (): void => {
      setHorizontalMetrics({ content: tree.scrollWidth, viewport: tree.clientWidth })
      if (horizontalAxisRef.current) horizontalAxisRef.current.scrollLeft = tree.scrollLeft
    }
    const frame = window.requestAnimationFrame(update)
    const observer = new ResizeObserver(update)
    observer.observe(tree)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [expanded, fullscreen, value])

  const content = (
    <div className={`payload-tree-content ${fullscreen ? 'is-fullscreen' : ''}`}>
      <div className="payload-tree-toolbar">
        <span>{fullscreen && <strong>原始事件负载</strong>}<i />红色为发送给前端渲染层的内容</span>
        <div>
          <button
            className={copied ? 'copied' : ''}
            title={copied ? '已复制' : '复制 JSON'}
            aria-label={copied ? '已复制' : '复制 JSON'}
            onClick={() => {
              void copyTextToClipboard(JSON.stringify(value, null, 2) || String(value ?? '')).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
              }).catch(console.error)
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button title="全部展开" aria-label="全部展开" onClick={() => setExpanded(collectContainerPaths(value))}>
            <ChevronsDown size={14} />
          </button>
          <button title="全部折叠" aria-label="全部折叠" onClick={() => setExpanded(new Set())}>
            <ChevronsUp size={14} />
          </button>
          <button
            title={fullscreen ? '退出全屏' : '全屏查看'}
            aria-label={fullscreen ? '退出全屏' : '全屏查看'}
            onClick={() => setFullscreen(current => !current)}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      {horizontalMetrics.content > horizontalMetrics.viewport + 1 && (
        <div
          ref={horizontalAxisRef}
          className="payload-horizontal-axis"
          aria-label="原始事件负载横向滚动"
          onScroll={event => {
            if (treeRef.current) treeRef.current.scrollLeft = event.currentTarget.scrollLeft
          }}
        >
          <div style={{ width: horizontalMetrics.content }} />
        </div>
      )}
      <div
        ref={treeRef}
        className="json-tree"
        role="tree"
        onScroll={event => {
          if (horizontalAxisRef.current) horizontalAxisRef.current.scrollLeft = event.currentTarget.scrollLeft
        }}
      >
        <JsonTreeNode value={value} path={[]} eventType={eventType} expanded={expanded} onToggle={toggle} />
      </div>
    </div>
  )
  if (!fullscreen) return content
  return createPortal(
    <div className="payload-fullscreen-backdrop" role="presentation" onMouseDown={() => setFullscreen(false)}>
      <section className="payload-fullscreen-dialog" role="dialog" aria-modal="true" aria-label="原始事件负载全屏查看" onMouseDown={event => event.stopPropagation()}>
        {content}
      </section>
    </div>,
    document.querySelector<HTMLElement>('.agent-window-container') || document.body
  )
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
    for (const event of events) {
      if (event.type === 'tool/call') tools += 1
      if (event.type === 'request/start') requests += 1
      if (event.type === 'error' || event.type === 'mcp/error') errors += 1
    }
    const first = events[0]?.time
    const last = events[events.length - 1]?.time
    return { tools, requests, errors, duration: first && last ? last - first : 0 }
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
  const selectedRemoteUrl = selected ? remoteHttpUrl(selected, events) : ''
  const inspectedEvent = selectedFull?.seq === selected?.seq ? selectedFull : selected
  const inspectedData = inspectedEvent?.data || {}
  const inspectedRequest = selected?.type === 'model/request' || selected?.type === 'mcp/request' ? inspectedData.request : undefined
  const inspectedResponse = selected?.type === 'model/response' || selected?.type === 'mcp/response' ? inspectedData.response : undefined
  const inspectedPayload: unknown = Array.isArray(inspectedData.sourcePayloads)
    ? inspectedData.sourcePayloads.length === 1 ? inspectedData.sourcePayloads[0] : inspectedData.sourcePayloads
    : selected?.type === 'mcp/request' && inspectedRequest !== undefined
      ? inspectedRequest
      : selected?.type === 'mcp/response' && inspectedResponse !== undefined
        ? inspectedResponse
        : inspectedRequest?.body !== undefined
      ? inspectedRequest.body
      : inspectedResponse?.transport === 'sse' && Array.isArray(inspectedResponse.events)
        ? inspectedResponse.events
        : inspectedResponse?.transport === 'json' && inspectedResponse.body !== undefined
          ? inspectedResponse.body
          : inspectedData

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
                              <span className={`trace-boundary boundary-${eventBoundary(event.type).kind}`}>{eventBoundary(event.type).label}</span>
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
              <div>
                <span>EVENT {String(selected.seq).padStart(4, '0')} · 至下一事件 {selectedDuration ? formatDuration(selectedDuration) : '—'}</span>
                <div className="inspector-title-row">
                  <h2>{eventLabel(selected.type)}</h2>
                  {selectedRemoteUrl && <code title={selectedRemoteUrl}>{selectedRemoteUrl}</code>}
                </div>
              </div>
              <button onClick={() => setSelected(null)} aria-label="关闭详情"><X size={16} /></button>
            </div>

            <div className="inspector-section inspector-payload">
              <h3>原始事件负载 {selected.compressed && <em>GZIP</em>}</h3>
              {selected.data?.truncated && selectedFull?.seq === selected.seq && selectedFull.data?.truncated ? (
                <div className="payload-loading">正在解压完整负载…</div>
              ) : (
                <StructuredPayload
                  key={`${selected.sessionId}:${selected.seq}`}
                  value={inspectedPayload}
                  eventType={selected.type}
                />
              )}
            </div>

          </aside>
        )}
      </main>
    </div>
  )
}

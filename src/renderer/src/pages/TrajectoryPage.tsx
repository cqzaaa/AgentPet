import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
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
import { AgentBrandIcon } from '../components/AgentBrandIcon'
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

function sourcesForFilter(_filter: FilterId): TraceSource[] | undefined {
  // The sub-agent view also needs the parent delegate_tasks tool call so the
  // complete durable event group can render as one expandable workflow.
  return undefined
}

function matchesFilter(event: TraceEvent, filter: FilterId): boolean {
  if (event.type === 'request/header') return false
  if (filter === 'all') return true
  if (filter === 'subagent') return event.type.startsWith('subagent/') || isDelegateCall(event)
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
  if (event.type.startsWith('subagent/')) {
    const step = Array.isArray(data.steps)
      ? data.steps.find((candidate: unknown) =>
          Boolean(candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === data.taskStepId))
      : undefined
    const scope = step?.title || data.run?.title || data.taskRunId || ''
    return `${data.action || event.type.slice(9)} · ${scope}`
  }
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
  if (event.type === 'subagent/step_running' && event.data?.taskStepId) {
    const result = events.slice(index + 1).find(candidate =>
      candidate.correlationId === event.correlationId &&
      candidate.data?.taskStepId === event.data.taskStepId &&
      ['subagent/step_completed', 'subagent/step_failed', 'subagent/step_retrying', 'subagent/cancelled'].includes(candidate.type))
    return result ? Math.max(0, result.time - event.time) : 0
  }
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

function isDelegateCall(event: TraceEvent): boolean {
  return event.type === 'tool/call' && event.data?.name === 'delegate_tasks'
}

function parseTaskRunId(value: unknown): string {
  if (value && typeof value === 'object') {
    const taskRunId = (value as Record<string, unknown>).taskRunId
    if (typeof taskRunId === 'string') return taskRunId
  }
  if (typeof value !== 'string') return ''
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return ''
    const taskRunId = (parsed as Record<string, unknown>).taskRunId
    return typeof taskRunId === 'string' ? taskRunId : ''
  } catch {
    return ''
  }
}

type WorkflowTaskData = {
  id?: unknown
  title?: unknown
  role?: unknown
  type?: unknown
  agentRole?: unknown
  agentId?: unknown
  model?: unknown
  dependencies?: unknown
  status?: unknown
  detail?: unknown
  startedAt?: unknown
  completedAt?: unknown
  prompt?: unknown
  goal?: unknown
  acceptanceCriteria?: unknown
  resultSummary?: unknown
  artifactPaths?: unknown
}

function workflowTaskList(value: unknown): WorkflowTaskData[] {
  return Array.isArray(value)
    ? value.filter((item): item is WorkflowTaskData => Boolean(item && typeof item === 'object'))
    : []
}

function delegateEvents(call: TraceEvent, events: TraceEvent[]): TraceEvent[] {
  const explicit = events.filter(event =>
    event.type.startsWith('subagent/') && event.data?.run?.parentToolCallId === call.correlationId)
  if (explicit.length > 0) return explicit

  const result = events.find(event => event.type === 'tool/result' && event.correlationId === call.correlationId)
  const taskRunId = parseTaskRunId(result?.data?.displayResult) || parseTaskRunId(result?.data?.modelResult)
  if (taskRunId) return events.filter(event => event.type.startsWith('subagent/') && event.correlationId === taskRunId)

  // Compatibility for traces written before parentToolCallId was persisted.
  const title = String(call.data?.arguments?.title || call.data?.arguments?.goal || '')
  return events.filter(event =>
    event.type.startsWith('subagent/') &&
    event.turn === call.turn &&
    event.time >= call.time &&
    (!title || event.data?.run?.title === title))
}

function mergeTraceEvents(...groups: TraceEvent[][]): TraceEvent[] {
  const bySeq = new Map<number, TraceEvent>()
  groups.flat().forEach(event => bySeq.set(event.seq, event))
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

async function readCorrelationHistory(sessionId: string, correlationIds: string[]): Promise<TraceEvent[]> {
  const ids = [...new Set(correlationIds.map(String).filter(Boolean))]
  if (ids.length === 0) return []
  const collected: TraceEvent[] = []
  let beforeSeq: number | undefined
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await window.api.getSessionEvents(sessionId, {
      beforeSeq,
      limit: 500,
      correlationIds: ids
    })
    const pageEvents = Array.isArray(page?.events) ? page.events as TraceEvent[] : []
    collected.unshift(...pageEvents)
    if (!page?.hasMore || pageEvents.length === 0) break
    const nextBeforeSeq = Number(page?.nextBeforeSeq ?? pageEvents[0]?.seq)
    if (!Number.isSafeInteger(nextBeforeSeq) || nextBeforeSeq === beforeSeq) break
    beforeSeq = nextBeforeSeq
  }
  return mergeTraceEvents(collected)
}

async function hydrateWorkflowHistory(sessionId: string, seed: TraceEvent[]): Promise<TraceEvent[]> {
  const runIds = seed.flatMap(event => {
    if (event.type.startsWith('subagent/') && event.correlationId) return [event.correlationId]
    if (event.type === 'tool/result') {
      const taskRunId = parseTaskRunId(event.data?.displayResult) || parseTaskRunId(event.data?.modelResult)
      return taskRunId ? [taskRunId] : []
    }
    return []
  })
  if (runIds.length === 0) return seed
  const runHistory = await readCorrelationHistory(sessionId, runIds)
  const parentCallIds = runHistory
    .map(event => String(event.data?.run?.parentToolCallId || ''))
    .filter(Boolean)
  const parentHistory = await readCorrelationHistory(sessionId, parentCallIds)
  return mergeTraceEvents(seed, runHistory, parentHistory)
}

function workflowStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待', running: '运行中', paused: '已暂停', completed: '完成',
    failed: '失败', blocked: '阻塞', cancelled: '取消'
  }
  return labels[status] || status || '等待'
}

function workflowRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    general: '通用执行', researcher: '研究分析', coder: '代码实现', reviewer: '审核验证'
  }
  return labels[role] || role || '通用执行'
}

function workflowAgentLabel(agentId: string): string {
  const labels: Record<string, string> = {
    agentpet: 'AgentPet', 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity CLI'
  }
  return labels[agentId] || agentId
}

function agentTransportLabel(protocol: unknown, agentId?: string): string {
  const labels: Record<string, string> = {
    'acp-v1': 'ACP v1 SDK',
    'claude-stream-json': 'Claude stream-json CLI',
    'codex-app-server': 'Codex App Server',
    'antigravity-json': 'Antigravity JSON CLI'
  }
  return labels[String(protocol || '')] || workflowAgentLabel(agentId || '') || '外部 Agent'
}

function subagentTraceLabel(type: string): string {
  const labels: Record<string, string> = {
    'subagent/step_running': '开始执行',
    'subagent/model_call': '模型网络请求',
    'subagent/model_response': '模型返回报文',
    'subagent/agent_request': 'Agent 请求报文',
    'subagent/agent_response': 'Agent 返回报文',
    'subagent/agent_error': 'Agent 请求异常',
    'subagent/acp_wire_request': 'ACP SDK 请求报文',
    'subagent/acp_wire_response': 'ACP SDK 返回报文',
    'subagent/acp_wire_notification': 'ACP SDK 通知报文',
    'subagent/agent_wire_request': '外部 Agent 传输请求',
    'subagent/agent_wire_response': '外部 Agent 传输返回',
    'subagent/agent_wire_notification': '外部 Agent 传输事件',
    'subagent/acp_request': '旧版外部 Agent 请求',
    'subagent/acp_response': '旧版外部 Agent 返回',
    'subagent/acp_error': '旧版外部 Agent 异常',
    'subagent/tool_call': '工具调用',
    'subagent/tool_result': '工具返回结果',
    'subagent/step_retrying': '准备重试',
    'subagent/retry_step': '手动重试',
    'subagent/retry_failed_steps': '手动重试失败节点',
    'subagent/step_completed': '执行完成',
    'subagent/step_failed': '执行失败',
    'subagent/blocked': '任务阻塞',
    'subagent/cancelled': '任务取消'
  }
  return labels[type] || '状态更新'
}

function isLegacyAgentResult(event: TraceEvent): boolean {
  return event.type === 'subagent/agent_event' && event.data?.activity?.update?.event === 'result'
}

function DelegateWorkflow({
  call,
  events,
  expanded,
  selected,
  onToggle,
  onFocus
}: {
  call: TraceEvent
  events: TraceEvent[]
  expanded: boolean
  selected: boolean
  onToggle: () => void
  onFocus: () => void
}): React.JSX.Element | null {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTraceSeq, setSelectedTraceSeq] = useState<number | null>(null)
  const [selectedTraceFull, setSelectedTraceFull] = useState<TraceEvent | null>(null)
  const [parameterTaskId, setParameterTaskId] = useState<string | null>(null)
  const [detailAnchor, setDetailAnchor] = useState<{
    x: number
    y: number
    horizontal: 'left' | 'right'
    vertical: 'up' | 'down'
  } | null>(null)
  const [callPayloadAnchor, setCallPayloadAnchor] = useState<{
    x: number
    y: number
    horizontal: 'left' | 'right'
    vertical: 'up' | 'down'
  } | null>(null)
  const [callPayloadPosition, setCallPayloadPosition] = useState<{ left: number; top: number } | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const workflowRef = useRef<HTMLElement>(null)
  const callPayloadRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!fullscreen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [fullscreen])
  useEffect(() => {
    if (!selectedTaskId && !parameterTaskId && !callPayloadAnchor) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelectedTaskId(null)
        setParameterTaskId(null)
        setCallPayloadAnchor(null)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [callPayloadAnchor, parameterTaskId, selectedTaskId])
  useLayoutEffect(() => {
    if (!callPayloadAnchor || !callPayloadRef.current) return
    const placeWithinViewport = (): void => {
      const rect = callPayloadRef.current!.getBoundingClientRect()
      const gap = 12
      const preferredLeft = callPayloadAnchor.horizontal === 'left'
        ? callPayloadAnchor.x - rect.width - gap
        : callPayloadAnchor.x + gap
      const preferredTop = callPayloadAnchor.vertical === 'up'
        ? callPayloadAnchor.y - rect.height - gap
        : callPayloadAnchor.y + gap
      setCallPayloadPosition({
        left: Math.max(gap, Math.min(window.innerWidth - rect.width - gap, preferredLeft)),
        top: Math.max(gap, Math.min(window.innerHeight - rect.height - gap, preferredTop))
      })
    }
    placeWithinViewport()
    window.addEventListener('resize', placeWithinViewport)
    return () => window.removeEventListener('resize', placeWithinViewport)
  }, [callPayloadAnchor])
  const toggleTaskDetail = (taskId: string): void => {
    onFocus()
    if (selectedTaskId === taskId) {
      setSelectedTaskId(null)
      setSelectedTraceSeq(null)
      return
    }
    setCallPayloadAnchor(null)
    setParameterTaskId(null)
    setSelectedTraceSeq(null)
    setSelectedTaskId(taskId)
  }
  const openTaskParameters = (taskId: string, event: React.MouseEvent<HTMLButtonElement>): void => {
    onFocus()
    const rect = event.currentTarget.getBoundingClientRect()
    const pointerX = event.clientX || rect.left + rect.width / 2
    const pointerY = event.clientY || rect.top + rect.height / 2
    const x = Math.max(12, Math.min(window.innerWidth - 12, pointerX))
    const y = Math.max(12, Math.min(window.innerHeight - 12, pointerY))
    setSelectedTaskId(null)
    setCallPayloadAnchor(null)
    setDetailAnchor({
      x,
      y,
      horizontal: x > window.innerWidth / 2 ? 'left' : 'right',
      vertical: y > window.innerHeight / 2 ? 'up' : 'down'
    })
    setParameterTaskId(taskId)
  }
  const openCallPayload = (event: React.MouseEvent<HTMLButtonElement>): void => {
    onFocus()
    const rect = event.currentTarget.getBoundingClientRect()
    const pointerX = event.clientX || rect.left + rect.width / 2
    const pointerY = event.clientY || rect.top + rect.height / 2
    const x = Math.max(12, Math.min(window.innerWidth - 12, pointerX))
    const y = Math.max(12, Math.min(window.innerHeight - 12, pointerY))
    setSelectedTaskId(null)
    setCallPayloadPosition(null)
    setCallPayloadAnchor({
      x,
      y,
      horizontal: x > window.innerWidth / 2 ? 'left' : 'right',
      vertical: y > window.innerHeight / 2 ? 'up' : 'down'
    })
  }
  const related = delegateEvents(call, events)
  const args = call.data?.arguments || {}
  const rawTasks = workflowTaskList(Array.isArray(args.tasks) ? args.tasks : args.subtasks)
  const latestWithSteps = [...related].reverse().find(event => Array.isArray(event.data?.steps))
  const persistedSteps = workflowTaskList(latestWithSteps?.data?.steps)
  const persistedById = new Map(persistedSteps.map(step => [String(step.id), step]))
  const sourceTasks = rawTasks.length > 0 ? rawTasks : persistedSteps
  if (sourceTasks.length === 0) return null

  const tasks = sourceTasks.map((task, index) => {
    const id = String(task.id || `agent-${index + 1}`)
    const persisted = persistedById.get(id) || task
    const taskEvents = related.filter(event =>
      event.data?.taskStepId === id ||
      (event.type === 'subagent/retry_failed_steps' && Array.isArray(event.data?.activity?.retriedStepIds) && event.data.activity.retriedStepIds.includes(id)))
    const runningEvent = taskEvents.find(event => event.type === 'subagent/step_running')
    const terminalEvent = [...taskEvents].reverse().find(event =>
      ['subagent/step_completed', 'subagent/step_failed', 'subagent/cancelled', 'subagent/blocked'].includes(event.type))
    const dependencies = Array.isArray(task.dependencies)
      ? task.dependencies
      : Array.isArray(persisted.dependencies) ? persisted.dependencies : []
    return {
      payload: task,
      id,
      title: String(task.title || persisted.title || id),
      role: String(task.role || task.type || persisted.agentRole || 'general'),
      agentId: String(task.agentId || persisted.agentId || 'agentpet'),
      model: String(task.model || persisted.model || ''),
      dependencies: dependencies.map(String),
      status: String(persisted.status || (runningEvent ? 'running' : 'pending')),
      detail: String(persisted.detail || ''),
      prompt: String(task.prompt || task.goal || persisted.prompt || persisted.goal || ''),
      acceptanceCriteria: String(task.acceptanceCriteria || persisted.acceptanceCriteria || ''),
      resultSummary: String(persisted.resultSummary || ''),
      artifactPaths: Array.isArray(persisted.artifactPaths) ? persisted.artifactPaths.map(String) : [],
      startedAt: Number(persisted.startedAt || runningEvent?.time || 0),
      completedAt: Number(persisted.completedAt || terminalEvent?.time || 0),
      events: taskEvents
    }
  })

  const stages = new Map<string, number>()
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const stageFor = (id: string, visiting = new Set<string>()): number => {
    if (stages.has(id)) return stages.get(id)!
    if (visiting.has(id)) return 1
    const task = taskById.get(id)
    if (!task || task.dependencies.length === 0) { stages.set(id, 1); return 1 }
    const nextVisiting = new Set(visiting).add(id)
    const stage = 1 + Math.max(0, ...task.dependencies.map(dependency => stageFor(dependency, nextVisiting)))
    stages.set(id, stage)
    return stage
  }
  tasks.forEach(task => stageFor(task.id))

  const latestRun = [...related].reverse().find(event => event.data?.run)?.data?.run
  const groupStart = Math.min(call.time, ...tasks.map(task => task.startedAt).filter(Boolean))
  const groupEnd = Math.max(
    groupStart + 1,
    Number(latestRun?.completedAt || 0),
    ...tasks.map(task => task.completedAt || task.startedAt).filter(Boolean),
    ...related.map(event => event.time)
  )
  const span = Math.max(1, groupEnd - groupStart)
  const intervals = tasks.filter(task => task.startedAt).map(task => ({
    start: task.startedAt,
    end: task.completedAt || groupEnd
  }))
  const points = intervals.flatMap(interval => [{ time: interval.start, delta: 1 }, { time: interval.end, delta: -1 }])
    .sort((a, b) => a.time - b.time || a.delta - b.delta)
  let active = 0
  let peak = 0
  points.forEach(point => { active += point.delta; peak = Math.max(peak, active) })
  const maxConcurrency = Math.max(1, Math.min(6, Number(args.maxConcurrency) || 3))
  const stageCount = Math.max(...tasks.map(task => stages.get(task.id) || 1))
  const stageGroups = Array.from({ length: stageCount }, (_, index) => ({
    stage: index + 1,
    tasks: tasks.filter(task => (stages.get(task.id) || 1) === index + 1)
  }))
  const completed = tasks.filter(task => task.status === 'completed').length
  const groupStatus = String(latestRun?.status || (completed === tasks.length ? 'completed' : related.length ? 'running' : 'pending'))
  const orchestrationCanvas = args.origin === 'orchestration-canvas'
  const selectedTask = tasks.find(task => task.id === selectedTaskId)
  const parameterTask = tasks.find(task => task.id === parameterTaskId)
  const structuredAgentTraceTypes = [
    'subagent/agent_request', 'subagent/agent_response', 'subagent/agent_error',
    'subagent/acp_wire_request', 'subagent/acp_wire_response', 'subagent/acp_wire_notification',
    'subagent/agent_wire_request', 'subagent/agent_wire_response', 'subagent/agent_wire_notification',
    'subagent/acp_request', 'subagent/acp_response', 'subagent/acp_error'
  ]
  const hasStructuredAgentTrace = selectedTask?.events.some(event => structuredAgentTraceTypes.includes(event.type)) || false
  const selectedTaskTrace = selectedTask?.events.filter(event => [
    'subagent/step_running',
    'subagent/model_call',
    'subagent/model_response',
    'subagent/agent_request',
    'subagent/agent_response',
    'subagent/agent_error',
    'subagent/acp_wire_request',
    'subagent/acp_wire_response',
    'subagent/acp_wire_notification',
    'subagent/agent_wire_request',
    'subagent/agent_wire_response',
    'subagent/agent_wire_notification',
    'subagent/acp_request',
    'subagent/acp_response',
    'subagent/acp_error',
    'subagent/tool_call',
    'subagent/tool_result',
    'subagent/step_retrying',
    'subagent/retry_step',
    'subagent/retry_failed_steps',
    'subagent/step_completed',
    'subagent/step_failed',
    'subagent/blocked',
    'subagent/cancelled'
  ].includes(event.type) || (!hasStructuredAgentTrace && isLegacyAgentResult(event))) || []
  const selectedTraceEvent = selectedTaskTrace.find(event => event.seq === selectedTraceSeq)
  useEffect(() => {
    setSelectedTraceFull(null)
    if (!selectedTraceEvent?.data?.truncated) return
    let cancelled = false
    void window.api.getSessionEvent(selectedTraceEvent.sessionId, selectedTraceEvent.seq).then(event => {
      if (!cancelled && event) setSelectedTraceFull(event as TraceEvent)
    })
    return () => { cancelled = true }
  }, [selectedTraceEvent?.sessionId, selectedTraceEvent?.seq, selectedTraceEvent?.data?.truncated])
  const effectiveTraceEvent = selectedTraceFull?.seq === selectedTraceEvent?.seq ? selectedTraceFull : selectedTraceEvent
  const selectedTraceActivity = effectiveTraceEvent?.data?.activity
  const selectedTraceStep = effectiveTraceEvent && Array.isArray(effectiveTraceEvent.data?.steps)
    ? effectiveTraceEvent.data.steps.find((step: { id?: unknown }) => step?.id === selectedTask?.id)
    : undefined
  const selectedTraceIsLegacyRequest = Boolean(
    selectedTraceEvent?.type === 'subagent/step_running' &&
    selectedTask?.agentId !== 'agentpet' &&
    !hasStructuredAgentTrace
  )
  const selectedTracePayload: unknown = effectiveTraceEvent
    ? (selectedTraceIsLegacyRequest
        ? {
            method: 'session/prompt',
            agentId: selectedTask?.agentId,
            model: selectedTask?.model || 'default',
            cwd: args.workspacePath,
            prompt: selectedTask?.prompt,
            attempt: Number(selectedTraceStep?.retryCount || 0) + 1,
            compatibility: '根据历史任务快照还原；旧版本未单独保存真实传输报文'
          }
        : selectedTraceActivity?.payload
        ?? selectedTraceActivity?.request
        ?? selectedTraceActivity?.response
        ?? selectedTraceActivity?.error
        ?? selectedTraceActivity?.update?.result
        ?? selectedTraceActivity?.arguments
        ?? selectedTraceActivity?.result
        ?? selectedTraceActivity) || {
        action: effectiveTraceEvent.data?.action,
        taskStepId: effectiveTraceEvent.data?.taskStepId,
        status: effectiveTraceEvent.data?.run?.status,
        time: effectiveTraceEvent.time
      }
    : null

  const workflowContent = (
    <section ref={workflowRef} className={`delegate-workflow status-${groupStatus} ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''} ${fullscreen ? 'is-app-fullscreen' : ''}`} aria-label={`子任务工作流：${String(args.title || latestRun?.title || '')}`}>
      <div className="delegate-workflow-head">
        <button className="delegate-workflow-toggle" onClick={() => { onFocus(); onToggle() }} aria-expanded={expanded}>
          <span className="workflow-head-icon"><GitBranch size={14} /></span>
          <span className="workflow-head-copy">
            <strong>{String(args.title || latestRun?.title || '子任务工作流')}</strong>
            <small>{orchestrationCanvas ? '多 Agent 编排' : '委派任务'} {String(call.seq).padStart(4, '0')} · {tasks.length} 个子任务 · {stageCount} 个依赖阶段</small>
          </span>
          <span className={`workflow-parallel-badge ${peak > 1 ? 'is-parallel' : ''}`}>
            {peak > 1 ? `实际并行峰值 ${peak}` : related.length ? '当前串行执行' : `最多并行 ${maxConcurrency}`}
          </span>
          <span className={`workflow-group-status status-${groupStatus}`}>{workflowStatusLabel(groupStatus)} {completed}/{tasks.length}</span>
          <ChevronRight className="workflow-expand-icon" size={15} />
        </button>
        <button className="workflow-inspect-button" onClick={openCallPayload}>调用参数</button>
        <button
          className="workflow-fullscreen-button"
          onClick={() => {
            onFocus()
            if (!expanded) onToggle()
            setFullscreen(current => !current)
          }}
          aria-label={fullscreen ? '退出全屏' : '全屏查看流程图'}
          title={fullscreen ? '退出全屏' : '全屏查看'}
        >
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      {expanded && (
        <div className="delegate-workflow-body">
          <div className="workflow-flow" aria-label="子任务依赖流程图">
            <span className="workflow-terminal start">开始</span>
            {stageGroups.map(group => (
              <React.Fragment key={group.stage}>
                <span className="workflow-flow-arrow" aria-hidden="true"><i /><ChevronRight size={13} /></span>
                <section className="workflow-flow-stage" aria-label={`阶段 ${group.stage}`}>
                  <header>阶段 {group.stage} · {group.tasks.length > 1 ? `${group.tasks.length} 项并行` : '串行节点'}</header>
                  {group.tasks.map(task => (
                    <button
                      key={task.id}
                      className={`workflow-flow-node status-${task.status} ${parameterTaskId === task.id ? 'selected' : ''}`}
                      onClick={event => openTaskParameters(task.id, event)}
                      aria-expanded={parameterTaskId === task.id}
                    >
                      <span><b className="workflow-agent-icon"><AgentBrandIcon agentId={task.agentId} /></b><i />{task.title}</span>
                      <small>{workflowAgentLabel(task.agentId)}{task.model ? ` · ${task.model}` : ` · ${workflowRoleLabel(task.role)}`}{task.dependencies.length ? ` · 依赖 ${task.dependencies.map(id => taskById.get(id)?.title || id).join('、')}` : ''}</small>
                    </button>
                  ))}
                </section>
              </React.Fragment>
            ))}
            <span className="workflow-flow-arrow" aria-hidden="true"><i /><ChevronRight size={13} /></span>
            <span className={`workflow-terminal end status-${groupStatus}`}>{workflowStatusLabel(groupStatus)}</span>
          </div>
          <div className="workflow-runtime-title"><span>实际运行时间</span><i />时间条重叠表示真实并行</div>
          <div className="workflow-axis" aria-hidden="true">
            <span>任务 / 依赖</span>
            <div><i>开始</i><b /><i>{formatDuration(span)}</i></div>
          </div>
          <div className="workflow-lanes">
            {tasks.map(task => {
              const stage = stages.get(task.id) || 1
              const left = task.startedAt ? ((task.startedAt - groupStart) / span) * 100 : 0
              const width = task.startedAt ? ((task.completedAt || groupEnd) - task.startedAt) / span * 100 : 0
              return (
                <React.Fragment key={task.id}>
                  <button
                    className={`workflow-lane status-${task.status} ${selectedTaskId === task.id ? 'selected' : ''}`}
                    onClick={() => toggleTaskDetail(task.id)}
                    aria-expanded={selectedTaskId === task.id}
                  >
                  <div className="workflow-task-copy">
                    <span className="workflow-stage">阶段 {stage}</span>
                    <span className="workflow-task-title" title={task.title}>{task.title}</span>
                    <span className="workflow-role">{workflowAgentLabel(task.agentId)}</span>
                    {task.dependencies.length > 0 && <small title={`等待：${task.dependencies.map(id => taskById.get(id)?.title || id).join('、')}`}>等待 {task.dependencies.map(id => taskById.get(id)?.title || id).join('、')}</small>}
                  </div>
                  <div className="workflow-time-track" title={task.detail || task.title}>
                    <i className="workflow-grid-line one-third" />
                    <i className="workflow-grid-line two-thirds" />
                    {task.startedAt ? (
                      <span className="workflow-time-bar" style={{ left: `${left}%`, width: `${Math.max(.8, width)}%` }}>
                        <b>{workflowStatusLabel(task.status)}</b>
                      </span>
                    ) : (
                      <span className="workflow-waiting-mark"><b>{workflowStatusLabel(task.status)}</b></span>
                    )}
                  </div>
                  <span className="workflow-lane-meta">
                    <time>{task.startedAt ? formatDuration((task.completedAt || groupEnd) - task.startedAt) : '—'}</time>
                    <ChevronRight size={12} />
                  </span>
                  </button>
                  {selectedTaskId === task.id && selectedTask && (
                    <section className="workflow-lane-detail" aria-label={`${selectedTask.title} 调用详情`}>
                      <header>
                        <span><small>子任务 · {selectedTask.id}</small><strong>{selectedTask.title}</strong></span>
                        <button onClick={() => { setSelectedTaskId(null); setSelectedTraceSeq(null) }} aria-label="收起子任务详情"><X size={13} /></button>
                      </header>
                      <div className={`workflow-task-trace-layout ${selectedTraceEvent ? 'with-payload' : ''}`}>
                        <ol className="workflow-task-call-trace">
                          {selectedTaskTrace.length > 0 ? selectedTaskTrace.map(taskEvent => {
                            const activity = taskEvent.data?.activity
                            const isModelRequest = taskEvent.type === 'subagent/model_call'
                            const isModelResponse = taskEvent.type === 'subagent/model_response'
                            const legacyAgentRequest = !hasStructuredAgentTrace && taskEvent.type === 'subagent/step_running' && selectedTask.agentId !== 'agentpet'
                            const legacyAgentResponse = !hasStructuredAgentTrace && isLegacyAgentResult(taskEvent)
                            const legacyResultStatus = String(activity?.update?.result?.status || '')
                            const isWireRequest = taskEvent.type === 'subagent/acp_wire_request'
                            const isWireResponse = taskEvent.type === 'subagent/acp_wire_response'
                            const isWireNotification = taskEvent.type === 'subagent/acp_wire_notification'
                            const isAgentWireRequest = taskEvent.type === 'subagent/agent_wire_request'
                            const isAgentWireResponse = taskEvent.type === 'subagent/agent_wire_response'
                            const isAgentWireNotification = taskEvent.type === 'subagent/agent_wire_notification'
                            const isAgentRequest = taskEvent.type === 'subagent/agent_request' || taskEvent.type === 'subagent/acp_request' || legacyAgentRequest
                            const isAgentResponse = taskEvent.type === 'subagent/agent_response' || taskEvent.type === 'subagent/acp_response' || (legacyAgentResponse && legacyResultStatus === 'SUCCESS')
                            const isAgentError = taskEvent.type === 'subagent/agent_error' || taskEvent.type === 'subagent/acp_error' || (legacyAgentResponse && legacyResultStatus !== 'SUCCESS')
                            const isToolCall = taskEvent.type === 'subagent/tool_call'
                            const isToolResult = taskEvent.type === 'subagent/tool_result'
                            const isModel = isModelRequest || isModelResponse
                            const isAcpWire = isWireRequest || isWireResponse || isWireNotification
                            const isExternalWire = isAgentWireRequest || isAgentWireResponse || isAgentWireNotification
                            const isAgentProtocol = isAcpWire || isExternalWire || isAgentRequest || isAgentResponse || isAgentError
                            const isTool = isToolCall || isToolResult
                            const isMcp = isTool && activity?.kind === 'mcp'
                            const eventStep = Array.isArray(taskEvent.data?.steps)
                              ? taskEvent.data.steps.find((step: { id?: unknown }) => step?.id === selectedTask.id)
                              : undefined
                            const retryCount = Number(eventStep?.retryCount || 0)
                            const transport = agentTransportLabel(activity?.protocol, String(activity?.agentId || selectedTask.agentId))
                            const title = isAcpWire
                              ? isWireRequest ? 'ACP SDK 请求报文' : isWireResponse ? 'ACP SDK 返回报文' : 'ACP SDK 通知报文'
                              : isExternalWire
                                ? isAgentWireRequest ? `${transport} 请求报文` : isAgentWireResponse ? `${transport} 返回报文` : `${transport} 传输事件`
                              : isAgentProtocol
                                ? legacyAgentRequest
                                  ? `${transport} 请求（历史快照还原）`
                                  : isAgentError ? `${transport} 请求异常` : isAgentResponse ? `${transport} 返回报文` : `${transport} 请求报文`
                              : taskEvent.type === 'subagent/step_retrying' && retryCount > 0
                                ? `准备第 ${retryCount} 次重试`
                                : taskEvent.type === 'subagent/step_running' && retryCount > 0
                                  ? `开始执行 · 重试 ${retryCount}`
                                  : isModel
                              ? `${subagentTraceLabel(taskEvent.type)} ${Number(activity?.index) || ''}`.trim()
                              : isTool
                                ? `${String(activity?.name || '工具')}${isToolResult ? ' · 返回结果' : ''}`
                                : subagentTraceLabel(taskEvent.type)
                            const detail = isAgentProtocol
                              ? [workflowAgentLabel(String(activity?.agentId || selectedTask.agentId)), isAcpWire || isExternalWire ? activity?.direction : transport, activity?.method, activity?.id !== undefined ? `id ${activity.id}` : '', activity?.model, activity?.attempt ? `第 ${activity.attempt} 次` : ''].filter(Boolean).join(' · ')
                              : isModel
                              ? [activity?.provider, activity?.model, activity?.messageCount ? `${activity.messageCount} 条消息` : ''].filter(Boolean).join(' · ')
                              : isTool
                                ? `${isMcp ? 'MCP 工具' : '本地工具'}${isToolResult ? '返回报文' : '调用参数'}`
                                : String(eventStep?.detail || workflowStatusLabel(String(taskEvent.data?.run?.status || 'running')))
                            return (
                              <li key={taskEvent.seq} className={`${isWireRequest || isAgentWireRequest || isAgentRequest ? 'model' : isWireResponse || isAgentWireResponse || isAgentResponse ? 'model-response' : isWireNotification || isAgentWireNotification ? 'mcp' : isAgentError ? 'status' : isModelRequest ? 'model' : isModelResponse ? 'model-response' : isMcp ? 'mcp' : isToolResult ? 'tool-result' : isTool ? 'tool' : 'status'} ${selectedTraceSeq === taskEvent.seq ? 'selected' : ''}`}>
                                <button onClick={() => setSelectedTraceSeq(current => current === taskEvent.seq ? null : taskEvent.seq)} aria-expanded={selectedTraceSeq === taskEvent.seq}>
                                  <span className="workflow-call-trace-icon">{isModel || isAgentProtocol ? <Bot size={12} /> : isTool ? <TerminalSquare size={12} /> : <GitBranch size={12} />}</span>
                                  <span><strong>{title}</strong><small>{detail || '执行状态更新'}</small></span>
                                  <time>{formatClock(taskEvent.time)}</time>
                                  <ChevronRight size={12} />
                                </button>
                              </li>
                            )
                          }) : (
                            <li className="empty"><span><strong>暂无详细调用记录</strong><small>历史任务未采集模型与工具调用摘要</small></span></li>
                          )}
                        </ol>
                        {selectedTraceEvent && (
                          <aside className="workflow-trace-payload" aria-label={`${subagentTraceLabel(selectedTraceEvent.type)} JSON 负载`}>
                            <header><strong>JSON 负载</strong><button onClick={() => setSelectedTraceSeq(null)} aria-label="关闭 JSON 负载"><X size={12} /></button></header>
                            <StructuredPayload
                              key={selectedTraceEvent.seq}
                              value={selectedTracePayload}
                              eventType={selectedTraceEvent.type}
                              initialDepth={2}
                              hint="JSON 负载"
                              showConsumedLegend={false}
                              alwaysShowHorizontalAxis
                              fullscreenTitle="调用事件负载"
                            />
                          </aside>
                        )}
                      </div>
                    </section>
                  )}
                </React.Fragment>
              )
            })}
          </div>
          <div className="workflow-foot">
            <span><i className="legend parallel" />时间条重叠 = 并行</span>
            <span><i className="legend dependency" />“等待”关系 = 串行依赖</span>
            <code>并发上限 {maxConcurrency}</code>
          </div>
        </div>
      )}
      {parameterTask && createPortal(
        <div className="workflow-task-detail-backdrop" role="presentation" onMouseDown={() => setParameterTaskId(null)}>
          <section
            className={`workflow-task-detail anchor-${detailAnchor?.horizontal || 'right'}-${detailAnchor?.vertical || 'down'}`}
            style={{
              '--workflow-detail-x': `${detailAnchor?.x ?? window.innerWidth / 2}px`,
              '--workflow-detail-y': `${detailAnchor?.y ?? window.innerHeight / 2}px`
            } as React.CSSProperties}
            role="dialog"
            aria-label={`${parameterTask.title} 任务参数`}
            onMouseDown={event => event.stopPropagation()}
          >
            <header>
              <div>
                <small>子任务 · {parameterTask.id}</small>
                <strong>{parameterTask.title}</strong>
              </div>
              <button onClick={() => setParameterTaskId(null)} aria-label="关闭任务参数"><X size={13} /></button>
            </header>
            <StructuredPayload
              key={parameterTask.id}
              value={parameterTask.payload}
              eventType="subagent/task_detail"
              initialDepth={0}
              hint="JSON 负载"
              showConsumedLegend={false}
              alwaysShowHorizontalAxis
              fullscreenTitle="任务参数"
            />
          </section>
        </div>,
        document.querySelector<HTMLElement>('.agent-window-container') || document.body
      )}
      {callPayloadAnchor && createPortal(
        <div className="workflow-task-detail-backdrop" role="presentation" onMouseDown={() => setCallPayloadAnchor(null)}>
          <section
            ref={callPayloadRef}
            className={`workflow-task-detail workflow-call-payload anchor-${callPayloadAnchor.horizontal}-${callPayloadAnchor.vertical}`}
            style={{
              '--workflow-detail-x': `${callPayloadPosition?.left ?? callPayloadAnchor.x}px`,
              '--workflow-detail-y': `${callPayloadPosition?.top ?? callPayloadAnchor.y}px`,
              visibility: callPayloadPosition ? 'visible' : 'hidden'
            } as React.CSSProperties}
            role="dialog"
            aria-label="delegate_tasks 调用参数"
            onMouseDown={event => event.stopPropagation()}
          >
            <header>
              <div>
                <small>{orchestrationCanvas ? '多 Agent 编排' : '工具调用 · delegate_tasks'}</small>
                <strong>调用参数</strong>
              </div>
              <button onClick={() => setCallPayloadAnchor(null)} aria-label="关闭调用参数"><X size={13} /></button>
            </header>
            <StructuredPayload
              value={call.data?.arguments ?? {}}
              eventType="tool/call"
              initialDepth={20}
              hint="JSON 负载"
              showConsumedLegend={false}
              alwaysShowHorizontalAxis
              fullscreenTitle="调用参数"
            />
          </section>
        </div>,
        document.querySelector<HTMLElement>('.agent-window-container') || document.body
      )}
    </section>
  )
  if (!fullscreen) return workflowContent
  return createPortal(
    <div className="workflow-fullscreen-backdrop">{workflowContent}</div>,
    document.querySelector<HTMLElement>('.agent-window-container') || document.body
  )
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

function initiallyExpandedPaths(value: unknown, path = '$', depth = 0, maxDepth = 2, paths = new Set<string>()): Set<string> {
  if (!isContainer(value)) return paths
  if (depth <= maxDepth) paths.add(path)
  Object.entries(value).forEach(([key, child]) => initiallyExpandedPaths(child, `${path}.${key}`, depth + 1, maxDepth, paths))
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
  onToggle,
  copiedPath,
  onOpenContextMenu
}: {
  value: unknown
  label?: string
  path: string[]
  eventType: string
  expanded: Set<string>
  onToggle: (path: string) => void
  copiedPath: string | null
  onOpenContextMenu: (position: { x: number; y: number }, path: string, label: string, value: unknown) => void
}): React.JSX.Element {
  const pathKey = path.length ? `$.${path.join('.')}` : '$'
  const consumed = isConsumedPayloadPath(eventType, path)
  if (!isContainer(value)) {
    return (
      <div className={`json-tree-leaf ${consumed ? 'frontend-consumed' : ''}`} role="treeitem">
        {label !== undefined && (
          <span
            className={`json-key json-key-context ${copiedPath === pathKey ? 'copied' : ''}`}
            title="右键查看操作"
            tabIndex={0}
            aria-haspopup="menu"
            onContextMenu={event => {
              event.preventDefault()
              onOpenContextMenu({ x: event.clientX, y: event.clientY }, pathKey, label, value)
            }}
            onKeyDown={event => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              onOpenContextMenu({ x: rect.left, y: rect.bottom + 4 }, pathKey, label, value)
            }}
          >
            {copiedPath === pathKey ? '已复制' : `${label}:`}
          </span>
        )}
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
      <div className="json-tree-toggle">
        <button className="json-tree-expand" onClick={() => onToggle(pathKey)} aria-expanded={open} aria-label={open ? '折叠字段' : '展开字段'}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {label !== undefined && (
          <span
            className={`json-key json-key-context ${copiedPath === pathKey ? 'copied' : ''}`}
            title="右键查看操作"
            tabIndex={0}
            aria-haspopup="menu"
            onContextMenu={event => {
              event.preventDefault()
              onOpenContextMenu({ x: event.clientX, y: event.clientY }, pathKey, label, value)
            }}
            onKeyDown={event => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              onOpenContextMenu({ x: rect.left, y: rect.bottom + 4 }, pathKey, label, value)
            }}
          >
            {copiedPath === pathKey ? '已复制' : `${label}:`}
          </span>
        )}
        <span className="json-bracket">{opening}</span>
        {!open && <span className="json-folded">{entries.length} 项</span>}
        {!open && <span className="json-bracket">{closing}</span>}
      </div>
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
              copiedPath={copiedPath}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}
          <div className="json-tree-close">{closing}</div>
        </div>
      )}
    </div>
  )
}

function StructuredPayload({
  value,
  eventType,
  initialDepth = 2,
  hint = '红色为发送给前端渲染层的内容',
  showConsumedLegend = true,
  alwaysShowHorizontalAxis = false,
  fullscreenTitle = '原始事件负载'
}: {
  value: unknown
  eventType: string
  initialDepth?: number
  hint?: string
  showConsumedLegend?: boolean
  alwaysShowHorizontalAxis?: boolean
  fullscreenTitle?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => initiallyExpandedPaths(value, '$', 0, initialDepth))
  const [copied, setCopied] = useState(false)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const [keyContextMenu, setKeyContextMenu] = useState<{
    x: number
    y: number
    path: string
    label: string
    value: unknown
  } | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const treeRef = useRef<HTMLDivElement>(null)
  const copyFeedbackTimerRef = useRef<number | null>(null)
  const [horizontalMetrics, setHorizontalMetrics] = useState({ content: 0, viewport: 0, offset: 0 })
  const toggle = (path: string): void => setExpanded(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const copyEntry = (path: string, label: string, entryValue: unknown): void => {
    const serializedValue = JSON.stringify(entryValue, null, 2) ?? String(entryValue ?? '')
    void copyTextToClipboard(`${JSON.stringify(label)}: ${serializedValue}`).then(() => {
      setCopiedPath(path)
      if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedPath(null)
        copyFeedbackTimerRef.current = null
      }, 1200)
    }).catch(console.error)
  }
  const openKeyContextMenu = (
    position: { x: number; y: number },
    path: string,
    label: string,
    entryValue: unknown
  ): void => {
    setKeyContextMenu({
      x: Math.max(8, Math.min(position.x, window.innerWidth - 150)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - 48)),
      path,
      label,
      value: entryValue
    })
  }
  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== null) window.clearTimeout(copyFeedbackTimerRef.current)
  }, [])
  useEffect(() => {
    if (!keyContextMenu) return
    const close = (): void => setKeyContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [keyContextMenu])
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
      setHorizontalMetrics({ content: tree.scrollWidth, viewport: tree.clientWidth, offset: tree.scrollLeft })
    }
    const frame = window.requestAnimationFrame(update)
    const observer = new ResizeObserver(update)
    observer.observe(tree)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [expanded, fullscreen, value])
  const horizontalMaximum = Math.max(0, horizontalMetrics.content - horizontalMetrics.viewport)

  const content = (
    <div className={`payload-tree-content ${fullscreen ? 'is-fullscreen' : ''} ${alwaysShowHorizontalAxis ? 'has-horizontal-axis' : ''}`}>
      <div className="payload-tree-toolbar">
        <span>
          {fullscreen && <strong>{fullscreenTitle}</strong>}
          {showConsumedLegend && <i />}
          {(!fullscreen || hint !== fullscreenTitle) && hint}
        </span>
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
      {(alwaysShowHorizontalAxis || horizontalMetrics.content > horizontalMetrics.viewport + 1) && (
        <div className="payload-horizontal-axis">
          <input
            type="range"
            min={0}
            max={Math.max(1, horizontalMaximum)}
            value={Math.min(horizontalMetrics.offset, Math.max(1, horizontalMaximum))}
            disabled={horizontalMaximum === 0}
            aria-label="JSON 负载横向滚动"
            onChange={event => {
              const offset = Number(event.currentTarget.value)
              if (treeRef.current) treeRef.current.scrollLeft = offset
              setHorizontalMetrics(current => ({ ...current, offset }))
            }}
          />
        </div>
      )}
      <div
        ref={treeRef}
        className="json-tree"
        role="tree"
        onScroll={event => {
          const offset = event.currentTarget.scrollLeft
          setHorizontalMetrics(current => current.offset === offset ? current : { ...current, offset })
        }}
      >
        <JsonTreeNode
          value={value}
          path={[]}
          eventType={eventType}
          expanded={expanded}
          onToggle={toggle}
          copiedPath={copiedPath}
          onOpenContextMenu={openKeyContextMenu}
        />
      </div>
      {keyContextMenu && createPortal(
        <div
          className="json-key-context-menu"
          role="menu"
          style={{ left: keyContextMenu.x, top: keyContextMenu.y }}
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            role="menuitem"
            autoFocus
            onClick={() => {
              copyEntry(keyContextMenu.path, keyContextMenu.label, keyContextMenu.value)
              setKeyContextMenu(null)
            }}
          >
            <Copy size={12} />
            复制键值对
          </button>
        </div>,
        document.querySelector<HTMLElement>('.agent-window-container') || document.body
      )}
    </div>
  )
  if (!fullscreen) return content
  return createPortal(
    <div className="payload-fullscreen-backdrop" role="presentation" onMouseDown={() => setFullscreen(false)}>
      <section className="payload-fullscreen-dialog" role="dialog" aria-modal="true" aria-label={`${fullscreenTitle}全屏查看`} onMouseDown={event => event.stopPropagation()}>
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
  const [expandedDelegates, setExpandedDelegates] = useState<Set<number>>(() => new Set())
  const [highlightedSeq, setHighlightedSeq] = useState<number | null>(null)
  const [pendingScrollSeq, setPendingScrollSeq] = useState<number | null>(null)
  const ledgerRef = useRef<VirtuosoHandle>(null)
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
      let nextEvents: TraceEvent[] = (page?.events || []).filter((event: TraceEvent) => matchesFilter(event, filter))
      if (!deferredQuery && (filter === 'all' || filter === 'subagent')) {
        nextEvents = (await hydrateWorkflowHistory(activeSessionId, nextEvents)).filter(event => matchesFilter(event, filter))
      }
      const loadedTurns = [...new Set(nextEvents.flatMap((event: TraceEvent) =>
        event.turn === undefined ? [] : [event.turn]))]
      const latestTurn = loadedTurns[loadedTurns.length - 1]
      latestTurnRef.current = latestTurn
      setCollapsedTurns(new Set(loadedTurns.filter(turn => turn !== latestTurn)))
      setEvents(nextEvents)
      setTotal(Number(page?.total || 0))
      const reachedSessionStart = Number.isSafeInteger(page?.firstSeq) && nextEvents.some(event => event.seq === page.firstSeq)
      setHasMore(Boolean(page?.hasMore) && !reachedSessionStart)
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
      let older = (page?.events || []).filter((event: TraceEvent) => matchesFilter(event, filter))
      if (!deferredQuery && (filter === 'all' || filter === 'subagent')) {
        older = (await hydrateWorkflowHistory(activeSessionId, older)).filter(event => matchesFilter(event, filter))
      }
      if (older.length > 0) {
        setEvents(current => mergeTraceEvents(older, current))
      }
      const reachedSessionStart = Number.isSafeInteger(page?.firstSeq) && older.some(event => event.seq === page.firstSeq)
      setHasMore(Boolean(page?.hasMore) && !reachedSessionStart)
    } finally {
      setLoadingOlder(false)
    }
  }, [activeSessionId, deferredQuery, events, filter, hasMore, loadingOlder])

  const workflowInternalSeqs = useMemo(() => {
    const hidden = new Set<number>()
    for (const call of events.filter(isDelegateCall)) {
      delegateEvents(call, events).forEach(event => hidden.add(event.seq))
      const result = events.find(event => event.type === 'tool/result' && event.correlationId === call.correlationId)
      if (result) hidden.add(result.seq)
    }
    return hidden
  }, [events])
  const mainTimelineEvents = useMemo(
    () => events.filter(event => !workflowInternalSeqs.has(event.seq)),
    [events, workflowInternalSeqs]
  )

  const metrics = useMemo(() => {
    let tools = 0
    let requests = 0
    let errors = 0
    for (const event of mainTimelineEvents) {
      if (event.type === 'tool/call') tools += 1
      if (event.type === 'request/start') requests += 1
      if (event.type === 'error' || event.type === 'mcp/error') errors += 1
    }
    const first = mainTimelineEvents[0]?.time
    const last = mainTimelineEvents[mainTimelineEvents.length - 1]?.time
    return { tools, requests, errors, duration: first && last ? last - first : 0 }
  }, [mainTimelineEvents])

  const turnSummaries = useMemo(() => {
    const summaries = new Map<number, { count: number; start: number; end: number }>()
    for (const event of mainTimelineEvents) {
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
  }, [mainTimelineEvents])
  const turns = turnSummaries.size
  const firstEventSeqByTurn = useMemo(() => {
    const first = new Map<number, number>()
    for (const event of mainTimelineEvents) {
      if (event.turn !== undefined && !first.has(event.turn)) first.set(event.turn, event.seq)
    }
    return first
  }, [mainTimelineEvents])
  const visibleEvents = useMemo(() => {
    const seenTurns = new Set<number>()
    return mainTimelineEvents.filter(event => {
      if (event.turn === undefined) return true
      const firstInTurn = !seenTurns.has(event.turn)
      seenTurns.add(event.turn)
      return firstInTurn || !collapsedTurns.has(event.turn)
    })
  }, [collapsedTurns, mainTimelineEvents])
  const focusTimelineEvent = useCallback((event: TraceEvent): void => {
    setFollowTail(false)
    setSelected(isDelegateCall(event) ? null : event)
    setHighlightedSeq(event.seq)
    setPendingScrollSeq(event.seq)
    if (event.turn !== undefined) {
      setCollapsedTurns(current => {
        if (!current.has(event.turn!)) return current
        const next = new Set(current)
        next.delete(event.turn!)
        return next
      })
    }
  }, [])
  useEffect(() => {
    if (pendingScrollSeq === null) return
    const index = visibleEvents.findIndex(event => event.seq === pendingScrollSeq)
    if (index < 0) return
    let measureFrame = 0
    const layoutFrame = window.requestAnimationFrame(() => {
      measureFrame = window.requestAnimationFrame(() => {
        ledgerRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' })
        setPendingScrollSeq(null)
      })
    })
    return () => {
      window.cancelAnimationFrame(layoutFrame)
      if (measureFrame) window.cancelAnimationFrame(measureFrame)
    }
  }, [pendingScrollSeq, visibleEvents])
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
              if (mainTimelineEvents.length === 0) return
              const rect = pointer.currentTarget.getBoundingClientRect()
              const fraction = Math.min(1, Math.max(0, (pointer.clientX - rect.left) / Math.max(1, rect.width)))
              const start = mainTimelineEvents[0].time
              const end = mainTimelineEvents[mainTimelineEvents.length - 1].time
              const targetTime = start + fraction * Math.max(1, end - start)
              const nearest = mainTimelineEvents.reduce((best, candidate) =>
                Math.abs(candidate.time - targetTime) < Math.abs(best.time - targetTime) ? candidate : best)
              focusTimelineEvent(nearest)
            }}
            title={mainTimelineEvents.length > 0 ? `${formatClock(mainTimelineEvents[0].time)} → ${formatClock(mainTimelineEvents[mainTimelineEvents.length - 1].time)}` : '暂无时间数据'}
          >
            {mainTimelineEvents.map((event) => {
              if (event.turn === undefined || firstEventSeqByTurn.get(event.turn) !== event.seq) return null
              const start = mainTimelineEvents[0]?.time || 0
              const span = Math.max(1, (mainTimelineEvents[mainTimelineEvents.length - 1]?.time || 0) - start)
              return <i key={`turn-${event.seq}`} className="timeline-turn-boundary" style={{ left: `${((event.time - start) / span) * 100}%` }} />
            })}
            {mainTimelineEvents.map((event) => {
              const start = mainTimelineEvents[0]?.time || 0
              const span = Math.max(1, (mainTimelineEvents[mainTimelineEvents.length - 1]?.time || 0) - start)
              const rawIndex = events.findIndex(candidate => candidate.seq === event.seq)
              const duration = rawIndex >= 0 ? timelineDuration(events, rawIndex) : 0
              const left = ((event.time - start) / span) * 100
              const width = (duration / span) * 100
              return (
                <button
                  key={event.seq}
                  className={`timeline-span lane-${timelineLane(event)} kind-${category(event)} ${duration === 0 ? 'point' : ''} ${selected?.seq === event.seq || highlightedSeq === event.seq ? 'selected' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${eventLabel(event.type)}\n${formatClock(event.time)}${duration ? ` · ${formatDuration(duration)}` : ''}`}
                  onClick={(pointer) => { pointer.stopPropagation(); focusTimelineEvent(event) }}
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

      <main className={`trajectory-workspace ${selected && !isDelegateCall(selected) ? 'with-inspector' : ''}`}>
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
              ref={ledgerRef}
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
                const delegateCall = isDelegateCall(event)
                const turnChanged = event.turn !== undefined && firstEventSeqByTurn.get(event.turn) === event.seq
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
                        {delegateCall ? (
                          <DelegateWorkflow
                            call={event}
                            events={events}
                            expanded={expandedDelegates.has(event.seq)}
                            selected={selected?.seq === event.seq || highlightedSeq === event.seq}
                            onFocus={() => { setHighlightedSeq(event.seq); setSelected(null) }}
                            onToggle={() => setExpandedDelegates(current => {
                              const next = new Set(current)
                              if (next.has(event.seq)) next.delete(event.seq)
                              else next.add(event.seq)
                              return next
                            })}
                          />
                        ) : (
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
                        )}
                      </>
                    )}
                  </div>
                )
              }}
            />
          )}
        </section>

        {selected && !isDelegateCall(selected) && (
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

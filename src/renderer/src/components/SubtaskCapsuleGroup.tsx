import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskEvent, TaskStep } from '../../../main/task-runtime/types'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock3,
  Copy,
  Loader2,
  X
} from 'lucide-react'
import { AgentBrandIcon } from './AgentBrandIcon'
import {
  cleanResultSummary,
  CollaborationArtifactCards,
  type CollaborationSnapshot
} from './CollaborationRunCard'
import {
  describeActivity,
  renderAdvancedMessage,
  ToolStepItem,
  ToolThinkItem
} from './ChatMessageItem'
import { ChatActivityGroup } from './ChatActivityGroup'
import { FileChangesCard } from './FileChangesCard'
import type { FileChangeItem } from './FileDiffModal'
import './SubtaskCapsuleGroup.css'

type OpenSubtask = (taskRunId: string, taskStepId: string) => void

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  running: '处理中',
  paused: '已暂停',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消'
}

function StepStatusIcon({ status }: { status: string }): React.JSX.Element {
  if (status === 'running') return <Loader2 className="spin" size={13} strokeWidth={2} />
  if (status === 'completed') return <Check size={13} strokeWidth={2.5} />
  if (['failed', 'blocked', 'cancelled'].includes(status)) {
    return <AlertTriangle size={13} strokeWidth={2} />
  }
  if (status === 'pending') return <Clock3 size={13} strokeWidth={1.8} />
  return <Circle size={9} strokeWidth={2} />
}

function groupByDependencyLayer(steps: TaskStep[]): TaskStep[][] {
  const byId = new Map(steps.map((step) => [String(step.id), step]))
  const cache = new Map<string, number>()
  const layerOf = (id: string, visiting = new Set<string>()): number => {
    if (cache.has(id)) return cache.get(id) || 0
    if (visiting.has(id)) return 0
    const dependencies = (byId.get(id)?.dependencies || [])
      .map(String)
      .filter((value: string) => byId.has(value))
    const layer = dependencies.length
      ? Math.max(
          ...dependencies.map((value: string) => layerOf(value, new Set(visiting).add(id)))
        ) + 1
      : 0
    cache.set(id, layer)
    return layer
  }
  const groups = new Map<number, TaskStep[]>()
  steps.forEach((step) => {
    const layer = layerOf(String(step.id))
    groups.set(layer, [...(groups.get(layer) || []), step])
  })
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group)
}

type SubtaskTraceItem = {
  id: string
  type: 'think' | 'tool' | 'message'
  detail?: string
  callId?: string
  name?: string
  callDetail?: unknown
  resultDetail?: unknown
  isWaiting?: boolean
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function subtaskToolName(value: unknown): string {
  const name = String(value || 'tool')
  const aliases: Record<string, string> = {
    Bash: 'run_command',
    Read: 'read_file',
    Write: 'write_file',
    Edit: 'edit_file',
    Grep: 'grep_content',
    Glob: 'find_files',
    WebSearch: 'search_web',
    WebFetch: 'read_url_content',
    Task: 'delegate_tasks',
    TodoWrite: 'update_task_plan'
  }
  return aliases[name] || name
}

function buildSubtaskTrace(events: TaskEvent[], stepId: string): SubtaskTraceItem[] {
  const trace: SubtaskTraceItem[] = []
  const append = (type: string, rawPayload: unknown, id: string): void => {
    const payload = recordOf(rawPayload)
    if (type === 'think' && String(payload.detail || '').trim()) {
      trace.push({ id, type: 'think', detail: String(payload.detail) })
      return
    }
    if (type === 'tool_call') {
      trace.push({
        id,
        type: 'tool',
        callId: String(payload.callId || ''),
        name: String(payload.name || 'tool'),
        callDetail: payload.arguments,
        isWaiting: true
      })
      return
    }
    if (type !== 'tool_result') return
    const callId = String(payload.callId || '')
    const name = String(payload.name || 'tool')
    const match = [...trace]
      .reverse()
      .find(
        (item) =>
          item.type === 'tool' &&
          item.isWaiting &&
          (callId ? item.callId === callId : item.name === name)
      )
    if (match) {
      match.resultDetail = payload.displayResult ?? payload.result
      match.isWaiting = false
    } else {
      trace.push({
        id,
        type: 'tool',
        callId,
        name,
        resultDetail: payload.displayResult ?? payload.result,
        isWaiting: false
      })
    }
  }

  ;[...events]
    .filter((event) => !event.taskStepId || String(event.taskStepId) === stepId)
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
    .forEach((event, index) => {
      append(String(event.type || ''), event.payload, String(event.id || `event-${index}`))
      const update = recordOf(event.payload?.update)
      if (event.type === 'agent_event' && update.type) {
        append(String(update.type), update, `${String(event.id || index)}-agent`)
      }
      if (event.type !== 'agent_event') return
      const sessionUpdate = String(update.sessionUpdate || '')
      const updateId = `${String(event.id || index)}-acp`
      if (sessionUpdate === 'agent_thought_chunk') {
        const content = recordOf(update.content)
        const detail = String(content.text || '').trim()
        if (detail) trace.push({ id: updateId, type: 'think', detail })
      }
      if (sessionUpdate === 'agent_message_chunk') {
        const content = recordOf(update.content)
        const text = typeof content.text === 'string' ? content.text : ''
        if (text) {
          const previous = trace[trace.length - 1]
          if (previous?.type === 'message') previous.detail = `${previous.detail || ''}${text}`
          else trace.push({ id: updateId, type: 'message', detail: text })
        }
      }
      if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return
      const callId = String(update.toolCallId || '')
      const match = [...trace].reverse().find((item) => item.type === 'tool' && item.callId === callId)
      if (sessionUpdate === 'tool_call' && !match) {
        trace.push({
          id: updateId,
          type: 'tool',
          callId,
          name: subtaskToolName(update.name),
          callDetail: update.rawInput,
          resultDetail: update.status === 'completed' ? update.rawOutput ?? '已完成' : update.status === 'failed' ? '执行失败' : undefined,
          isWaiting: update.status !== 'completed' && update.status !== 'failed'
        })
      } else if (match) {
        match.resultDetail = update.rawOutput ?? (update.status === 'failed' ? '执行失败' : '已完成')
        match.isWaiting = false
      } else {
        trace.push({
          id: updateId,
          type: 'tool',
          callId,
          name: subtaskToolName(update.name),
          resultDetail: update.rawOutput ?? (update.status === 'failed' ? '执行失败' : '已完成'),
          isWaiting: false
        })
      }
    })
  return trace
}

function cleanProgressMessage(text: string): string {
  return text
    .replace(/^子 Agent\s*/, '')
    .replace(/\brun_terminal_command\b/g, '终端命令')
    .replace(/\brun_command\b/g, '终端命令')
    .replace(/\blist_directory\b/g, '列出目录')
    .replace(/\blist_dir\b/g, '列出目录')
    .replace(/\bread_file\b/g, '读取文件')
    .replace(/\bwrite_file\b/g, '写入文件')
    .replace(/\bedit_file\b/g, '修改文件')
    .replace(/\bedit_files\b/g, '批量修改文件')
    .replace(/\bgrep_content\b/g, '代码检索')
    .replace(/\bfind_files\b/g, '查找文件')
    .replace(/\brequest_skill\b/g, '加载能力')
    .replace(/\bdelegate_tasks\b/g, '分派子任务')
}

function extractSubtaskFileChanges(events: TaskEvent[], stepId: string): FileChangeItem[] {
  const changesMap = new Map<string, FileChangeItem>()
  for (const event of events) {
    if (event.taskStepId && String(event.taskStepId) !== stepId) continue
    if (event.type === 'file_changes') {
      const payload = recordOf(event.payload)
      const list = Array.isArray(payload.changes) ? (payload.changes as FileChangeItem[]) : []
      for (const item of list) {
        if (item?.filePath) {
          changesMap.set(item.filePath, item)
        }
      }
    }
  }
  return [...changesMap.values()]
}

function resolveSubtaskPrompt(step: TaskStep, events: TaskEvent[] = []): string {
  const direct = String(step.prompt || '').trim()
  if (direct) return direct

  // 从事件流中回溯最初的下发 prompt
  for (const event of events) {
    if (event.taskStepId && String(event.taskStepId) !== String(step.id)) continue
    const payload = recordOf(event.payload)
    const request = recordOf(payload.request)
    const requestPrompt = String(request.prompt || payload.prompt || '').trim()
    if (requestPrompt) return requestPrompt

    const plan = recordOf(payload.plan)
    const planSteps = Array.isArray(plan.steps) ? plan.steps : []
    const matchingStep = planSteps.find((s: any) => String(s?.id) === String(step.id))
    if (matchingStep?.prompt && String(matchingStep.prompt).trim()) {
      return String(matchingStep.prompt).trim()
    }
  }

  const goal = String(step.goal || '').trim()
  if (goal) return goal

  const title = String(step.title || '').trim()
  if (title) return `执行任务：${title}`

  return '执行该子任务并返回可验证结果。'
}

/**
 * 下发任务提示词卡片（基于 taste-skill 极简高质感设计）：
 * - 长文本默认折叠（平滑渐变遮罩 + 胶囊展开）
 * - 展开后支持在卡片内丝滑滑动（独立滚动限高，不撑爆外层界面）
 * - 顶部与底部双重便捷收起，支持一键复制代码与状态微反馈
 */
function SubtaskPromptCard({
  prompt,
  agentId
}: {
  prompt: string
  agentId: string
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // 当指令文本较长（> 110 字符或 > 3 行）时默认折叠
  const isLongText = useMemo(() => {
    return prompt.length > 110 || prompt.split('\n').length > 3
  }, [prompt])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // 忽略无法访问剪贴板的边缘错误
    }
  }, [prompt])

  return (
    <article
      className={`subtask-prompt-card ${isLongText ? (isExpanded ? 'is-expanded' : 'is-collapsed') : 'is-short'}`}
    >
      <header
        className="subtask-prompt-header"
        onDoubleClick={isLongText ? () => setIsExpanded((prev) => !prev) : undefined}
      >
        <div className="subtask-prompt-meta">
          <span className="subtask-prompt-agent-tag">
            <span className="subtask-prompt-brand-icon" aria-hidden="true">
              <AgentBrandIcon agentId={agentId} />
            </span>
            <span>下发给 {agentId}</span>
          </span>
          <span className="subtask-prompt-length-badge">{prompt.length} 字</span>
        </div>

        <div className="subtask-prompt-actions">
          {isLongText && (
            <button
              type="button"
              className="subtask-prompt-action-btn subtask-prompt-header-toggle"
              onClick={() => setIsExpanded((prev) => !prev)}
              aria-expanded={isExpanded}
              title={isExpanded ? '收起完整指令' : '展开完整指令'}
            >
              {isExpanded ? (
                <>
                  <ChevronUp size={12} strokeWidth={2.2} aria-hidden="true" />
                  <span>收起</span>
                </>
              ) : (
                <>
                  <ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" />
                  <span>展开</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            className={`subtask-prompt-action-btn subtask-prompt-copy-btn ${copied ? 'is-copied' : ''}`}
            onClick={handleCopy}
            aria-label={copied ? '已复制完整指令' : '复制完整指令'}
            title="复制指令内容"
          >
            {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </header>

      <div className="subtask-prompt-body-wrap">
        <div className="subtask-prompt-body message-text">
          {renderAdvancedMessage(prompt)}
        </div>
        {isLongText && !isExpanded && (
          <div className="subtask-prompt-mask" aria-hidden="true" />
        )}
      </div>

      {isLongText && (
        <footer className="subtask-prompt-footer">
          <button
            type="button"
            className="subtask-prompt-toggle-btn"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? (
              <>
                <ChevronUp size={13} strokeWidth={2} aria-hidden="true" />
                <span>收起完整指令</span>
              </>
            ) : (
              <>
                <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
                <span>展开完整指令（共 {prompt.length} 字）</span>
              </>
            )}
          </button>
        </footer>
      )}
    </article>
  )
}

export const SubtaskCapsuleGroup = React.memo(function SubtaskCapsuleGroup({
  snapshot,
  selectedStepId,
  onOpenDetails
}: {
  snapshot: CollaborationSnapshot
  selectedStepId?: string
  onOpenDetails: OpenSubtask
}): React.JSX.Element {
  const layers = useMemo(
    () => groupByDependencyLayer((snapshot.steps || []) as TaskStep[]),
    [snapshot.steps]
  )
  return (
    <section
      className="subtask-capsule-cluster"
      aria-label={`子任务：${snapshot.run.title || '多 Agent 协作'}`}
    >
      <div className="subtask-capsule-layers">
        {layers.map((layer, layerIndex) => (
          <React.Fragment key={`layer-${layerIndex}`}>
            {layerIndex > 0 && <span className="subtask-layer-connector" aria-hidden="true" />}
            <div className={`subtask-capsule-row ${layer.length > 1 ? 'is-parallel' : ''}`}>
              {layer.map((step) => {
                const status = String(step.status || 'pending')
                const selected = selectedStepId === String(step.id)
                return (
                  <button
                    key={step.id}
                    type="button"
                    className={`subtask-capsule status-${status} ${selected ? 'is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => onOpenDetails(String(snapshot.run.id), String(step.id))}
                  >
                    <span className="subtask-capsule-agent" aria-hidden="true">
                      <AgentBrandIcon agentId={step.agentId || 'agentpet'} />
                    </span>
                    <span className="subtask-capsule-title">{step.title || '未命名子任务'}</span>
                    <span className="subtask-capsule-status">
                      <StepStatusIcon status={status} />
                      {STATUS_LABEL[status] || status}
                    </span>
                    <ChevronRight
                      className="subtask-capsule-open"
                      size={15}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                )
              })}
            </div>
          </React.Fragment>
        ))}
      </div>
    </section>
  )
})

export function SubtaskDetailDrawer({
  snapshot,
  stepId,
  onClose,
  onPreviewFile
}: {
  snapshot: CollaborationSnapshot
  stepId: string
  onClose: () => void
  onPreviewFile?: (file: { name: string; path: string; size: number }) => void
}): React.JSX.Element | null {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const step = snapshot.steps.find((item) => String(item.id) === stepId)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() =>
      closeButtonRef.current?.focus({ preventScroll: true })
    )
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      openerRef.current?.focus({ preventScroll: true })
    }
  }, [stepId])

  if (!step) return null
  const status = String(step.status || 'pending')
  const agentId = String(step.agentId || 'agentpet')
  const prompt = resolveSubtaskPrompt(step, snapshot.events || [])
  const progress = String(step.detail || '').trim()
  const result = String(step.resultSummary || '').trim()
  const trace = buildSubtaskTrace(snapshot.events || [], stepId)

  const isRunning = status === 'running'
  const isBlockedOrFailed = ['failed', 'blocked', 'cancelled'].includes(status)
  const lastTraceStep = trace[trace.length - 1]

  // 动态活动摘要：优先反映当前具体执行步骤，若处于等待模型继续阶段且有后端进度日志，平滑融入活动摘要
  const activityLabel = useMemo(() => {
    if (lastTraceStep?.type === 'message') {
      const text = String(lastTraceStep.detail || '').replace(/\s+/g, ' ').trim()
      return text ? `${isRunning ? '正在回复' : '已回复'}：${text.slice(-36)}` : '正在回复'
    }
    if (isRunning && progress && trace.length > 0 && !lastTraceStep?.isWaiting) {
      const cleanProgress = cleanProgressMessage(progress)
      if (cleanProgress.length <= 40) return cleanProgress
    }
    return describeActivity(lastTraceStep, isRunning) || (isRunning ? '正在处理' : '执行记录')
  }, [isRunning, progress, trace.length, lastTraceStep])

  const toolCount = trace.filter((item) => item.type === 'tool').length
  const subtaskFileChanges = useMemo(
    () => extractSubtaskFileChanges(snapshot.events || [], stepId),
    [snapshot.events, stepId]
  )

  return (
    <div className="subtask-detail-layer">
      <aside className="subtask-detail-drawer" aria-labelledby="subtask-detail-title">
        <header className="subtask-detail-header">
          <span className="subtask-detail-agent" aria-hidden="true">
            <AgentBrandIcon agentId={agentId} />
          </span>
          <span>
            <strong id="subtask-detail-title">{step.title || '子任务详情'}</strong>
            <small>{agentId} · 执行记录</small>
          </span>
          <em className={`status-${status}`}>
            <StepStatusIcon status={status} />
            {STATUS_LABEL[status] || status}
          </em>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭子任务详情">
            <X size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </header>

        <div className="subtask-conversation" role="log" aria-live="polite">
          {/* 下发子任务卡片（长文本默认不全部展开，微毛玻璃渐变遮罩 + 展开/收起） */}
          <SubtaskPromptCard prompt={prompt} agentId={agentId} />

          {/* 异常终止或受阻时的错误警示提示 */}
          {isBlockedOrFailed && progress && !result && (
            <article className="subtask-message is-progress is-error">
              <small>{STATUS_LABEL[status] || status}</small>
              <p>{progress}</p>
            </article>
          )}

          {/* 执行过程（复用 ChatActivityGroup 与 ToolStepItem，默认收起为紧凑胶囊，点击可展开详情） */}
          {trace.length > 0 && (
            <section className="subtask-activity-section" aria-label="子任务执行过程">
              <ChatActivityGroup
                count={toolCount}
                activityLabel={activityLabel}
                running={isRunning}
                isThinking={isRunning && lastTraceStep?.type === 'think'}
                defaultOpen={false}
              >
                {trace.map((item, index) =>
                  item.type === 'tool' ? (
                    <ToolStepItem key={item.id} step={item} isThinking={isRunning} />
                  ) : item.type === 'message' ? (
                    <article key={item.id} className="subtask-message is-progress">
                      <small>过程消息</small>
                      <p>{item.detail}</p>
                    </article>
                  ) : (
                    <ToolThinkItem
                      key={item.id}
                      step={item}
                      isThinking={isRunning && index === trace.length - 1}
                    />
                  )
                )}
              </ChatActivityGroup>
            </section>
          )}

          {/* 执行结果 / 启动中流光提示 */}
          {result ? (
            <article
              className={`subtask-message is-response ${isBlockedOrFailed ? 'is-error' : ''}`}
            >
              <small>{status === 'completed' ? 'Agent 回复' : '执行结果'}</small>
              <div>{renderAdvancedMessage(cleanResultSummary(result))}</div>
            </article>
          ) : isRunning ? (
            trace.length === 0 && (
              <div className="chat-thinking-shimmer subtask-shimmer" role="status" aria-label="处理中">
                <span className="chat-thinking-shimmer-text">
                  {progress ? progress.replace(/^子 Agent\s*/, '') : '正在启动并分析任务…'}
                </span>
              </div>
            )
          ) : status === 'pending' ? (
            <div className="subtask-conversation-pending" role="status">
              <Clock3 size={14} />
              <span>等待系统调度</span>
            </div>
          ) : !isBlockedOrFailed ? (
            <div className="subtask-conversation-pending" role="status">
              <span>暂时还没有回复</span>
            </div>
          ) : null}

          {/* 子任务产生的文件变更 Diff 追踪与审核 */}
          {subtaskFileChanges.length > 0 && (
            <div className="subtask-detail-diff-section">
              <FileChangesCard changes={subtaskFileChanges} />
            </div>
          )}

          <CollaborationArtifactCards
            paths={Array.isArray(step.artifactPaths) ? step.artifactPaths.map(String) : []}
            workspacePath={snapshot.run.workspacePath}
            onPreviewFile={onPreviewFile}
            className="subtask-detail-artifacts"
          />
        </div>
      </aside>
    </div>
  )
}

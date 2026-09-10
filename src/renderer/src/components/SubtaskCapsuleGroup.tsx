import React, { useEffect, useMemo, useRef } from 'react'
import type { TaskEvent, TaskStep } from '../../../main/task-runtime/types'
import { AlertTriangle, Check, ChevronRight, Circle, Clock3, Loader2, X } from 'lucide-react'
import { AgentBrandIcon } from './AgentBrandIcon'
import {
  cleanResultSummary,
  CollaborationArtifactCards,
  type CollaborationSnapshot
} from './CollaborationRunCard'
import { renderAdvancedMessage, ToolStepItem, ToolThinkItem } from './ChatMessageItem'
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
  type: 'think' | 'tool'
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
    })
  return trace
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
  const prompt = String(step.prompt || step.goal || '执行该子任务并返回可验证结果。')
  const progress = String(step.detail || '').trim()
  const result = String(step.resultSummary || '').trim()
  const trace = buildSubtaskTrace(snapshot.events || [], stepId)

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
          <article className="subtask-message is-request">
            <small>下发给 {agentId}</small>
            <div>{renderAdvancedMessage(prompt)}</div>
          </article>

          {progress && progress !== result && (
            <article className="subtask-message is-progress">
              <small>{STATUS_LABEL[status] || status}</small>
              <p>{progress}</p>
            </article>
          )}

          {trace.length > 0 && (
            <section className="subtask-execution-trace" aria-label="子任务执行过程">
              <header>
                <strong>执行过程</strong>
                <span>{trace.length} 条记录</span>
              </header>
              <div>
                {trace.map((item, index) =>
                  item.type === 'tool' ? (
                    <ToolStepItem key={item.id} step={item} isThinking={status === 'running'} />
                  ) : (
                    <ToolThinkItem
                      key={item.id}
                      step={item}
                      isThinking={status === 'running' && index === trace.length - 1}
                    />
                  )
                )}
              </div>
            </section>
          )}

          {result ? (
            <article
              className={`subtask-message is-response ${['failed', 'blocked'].includes(status) ? 'is-error' : ''}`}
            >
              <small>{status === 'completed' ? 'Agent 回复' : '执行结果'}</small>
              <div>{renderAdvancedMessage(cleanResultSummary(result))}</div>
            </article>
          ) : (
            <div className="subtask-conversation-pending" role="status">
              {status === 'running' && <Loader2 className="spin" size={16} />}
              <span>
                {status === 'pending'
                  ? '等待调度'
                  : status === 'running'
                    ? 'Agent 正在处理'
                    : '暂时还没有回复'}
              </span>
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

import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Circle, FileText, ListChecks, LoaderCircle, LocateFixed, Network, Pause, Play, RotateCcw, Square, X } from 'lucide-react'
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './TaskPlanCard.css'
import { AgentBrandIcon } from './AgentBrandIcon'

export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface TaskPlanStep {
  id: string
  title: string
  status: TaskStepStatus
  detail?: string
  goal?: string
  dependencies?: string[]
  acceptanceCriteria?: string
  resultSummary?: string
  artifactPaths?: string[]
  retryCount?: number
  agentRole?: 'general' | 'researcher' | 'coder' | 'reviewer'
  agentId?: string
}

export interface TaskPlan {
  runId?: string
  title: string
  explanation?: string
  steps: TaskPlanStep[]
}

const STATUS_LABEL: Record<TaskStepStatus, string> = {
  pending: '等待',
  in_progress: '进行中',
  completed: '完成',
  blocked: '受阻'
}

function normalizeTaskPlan(value: any): TaskPlan | null {
  if (!value || typeof value !== 'object') return null
  const title = String(value.title || '').trim()
  const rawSteps = Array.isArray(value.steps) ? value.steps : []
  const validStatuses = new Set<TaskStepStatus>(['pending', 'in_progress', 'completed', 'blocked'])
  const steps = rawSteps.slice(0, 12).map((step: any, index: number) => ({
    id: String(step?.id || `step-${index + 1}`),
    title: String(step?.title || '').trim(),
    status: validStatuses.has(step?.status) ? step.status as TaskStepStatus : 'pending',
    detail: String(step?.detail || '').trim() || undefined,
    goal: String(step?.goal || step?.prompt || '').trim() || undefined,
    dependencies: Array.isArray(step?.dependencies) ? step.dependencies.map(String).filter(Boolean) : [],
    acceptanceCriteria: String(step?.acceptanceCriteria || '').trim() || undefined,
    resultSummary: String(step?.resultSummary || '').trim() || undefined,
    artifactPaths: Array.isArray(step?.artifactPaths) ? step.artifactPaths.map(String).filter(Boolean) : [],
    retryCount: Math.max(0, Number(step?.retryCount) || 0),
    agentRole: ['general', 'researcher', 'coder', 'reviewer'].includes(String(step?.agentRole || step?.role))
      ? step.agentRole || step.role
      : undefined,
    agentId: String(step?.agentId || 'agentpet')
  })).filter((step: TaskPlanStep) => step.title)
  if (!title || steps.length < 1) return null
  return {
    title,
    explanation: String(value.explanation || '').trim() || undefined,
    steps
  }
}

export function latestTaskPlan(toolSteps: any[]): TaskPlan | null {
  for (let index = toolSteps.length - 1; index >= 0; index -= 1) {
    const step = toolSteps[index]
    if (step?.type === 'call' && ['update_task_plan', 'delegate_tasks'].includes(step?.name)) {
      const source = step.name === 'delegate_tasks'
        ? { title: step.detail?.title || step.detail?.goal || 'Delegated tasks', explanation: 'Live multi-agent execution graph', steps: step.detail?.tasks || step.detail?.subtasks || [] }
        : step.detail
      const plan = normalizeTaskPlan(source)
      if (!plan) return null
      const result = toolSteps.slice(index + 1).find((candidate: any) => candidate?.type === 'result' && candidate?.name === step.name)
      if (typeof result?.detail === 'string') {
        try { plan.runId = String(JSON.parse(result.detail)?.taskRunId || '') || undefined } catch { /* Historical result did not contain a run id. */ }
      }
      return plan
    }
  }
  return null
}

export const TaskPlanFloatingStatus = React.memo(function TaskPlanFloatingStatus({ plan }: { plan: TaskPlan }) {
  const currentStepIndex = plan.steps.findIndex(step => step.status === 'in_progress')
  if (currentStepIndex < 0) return null

  const currentStep = plan.steps[currentStepIndex]
  const completed = plan.steps.filter(step => step.status === 'completed').length
  const progress = Math.max(8, Math.round((completed / plan.steps.length) * 100))

  return (
    <div
      className="task-plan-floating-status"
      role="status"
      tabIndex={0}
      aria-live="polite"
      aria-label={`正在执行第 ${currentStepIndex + 1} / ${plan.steps.length} 步：${currentStep.title}`}
    >
      <svg className="task-plan-floating-progress" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" />
        <circle
          className="task-plan-floating-progress-value"
          cx="18"
          cy="18"
          r="15.9155"
          fill="none"
          strokeWidth="4"
          strokeDasharray={`${progress} ${100 - progress}`}
          strokeDashoffset="25"
          strokeLinecap="round"
        />
      </svg>
      <span className="task-plan-floating-count">第 {currentStepIndex + 1} / {plan.steps.length} 步</span>
      <span className="task-plan-floating-divider" aria-hidden="true">·</span>
      <span className="task-plan-floating-title">{currentStep.title}</span>

      <section className="task-plan-floating-details" aria-label={`任务步骤：${plan.title}`}>
        <header>
          <strong>{plan.title}</strong>
          <span>{completed} / {plan.steps.length}</span>
        </header>
        {plan.explanation && <p>{plan.explanation}</p>}
        <ol>
          {plan.steps.map((step, index) => (
            <li key={step.id} className={`is-${step.status}`}>
              <span className="task-plan-floating-step-marker" aria-hidden="true">
                {step.status === 'completed' ? <Check size={12} strokeWidth={2.7} /> : index + 1}
              </span>
              <span className="task-plan-floating-step-copy">
                <strong>{step.title}</strong>
                {step.detail && <small>{step.detail}</small>}
              </span>
              <small className="task-plan-floating-step-status">{STATUS_LABEL[step.status]}</small>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
})

function StepMarker({ status }: { status: TaskStepStatus }): React.JSX.Element {
  if (status === 'completed') return <Check size={13} strokeWidth={2.7} aria-hidden="true" />
  if (status === 'in_progress') return <LoaderCircle size={14} strokeWidth={2.2} aria-hidden="true" />
  if (status === 'blocked') return <AlertTriangle size={13} strokeWidth={2.3} aria-hidden="true" />
  return <Circle size={9} strokeWidth={2} aria-hidden="true" />
}

function toPlanStep(step: any): TaskPlanStep {
  const status: TaskStepStatus = step?.status === 'running'
    ? 'in_progress'
    : ['failed', 'cancelled'].includes(step?.status) ? 'blocked' : step?.status || 'pending'
  return { ...step, status }
}

function normalizeArtifactUrl(path: string): string {
  const value = path.trim()
  if (value.startsWith('file:///')) return value.replace('file:///', 'local-file:///')
  if (value.startsWith('local-file:///')) return value
  if (/^[A-Za-z]:[/\\]/.test(value)) return `local-file:///${value.replace(/\\/g, '/')}`
  return value
}

function artifactDisplayName(path: string): string {
  const value = decodeURIComponent(path.trim())
    .replace(/^local-file:\/\/\/?/i, '')
    .replace(/^file:\/\/\/?/i, '')
  return value.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
}

type DagNode = { step: TaskPlanStep; x: number; y: number; width: number; height: number }

function layoutDag(steps: TaskPlanStep[]): { nodes: DagNode[]; width: number; height: number } {
  const byId = new Map(steps.map(step => [step.id, step]))
  const levelCache = new Map<string, number>()
  const levelOf = (id: string, visiting = new Set<string>()): number => {
    if (levelCache.has(id)) return levelCache.get(id)!
    if (visiting.has(id)) return 0
    const nextVisiting = new Set(visiting).add(id)
    const dependencies = (byId.get(id)?.dependencies || []).filter(dependency => byId.has(dependency))
    const level = dependencies.length === 0 ? 0 : Math.max(...dependencies.map(dependency => levelOf(dependency, nextVisiting))) + 1
    levelCache.set(id, level)
    return level
  }
  const groups = new Map<number, TaskPlanStep[]>()
  for (const step of steps) {
    const level = levelOf(step.id)
    groups.set(level, [...(groups.get(level) || []), step])
  }
  const nodeWidth = 135
  const nodeHeight = 54
  const columnGap = 36
  const rowGap = 12
  const padding = 14
  const columnCount = Math.max(0, ...groups.keys()) + 1
  const maxRows = Math.max(1, ...Array.from(groups.values(), group => group.length))
  const height = padding * 2 + maxRows * nodeHeight + (maxRows - 1) * rowGap
  const nodes: DagNode[] = []
  for (const [level, group] of groups) {
    const groupHeight = group.length * nodeHeight + Math.max(0, group.length - 1) * rowGap
    group.forEach((step, row) => nodes.push({
      step,
      x: padding + level * (nodeWidth + columnGap),
      y: (height - groupHeight) / 2 + row * (nodeHeight + rowGap),
      width: nodeWidth,
      height: nodeHeight
    }))
  }
  return { nodes, width: padding * 2 + columnCount * nodeWidth + (columnCount - 1) * columnGap, height }
}

type ReadonlyTaskNode = Node<{ step: TaskPlanStep; highlighted: boolean }, 'readonlyTask'>

function ReadonlyTaskNodeView({ data }: NodeProps<ReadonlyTaskNode>): React.JSX.Element {
  const { step, highlighted } = data
  return <article className={`task-dag-node is-${step.status} ${highlighted ? 'is-selected' : ''}`} style={{ position: 'relative', width: 135, height: 54 }} title={step.detail || step.title}>
    <Handle type="target" position={Position.Left} isConnectable={false} style={{ visibility: 'hidden' }} />
    <span className="task-dag-node-top">
      <span className="task-dag-node-marker"><StepMarker status={step.status} /></span>
      <AgentBrandIcon agentId={step.agentId || 'agentpet'} className="task-dag-agent-icon" />
      <small>{step.agentId || step.agentRole || 'agentpet'}</small>
      {(step.retryCount || 0) > 0 && <em>retry {step.retryCount}</em>}
    </span>
    <strong>{step.title}</strong>
    <span className="task-dag-node-state" title={step.detail}>{step.status === 'in_progress' && step.detail ? step.detail : STATUS_LABEL[step.status]}</span>
    <Handle type="source" position={Position.Right} isConnectable={false} style={{ visibility: 'hidden' }} />
  </article>
}

const readonlyNodeTypes = { readonlyTask: ReadonlyTaskNodeView }

export function TaskDagGraph({ plan, onStepClick, selectedStepId, showHeader = false }: {
  plan: TaskPlan
  onStepClick?: (step: TaskPlanStep) => void
  selectedStepId?: string
  showHeader?: boolean
}): React.JSX.Element {
  const flowRef = React.useRef<ReactFlowInstance<ReadonlyTaskNode> | null>(null)
  const hasSelection = Boolean(selectedStepId)
  useEffect(() => {
    // The details panel changes the available width after selecting a node.
    let nextFrame = 0
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => {
        void flowRef.current?.fitView({ padding: 0.25, maxZoom: 1.5 })
      })
    })
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(nextFrame) }
  }, [hasSelection])
  const layout = useMemo(() => layoutDag(plan.steps), [plan.steps])
  const nodes = useMemo<ReadonlyTaskNode[]>(() => layout.nodes.map(node => ({
    id: node.step.id, type: 'readonlyTask', position: { x: node.x, y: node.y },
    data: { step: node.step, highlighted: selectedStepId === node.step.id },
    ariaLabel: `${node.step.title}，${STATUS_LABEL[node.step.status]}`
  })), [layout, selectedStepId])
  const edges = useMemo(() => {
    const ids = new Set(plan.steps.map(step => step.id))
    return plan.steps.flatMap(step => (step.dependencies || []).filter(id => ids.has(id)).map(id => ({
      id: JSON.stringify([id, step.id]), source: id, target: step.id,
      animated: step.status === 'in_progress',
      style: { stroke: step.status === 'completed' ? '#2aa178' : step.status === 'blocked' ? '#d97732' : '#8c91a0' },
      markerEnd: { type: MarkerType.ArrowClosed }
    })))
  }, [plan.steps])
  const running = plan.steps.filter(step => step.status === 'in_progress').length
  const completed = plan.steps.filter(step => step.status === 'completed').length
  return <section className={`task-dag task-dag-react-flow ${!showHeader ? 'is-bare' : ''}`} aria-label={`只读流程图：${plan.title}`}>
    {showHeader && <header className="task-dag-header">
      <span><Network size={14} aria-hidden="true" /><strong>Agent DAG</strong></span>
      <small>{running > 0 ? `${running} running` : `${completed}/${plan.steps.length} complete`}</small>
    </header>}
    <div className="task-dag-flow-viewport" tabIndex={0}
      aria-label="流程图画布，滚轮缩放，拖动空白处移动；Ctrl 或 Command 加减键缩放，0 适应画布"
      onPointerDown={event => { if (!(event.target as HTMLElement).closest('button, .react-flow__node')) event.currentTarget.focus({ preventScroll: true }) }}
      onKeyDownCapture={event => {
        if (!event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && ['Enter', ' '].includes(event.key) && onStepClick) {
          const id = (event.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id')
          const step = plan.steps.find(item => item.id === id)
          if (step) { event.preventDefault(); event.stopPropagation(); onStepClick(step); return }
        }
        if (event.nativeEvent.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return
        if (!['+', '=', '-', '0'].includes(event.key) || !flowRef.current) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === '0') void flowRef.current.fitView({ padding: 0.25, maxZoom: 1.5 })
        else if (event.key === '-') void flowRef.current.zoomOut()
        else void flowRef.current.zoomIn()
      }}>
      <div className="task-dag-flow-surface">
        <ReactFlow<ReadonlyTaskNode> nodes={nodes} edges={edges} nodeTypes={readonlyNodeTypes}
          onInit={instance => { flowRef.current = instance }}
          onNodeClick={(_, node) => onStepClick?.(node.data.step)}
          nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
          elementsSelectable={false} nodesFocusable={!!onStepClick} edgesFocusable={false}
          deleteKeyCode={null} selectionKeyCode={null} panOnDrag zoomOnScroll zoomOnPinch
          fitView fitViewOptions={{ padding: 0.25, maxZoom: 1.5 }} minZoom={0.25} maxZoom={3}>
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  </section>
}

export const TaskPlanCard = React.memo(function TaskPlanCard({ toolSteps, messageId }: { toolSteps: any[]; messageId?: string | number }) {
  const plan = useMemo(() => latestTaskPlan(toolSteps), [toolSteps])
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const [runtimePlan, setRuntimePlan] = useState<TaskPlan | null>(null)

  useEffect(() => {
    if (!plan) return undefined
    let active = true
    const accepts = (run: any): boolean => Boolean(
      run && ((plan.runId && run.id === plan.runId) || (messageId !== undefined && String(run.messageId) === String(messageId)))
    )
    const applySnapshot = (run: any, steps: any[]): void => {
      if (!active || !accepts(run) || !Array.isArray(steps)) return
      setRuntimePlan({ runId: run.id, title: run.title || plan.title, explanation: run.explanation || plan.explanation, steps: steps.map(toPlanStep) })
    }
    void window.api.listTaskRuns().then(runs => {
      const match = Array.isArray(runs) ? runs.find((item: any) => accepts(item?.run)) : null
      if (match) applySnapshot(match.run, match.steps)
    }).catch(() => undefined)
    const unsubscribe = window.api.onTaskRunUpdated((update: any) => applySnapshot(update?.run, update?.steps))
    return () => { active = false; unsubscribe() }
  }, [messageId, plan])

  if (!plan) return null

  const displayPlan = runtimePlan || plan

  const completed = displayPlan.steps.filter(step => step.status === 'completed').length
  const blocked = displayPlan.steps.some(step => step.status === 'blocked')
  const allCompleted = completed === displayPlan.steps.length
  const expanded = manualExpanded ?? !allCompleted
  const progress = Math.round((completed / displayPlan.steps.length) * 100)
  const stateLabel = blocked ? '需要处理' : allCompleted ? '已完成' : `${completed} / ${plan.steps.length}`

  return (
    <section className={`task-plan-card ${blocked ? 'is-blocked' : ''} ${allCompleted ? 'is-complete' : ''}`} aria-label={`任务计划：${plan.title}`}>
      <button
        type="button"
        className="task-plan-header"
        onClick={() => setManualExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="task-plan-symbol"><ListChecks size={16} strokeWidth={2.1} aria-hidden="true" /></span>
        <span className="task-plan-heading">
          <strong>{displayPlan.title}</strong>
          <span>{stateLabel}</span>
        </span>
        <span
          className="task-plan-progress"
          role="progressbar"
          aria-label="任务完成进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ transform: `scaleX(${progress / 100})` }} />
        </span>
        <ChevronDown className="task-plan-chevron" size={15} aria-hidden="true" data-expanded={expanded} />
      </button>

      {expanded && (
        <div className="task-plan-body">
          {displayPlan.explanation && <p className="task-plan-explanation">{displayPlan.explanation}</p>}
          <ol className="task-plan-steps">
            {displayPlan.steps.map((step, index) => (
              <li key={step.id} className={`task-plan-step is-${step.status}`}>
                <span className="task-plan-step-rail" aria-hidden="true">
                  <span className="task-plan-step-marker"><StepMarker status={step.status} /></span>
                </span>
                <span className="task-plan-step-copy">
                  <span className="task-plan-step-title">
                    <span>{index + 1}. {step.title}</span>
                    <small>{STATUS_LABEL[step.status]}</small>
                  </span>
                  {step.detail && <span className="task-plan-step-detail">{step.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
})

interface TaskPlanPanelProps {
  plan: TaskPlan
  messageId?: string | number
  running: boolean
  onClose: () => void
  onLocate: () => void
}

export const TaskPlanPanel = React.memo(function TaskPlanPanel({ plan, messageId, running, onClose, onLocate }: TaskPlanPanelProps) {
  const [isControlling, setIsControlling] = useState(false)
  const [runtimeRunId, setRuntimeRunId] = useState<string | undefined>(plan.runId)
  const [runtimeSteps, setRuntimeSteps] = useState<TaskPlanStep[] | null>(null)
  const [relatedRuns, setRelatedRuns] = useState<any[]>([])
  const steps = runtimeSteps || plan.steps
  const completed = steps.filter(step => step.status === 'completed').length
  const blocked = steps.some(step => step.status === 'blocked')
  const allCompleted = completed === steps.length
  const showDag = steps.some(step => step.agentId !== 'agentpet' || step.agentRole || (step.dependencies?.length || 0) > 0)
  const artifacts = useMemo(() => {
    const seen = new Set<string>()
    const result: Array<{ path: string; stepTitle: string }> = []
    for (const step of steps) {
      for (const path of step.artifactPaths || []) {
        const normalizedPath = path.trim()
        if (!normalizedPath || seen.has(normalizedPath)) continue
        seen.add(normalizedPath)
        result.push({ path: normalizedPath, stepTitle: step.title })
      }
    }
    return result
  }, [steps])
  const panelStatus = blocked ? '需要处理' : allCompleted ? '任务完成' : running ? '正在执行' : '已暂停更新'

  useEffect(() => {
    let active = true
    const matches = (run: any): boolean => Boolean(
      run && ((runtimeRunId && run.id === runtimeRunId) || (plan.runId && run.id === plan.runId) || (messageId !== undefined && String(run.messageId) === String(messageId)))
    )
    const applySnapshot = async (snapshot: any): Promise<void> => {
      if (!active || !snapshot?.run || !matches(snapshot.run)) return
      setRuntimeRunId(snapshot.run.id)
      if (Array.isArray(snapshot.steps)) setRuntimeSteps(snapshot.steps.map(toPlanStep))
      const runs = snapshot.run.sessionId ? await window.api.listTaskRuns(snapshot.run.sessionId) : []
      if (!active) return
      setRelatedRuns(Array.isArray(runs) ? runs : [])
    }
    const refresh = async (): Promise<void> => {
      const knownRunId = plan.runId || runtimeRunId
      if (knownRunId) {
        await applySnapshot(await window.api.getTaskRun(knownRunId))
        return
      }
      const runs = await window.api.listTaskRuns()
      const match = Array.isArray(runs) ? runs.find((item: any) => matches(item?.run)) : null
      if (match) await applySnapshot(match)
    }
    void refresh()
    const unsubscribe = window.api.onTaskRunUpdated((update: any) => {
      if (matches(update?.run)) void applySnapshot({ run: update.run, steps: update.steps })
    })
    return () => { active = false; unsubscribe() }
  }, [messageId, plan.runId, runtimeRunId])

  const control = async (action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
    if (!runtimeRunId || isControlling) return
    setIsControlling(true)
    try { await window.api.controlTaskRun(runtimeRunId, action) } finally { setIsControlling(false) }
  }

  const retry = async (stepId: string): Promise<void> => {
    if (!runtimeRunId || isControlling) return
    setIsControlling(true)
    try { await window.api.retryTaskStep(runtimeRunId, stepId) } finally { setIsControlling(false) }
  }

  return (
    <aside className={`task-plan-side-panel ${blocked ? 'is-blocked' : ''} ${allCompleted ? 'is-complete' : ''}`} aria-label={`任务执行面板：${plan.title}`}>
      <header className="task-plan-panel-header">
        <span className="task-plan-panel-icon"><ListChecks size={17} strokeWidth={2.1} /></span>
        <span className="task-plan-panel-title">
          <small>{panelStatus}</small>
          <strong title={plan.title}>{plan.title}</strong>
        </span>
        <button type="button" onClick={onLocate} title="定位到聊天中的计划"><LocateFixed size={15} /></button>
        <button type="button" onClick={onClose} title="关闭任务面板"><X size={16} /></button>
      </header>

      {runtimeRunId && !allCompleted && (
        <div className="task-plan-panel-controls" aria-label="Task controls">
          <button type="button" disabled={isControlling} onClick={() => control('pause')} title="Pause and save checkpoint"><Pause size={14} />暂停</button>
          <button type="button" disabled={isControlling} onClick={() => control('resume')} title="Request resume"><Play size={14} />继续</button>
          <button type="button" disabled={isControlling} onClick={() => control('cancel')} title="Stop task"><Square size={13} />停止</button>
        </div>
      )}

      <div className="task-plan-panel-scroll">
        {plan.explanation && <p className="task-plan-panel-explanation">{plan.explanation}</p>}
        {showDag && <TaskDagGraph plan={{ ...plan, runId: runtimeRunId, steps }} />}
        <ol className="task-plan-panel-steps">
          {steps.map((step, index) => (
            <li key={step.id} className={`is-${step.status}`}>
              <span className="task-plan-panel-index"><StepMarker status={step.status} /></span>
              <span className="task-plan-panel-step-copy">
                <span><b>{index + 1}. {step.title}</b><small>{STATUS_LABEL[step.status]}</small></span>
                {(step.agentId || step.agentRole || (step.dependencies?.length || 0) > 0 || (step.retryCount || 0) > 0) && (
                  <span className="task-plan-step-meta">
                    {step.agentId && <small>{step.agentId}</small>}
                    {!step.agentId && step.agentRole && <small>{step.agentRole}</small>}
                    {(step.dependencies?.length || 0) > 0 && <small>depends on {step.dependencies!.join(', ')}</small>}
                    {(step.retryCount || 0) > 0 && <small>retry {step.retryCount}</small>}
                  </span>
                )}
                {runtimeRunId && step.status === 'blocked' && <button className="task-plan-step-retry" type="button" disabled={isControlling} onClick={() => retry(step.id)}><RotateCcw size={11} />重试此步骤</button>}
              </span>
            </li>
          ))}
        </ol>
        {relatedRuns.length > 1 && (
          <section className="task-plan-related-runs">
            <h4>Task runs</h4>
            {relatedRuns.map(item => {
              const done = Array.isArray(item.steps) ? item.steps.filter((step: any) => step.status === 'completed').length : 0
              const total = Array.isArray(item.steps) ? item.steps.length : 0
              return (
                <div key={item.run.id} className={`is-${item.run.status}`}>
                  <span><b>{item.run.title}</b><small>{item.run.status}</small></span>
                  <small>{done} / {total}{item.run.id === runtimeRunId ? ' · current' : ''}</small>
                </div>
              )
            })}
          </section>
        )}
      </div>
      {artifacts.length > 0 && (
        <section className="task-plan-panel-artifacts" aria-label="产出文件">
          <header>
            <strong>产出文件</strong>
            <small>{artifacts.length}</small>
          </header>
          <ul>
            {artifacts.map(artifact => {
              const url = normalizeArtifactUrl(artifact.path)
              return (
                <li key={artifact.path}>
                  <a
                    href={url}
                    title={artifact.path}
                    onClick={(event) => {
                      event.preventDefault()
                      void window.api.openLocalFile(url)
                    }}
                  >
                    <FileText size={14} strokeWidth={1.9} aria-hidden="true" />
                    <span>{artifactDisplayName(artifact.path)}</span>
                    <small>{artifact.stepTitle}</small>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </aside>
  )
})

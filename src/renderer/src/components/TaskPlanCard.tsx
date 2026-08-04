import React, { useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Circle, ListChecks, LoaderCircle, LocateFixed, Pause, Play, RotateCcw, Square, X } from 'lucide-react'
import './TaskPlanCard.css'

export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface TaskPlanStep {
  id: string
  title: string
  status: TaskStepStatus
  detail?: string
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
    detail: String(step?.detail || '').trim() || undefined
  })).filter((step: TaskPlanStep) => step.title)
  if (!title || steps.length < 2) return null
  return {
    title,
    explanation: String(value.explanation || '').trim() || undefined,
    steps
  }
}

export function latestTaskPlan(toolSteps: any[]): TaskPlan | null {
  for (let index = toolSteps.length - 1; index >= 0; index -= 1) {
    const step = toolSteps[index]
    if (step?.type === 'call' && step?.name === 'update_task_plan') {
      const plan = normalizeTaskPlan(step.detail)
      if (!plan) return null
      const result = toolSteps.slice(index + 1).find((candidate: any) => candidate?.type === 'result' && candidate?.name === 'update_task_plan')
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

export const TaskPlanCard = React.memo(function TaskPlanCard({ toolSteps }: { toolSteps: any[] }) {
  const plan = useMemo(() => latestTaskPlan(toolSteps), [toolSteps])
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)

  if (!plan) return null

  const completed = plan.steps.filter(step => step.status === 'completed').length
  const blocked = plan.steps.some(step => step.status === 'blocked')
  const allCompleted = completed === plan.steps.length
  const expanded = manualExpanded ?? !allCompleted
  const progress = Math.round((completed / plan.steps.length) * 100)
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
          <strong>{plan.title}</strong>
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
          {plan.explanation && <p className="task-plan-explanation">{plan.explanation}</p>}
          <ol className="task-plan-steps">
            {plan.steps.map((step, index) => (
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
  running: boolean
  onClose: () => void
  onLocate: () => void
}

export const TaskPlanPanel = React.memo(function TaskPlanPanel({ plan, running, onClose, onLocate }: TaskPlanPanelProps) {
  const [isControlling, setIsControlling] = useState(false)
  const completed = plan.steps.filter(step => step.status === 'completed').length
  const blocked = plan.steps.some(step => step.status === 'blocked')
  const allCompleted = completed === plan.steps.length
  const progress = Math.round((completed / plan.steps.length) * 100)
  const currentStep = plan.steps.find(step => step.status === 'in_progress')
  const panelStatus = blocked ? '需要处理' : allCompleted ? '任务完成' : running ? '正在执行' : '已暂停更新'

  const control = async (action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
    if (!plan.runId || isControlling) return
    setIsControlling(true)
    try { await window.api.controlTaskRun(plan.runId, action) } finally { setIsControlling(false) }
  }

  const retry = async (stepId: string): Promise<void> => {
    if (!plan.runId || isControlling) return
    setIsControlling(true)
    try { await window.api.retryTaskStep(plan.runId, stepId) } finally { setIsControlling(false) }
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

      <div className="task-plan-panel-progress-wrap">
        <span><strong>{completed}</strong> / {plan.steps.length}</span>
        <span className="task-plan-panel-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span style={{ transform: `scaleX(${progress / 100})` }} />
        </span>
        <small>{progress}%</small>
      </div>

      {plan.runId && !allCompleted && (
        <div className="task-plan-panel-controls" aria-label="Task controls">
          <button type="button" disabled={isControlling} onClick={() => control('pause')} title="Pause and save checkpoint"><Pause size={14} />暂停</button>
          <button type="button" disabled={isControlling} onClick={() => control('resume')} title="Request resume"><Play size={14} />继续</button>
          <button type="button" disabled={isControlling} onClick={() => control('cancel')} title="Stop task"><Square size={13} />停止</button>
        </div>
      )}

      {currentStep && (
        <div className="task-plan-panel-now">
          <span><LoaderCircle size={13} />当前步骤</span>
          <strong>{currentStep.title}</strong>
          {currentStep.detail && <p>{currentStep.detail}</p>}
        </div>
      )}

      <div className="task-plan-panel-scroll">
        {plan.explanation && <p className="task-plan-panel-explanation">{plan.explanation}</p>}
        <ol className="task-plan-panel-steps">
          {plan.steps.map((step, index) => (
            <li key={step.id} className={`is-${step.status}`}>
              <span className="task-plan-panel-index"><StepMarker status={step.status} /></span>
              <span className="task-plan-panel-step-copy">
                <span><b>{index + 1}. {step.title}</b><small>{STATUS_LABEL[step.status]}</small></span>
                {step.detail && <p>{step.detail}</p>}
                {plan.runId && step.status === 'blocked' && <button className="task-plan-step-retry" type="button" disabled={isControlling} onClick={() => retry(step.id)}><RotateCcw size={11} />重试此步骤</button>}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  )
})

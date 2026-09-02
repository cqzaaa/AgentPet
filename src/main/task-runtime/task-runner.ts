import type {
  TaskPlanInput,
  TaskRun,
  TaskRunStatus,
  TaskStep,
  TaskStepExecutionResult,
  TaskStepExecutor
} from './types'
import { TaskStore } from './task-store'
import { buildTaskStepPrompt } from './prompt-builder'
import { getReadyPendingSteps, validateTaskDependencies } from './task-scheduler'

export type TaskControlAction = 'pause' | 'resume' | 'cancel'
export type TaskRunUpdate = {
  taskRunId: string
  run: TaskRun
  steps: TaskStep[]
  action: string
  taskStepId?: string
  payload?: Record<string, unknown>
}

type ActiveExecution = {
  controller: AbortController
  promise: Promise<TaskRun | null>
}

/** Owns durable state, dependency scheduling, cancellation and resumable step execution. */
export class TaskRunner {
  private executor?: TaskStepExecutor
  private readonly active = new Map<string, ActiveExecution>()
  private readonly listeners = new Set<(update: TaskRunUpdate) => void>()

  public constructor(private readonly store = new TaskStore()) {}

  public setExecutor(executor: TaskStepExecutor): void {
    this.executor = executor
  }

  public subscribe(listener: (update: TaskRunUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public async updatePlan(sessionId: string | undefined, messageId: number | string | undefined, plan: TaskPlanInput): Promise<TaskRun> {
    const status = this.deriveStatus(plan)
    const run = await this.store.upsertPlan(sessionId || 'default', messageId === undefined ? undefined : String(messageId), plan, status)
    await this.publish(run.id, 'plan_updated')
    return run
  }

  public checkpointActiveRuns(): Promise<void> {
    return this.store.checkpointActiveRuns()
  }

  public recoverInterruptedRuns(): Promise<number> {
    return this.store.recoverInterruptedRuns()
  }

  public async control(taskRunId: string, action: TaskControlAction): Promise<TaskRun | null> {
    if (action === 'pause' || action === 'cancel') this.active.get(taskRunId)?.controller.abort()
    const status: Record<TaskControlAction, TaskRunStatus> = { pause: 'paused', resume: 'pending', cancel: 'cancelled' }
    const run = await this.store.setRunStatus(taskRunId, status[action], `user_${action}`)
    if (run) await this.publish(taskRunId, action)
    if (action === 'resume' && run) this.executeInBackground(taskRunId)
    return run
  }

  public async retryStep(taskRunId: string, taskStepId: string) {
    const result = await this.store.retryStep(taskRunId, taskStepId)
    if (result) {
      await this.publish(taskRunId, 'retry_step', taskStepId)
      this.executeInBackground(taskRunId)
    }
    return result
  }

  public getRun(taskRunId: string) {
    return this.store.getRun(taskRunId)
  }

  public listRuns(sessionId?: string) {
    return this.store.listRuns(sessionId)
  }

  public listSubagentTasks(taskRunId: string) {
    return this.store.listSubagentTasks(taskRunId)
  }

  public async getRunForMessage(sessionId: string | undefined, messageId: number | string | undefined) {
    if (messageId === undefined) return null
    const runs = await this.store.listRuns(sessionId || 'default')
    return runs.find(item => String(item.run.messageId || '') === String(messageId)) || null
  }

  public async updateStep(
    taskRunId: string,
    taskStepId: string,
    status: 'in_progress' | 'completed' | 'blocked',
    update: { detail?: string; resultSummary?: string; artifactPaths?: string[] } = {}
  ) {
    const snapshot = await this.store.getRun(taskRunId)
    if (!snapshot) throw new Error('Task plan was not found.')
    if (['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) {
      throw new Error(`Task plan is already ${snapshot.run.status}.`)
    }
    const target = snapshot.steps.find(step => step.id === taskStepId)
    if (!target) throw new Error(`Unknown task step: ${taskStepId}`)
    if (status === 'in_progress') {
      const otherRunning = snapshot.steps.find(step => step.status === 'running' && step.id !== taskStepId)
      if (otherRunning) throw new Error(`Complete or block ${otherRunning.id} before starting ${taskStepId}.`)
      const incompleteDependencies = (target.dependencies || []).filter(id =>
        snapshot.steps.find(step => step.id === id)?.status !== 'completed'
      )
      if (incompleteDependencies.length > 0) {
        throw new Error(`${taskStepId} is waiting for: ${incompleteDependencies.join(', ')}`)
      }
    }

    await this.store.setStepStatus(taskRunId, taskStepId, status === 'in_progress' ? 'running' : status, update)
    let current = await this.store.getRun(taskRunId)
    if (!current) return null

    if (status === 'completed' && !current.steps.some(step => step.status === 'running')) {
      const next = getReadyPendingSteps(current.steps)[0]
      if (next) {
        await this.store.setStepStatus(taskRunId, next.id, 'running', { detail: 'Ready for the next action.' })
        current = await this.store.getRun(taskRunId)
        if (!current) return null
      }
    }

    const nextRunStatus: TaskRunStatus = current.steps.some(step => step.status === 'blocked' || step.status === 'failed')
      ? 'blocked'
      : current.steps.every(step => step.status === 'completed')
        ? 'completed'
        : current.steps.some(step => step.status === 'running')
          ? 'running'
          : 'pending'
    await this.store.setRunStatus(taskRunId, nextRunStatus, `step_${status}`)
    await this.publish(taskRunId, `step_${status}`, taskStepId)
    return this.store.getRun(taskRunId)
  }

  public async finalizePlanForMessage(sessionId: string | undefined, messageId: number | string | undefined) {
    const snapshot = await this.getRunForMessage(sessionId, messageId)
    if (!snapshot || ['completed', 'failed', 'blocked', 'cancelled'].includes(snapshot.run.status)) return snapshot
    if (snapshot.steps.some(step => ['failed', 'blocked', 'cancelled'].includes(step.status))) return snapshot
    for (const step of snapshot.steps) {
      if (step.status !== 'completed') {
        await this.store.setStepStatus(snapshot.run.id, step.id, 'completed', {
          detail: step.detail || 'Completed when the agent finished successfully.'
        })
      }
    }
    await this.store.setRunStatus(snapshot.run.id, 'completed', 'agent_finished_successfully')
    await this.publish(snapshot.run.id, 'completed')
    return this.store.getRun(snapshot.run.id)
  }

  public notify(taskRunId: string, action: string, taskStepId?: string, payload?: Record<string, unknown>): Promise<void> {
    return this.publish(taskRunId, action, taskStepId, payload)
  }

  public executeRun(taskRunId: string, options: { maxConcurrency?: number } = {}): Promise<TaskRun | null> {
    const current = this.active.get(taskRunId)
    if (current) return current.promise
    if (!this.executor) return Promise.reject(new Error('TaskRunner executor has not been configured'))

    const controller = new AbortController()
    const promise = this.executeLoop(taskRunId, controller.signal, Math.max(1, Math.min(8, options.maxConcurrency || 1)))
      .finally(() => {
        if (this.active.get(taskRunId)?.controller === controller) this.active.delete(taskRunId)
      })
    this.active.set(taskRunId, { controller, promise })
    return promise
  }

  private async executeLoop(taskRunId: string, signal: AbortSignal, maxConcurrency: number): Promise<TaskRun | null> {
    await this.store.setRunStatus(taskRunId, 'running', 'execution_started')
    await this.publish(taskRunId, 'execution_started')

    while (!signal.aborted) {
      const snapshot = await this.store.getRun(taskRunId)
      if (!snapshot) return null
      if (snapshot.run.status === 'paused' || snapshot.run.status === 'cancelled') return snapshot.run

      const pending = snapshot.steps.filter(step => step.status === 'pending')
      if (pending.length === 0) {
        const failed = snapshot.steps.some(step => step.status === 'failed' || step.status === 'blocked')
        const run = await this.store.setRunStatus(taskRunId, failed ? 'blocked' : 'completed', failed ? 'step_failed' : 'all_steps_completed')
        if (run) await this.publish(taskRunId, failed ? 'blocked' : 'completed')
        return run
      }

      const dependencyErrors = validateTaskDependencies(snapshot.steps)
      const ready = dependencyErrors.length === 0 ? getReadyPendingSteps(snapshot.steps) : []
      if (ready.length === 0) {
        for (const step of pending) {
          await this.store.setStepStatus(taskRunId, step.id, 'blocked', {
            detail: dependencyErrors.length ? dependencyErrors.join('; ') : 'Dependencies cannot be satisfied.'
          })
        }
        const run = await this.store.setRunStatus(taskRunId, 'blocked', 'dependency_deadlock')
        if (run) await this.publish(taskRunId, 'dependency_deadlock')
        return run
      }

      const batch = ready.slice(0, maxConcurrency)
      await Promise.all(batch.map(step => this.executeStep(snapshot.run, step, snapshot.steps, signal)))
    }

    return (await this.store.getRun(taskRunId))?.run || null
  }

  private async executeStep(run: TaskRun, step: TaskStep, allSteps: TaskStep[], signal: AbortSignal): Promise<void> {
    if (!this.executor || signal.aborted) return
    await this.store.setStepStatus(run.id, step.id, 'running', { detail: 'Agent is working on this step.' })
    await this.publish(run.id, 'step_running', step.id)
    try {
      const completedSteps = allSteps.filter(candidate => candidate.status === 'completed')
      const result: TaskStepExecutionResult = await this.executor({
        run,
        step,
        completedSteps,
        prompt: buildTaskStepPrompt(run, step, completedSteps),
        signal,
        reportProgress: async (detail: string) => {
          await this.store.setStepStatus(run.id, step.id, 'running', { detail })
          await this.publish(run.id, 'step_progress', step.id)
        }
      })
      if (signal.aborted) throw new Error('TaskExecutionAborted')
      await this.store.setStepStatus(run.id, step.id, 'completed', {
        detail: result.resultSummary,
        resultSummary: result.resultSummary,
        artifactPaths: result.artifactPaths || []
      })
      await this.publish(run.id, 'step_completed', step.id)
    } catch (error) {
      const latest = await this.store.getRun(run.id)
      if (signal.aborted || latest?.run.status === 'paused' || latest?.run.status === 'cancelled') {
        const nextStatus = latest?.run.status === 'cancelled' ? 'cancelled' : 'pending'
        await this.store.setStepStatus(run.id, step.id, nextStatus, { detail: nextStatus === 'pending' ? 'Paused at checkpoint; ready to resume.' : 'Cancelled.' })
        await this.publish(run.id, nextStatus, step.id)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const retryCount = step.retryCount || 0
      if (retryCount < 2) {
        await this.store.setStepStatus(run.id, step.id, 'pending', {
          detail: `Attempt ${retryCount + 1} failed: ${message}. Retrying from checkpoint.`,
          incrementRetry: true
        })
        await this.publish(run.id, 'step_retrying', step.id)
      } else {
        await this.store.setStepStatus(run.id, step.id, 'failed', { detail: message, resultSummary: message })
        await this.publish(run.id, 'step_failed', step.id)
      }
    }
  }

  private async publish(taskRunId: string, action: string, taskStepId?: string, payload?: Record<string, unknown>): Promise<void> {
    const snapshot = await this.store.getRun(taskRunId)
    if (!snapshot) return
    const update = { taskRunId, run: snapshot.run, steps: snapshot.steps, action, taskStepId, payload }
    for (const listener of this.listeners) {
      try { listener(update) } catch (error) { console.error('[TaskRunner] update listener failed', error) }
    }
  }

  private executeInBackground(taskRunId: string): void {
    void this.executeRun(taskRunId).catch(error => console.error(`[TaskRunner] background execution failed for ${taskRunId}`, error))
  }

  private deriveStatus(plan: TaskPlanInput): TaskRunStatus {
    if (plan.steps.some(step => step.status === 'blocked')) return 'blocked'
    if (plan.steps.length > 0 && plan.steps.every(step => step.status === 'completed')) return 'completed'
    if (plan.steps.some(step => step.status === 'in_progress')) return 'running'
    return 'pending'
  }
}

export const taskRunner = new TaskRunner()

import type { TaskPlanInput, TaskRun, TaskRunStatus } from './types'
import { TaskStore } from './task-store'

export type TaskControlAction = 'pause' | 'resume' | 'cancel'

/** Coordinates durable task state. The active model stream is interrupted by the IPC owner. */
export class TaskRunner {
  public constructor(private readonly store = new TaskStore()) {}

  public async updatePlan(sessionId: string | undefined, messageId: number | undefined, plan: TaskPlanInput): Promise<TaskRun> {
    const status = this.deriveStatus(plan)
    return this.store.upsertPlan(sessionId || 'default', messageId === undefined ? undefined : String(messageId), plan, status)
  }

  public checkpointActiveRuns(): Promise<void> {
    return this.store.checkpointActiveRuns()
  }

  public recoverInterruptedRuns(): Promise<number> {
    return this.store.recoverInterruptedRuns()
  }

  public async control(taskRunId: string, action: TaskControlAction): Promise<TaskRun | null> {
    const status: Record<TaskControlAction, TaskRunStatus> = { pause: 'paused', resume: 'running', cancel: 'cancelled' }
    return this.store.setRunStatus(taskRunId, status[action], `user_${action}`)
  }

  public retryStep(taskRunId: string, taskStepId: string) {
    return this.store.retryStep(taskRunId, taskStepId)
  }

  public getRun(taskRunId: string) {
    return this.store.getRun(taskRunId)
  }

  private deriveStatus(plan: TaskPlanInput): TaskRunStatus {
    if (plan.steps.some(step => step.status === 'blocked')) return 'blocked'
    if (plan.steps.length > 0 && plan.steps.every(step => step.status === 'completed')) return 'completed'
    if (plan.steps.some(step => step.status === 'in_progress')) return 'running'
    return 'pending'
  }
}

export const taskRunner = new TaskRunner()

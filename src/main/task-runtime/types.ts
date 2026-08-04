export const TASK_RUN_STATUSES = ['pending', 'running', 'paused', 'completed', 'failed', 'blocked', 'cancelled'] as const
export type TaskRunStatus = typeof TASK_RUN_STATUSES[number]

export const TASK_STEP_STATUSES = ['pending', 'running', 'paused', 'completed', 'failed', 'blocked', 'cancelled'] as const
export type TaskStepStatus = typeof TASK_STEP_STATUSES[number]

export interface TaskPlanInputStep {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  detail?: string
  goal?: string
  dependencies?: string[]
  acceptanceCriteria?: string
  resultSummary?: string
  artifactPaths?: string[]
  retryCount?: number
}

export interface TaskPlanInput {
  title: string
  explanation?: string
  steps: TaskPlanInputStep[]
}

export interface TaskRun {
  id: string
  sessionId: string
  messageId?: string
  title: string
  status: TaskRunStatus
  explanation?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface TaskStep extends Omit<TaskPlanInputStep, 'status'> {
  taskRunId: string
  sequence: number
  status: TaskStepStatus
  startedAt?: number
  completedAt?: number
}

export interface TaskEvent {
  id: string
  taskRunId: string
  taskStepId?: string
  type: string
  payload?: Record<string, unknown>
  createdAt: number
}

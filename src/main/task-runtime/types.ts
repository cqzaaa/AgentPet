export const TASK_RUN_STATUSES = ['pending', 'running', 'paused', 'completed', 'failed', 'blocked', 'cancelled'] as const
export type TaskRunStatus = typeof TASK_RUN_STATUSES[number]

export const TASK_STEP_STATUSES = ['pending', 'running', 'paused', 'completed', 'failed', 'blocked', 'cancelled'] as const
export type TaskStepStatus = typeof TASK_STEP_STATUSES[number]

export const SUBAGENT_ROLES = ['general', 'researcher', 'coder', 'reviewer'] as const
export type SubagentRole = typeof SUBAGENT_ROLES[number]

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
  agentRole?: SubagentRole
  prompt?: string
}

export interface TaskPlanInput {
  title: string
  explanation?: string
  workspacePath?: string
  steps: TaskPlanInputStep[]
}

export interface TaskRun {
  id: string
  sessionId: string
  messageId?: string
  title: string
  status: TaskRunStatus
  explanation?: string
  workspacePath?: string
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

export interface TaskStepExecutionResult {
  resultSummary: string
  artifactPaths?: string[]
}

export interface TaskStepExecutionRequest {
  run: TaskRun
  step: TaskStep
  completedSteps: TaskStep[]
  prompt: string
  signal: AbortSignal
  reportProgress: (detail: string) => Promise<void>
}

export type TaskStepExecutor = (request: TaskStepExecutionRequest) => Promise<TaskStepExecutionResult>

export interface SubagentTask {
  id: string
  taskRunId: string
  taskStepId: string
  parentSessionId: string
  role: SubagentRole
  title: string
  prompt: string
  status: TaskStepStatus
  dependencies: string[]
  resultSummary?: string
  artifactPaths: string[]
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface DelegateTaskInput {
  id: string
  title: string
  prompt: string
  role?: SubagentRole
  dependencies?: string[]
  acceptanceCriteria?: string
}

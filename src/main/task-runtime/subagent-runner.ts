import { randomUUID } from 'crypto'
import { TaskStore } from './task-store'
import { taskRunner, type TaskRunner } from './task-runner'
import { SUBAGENT_ROLES, type DelegateTaskInput, type SubagentRole, type SubagentTask } from './types'

export class SubagentRunner {
  public constructor(
    private readonly runner: TaskRunner = taskRunner,
    private readonly store = new TaskStore()
  ) {}

  public async delegate(
    parentSessionId: string,
    parentMessageId: string | number | undefined,
    parentTurn: number | undefined,
    parentToolCallId: string | undefined,
    title: string,
    inputs: DelegateTaskInput[],
    maxConcurrency = 3,
    workspacePath?: string,
    signal?: AbortSignal
  ): Promise<{ taskRunId: string; status: string; tasks: SubagentTask[] }> {
    const normalized = this.normalizeInputs(inputs)
    this.validateDependencies(normalized)
    const taskRun = await this.runner.updatePlan(parentSessionId, `delegate-${parentMessageId ?? 'background'}-${randomUUID()}`, {
      title,
      explanation: `Delegated to ${normalized.length} sub-agent task${normalized.length === 1 ? '' : 's'}.`,
      workspacePath: workspacePath || undefined,
      parentTurn,
      parentMessageId: parentMessageId === undefined ? undefined : String(parentMessageId),
      parentToolCallId,
      steps: normalized.map(input => ({
        id: input.id,
        title: input.title,
        status: 'pending',
        goal: input.prompt,
        prompt: input.prompt,
        agentRole: input.role,
        dependencies: input.dependencies,
        acceptanceCriteria: input.acceptanceCriteria
      }))
    })
    const now = Date.now()
    const records: SubagentTask[] = normalized.map(input => ({
      id: randomUUID(),
      taskRunId: taskRun.id,
      taskStepId: input.id,
      parentSessionId,
      role: input.role || 'general',
      title: input.title,
      prompt: input.prompt,
      status: 'pending',
      dependencies: input.dependencies || [],
      artifactPaths: [],
      createdAt: now,
      updatedAt: now
    }))
    await this.store.upsertSubagentTasks(records)
    const cancel = (): void => { void this.runner.control(taskRun.id, 'cancel') }
    signal?.addEventListener('abort', cancel, { once: true })
    const run = await this.runner.executeRun(taskRun.id, { maxConcurrency }).finally(() => {
      signal?.removeEventListener('abort', cancel)
    })
    const snapshot = await this.runner.getRun(taskRun.id)
    if (snapshot) {
      const byStepId = new Map(snapshot.steps.map(step => [step.id, step]))
      const completedAt = Date.now()
      for (const record of records) {
        const step = byStepId.get(record.taskStepId)
        if (!step) continue
        record.status = step.status
        record.resultSummary = step.resultSummary
        record.artifactPaths = step.artifactPaths || []
        record.updatedAt = completedAt
        record.completedAt = step.completedAt
      }
      await this.store.upsertSubagentTasks(records)
      await this.runner.notify(taskRun.id, 'subagents_updated')
    }
    return { taskRunId: taskRun.id, status: run?.status || 'failed', tasks: records }
  }

  private normalizeInputs(inputs: DelegateTaskInput[]): DelegateTaskInput[] {
    const allowedRoles = new Set<string>(SUBAGENT_ROLES)
    const seen = new Set<string>()
    return inputs.slice(0, 12).map((input, index) => {
      let id = String(input.id || `agent-${index + 1}`).trim().slice(0, 64) || `agent-${index + 1}`
      if (seen.has(id)) id = `${id}-${index + 1}`
      seen.add(id)
      return {
        id,
        title: String(input.title || '').trim().slice(0, 180),
        prompt: String(input.prompt || '').trim().slice(0, 8000),
        role: (allowedRoles.has(String(input.role)) ? input.role : 'general') as SubagentRole,
        dependencies: Array.isArray(input.dependencies) ? [...new Set(input.dependencies.map(String))].filter(Boolean) : [],
        acceptanceCriteria: String(input.acceptanceCriteria || '').trim().slice(0, 1000) || undefined
      }
    }).filter(input => input.title && input.prompt)
  }

  private validateDependencies(inputs: DelegateTaskInput[]): void {
    if (inputs.length === 0) throw new Error('delegate_tasks requires at least one valid task')
    const ids = new Set(inputs.map(input => input.id))
    for (const input of inputs) {
      for (const dependency of input.dependencies || []) {
        if (!ids.has(dependency)) throw new Error(`Unknown dependency "${dependency}" for task "${input.id}"`)
        if (dependency === input.id) throw new Error(`Task "${input.id}" cannot depend on itself`)
      }
    }
  }
}

export const subagentRunner = new SubagentRunner()

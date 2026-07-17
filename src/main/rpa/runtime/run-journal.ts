import { randomUUID } from 'crypto'
import type { JsonValue, RpaNode, RpaRunStatus } from '../domain/types'
import { getRpaRunRepository } from '../persistence/repository-manager'
import type { RpaRunRepository } from '../persistence/run-repository'
import { legacyNodeToAction, summarizeRpaValue } from './legacy-node-action'

const TERMINAL_STATUSES = new Set<RpaRunStatus>(['success', 'failed', 'cancelled'])

export class RpaRunJournal {
  public readonly runId = randomUUID()

  private readonly repository: RpaRunRepository
  private queue: Promise<void> = Promise.resolve()
  private status: RpaRunStatus = 'pending'
  private disabled = false

  public constructor(
    private readonly workflowId: string,
    private readonly nodeCount: number,
    repository: RpaRunRepository = getRpaRunRepository()
  ) {
    this.repository = repository
  }

  public start(): void {
    if (this.status !== 'pending') return
    this.status = 'running'
    const startedAt = Date.now()
    this.enqueue(async () => {
      await this.repository.createRun({
        id: this.runId,
        workflowId: this.workflowId,
        status: 'pending',
        inputs: {},
        createdAt: startedAt
      })
      await this.repository.appendEvent({
        runId: this.runId,
        type: 'run.created',
        payload: { workflowId: this.workflowId, nodeCount: this.nodeCount },
        createdAt: startedAt
      })
      await this.repository.updateRunStatus({
        runId: this.runId,
        status: 'running',
        startedAt
      })
      await this.repository.appendEvent({
        runId: this.runId,
        type: 'run.started',
        createdAt: startedAt
      })
    })
  }

  public recordStep(
    node: RpaNode | undefined,
    state: 'idle' | 'running' | 'paused' | 'success' | 'failed',
    data?: unknown
  ): void {
    if (!node || this.status === 'pending' || TERMINAL_STATUSES.has(this.status)) return
    const action = legacyNodeToAction(node)

    if (state === 'running') {
      this.appendEvent('action.started', action)
    } else if (state === 'success') {
      this.appendEvent('action.completed', action, { result: summarizeRpaValue(data) })
    } else if (state === 'failed') {
      this.appendEvent('action.failed', action, {
        error: this.truncateError(data)
      })
    } else if (state === 'paused') {
      this.pause(node)
    }
  }

  public pause(node?: RpaNode): void {
    if (this.status !== 'running') return
    this.status = 'paused'
    const createdAt = Date.now()
    const action = node ? legacyNodeToAction(node) : undefined
    this.enqueue(async () => {
      await this.repository.updateRunStatus({ runId: this.runId, status: 'paused' })
      await this.repository.appendEvent({
        runId: this.runId,
        type: 'run.paused',
        action,
        createdAt
      })
      if (action?.kind === 'system.approval') {
        await this.repository.appendEvent({
          runId: this.runId,
          type: 'approval.requested',
          action,
          createdAt
        })
      }
    })
  }

  public resume(node?: RpaNode): void {
    if (this.status !== 'paused') return
    this.status = 'running'
    const createdAt = Date.now()
    const action = node ? legacyNodeToAction(node) : undefined
    this.enqueue(async () => {
      if (action?.kind === 'system.approval') {
        await this.repository.appendEvent({
          runId: this.runId,
          type: 'approval.resolved',
          action,
          createdAt
        })
      }
      await this.repository.updateRunStatus({ runId: this.runId, status: 'running' })
      await this.repository.appendEvent({
        runId: this.runId,
        type: 'run.resumed',
        action,
        createdAt
      })
    })
  }

  public complete(contextKeys: string[]): void {
    if (TERMINAL_STATUSES.has(this.status)) return
    this.status = 'success'
    const finishedAt = Date.now()
    this.enqueue(async () => {
      await this.repository.updateRunStatus({
        runId: this.runId,
        status: 'success',
        output: { contextKeys },
        finishedAt
      })
      await this.repository.appendEvent({
        runId: this.runId,
        type: 'run.completed',
        payload: { contextKeys },
        createdAt: finishedAt
      })
    })
  }

  public fail(error: unknown): void {
    if (TERMINAL_STATUSES.has(this.status)) return
    this.status = 'failed'
    const finishedAt = Date.now()
    const errorPayload = { message: this.truncateError(error) }
    this.enqueue(async () => {
      await this.repository.updateRunStatus({
        runId: this.runId,
        status: 'failed',
        error: errorPayload,
        finishedAt
      })
      await this.repository.appendEvent({
        runId: this.runId,
        type: 'run.failed',
        payload: errorPayload,
        createdAt: finishedAt
      })
    })
  }

  public cancel(): void {
    if (TERMINAL_STATUSES.has(this.status)) return
    this.status = 'cancelled'
    const finishedAt = Date.now()
    this.enqueue(async () => {
      await this.repository.updateRunStatus({
        runId: this.runId,
        status: 'cancelled',
        finishedAt
      })
      await this.repository.appendEvent({
        runId: this.runId,
        type: 'run.cancelled',
        createdAt: finishedAt
      })
    })
  }

  public async flush(): Promise<void> {
    await this.queue
  }

  public getStatus(): RpaRunStatus {
    return this.status
  }

  private appendEvent(
    type: 'action.started' | 'action.completed' | 'action.failed',
    action: ReturnType<typeof legacyNodeToAction>,
    payload?: JsonValue
  ): void {
    this.enqueue(async () => {
      await this.repository.appendEvent({ runId: this.runId, type, action, payload })
    })
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.disabled) return
      try {
        await operation()
      } catch (error) {
        this.disabled = true
        console.warn('[RPA Journal] Run history disabled after persistence failure:', error)
      }
    })
  }

  private truncateError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
    return message.slice(0, 2000)
  }
}

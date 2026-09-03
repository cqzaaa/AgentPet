import sqlite3 from 'sqlite3'
import { open, type Database } from 'sqlite'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getActiveStorageDir } from '../tools/utils/paths'
import type { SubagentTask, TaskEvent, TaskPlanInput, TaskRun, TaskRunStatus, TaskStep, TaskStepStatus } from './types'
import { TransactionQueue } from './transaction-queue'

type TaskRow = Record<string, any>

function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

export class TaskStore {
  private database: Database | null = null
  private filename = ''
  private readonly transactions = new TransactionQueue()

  public async upsertPlan(sessionId: string, messageId: string | undefined, plan: TaskPlanInput, status: TaskRunStatus): Promise<TaskRun> {
    const database = await this.getDatabase()
    const now = Date.now()
    const existing = await database.get<TaskRow>(
      'SELECT * FROM task_runs WHERE session_id = ? AND COALESCE(message_id, \'\') = ? ORDER BY updated_at DESC LIMIT 1',
      sessionId,
      messageId || ''
    )
    const id = existing?.id || randomUUID()
    const completedAt = ['completed', 'failed', 'blocked', 'cancelled'].includes(status) ? now : null

    await this.withTransaction(database, async () => {
      if (existing) {
        await database.run(
          'UPDATE task_runs SET title = ?, status = ?, explanation = ?, workspace_path = COALESCE(?, workspace_path), parent_turn = COALESCE(?, parent_turn), parent_message_id = COALESCE(?, parent_message_id), parent_tool_call_id = COALESCE(?, parent_tool_call_id), updated_at = ?, completed_at = ? WHERE id = ?',
          plan.title, status, plan.explanation || null, plan.workspacePath || null, plan.parentTurn ?? null, plan.parentMessageId || null, plan.parentToolCallId || null, now, completedAt, id
        )
      } else {
        await database.run(
          'INSERT INTO task_runs (id, session_id, message_id, parent_turn, parent_message_id, parent_tool_call_id, title, status, explanation, workspace_path, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, sessionId, messageId || null, plan.parentTurn ?? null, plan.parentMessageId || null, plan.parentToolCallId || null, plan.title, status, plan.explanation || null, plan.workspacePath || null, now, now, completedAt
        )
      }

      for (const [index, item] of plan.steps.entries()) {
        const stepStatus = this.toStepStatus(item.status)
        const previous = await database.get<TaskRow>('SELECT * FROM task_steps WHERE task_run_id = ? AND id = ?', id, item.id)
        const startedAt = stepStatus === 'running' ? previous?.started_at || now : previous?.started_at || null
        const stepCompletedAt = ['completed', 'failed', 'blocked', 'cancelled'].includes(stepStatus) ? previous?.completed_at || now : null
        await database.run(
          `INSERT INTO task_steps (id, task_run_id, sequence, title, goal, dependencies_json, acceptance_criteria, status, detail, result_summary, artifact_paths_json, retry_count, agent_role, agent_id, model, prompt, started_at, completed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_run_id, id) DO UPDATE SET
             sequence = excluded.sequence, title = excluded.title, goal = excluded.goal, dependencies_json = excluded.dependencies_json,
             acceptance_criteria = excluded.acceptance_criteria, status = excluded.status, detail = excluded.detail,
             result_summary = excluded.result_summary, artifact_paths_json = excluded.artifact_paths_json,
             retry_count = excluded.retry_count, agent_role = excluded.agent_role, agent_id = excluded.agent_id, model = excluded.model, prompt = excluded.prompt,
             started_at = excluded.started_at, completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
          item.id, id, index + 1, item.title, item.goal || null, toJson(item.dependencies || []), item.acceptanceCriteria || null,
          stepStatus, item.detail || null, item.resultSummary || item.detail || null, toJson(item.artifactPaths || []), item.retryCount || previous?.retry_count || 0,
          item.agentRole || null, item.agentId || 'agentpet', item.model || null, item.prompt || null, startedAt, stepCompletedAt, now
        )
        for (const artifactPath of item.artifactPaths || []) {
          await database.run(
            'INSERT OR IGNORE INTO task_artifacts (id, task_run_id, task_step_id, path, created_at) VALUES (?, ?, ?, ?, ?)',
            randomUUID(), id, item.id, artifactPath, now
          )
        }
      }
      await this.insertEvent(database, id, undefined, existing ? 'plan_updated' : 'plan_created', { status, stepCount: plan.steps.length }, now)
      await this.saveCheckpoint(database, id, { status, plan }, now)
    })
    return { id, sessionId, messageId, parentTurn: plan.parentTurn ?? existing?.parent_turn ?? undefined, parentMessageId: plan.parentMessageId || existing?.parent_message_id || undefined, parentToolCallId: plan.parentToolCallId || existing?.parent_tool_call_id || undefined, title: plan.title, status, explanation: plan.explanation, workspacePath: plan.workspacePath || existing?.workspace_path || undefined, createdAt: existing?.created_at || now, updatedAt: now, completedAt: completedAt || undefined }
  }

  public async checkpointActiveRuns(): Promise<void> {
    const database = await this.getDatabase()
    const now = Date.now()
    await this.withTransaction(database, async () => {
      const runs = await database.all<TaskRow[]>('SELECT id, status FROM task_runs WHERE status IN (?, ?, ?)', 'pending', 'running', 'paused')
      for (const run of runs) {
        await this.saveCheckpoint(database, run.id, { status: run.status, reason: 'application_exit' }, now)
        await this.insertEvent(database, run.id, undefined, 'checkpoint_saved', { reason: 'application_exit' }, now)
      }
    })
  }

  /** Running streams cannot survive a process restart; expose them as paused work awaiting confirmation. */
  public async recoverInterruptedRuns(): Promise<number> {
    const database = await this.getDatabase()
    const now = Date.now()
    const runs = await database.all<TaskRow[]>('SELECT id FROM task_runs WHERE status = ?', 'running')
    if (runs.length === 0) return 0
    await this.withTransaction(database, async () => {
      for (const run of runs) {
        await database.run('UPDATE task_runs SET status = ?, updated_at = ? WHERE id = ?', 'paused', now, run.id)
        await database.run(
          'UPDATE task_steps SET status = ?, detail = ?, completed_at = NULL, updated_at = ? WHERE task_run_id = ? AND status = ?',
          'pending', 'Interrupted by application restart; ready to resume.', now, run.id, 'running'
        )
        await this.insertEvent(database, run.id, undefined, 'recovered_requires_confirmation', { reason: 'application_restart' }, now)
        await this.saveCheckpoint(database, run.id, { status: 'paused', reason: 'application_restart' }, now)
      }
    })
    return runs.length
  }

  public async getRun(id: string): Promise<{ run: TaskRun; steps: TaskStep[]; events: TaskEvent[] } | null> {
    const database = await this.getDatabase()
    const row = await database.get<TaskRow>('SELECT * FROM task_runs WHERE id = ?', id)
    if (!row) return null
    const steps = await database.all<TaskRow[]>('SELECT * FROM task_steps WHERE task_run_id = ? ORDER BY sequence', id)
    const events = await database.all<TaskRow[]>('SELECT * FROM task_events WHERE task_run_id = ? ORDER BY created_at DESC LIMIT 100', id)
    return { run: this.mapRun(row), steps: steps.map(row => this.mapStep(row)), events: events.map(row => ({ id: row.id, taskRunId: row.task_run_id, taskStepId: row.task_step_id || undefined, type: row.type, payload: parseJson(row.payload_json, {}), createdAt: row.created_at })) }
  }

  public async setRunStatus(id: string, status: TaskRunStatus, reason?: string): Promise<TaskRun | null> {
    const database = await this.getDatabase()
    const existing = await database.get<TaskRow>('SELECT * FROM task_runs WHERE id = ?', id)
    if (!existing) return null
    const now = Date.now()
    const completedAt = ['completed', 'failed', 'blocked', 'cancelled'].includes(status) ? now : null
    await this.withTransaction(database, async () => {
      await database.run('UPDATE task_runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?', status, now, completedAt, id)
      if (status === 'paused') {
        await database.run(
          'UPDATE task_steps SET status = ?, detail = ?, completed_at = NULL, updated_at = ? WHERE task_run_id = ? AND status = ?',
          'pending', 'Paused at checkpoint; ready to resume.', now, id, 'running'
        )
      } else if (status === 'cancelled') {
        await database.run(
          `UPDATE task_steps SET status = ?, detail = ?, completed_at = ?, updated_at = ?
           WHERE task_run_id = ? AND status IN ('pending', 'running', 'paused')`,
          'cancelled', 'Cancelled.', now, now, id
        )
      }
      await this.insertEvent(database, id, undefined, `task_${status}`, reason ? { reason } : {}, now)
      await this.saveCheckpoint(database, id, { status, reason: reason || undefined }, now)
    })
    return { ...this.mapRun(existing), status, updatedAt: now, completedAt: completedAt || undefined }
  }

  public async listRuns(sessionId?: string): Promise<Array<{ run: TaskRun; steps: TaskStep[] }>> {
    const database = await this.getDatabase()
    const rows = sessionId
      ? await database.all<TaskRow[]>('SELECT * FROM task_runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 50', sessionId)
      : await database.all<TaskRow[]>('SELECT * FROM task_runs ORDER BY updated_at DESC LIMIT 50')
    return Promise.all(rows.map(async row => ({
      run: this.mapRun(row),
      steps: (await database.all<TaskRow[]>('SELECT * FROM task_steps WHERE task_run_id = ? ORDER BY sequence', row.id)).map(step => this.mapStep(step))
    })))
  }

  public async setStepStatus(
    taskRunId: string,
    taskStepId: string,
    status: TaskStepStatus,
    update: { detail?: string; resultSummary?: string; artifactPaths?: string[]; incrementRetry?: boolean } = {}
  ): Promise<TaskStep | null> {
    const database = await this.getDatabase()
    const existing = await database.get<TaskRow>('SELECT * FROM task_steps WHERE task_run_id = ? AND id = ?', taskRunId, taskStepId)
    if (!existing) return null
    const now = Date.now()
    const startedAt = status === 'running' ? existing.started_at || now : existing.started_at || null
    const completedAt = ['completed', 'failed', 'blocked', 'cancelled'].includes(status) ? now : null
    const artifactPaths = update.artifactPaths || parseJson<string[]>(existing.artifact_paths_json, [])
    await this.withTransaction(database, async () => {
      await database.run(
        `UPDATE task_steps SET status = ?, detail = COALESCE(?, detail), result_summary = COALESCE(?, result_summary),
         artifact_paths_json = ?, retry_count = retry_count + ?, started_at = ?, completed_at = ?, updated_at = ?
         WHERE task_run_id = ? AND id = ?`,
        status, update.detail ?? null, update.resultSummary ?? null, toJson(artifactPaths), update.incrementRetry ? 1 : 0,
        startedAt, completedAt, now, taskRunId, taskStepId
      )
      for (const artifactPath of artifactPaths) {
        await database.run(
          'INSERT OR IGNORE INTO task_artifacts (id, task_run_id, task_step_id, path, created_at) VALUES (?, ?, ?, ?, ?)',
          randomUUID(), taskRunId, taskStepId, artifactPath, now
        )
      }
      await this.insertEvent(database, taskRunId, taskStepId, `step_${status}`, {
        detail: update.detail,
        resultSummary: update.resultSummary,
        artifactPaths
      }, now)
      await this.saveCheckpoint(database, taskRunId, { activeStepId: taskStepId, stepStatus: status }, now)
    })
    return this.mapStep({ ...existing, status, detail: update.detail ?? existing.detail, result_summary: update.resultSummary ?? existing.result_summary, artifact_paths_json: toJson(artifactPaths), retry_count: Number(existing.retry_count || 0) + (update.incrementRetry ? 1 : 0), started_at: startedAt, completed_at: completedAt })
  }

  public async upsertSubagentTasks(tasks: SubagentTask[]): Promise<void> {
    if (tasks.length === 0) return
    const database = await this.getDatabase()
    await this.withTransaction(database, async () => {
      for (const task of tasks) {
        await database.run(
          `INSERT INTO subagent_tasks (id, task_run_id, task_step_id, parent_session_id, role, agent_id, model, title, prompt, status, dependencies_json, result_summary, artifact_paths_json, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, result_summary = excluded.result_summary,
           artifact_paths_json = excluded.artifact_paths_json, updated_at = excluded.updated_at, completed_at = excluded.completed_at`,
          task.id, task.taskRunId, task.taskStepId, task.parentSessionId, task.role, task.agentId || 'agentpet', task.model || null, task.title, task.prompt, task.status,
          toJson(task.dependencies), task.resultSummary || null, toJson(task.artifactPaths), task.createdAt, task.updatedAt, task.completedAt || null
        )
      }
    })
  }

  public async listSubagentTasks(taskRunId: string): Promise<SubagentTask[]> {
    const database = await this.getDatabase()
    const rows = await database.all<TaskRow[]>('SELECT * FROM subagent_tasks WHERE task_run_id = ? ORDER BY created_at, id', taskRunId)
    return rows.map(row => ({
      id: row.id, taskRunId: row.task_run_id, taskStepId: row.task_step_id, parentSessionId: row.parent_session_id,
      role: row.role, agentId: row.agent_id || 'agentpet', model: row.model || undefined, title: row.title, prompt: row.prompt, status: row.status,
      dependencies: parseJson(row.dependencies_json, []), resultSummary: row.result_summary || undefined,
      artifactPaths: parseJson(row.artifact_paths_json, []), createdAt: row.created_at, updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined
    }))
  }

  public async retryStep(taskRunId: string, taskStepId: string): Promise<{ run: TaskRun; step: TaskStep } | null> {
    const database = await this.getDatabase()
    const run = await database.get<TaskRow>('SELECT * FROM task_runs WHERE id = ?', taskRunId)
    const step = await database.get<TaskRow>('SELECT * FROM task_steps WHERE task_run_id = ? AND id = ?', taskRunId, taskStepId)
    if (!run || !step) return null
    const now = Date.now()
    await this.withTransaction(database, async () => {
      await database.run('UPDATE task_steps SET status = ?, retry_count = retry_count + 1, completed_at = NULL, updated_at = ? WHERE task_run_id = ? AND id = ?', 'pending', now, taskRunId, taskStepId)
      const blockedSteps = await database.all<TaskRow[]>('SELECT id, dependencies_json, detail FROM task_steps WHERE task_run_id = ? AND status = ?', taskRunId, 'blocked')
      const restoredDependencyIds = new Set([taskStepId])
      let restoredInPass = true
      while (restoredInPass) {
        restoredInPass = false
        for (const blockedStep of blockedSteps) {
          if (restoredDependencyIds.has(blockedStep.id)) continue
          const wasDependencyBlocked = !blockedStep.detail || blockedStep.detail === 'Dependencies cannot be satisfied.' || blockedStep.detail === 'Dependency retry requested; waiting to run.'
          const dependsOnRestoredStep = parseJson<string[]>(blockedStep.dependencies_json, []).some(dependency => restoredDependencyIds.has(dependency))
          if (!wasDependencyBlocked || !dependsOnRestoredStep) continue
          await database.run(
            'UPDATE task_steps SET status = ?, detail = ?, completed_at = NULL, updated_at = ? WHERE task_run_id = ? AND id = ?',
            'pending', 'Dependency retry requested; waiting to run.', now, taskRunId, blockedStep.id
          )
          restoredDependencyIds.add(blockedStep.id)
          restoredInPass = true
        }
      }
      await database.run('UPDATE task_runs SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ?', 'pending', now, taskRunId)
      await this.insertEvent(database, taskRunId, taskStepId, 'step_retry_requested', { retryCount: Number(step.retry_count || 0) + 1 }, now)
      await this.saveCheckpoint(database, taskRunId, { status: 'pending', retryStepId: taskStepId }, now)
    })
    return { run: { ...this.mapRun(run), status: 'pending', updatedAt: now, completedAt: undefined }, step: { ...this.mapStep(step), status: 'pending', retryCount: Number(step.retry_count || 0) + 1, completedAt: undefined } }
  }

  public async retryFailedSteps(taskRunId: string): Promise<{ run: TaskRun; steps: TaskStep[] } | null> {
    const database = await this.getDatabase()
    const run = await database.get<TaskRow>('SELECT * FROM task_runs WHERE id = ?', taskRunId)
    const rows = await database.all<TaskRow[]>('SELECT * FROM task_steps WHERE task_run_id = ? ORDER BY sequence', taskRunId)
    if (!run || rows.length === 0) return null
    const failedIds = new Set(rows.filter(row => row.status === 'failed').map(row => String(row.id)))
    if (failedIds.size === 0) return { run: this.mapRun(run), steps: rows.map(row => this.mapStep(row)) }
    const now = Date.now()
    const restoredIds = new Set(failedIds)

    await this.withTransaction(database, async () => {
      for (const failedId of failedIds) {
        await database.run(
          'UPDATE task_steps SET status = ?, detail = ?, retry_count = retry_count + 1, completed_at = NULL, updated_at = ? WHERE task_run_id = ? AND id = ?',
          'pending', 'Run retry requested; waiting to run.', now, taskRunId, failedId
        )
      }

      let restoredInPass = true
      while (restoredInPass) {
        restoredInPass = false
        for (const row of rows) {
          if (row.status !== 'blocked' || restoredIds.has(String(row.id))) continue
          const wasDependencyBlocked = !row.detail || row.detail === 'Dependencies cannot be satisfied.' || row.detail === 'Dependency retry requested; waiting to run.'
          const dependsOnRestoredStep = parseJson<string[]>(row.dependencies_json, []).some(dependency => restoredIds.has(dependency))
          if (!wasDependencyBlocked || !dependsOnRestoredStep) continue
          await database.run(
            'UPDATE task_steps SET status = ?, detail = ?, completed_at = NULL, updated_at = ? WHERE task_run_id = ? AND id = ?',
            'pending', 'Dependency retry requested; waiting to run.', now, taskRunId, row.id
          )
          restoredIds.add(String(row.id))
          restoredInPass = true
        }
      }

      await database.run('UPDATE task_runs SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ?', 'pending', now, taskRunId)
      await this.insertEvent(database, taskRunId, undefined, 'run_retry_requested', { failedStepIds: [...failedIds], restoredStepIds: [...restoredIds] }, now)
      await this.saveCheckpoint(database, taskRunId, { status: 'pending', retryFailedStepIds: [...failedIds] }, now)
    })

    return this.getRun(taskRunId)
  }

  private async getDatabase(): Promise<Database> {
    const filename = join(getActiveStorageDir(), 'chat', 'chat.db')
    if (this.database && this.filename === filename) return this.database
    if (this.database) await this.database.close()
    this.filename = filename
    this.database = await open({ filename, driver: sqlite3.Database })
    await this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
        explanation TEXT, workspace_path TEXT, parent_turn INTEGER, parent_message_id TEXT, parent_tool_call_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_session_message ON task_runs(session_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status_updated ON task_runs(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT NOT NULL, task_run_id TEXT NOT NULL, sequence INTEGER NOT NULL, title TEXT NOT NULL, goal TEXT,
        dependencies_json TEXT DEFAULT '[]', acceptance_criteria TEXT, status TEXT NOT NULL, detail TEXT,
        result_summary TEXT, artifact_paths_json TEXT DEFAULT '[]', retry_count INTEGER NOT NULL DEFAULT 0,
        agent_role TEXT, agent_id TEXT DEFAULT 'agentpet', model TEXT, prompt TEXT, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_run_id, id), FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, task_step_id TEXT, type TEXT NOT NULL, payload_json TEXT,
        created_at INTEGER NOT NULL, FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_run_created ON task_events(task_run_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, task_step_id TEXT, path TEXT NOT NULL, metadata_json TEXT,
        created_at INTEGER NOT NULL, FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, state_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_checkpoints_run_created ON task_checkpoints(task_run_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS subagent_tasks (
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, task_step_id TEXT NOT NULL, parent_session_id TEXT NOT NULL,
        role TEXT NOT NULL, agent_id TEXT DEFAULT 'agentpet', model TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
        dependencies_json TEXT DEFAULT '[]', result_summary TEXT, artifact_paths_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
        FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_subagent_tasks_run ON subagent_tasks(task_run_id, created_at);
    `)
    await this.ensureColumn(this.database, 'task_steps', 'agent_role', 'TEXT')
    await this.ensureColumn(this.database, 'task_steps', 'agent_id', "TEXT DEFAULT 'agentpet'")
    await this.ensureColumn(this.database, 'task_steps', 'prompt', 'TEXT')
    await this.ensureColumn(this.database, 'task_steps', 'model', 'TEXT')
    await this.ensureColumn(this.database, 'subagent_tasks', 'agent_id', "TEXT DEFAULT 'agentpet'")
    await this.ensureColumn(this.database, 'subagent_tasks', 'model', 'TEXT')
    await this.ensureColumn(this.database, 'task_runs', 'workspace_path', 'TEXT')
    await this.ensureColumn(this.database, 'task_runs', 'parent_turn', 'INTEGER')
    await this.ensureColumn(this.database, 'task_runs', 'parent_message_id', 'TEXT')
    await this.ensureColumn(this.database, 'task_runs', 'parent_tool_call_id', 'TEXT')
    return this.database
  }

  private async ensureColumn(database: Database, table: string, column: string, declaration: string): Promise<void> {
    const columns = await database.all<Array<{ name: string }>>(`PRAGMA table_info(${table})`)
    if (!columns.some(item => item.name === column)) await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }

  /** Keep persistence transactions sequential on this SQLite connection while
   * allowing the agent operations around them to remain concurrent. */
  private async withTransaction<T>(database: Database, operation: () => Promise<T>): Promise<T> {
    return this.transactions.run(database, operation)
  }

  private async insertEvent(database: Database, taskRunId: string, taskStepId: string | undefined, type: string, payload: Record<string, unknown>, createdAt: number): Promise<void> {
    await database.run('INSERT INTO task_events (id, task_run_id, task_step_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), taskRunId, taskStepId || null, type, JSON.stringify(payload), createdAt)
  }

  private async saveCheckpoint(database: Database, taskRunId: string, state: Record<string, unknown>, createdAt: number): Promise<void> {
    await database.run('INSERT INTO task_checkpoints (id, task_run_id, state_json, created_at) VALUES (?, ?, ?, ?)', randomUUID(), taskRunId, JSON.stringify(state), createdAt)
  }

  private toStepStatus(status: TaskPlanInput['steps'][number]['status']): TaskStepStatus {
    return status === 'in_progress' ? 'running' : status
  }

  private mapRun(row: TaskRow): TaskRun {
    return { id: row.id, sessionId: row.session_id, messageId: row.message_id || undefined, parentTurn: row.parent_turn === null || row.parent_turn === undefined ? undefined : Number(row.parent_turn), parentMessageId: row.parent_message_id || undefined, parentToolCallId: row.parent_tool_call_id || undefined, title: row.title, status: row.status, explanation: row.explanation || undefined, workspacePath: row.workspace_path || undefined, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || undefined }
  }

  private mapStep(row: TaskRow): TaskStep {
    return { id: row.id, taskRunId: row.task_run_id, sequence: row.sequence, title: row.title, goal: row.goal || undefined, dependencies: parseJson(row.dependencies_json, []), acceptanceCriteria: row.acceptance_criteria || undefined, status: row.status, detail: row.detail || undefined, resultSummary: row.result_summary || undefined, artifactPaths: parseJson(row.artifact_paths_json, []), retryCount: row.retry_count, agentRole: row.agent_role || undefined, agentId: row.agent_id || 'agentpet', model: row.model || undefined, prompt: row.prompt || undefined, startedAt: row.started_at || undefined, completedAt: row.completed_at || undefined }
  }
}

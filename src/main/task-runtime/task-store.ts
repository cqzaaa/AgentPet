import sqlite3 from 'sqlite3'
import { open, type Database } from 'sqlite'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getActiveStorageDir } from '../tools/utils/paths'
import type { TaskEvent, TaskPlanInput, TaskRun, TaskRunStatus, TaskStep, TaskStepStatus } from './types'

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

    await database.exec('BEGIN IMMEDIATE')
    try {
      if (existing) {
        await database.run(
          'UPDATE task_runs SET title = ?, status = ?, explanation = ?, updated_at = ?, completed_at = ? WHERE id = ?',
          plan.title, status, plan.explanation || null, now, completedAt, id
        )
      } else {
        await database.run(
          'INSERT INTO task_runs (id, session_id, message_id, title, status, explanation, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, sessionId, messageId || null, plan.title, status, plan.explanation || null, now, now, completedAt
        )
      }

      for (const [index, item] of plan.steps.entries()) {
        const stepStatus = this.toStepStatus(item.status)
        const previous = await database.get<TaskRow>('SELECT * FROM task_steps WHERE task_run_id = ? AND id = ?', id, item.id)
        const startedAt = stepStatus === 'running' ? previous?.started_at || now : previous?.started_at || null
        const stepCompletedAt = ['completed', 'failed', 'blocked', 'cancelled'].includes(stepStatus) ? previous?.completed_at || now : null
        await database.run(
          `INSERT INTO task_steps (id, task_run_id, sequence, title, goal, dependencies_json, acceptance_criteria, status, detail, result_summary, artifact_paths_json, retry_count, started_at, completed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_run_id, id) DO UPDATE SET
             sequence = excluded.sequence, title = excluded.title, goal = excluded.goal, dependencies_json = excluded.dependencies_json,
             acceptance_criteria = excluded.acceptance_criteria, status = excluded.status, detail = excluded.detail,
             result_summary = excluded.result_summary, artifact_paths_json = excluded.artifact_paths_json,
             retry_count = excluded.retry_count, started_at = excluded.started_at, completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
          item.id, id, index + 1, item.title, item.goal || null, toJson(item.dependencies || []), item.acceptanceCriteria || null,
          stepStatus, item.detail || null, item.resultSummary || item.detail || null, toJson(item.artifactPaths || []), item.retryCount || previous?.retry_count || 0,
          startedAt, stepCompletedAt, now
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
      await database.exec('COMMIT')
    } catch (error) {
      await database.exec('ROLLBACK')
      throw error
    }
    return { id, sessionId, messageId, title: plan.title, status, explanation: plan.explanation, createdAt: existing?.created_at || now, updatedAt: now, completedAt: completedAt || undefined }
  }

  public async checkpointActiveRuns(): Promise<void> {
    const database = await this.getDatabase()
    const now = Date.now()
    const runs = await database.all<TaskRow[]>('SELECT id, status FROM task_runs WHERE status IN (?, ?, ?)', 'pending', 'running', 'paused')
    for (const run of runs) {
      await this.saveCheckpoint(database, run.id, { status: run.status, reason: 'application_exit' }, now)
      await this.insertEvent(database, run.id, undefined, 'checkpoint_saved', { reason: 'application_exit' }, now)
    }
  }

  /** Running streams cannot survive a process restart; expose them as paused work awaiting confirmation. */
  public async recoverInterruptedRuns(): Promise<number> {
    const database = await this.getDatabase()
    const now = Date.now()
    const runs = await database.all<TaskRow[]>('SELECT id FROM task_runs WHERE status = ?', 'running')
    if (runs.length === 0) return 0
    await database.exec('BEGIN IMMEDIATE')
    try {
      for (const run of runs) {
        await database.run('UPDATE task_runs SET status = ?, updated_at = ? WHERE id = ?', 'paused', now, run.id)
        await this.insertEvent(database, run.id, undefined, 'recovered_requires_confirmation', { reason: 'application_restart' }, now)
        await this.saveCheckpoint(database, run.id, { status: 'paused', reason: 'application_restart' }, now)
      }
      await database.exec('COMMIT')
      return runs.length
    } catch (error) {
      await database.exec('ROLLBACK')
      throw error
    }
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
    await database.exec('BEGIN IMMEDIATE')
    try {
      await database.run('UPDATE task_runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?', status, now, completedAt, id)
      await this.insertEvent(database, id, undefined, `task_${status}`, reason ? { reason } : {}, now)
      await this.saveCheckpoint(database, id, { status, reason: reason || undefined }, now)
      await database.exec('COMMIT')
    } catch (error) {
      await database.exec('ROLLBACK')
      throw error
    }
    return { ...this.mapRun(existing), status, updatedAt: now, completedAt: completedAt || undefined }
  }

  public async retryStep(taskRunId: string, taskStepId: string): Promise<{ run: TaskRun; step: TaskStep } | null> {
    const database = await this.getDatabase()
    const run = await database.get<TaskRow>('SELECT * FROM task_runs WHERE id = ?', taskRunId)
    const step = await database.get<TaskRow>('SELECT * FROM task_steps WHERE task_run_id = ? AND id = ?', taskRunId, taskStepId)
    if (!run || !step) return null
    const now = Date.now()
    await database.exec('BEGIN IMMEDIATE')
    try {
      await database.run('UPDATE task_steps SET status = ?, retry_count = retry_count + 1, completed_at = NULL, updated_at = ? WHERE task_run_id = ? AND id = ?', 'pending', now, taskRunId, taskStepId)
      await database.run('UPDATE task_runs SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ?', 'pending', now, taskRunId)
      await this.insertEvent(database, taskRunId, taskStepId, 'step_retry_requested', { retryCount: Number(step.retry_count || 0) + 1 }, now)
      await this.saveCheckpoint(database, taskRunId, { status: 'pending', retryStepId: taskStepId }, now)
      await database.exec('COMMIT')
    } catch (error) {
      await database.exec('ROLLBACK')
      throw error
    }
    return { run: { ...this.mapRun(run), status: 'pending', updatedAt: now, completedAt: undefined }, step: { ...this.mapStep(step), status: 'pending', retryCount: Number(step.retry_count || 0) + 1, completedAt: undefined } }
  }

  private async getDatabase(): Promise<Database> {
    const filename = join(getActiveStorageDir(), 'chat', 'chat.db')
    if (this.database && this.filename === filename) return this.database
    if (this.database) await this.database.close()
    this.filename = filename
    this.database = await open({ filename, driver: sqlite3.Database })
    await this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
        explanation TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_session_message ON task_runs(session_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status_updated ON task_runs(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT NOT NULL, task_run_id TEXT NOT NULL, sequence INTEGER NOT NULL, title TEXT NOT NULL, goal TEXT,
        dependencies_json TEXT DEFAULT '[]', acceptance_criteria TEXT, status TEXT NOT NULL, detail TEXT,
        result_summary TEXT, artifact_paths_json TEXT DEFAULT '[]', retry_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL,
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
    `)
    return this.database
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
    return { id: row.id, sessionId: row.session_id, messageId: row.message_id || undefined, title: row.title, status: row.status, explanation: row.explanation || undefined, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || undefined }
  }

  private mapStep(row: TaskRow): TaskStep {
    return { id: row.id, taskRunId: row.task_run_id, sequence: row.sequence, title: row.title, goal: row.goal || undefined, dependencies: parseJson(row.dependencies_json, []), acceptanceCriteria: row.acceptance_criteria || undefined, status: row.status, detail: row.detail || undefined, resultSummary: row.result_summary || undefined, artifactPaths: parseJson(row.artifact_paths_json, []), retryCount: row.retry_count, startedAt: row.started_at || undefined, completedAt: row.completed_at || undefined }
  }
}

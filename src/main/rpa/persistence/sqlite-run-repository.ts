import { randomUUID } from 'crypto'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import sqlite3 from 'sqlite3'
import { open, type Database } from 'sqlite'
import type {
  JsonValue,
  RpaAction,
  RpaArtifactRecord,
  RpaRunEvent,
  RpaRunEventType,
  RpaRunRecord,
  RpaRunStatus
} from '../domain/types'
import type {
  AppendRpaRunEventInput,
  CreateRpaArtifactInput,
  CreateRpaRunInput,
  RpaRunRepository,
  UpdateRpaRunStatusInput
} from './run-repository'

interface RunRow {
  id: string
  workflow_id: string | null
  workflow_version: number | null
  session_id: string | null
  status: RpaRunStatus
  inputs_json: string
  output_json: string | null
  error_json: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface EventRow {
  id: string
  run_id: string
  sequence: number
  type: RpaRunEventType
  action_json: string | null
  payload_json: string | null
  created_at: number
}

const SCHEMA_VERSION = 1

export class SqliteRpaRunRepository implements RpaRunRepository {
  private databasePromise?: Promise<Database>
  private writeQueue: Promise<void> = Promise.resolve()

  public constructor(private readonly filename: string) {}

  public async initialize(): Promise<void> {
    await this.getDatabase()
  }

  public async createRun(input: CreateRpaRunInput): Promise<RpaRunRecord> {
    const run: RpaRunRecord = {
      id: input.id ?? randomUUID(),
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      sessionId: input.sessionId,
      status: input.status ?? 'pending',
      inputs: input.inputs ?? {},
      createdAt: input.createdAt ?? Date.now()
    }

    await this.enqueueWrite(async () => {
      const database = await this.getDatabase()
      await database.run(
        `INSERT INTO rpa_runs (
          id, workflow_id, workflow_version, session_id, status, inputs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        run.id,
        run.workflowId ?? null,
        run.workflowVersion ?? null,
        run.sessionId ?? null,
        run.status,
        JSON.stringify(run.inputs),
        run.createdAt
      )
    })

    return run
  }

  public async getRun(runId: string): Promise<RpaRunRecord | null> {
    const database = await this.getDatabase()
    const row = await database.get<RunRow>('SELECT * FROM rpa_runs WHERE id = ?', runId)
    return row ? this.mapRun(row) : null
  }

  public async updateRunStatus(input: UpdateRpaRunStatusInput): Promise<void> {
    await this.enqueueWrite(async () => {
      const database = await this.getDatabase()
      const result = await database.run(
        `UPDATE rpa_runs
         SET status = ?,
             output_json = CASE WHEN ? = 1 THEN ? ELSE output_json END,
             error_json = CASE WHEN ? = 1 THEN ? ELSE error_json END,
             started_at = COALESCE(?, started_at),
             finished_at = COALESCE(?, finished_at)
         WHERE id = ?`,
        input.status,
        input.output === undefined ? 0 : 1,
        this.stringifyOptional(input.output),
        input.error === undefined ? 0 : 1,
        this.stringifyOptional(input.error),
        input.startedAt ?? null,
        input.finishedAt ?? null,
        input.runId
      )
      if (result.changes === 0) {
        throw new Error(`RPA run not found: ${input.runId}`)
      }
    })
  }

  public async appendEvent(input: AppendRpaRunEventInput): Promise<RpaRunEvent> {
    return this.enqueueWrite(async () => {
      const database = await this.getDatabase()
      const eventId = input.id ?? randomUUID()
      const createdAt = input.createdAt ?? Date.now()

      await database.run(
        `INSERT INTO rpa_run_events (
          id, run_id, sequence, type, action_json, payload_json, created_at
        )
        SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?
        FROM rpa_run_events
        WHERE run_id = ?`,
        eventId,
        input.runId,
        input.type,
        this.stringifyOptional(input.action),
        this.stringifyOptional(input.payload),
        createdAt,
        input.runId
      )

      const row = await database.get<EventRow>('SELECT * FROM rpa_run_events WHERE id = ?', eventId)
      if (!row) {
        throw new Error(`Failed to persist RPA run event: ${eventId}`)
      }
      return this.mapEvent(row)
    })
  }

  public async listEvents(runId: string, afterSequence = 0): Promise<RpaRunEvent[]> {
    const database = await this.getDatabase()
    const rows = await database.all<EventRow[]>(
      `SELECT * FROM rpa_run_events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC`,
      runId,
      afterSequence
    )
    return rows.map((row) => this.mapEvent(row))
  }

  public async createArtifact(input: CreateRpaArtifactInput): Promise<RpaArtifactRecord> {
    const artifact: RpaArtifactRecord = {
      id: input.id ?? randomUUID(),
      runId: input.runId,
      eventId: input.eventId,
      type: input.type,
      filePath: input.filePath,
      sha256: input.sha256,
      createdAt: input.createdAt ?? Date.now()
    }

    await this.enqueueWrite(async () => {
      const database = await this.getDatabase()
      await database.run(
        `INSERT INTO rpa_artifacts (
          id, run_id, event_id, type, file_path, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        artifact.id,
        artifact.runId,
        artifact.eventId ?? null,
        artifact.type,
        artifact.filePath,
        artifact.sha256 ?? null,
        artifact.createdAt
      )
    })

    return artifact
  }

  public async close(): Promise<void> {
    await this.writeQueue
    if (!this.databasePromise) return
    const database = await this.databasePromise
    await database.close()
    this.databasePromise = undefined
  }

  private getDatabase(): Promise<Database> {
    if (!this.databasePromise) {
      this.databasePromise = this.openDatabase().catch((error) => {
        this.databasePromise = undefined
        throw error
      })
    }
    return this.databasePromise
  }

  private async openDatabase(): Promise<Database> {
    await mkdir(dirname(this.filename), { recursive: true })
    const database = await open({ filename: this.filename, driver: sqlite3.Database })
    await database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS rpa_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT,
        workflow_version INTEGER,
        session_id TEXT,
        status TEXT NOT NULL,
        inputs_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS rpa_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        action_json TEXT,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES rpa_runs(id) ON DELETE CASCADE,
        UNIQUE (run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS rpa_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_id TEXT,
        type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sha256 TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES rpa_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (event_id) REFERENCES rpa_run_events(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rpa_runs_workflow_created
        ON rpa_runs(workflow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rpa_runs_session_created
        ON rpa_runs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rpa_events_run_sequence
        ON rpa_run_events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_rpa_artifacts_run
        ON rpa_artifacts(run_id);

      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
    return database
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private mapRun(row: RunRow): RpaRunRecord {
    return {
      id: row.id,
      workflowId: row.workflow_id ?? undefined,
      workflowVersion: row.workflow_version ?? undefined,
      sessionId: row.session_id ?? undefined,
      status: row.status,
      inputs: this.parseJson<Record<string, JsonValue>>(row.inputs_json, {}),
      output: this.parseOptionalJson(row.output_json),
      error: this.parseOptionalJson(row.error_json),
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined
    }
  }

  private mapEvent(row: EventRow): RpaRunEvent {
    return {
      id: row.id,
      runId: row.run_id,
      sequence: row.sequence,
      type: row.type,
      action: this.parseOptionalJson<RpaAction>(row.action_json),
      payload: this.parseOptionalJson<JsonValue>(row.payload_json),
      createdAt: row.created_at
    }
  }

  private stringifyOptional(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value)
  }

  private parseOptionalJson<T extends JsonValue | RpaAction>(value: string | null): T | undefined {
    if (value === null) return undefined
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
}

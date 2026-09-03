import sqlite3 from 'sqlite3'
import { open, type Database } from 'sqlite'
import { join } from 'path'
import { gzip, gunzip } from 'zlib'
import { promisify } from 'util'
import { getActiveStorageDir } from '../tools/utils/paths'
import { TransactionQueue } from '../task-runtime/transaction-queue'
import type { SessionEventInput, SessionEventPage, SessionEventRecord } from './types'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const WRITE_BATCH_DELAY_MS = 40
const WRITE_BATCH_MAX_EVENTS = 128
const COMPRESS_THRESHOLD_BYTES = 128 * 1024
const SEARCH_TEXT_LIMIT = 12_000

interface PendingEvent {
  record: SessionEventRecord
  payloadJson: string
  searchText: string
}

interface SessionController {
  nextSeq: number
  nextTurn: number
  pending: PendingEvent[]
  timer?: NodeJS.Timeout
  writing?: Promise<void>
}

type EventListener = (events: SessionEventRecord[]) => void

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch (error) {
    return JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) })
  }
}

function buildSearchText(type: string, source: string, payloadJson: string): string {
  return `${type}\n${source}\n${payloadJson}`.slice(0, SEARCH_TEXT_LIMIT)
}

function previewData(payloadJson: string, payloadBytes: number): Record<string, unknown> {
  if (payloadBytes <= COMPRESS_THRESHOLD_BYTES) {
    try { return JSON.parse(payloadJson) as Record<string, unknown> } catch { return {} }
  }
  return {
    preview: payloadJson.slice(0, 8_000),
    truncated: true,
    payloadBytes
  }
}

/**
 * High-throughput append-only event store. Logical events receive their sequence
 * number immediately, while SQLite writes are grouped into short WAL transactions.
 * flush() is the durability barrier used before model and tool dispatch.
 */
export class SessionEventStore {
  private database: Database | null = null
  private filename = ''
  private readonly transactions = new TransactionQueue()
  private readonly controllers = new Map<string, Promise<SessionController>>()
  private readonly listeners = new Set<EventListener>()

  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public async beginTurn(
    sessionId: string,
    data: Record<string, unknown>,
    messageId?: string | number
  ): Promise<number> {
    const controller = await this.getController(sessionId)
    const turn = controller.nextTurn++
    await this.append(sessionId, {
      type: 'turn/start',
      source: 'system',
      turn,
      messageId,
      data: { turn, ...data }
    })
    return turn
  }

  /** Resolves once the immutable event has been admitted to the in-memory batch. */
  public async append(sessionId: string, input: SessionEventInput): Promise<SessionEventRecord> {
    const controller = await this.getController(sessionId)
    const data = input.data || {}

    // Streaming providers can yield a delta per token. Coalesce adjacent deltas
    // inside the same 40 ms write window to keep row and IPC volume bounded.
    const streamField = input.type === 'assistant/chunk'
      ? 'content'
      : input.type === 'assistant/reasoning_chunk'
        ? 'detail'
        : null
    if (streamField && typeof data[streamField] === 'string') {
      const previous = controller.pending[controller.pending.length - 1]
      if (
        previous?.record.type === input.type &&
        previous.record.turn === input.turn &&
        previous.record.step === input.step &&
        typeof previous.record.data[streamField] === 'string'
      ) {
        previous.record.data = {
          ...previous.record.data,
          [streamField]: previous.record.data[streamField] + data[streamField],
          ...(Array.isArray(data.sourcePayloads) ? {
            sourcePayloads: [
              ...(Array.isArray(previous.record.data.sourcePayloads) ? previous.record.data.sourcePayloads : []),
              ...data.sourcePayloads
            ]
          } : {})
        }
        previous.payloadJson = safeJson(previous.record.data)
        previous.record.payloadBytes = Buffer.byteLength(previous.payloadJson)
        previous.record.compressed = previous.record.payloadBytes > COMPRESS_THRESHOLD_BYTES
        previous.searchText = buildSearchText(input.type, input.source, previous.payloadJson)
        return previous.record
      }
    }

    const payloadJson = safeJson(data)
    const payloadBytes = Buffer.byteLength(payloadJson)
    const record: SessionEventRecord = {
      ...input,
      sessionId,
      seq: controller.nextSeq++,
      time: Date.now(),
      data,
      payloadBytes,
      compressed: payloadBytes > COMPRESS_THRESHOLD_BYTES
    }
    controller.pending.push({
      record,
      payloadJson,
      searchText: buildSearchText(input.type, input.source, payloadJson)
    })
    if (controller.pending.length >= WRITE_BATCH_MAX_EVENTS) {
      this.cancelTimer(controller)
      void this.drain(sessionId, controller)
    } else if (!controller.timer) {
      controller.timer = setTimeout(() => {
        controller.timer = undefined
        void this.drain(sessionId, controller)
      }, WRITE_BATCH_DELAY_MS)
    }
    return record
  }

  public async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      const controllerPromise = this.controllers.get(sessionId)
      if (!controllerPromise) return
      const controller = await controllerPromise
      this.cancelTimer(controller)
      await this.drain(sessionId, controller)
      return
    }
    const entries = [...this.controllers.entries()]
    await Promise.all(entries.map(async ([id, promise]) => {
      const controller = await promise
      this.cancelTimer(controller)
      await this.drain(id, controller)
    }))
  }

  public async readPage(
    sessionId: string,
    options: { beforeSeq?: number; limit?: number; types?: string[]; sources?: string[]; correlationIds?: string[]; search?: string } = {}
  ): Promise<SessionEventPage> {
    await this.flush(sessionId)
    const database = await this.getDatabase()
    const limit = Math.max(20, Math.min(500, Number(options.limit) || 240))
    const clauses = ['session_id = ?']
    const params: unknown[] = [sessionId]
    if (Number.isSafeInteger(options.beforeSeq)) {
      clauses.push('seq < ?')
      params.push(options.beforeSeq)
    }
    if (Array.isArray(options.types) && options.types.length > 0) {
      clauses.push(`type IN (${options.types.map(() => '?').join(', ')})`)
      params.push(...options.types)
    }
    if (Array.isArray(options.sources) && options.sources.length > 0) {
      clauses.push(`source IN (${options.sources.map(() => '?').join(', ')})`)
      params.push(...options.sources)
    }
    if (Array.isArray(options.correlationIds) && options.correlationIds.length > 0) {
      const correlationIds = options.correlationIds.map(String).filter(Boolean).slice(0, 50)
      if (correlationIds.length > 0) {
        clauses.push(`correlation_id IN (${correlationIds.map(() => '?').join(', ')})`)
        params.push(...correlationIds)
      }
    }
    if (options.search?.trim()) {
      clauses.push('search_text LIKE ?')
      params.push(`%${options.search.trim().slice(0, 200)}%`)
    }
    const where = clauses.join(' AND ')
    const rows = await database.all<any[]>(
      `SELECT session_id, seq, time, type, source, turn_no, step_no, correlation_id, message_id,
              payload_json, payload_bytes, payload_codec, search_text
       FROM session_events WHERE ${where} ORDER BY seq DESC LIMIT ?`,
      ...params,
      limit + 1
    )
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit).reverse()
    const events = selected.map(row => this.mapRowPreview(row))
    const bounds = await database.get<any>(
      'SELECT COUNT(*) AS total, MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM session_events WHERE session_id = ?',
      sessionId
    )
    return {
      events,
      hasMore,
      nextBeforeSeq: hasMore && events.length > 0 ? events[0].seq : undefined,
      total: Number(bounds?.total || 0),
      firstSeq: bounds?.first_seq === null ? undefined : Number(bounds?.first_seq),
      lastSeq: bounds?.last_seq === null ? undefined : Number(bounds?.last_seq)
    }
  }

  public async readEvent(sessionId: string, seq: number): Promise<SessionEventRecord | null> {
    await this.flush(sessionId)
    const database = await this.getDatabase()
    const row = await database.get<any>(
      `SELECT session_id, seq, time, type, source, turn_no, step_no, correlation_id, message_id,
              payload_json, payload_blob, payload_bytes, payload_codec
       FROM session_events WHERE session_id = ? AND seq = ?`,
      sessionId,
      seq
    )
    if (!row) return null
    let payloadJson = String(row.payload_json || '{}')
    if (row.payload_codec === 'gzip' && row.payload_blob) {
      payloadJson = (await gunzipAsync(row.payload_blob as Buffer)).toString('utf8')
    }
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(payloadJson) } catch { data = { raw: payloadJson } }
    return this.mapRow(row, data)
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.flush(sessionId)
    const database = await this.getDatabase()
    await this.transactions.run(database, async () => {
      await database.run('DELETE FROM session_events WHERE session_id = ?', sessionId)
      await database.run('DELETE FROM session_event_headers WHERE session_id = ?', sessionId)
    })
    this.controllers.delete(sessionId)
  }

  public async close(): Promise<void> {
    await this.flush()
    if (this.database) await this.database.close()
    this.database = null
    this.filename = ''
    this.controllers.clear()
  }

  private async getController(sessionId: string): Promise<SessionController> {
    let promise = this.controllers.get(sessionId)
    if (!promise) {
      promise = (async () => {
        const database = await this.getDatabase()
        const row = await database.get<any>(
          'SELECT COALESCE(MAX(seq), -1) AS max_seq, COALESCE(MAX(turn_no), 0) AS max_turn FROM session_events WHERE session_id = ?',
          sessionId
        )
        return {
          nextSeq: Number(row?.max_seq ?? -1) + 1,
          nextTurn: Math.max(1, Number(row?.max_turn || 0) + 1),
          pending: []
        }
      })()
      this.controllers.set(sessionId, promise)
    }
    return promise
  }

  private async getDatabase(): Promise<Database> {
    const filename = join(getActiveStorageDir(), 'chat', 'chat.db')
    if (this.database && this.filename === filename) return this.database
    if (this.database) {
      await this.database.close()
      this.controllers.clear()
    }
    this.filename = filename
    this.database = await open({ filename, driver: sqlite3.Database })
    await this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS session_event_headers (
        session_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        parent_session_id TEXT,
        fork_seq INTEGER,
        seed_length INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        turn_no INTEGER,
        step_no INTEGER,
        correlation_id TEXT,
        message_id TEXT,
        payload_json TEXT,
        payload_blob BLOB,
        payload_codec TEXT,
        payload_bytes INTEGER NOT NULL DEFAULT 0,
        search_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_time ON session_events(session_id, time);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type, seq);
      CREATE INDEX IF NOT EXISTS idx_session_events_correlation ON session_events(session_id, correlation_id, seq);
    `)
    return this.database
  }

  private async drain(sessionId: string, controller: SessionController): Promise<void> {
    if (controller.writing) {
      await controller.writing
      if (controller.pending.length > 0) await this.drain(sessionId, controller)
      return
    }
    if (controller.pending.length === 0) return
    const batch = controller.pending.splice(0, controller.pending.length)
    controller.writing = this.writeBatch(sessionId, batch).finally(() => {
      controller.writing = undefined
    })
    await controller.writing
    if (controller.pending.length > 0 && !controller.timer) {
      controller.timer = setTimeout(() => {
        controller.timer = undefined
        void this.drain(sessionId, controller)
      }, WRITE_BATCH_DELAY_MS)
    }
  }

  private async writeBatch(sessionId: string, batch: PendingEvent[]): Promise<void> {
    const database = await this.getDatabase()
    const encoded = await Promise.all(batch.map(async item => {
      if (item.record.payloadBytes <= COMPRESS_THRESHOLD_BYTES) {
        return { ...item, payloadText: item.payloadJson, payloadBlob: null, codec: null }
      }
      return {
        ...item,
        payloadText: null,
        payloadBlob: await gzipAsync(Buffer.from(item.payloadJson, 'utf8')),
        codec: 'gzip'
      }
    }))
    const now = Date.now()
    await this.transactions.run(database, async () => {
      await database.run(
        `INSERT INTO session_event_headers (session_id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`,
        sessionId,
        batch[0]?.record.time || now,
        now
      )
      for (const item of encoded) {
        const event = item.record
        await database.run(
          `INSERT INTO session_events
           (session_id, seq, time, type, source, turn_no, step_no, correlation_id, message_id,
            payload_json, payload_blob, payload_codec, payload_bytes, search_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionId,
          event.seq,
          event.time,
          event.type,
          event.source,
          event.turn ?? null,
          event.step ?? null,
          event.correlationId || null,
          event.messageId === undefined ? null : String(event.messageId),
          item.payloadText,
          item.payloadBlob,
          item.codec,
          event.payloadBytes,
          item.searchText
        )
      }
    })
    const liveEvents = batch.map(item => item.record.payloadBytes > COMPRESS_THRESHOLD_BYTES
        ? { ...item.record, data: previewData(item.payloadJson, item.record.payloadBytes) }
        : item.record)
    for (const listener of this.listeners) {
      try { listener(liveEvents) } catch (error) { console.warn('[SessionEvents] listener failed', error) }
    }
  }

  private mapRowPreview(row: any): SessionEventRecord {
    if (row.payload_codec === 'gzip') {
      return this.mapRow(row, {
        preview: String(row.search_text || '').slice(0, 8_000),
        truncated: true,
        payloadBytes: Number(row.payload_bytes || 0)
      })
    }
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(String(row.payload_json || '{}')) } catch { data = {} }
    return this.mapRow(row, data)
  }

  private mapRow(row: any, data: Record<string, unknown>): SessionEventRecord {
    return {
      sessionId: String(row.session_id),
      seq: Number(row.seq),
      time: Number(row.time),
      type: String(row.type),
      source: row.source,
      turn: row.turn_no === null || row.turn_no === undefined ? undefined : Number(row.turn_no),
      step: row.step_no === null || row.step_no === undefined ? undefined : Number(row.step_no),
      correlationId: row.correlation_id || undefined,
      messageId: row.message_id || undefined,
      data,
      payloadBytes: Number(row.payload_bytes || 0),
      compressed: row.payload_codec === 'gzip'
    }
  }

  private cancelTimer(controller: SessionController): void {
    if (controller.timer) clearTimeout(controller.timer)
    controller.timer = undefined
  }
}

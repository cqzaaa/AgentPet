import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { BrowserRecordedAction, RpaTaskManifest } from '../domain/types'
import { writeTextAtomically } from '../../security/secret-vault-core'
import { RpaBrowserRecorder } from '../rpaBrowserRecorder'
import { loadManifest, saveManifest, saveTaskFlow } from '../rpaStorage'
import { compileBrowserRecording } from './recording-compiler'

export type RecordingStatus = 'preparing' | 'recording' | 'paused' | 'reviewing' | 'completed' | 'cancelled' | 'failed'

export interface RecordingSession {
  id: string
  workflowId: string
  name: string
  objective: string
  mode: 'guided' | 'collaborative' | 'autonomous'
  surfaces: Array<'browser' | 'desktop'>
  status: RecordingStatus
  startUrl?: string
  actionCount: number
  missingSecretBindings: number
  pendingSecretBindings?: Array<{ selector: string; label?: string }>
  createdAt: number
  updatedAt: number
  error?: string
}

interface RecordingDocument extends RecordingSession {
  actions: BrowserRecordedAction[]
}

export class RecordingCoordinator {
  private readonly activePromises = new Map<string, Promise<BrowserRecordedAction[]>>()

  public start(input: {
    name: string
    objective: string
    startUrl?: string
    mode?: RecordingSession['mode']
    surfaces?: RecordingSession['surfaces']
  }): RecordingSession {
    const name = input.name.trim()
    if (!name) throw new TypeError('Recording name is required')
    const now = Date.now()
    const session: RecordingDocument = {
      id: randomUUID(),
      workflowId: `rpa_${now}_${randomUUID().slice(0, 8)}`,
      name,
      objective: input.objective.trim(),
      mode: input.mode ?? 'guided',
      surfaces: input.surfaces?.length ? [...new Set(input.surfaces)] : ['browser', 'desktop'],
      status: input.startUrl ? 'recording' : 'preparing',
      startUrl: input.startUrl,
      actionCount: 0,
      missingSecretBindings: 0,
      createdAt: now,
      updatedAt: now,
      actions: []
    }
    this.write(session)
    if (input.startUrl) this.launchBrowserRecording(session)
    return this.publicSession(session)
  }

  public resume(sessionId: string, startUrl?: string): RecordingSession {
    const session = this.read(sessionId)
    if (session.status === 'preparing') {
      if (!startUrl) throw new Error('start_url is required before browser recording can begin')
      session.startUrl = startUrl
      session.status = 'recording'
      session.updatedAt = Date.now()
      this.write(session)
      this.launchBrowserRecording(session)
    } else if (session.status === 'paused') {
      RpaBrowserRecorder.resume(sessionId)
      session.status = 'recording'
      session.updatedAt = Date.now()
      this.write(session)
    }
    return this.publicSession(session)
  }

  public pause(sessionId: string): RecordingSession {
    const session = this.read(sessionId)
    if (session.status !== 'recording') throw new Error(`Recording cannot be paused from ${session.status}`)
    RpaBrowserRecorder.pause(sessionId)
    session.status = 'paused'
    session.updatedAt = Date.now()
    this.write(session)
    return this.publicSession(session)
  }

  public getStatus(sessionId: string): RecordingSession {
    return this.publicSession(this.read(sessionId))
  }

  public async finish(sessionId: string): Promise<RecordingSession> {
    let session = this.read(sessionId)
    if (session.status === 'recording' || session.status === 'paused') {
      await RpaBrowserRecorder.finish(sessionId)
      const pending = this.activePromises.get(sessionId)
      if (pending) await pending
      session = this.read(sessionId)
    }
    if (session.status !== 'reviewing') {
      throw new Error(`Recording is not ready to save: ${session.status}`)
    }
    if (session.missingSecretBindings > 0) {
      throw new Error(`Recording has ${session.missingSecretBindings} sensitive inputs that require secretRef binding`)
    }
    await this.saveWorkflow(session)
    session.status = 'completed'
    session.updatedAt = Date.now()
    this.write(session)
    return this.publicSession(session)
  }

  public bindSecret(sessionId: string, selector: string, secretRef: `secret.${string}`): RecordingSession {
    if (!/^secret\.[a-z0-9][a-z0-9._-]{0,119}$/i.test(secretRef)) throw new TypeError('Invalid secretRef')
    const session = this.read(sessionId)
    if (session.status !== 'reviewing') throw new Error('Secrets can be bound after recording enters reviewing status')
    let matched = false
    session.actions = session.actions.map((action) => {
      if (action.type !== 'fill' || action.selector !== selector || !action.sensitive) return action
      matched = true
      return { ...action, valueSource: { type: 'secretRef', ref: secretRef } }
    })
    if (!matched) throw new Error(`Sensitive recorded input not found for selector: ${selector}`)
    session.missingSecretBindings = session.actions.filter(
      (action) => action.type === 'fill' && action.sensitive && action.valueSource?.type !== 'secretRef'
    ).length
    session.updatedAt = Date.now()
    this.write(session)
    return this.publicSession(session)
  }

  public async cancel(sessionId: string): Promise<RecordingSession> {
    const session = this.read(sessionId)
    await RpaBrowserRecorder.finish(sessionId)
    session.status = 'cancelled'
    session.updatedAt = Date.now()
    this.write(session)
    return this.publicSession(session)
  }

  private launchBrowserRecording(session: RecordingDocument): void {
    if (!session.startUrl || this.activePromises.has(session.id)) return
    const promise = RpaBrowserRecorder.record(session.startUrl, session.id)
    this.activePromises.set(session.id, promise)
    promise.then((actions) => {
      const latest = this.read(session.id)
      if (latest.status === 'cancelled') return
      latest.actions = this.sanitizeActions(actions)
      latest.actionCount = latest.actions.length
      latest.missingSecretBindings = latest.actions.filter((action) => action.type === 'fill' && action.sensitive).length
      latest.status = 'reviewing'
      latest.updatedAt = Date.now()
      this.write(latest)
    }).catch((error) => {
      const latest = this.read(session.id)
      latest.status = 'failed'
      latest.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      latest.updatedAt = Date.now()
      this.write(latest)
    }).finally(() => this.activePromises.delete(session.id))
  }

  private sanitizeActions(actions: BrowserRecordedAction[]): BrowserRecordedAction[] {
    return actions.slice(0, 1000).map((action) => {
      if (action.type !== 'fill' || !action.sensitive) return action
      return { type: 'fill', selector: action.selector, sensitive: true, label: action.label }
    })
  }

  private async saveWorkflow(session: RecordingDocument): Promise<void> {
    const { nodes, edges } = compileBrowserRecording(session.actions)
    await saveTaskFlow(session.workflowId, { id: session.workflowId, schemaVersion: 1, nodes, edges })
    const manifest = await loadManifest()
    const item: RpaTaskManifest = {
      id: session.workflowId,
      name: session.name,
      description: session.objective,
      lastRunStatus: 'idle',
      createdAt: new Date(session.createdAt).toISOString()
    }
    await saveManifest([item, ...manifest.filter((entry) => entry.id !== session.workflowId)])
  }

  private directory(): string { return join(app.getPath('userData'), 'rpa', 'recordings') }
  private path(sessionId: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new TypeError('Invalid recording session ID')
    return join(this.directory(), `${sessionId}.json`)
  }
  private read(sessionId: string): RecordingDocument {
    const filePath = this.path(sessionId)
    if (!existsSync(filePath)) throw new Error(`Recording session not found: ${sessionId}`)
    return JSON.parse(readFileSync(filePath, 'utf8')) as RecordingDocument
  }
  private write(session: RecordingDocument): void {
    writeTextAtomically(this.path(session.id), `${JSON.stringify(session, null, 2)}\n`)
  }
  private publicSession(session: RecordingDocument): RecordingSession {
    const { actions: _actions, ...safe } = session
    return {
      ...safe,
      pendingSecretBindings: session.actions
        .filter((action) => action.type === 'fill' && action.sensitive && action.valueSource?.type !== 'secretRef')
        .map((action) => ({ selector: action.type === 'fill' ? action.selector : '', label: action.label }))
    }
  }
}

export const recordingCoordinator = new RecordingCoordinator()

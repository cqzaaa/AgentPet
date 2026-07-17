import type {
  JsonValue,
  RpaAction,
  RpaArtifactRecord,
  RpaRunEvent,
  RpaRunEventType,
  RpaRunRecord,
  RpaRunStatus
} from '../domain/types'

export interface CreateRpaRunInput {
  id?: string
  workflowId?: string
  workflowVersion?: number
  sessionId?: string
  status?: RpaRunStatus
  inputs?: Record<string, JsonValue>
  createdAt?: number
}

export interface AppendRpaRunEventInput {
  id?: string
  runId: string
  type: RpaRunEventType
  action?: RpaAction
  payload?: JsonValue
  createdAt?: number
}

export interface UpdateRpaRunStatusInput {
  runId: string
  status: RpaRunStatus
  output?: JsonValue
  error?: JsonValue
  startedAt?: number
  finishedAt?: number
}

export interface CreateRpaArtifactInput {
  id?: string
  runId: string
  eventId?: string
  type: RpaArtifactRecord['type']
  filePath: string
  sha256?: string
  createdAt?: number
}

export interface RpaRunRepository {
  initialize(): Promise<void>
  createRun(input: CreateRpaRunInput): Promise<RpaRunRecord>
  getRun(runId: string): Promise<RpaRunRecord | null>
  updateRunStatus(input: UpdateRpaRunStatusInput): Promise<void>
  appendEvent(input: AppendRpaRunEventInput): Promise<RpaRunEvent>
  listEvents(runId: string, afterSequence?: number): Promise<RpaRunEvent[]>
  createArtifact(input: CreateRpaArtifactInput): Promise<RpaArtifactRecord>
  close(): Promise<void>
}

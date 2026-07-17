export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type RpaSecretRef = `secret.${string}`

export type RpaValueSource =
  | { type: 'literal'; value: JsonValue }
  | { type: 'variable'; name: string }
  | { type: 'secretRef'; ref: RpaSecretRef }

export type RpaSurface = 'browser' | 'desktop' | 'system' | 'agent'

export type RpaActionKind =
  | 'workflow.start'
  | 'workflow.end'
  | 'browser.open'
  | 'browser.click'
  | 'browser.fill'
  | 'browser.extract'
  | 'desktop.launch'
  | 'desktop.focus'
  | 'desktop.click'
  | 'desktop.type'
  | 'desktop.hotkey'
  | 'desktop.scroll'
  | 'system.wait'
  | 'system.condition'
  | 'system.approval'
  | 'agent.resolve'

export type RpaRiskLevel = 'read' | 'write' | 'external' | 'critical'

export interface RpaRetryPolicy {
  maxAttempts: number
  delayMs?: number
  backoffMultiplier?: number
}

/**
 * A target stores semantic locators first and coordinates only as a fallback.
 * This lets recorded workflows survive layout, resolution, and DPI changes.
 */
export interface RpaTarget {
  selector?: string
  role?: string
  name?: string
  text?: string
  windowTitle?: string
  processName?: string
  automationId?: string
  controlType?: string
  displayId?: number
  x?: number
  y?: number
}

export interface RpaAction {
  id: string
  kind: RpaActionKind
  surface: RpaSurface
  target?: RpaTarget
  input?: Record<string, JsonValue>
  timeoutMs?: number
  retry?: RpaRetryPolicy
  risk?: RpaRiskLevel
  metadata?: Record<string, JsonValue>
}

export interface RpaParameterDefinition {
  type: 'string' | 'number' | 'boolean' | 'secret' | 'file'
  description?: string
  required?: boolean
  default?: JsonValue
}

// Legacy visual-editor nodes are intentionally open-ended until each node kind
// is migrated to a discriminated data type. New runtime actions stay strict.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RpaNode<TData extends Record<string, any> = Record<string, any>> {
  id: string
  type: string
  data: TData
  position?: { x: number; y: number }
}

export interface RpaEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

/**
 * The current visual editor persists nodes and edges. Keep that representation
 * as the compatibility boundary while actions are introduced incrementally.
 */
export interface RpaTaskFlow {
  id: string
  nodes: RpaNode[]
  edges: RpaEdge[]
  schemaVersion?: number
}

export interface RpaTaskManifest {
  id: string
  name: string
  description?: string
  lastRunStatus?: RpaRunStatus
  lastRunTime?: string
  createdAt?: string
}

export interface RpaWorkflowDefinition {
  schemaVersion: 1
  id: string
  name: string
  description?: string
  version: number
  parameters: Record<string, RpaParameterDefinition>
  actions: RpaAction[]
  createdAt: number
  updatedAt: number
  metadata?: Record<string, JsonValue>
}

export type RpaRunStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'paused'
  | 'success'
  | 'failed'
  | 'cancelled'

export type RpaRunEventType =
  | 'run.created'
  | 'run.started'
  | 'run.paused'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'action.started'
  | 'action.completed'
  | 'action.failed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'artifact.created'
  | 'validation.completed'

export interface RpaRunRecord {
  id: string
  workflowId?: string
  workflowVersion?: number
  sessionId?: string
  status: RpaRunStatus
  inputs: Record<string, JsonValue>
  output?: JsonValue
  error?: JsonValue
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface RpaRunEvent {
  id: string
  runId: string
  sequence: number
  type: RpaRunEventType
  action?: RpaAction
  payload?: JsonValue
  createdAt: number
}

export interface RpaArtifactRecord {
  id: string
  runId: string
  eventId?: string
  type: 'screenshot' | 'file' | 'log'
  filePath: string
  sha256?: string
  createdAt: number
}

export type BrowserRecordedAction =
  | { type: 'open_url'; url: string; label?: string }
  | { type: 'click'; selector: string; label?: string }
  | {
      type: 'fill'
      selector: string
      value?: string
      valueSource?: RpaValueSource
      sensitive?: boolean
      label?: string
    }

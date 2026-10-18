export type WikiModelSelection =
  | { mode: 'system' }
  | { mode: 'local' }
  | { mode: 'profile'; profileId: string }

export interface WikiModelOption {
  id: string
  name: string
  provider: string
  model: string
  available: boolean
}

export interface WikiModelSettings {
  selection: WikiModelSelection
  profiles: WikiModelOption[]
  effectiveModel: WikiModelOption | null
  warning?: string
}

export interface WikiSyncProgress {
  workspaceId: string
  status: 'running' | 'completed' | 'failed'
  total: number
  completed: number
  failed: number
  currentFile: string
  updatedAt: number
  error?: string
}

export interface WikiParserComponentStatus {
  status: 'not-installed' | 'installing' | 'ready' | 'failed' | 'unsupported'
  detail: string
  updatedAt: number
}

export interface WikiEntityEvidence {
  nodeId: string | null
  title: string
  pageStart: number | null
  quote: string
}

export interface WikiEvidenceRegion {
  page: number
  // Fractions of the unrotated PDF page, measured from its top-left corner.
  x: number
  y: number
  width: number
  height: number
}

export interface WikiEvidenceLocation {
  regions: WikiEvidenceRegion[]
  reason?: string
}

export interface WikiGraphNode {
  id: string
  itemId: string | null
  label: string
  kind: string
  entityType?: string
  fileType: string
  relativePath: string
  resource?: string
  size?: number
  evidence?: WikiEntityEvidence
}

export interface WikiGraphData {
  nodes: WikiGraphNode[]
  edges: Array<{ id: string; source: string; target: string; kind: string; weight?: number }>
  entities: Array<{ id: string; name: string; type: string; mentionCount: number; confidence: number; evidence: WikiEntityEvidence[] }>
  sources: Array<{
    id: string; itemId: string; resource: string; relativePath: string
    startLine: number | null; endLine: number | null; claimId: string
    statement: string; version: string; status: 'linked' | 'verified' | 'missing'
  }>
  relatedItems: Array<{ id: string; title: string; relativePath: string; fileType: string; sharedEntities: string[]; sharedSources: string[]; directLink: boolean }>
  backlinks: Array<{ id: string; title: string; relativePath: string; fileType: string }>
  unresolved: Array<{ id: string; fromItemId: string; targetText: string }>
  truncated?: boolean
}

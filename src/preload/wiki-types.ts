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

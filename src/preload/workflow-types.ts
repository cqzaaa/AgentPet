export interface WorkflowCondition {
  source: string
  path: string
  operator: 'equals' | 'not_equals' | 'contains' | 'greater' | 'exists'
  value: string
}

export interface WorkflowControl {
  kind: 'agent' | 'condition' | 'rpa'
  rpaTaskId?: string
  condition?: WorkflowCondition
  branches?: Record<string, 'true' | 'false'>
  repeat?: number
}

export interface WorkflowNode {
  id: string
  type?: string
  position: { x: number; y: number }
  data: {
    title: string
    prompt: string
    agentId: string
    agentName: string
    model?: string
    control?: WorkflowControl
    [key: string]: unknown
  }
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface WorkflowDefinition {
  id: string
  title: string
  goal: string
  workspacePath: string
  maxConcurrency: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  createdAt: number
  updatedAt: number
}

export type WorkflowDraft = Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
  updatedAt?: number
}

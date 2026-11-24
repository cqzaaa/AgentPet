export interface ReasoningEffortOption {
  value: string
  description?: string
}

export interface ModelReasoningOptions {
  reasoningEfforts?: ReasoningEffortOption[]
  defaultReasoningEffort?: string
}

export interface ClarificationOption extends ModelReasoningOptions {
  label: string
  value: string
  description?: string
}

export interface ClarificationQuestion {
  id: string
  question: string
  options?: ClarificationOption[]
  agentId?: string
  allowCustom?: boolean
  placeholder?: string
}

export type ClarificationAnswers = Record<string, string | {
  agentId: string
  model: string
  reasoningEffort?: string
}>

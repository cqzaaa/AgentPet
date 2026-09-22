import { countTokens } from '../tools/context/token-counter'

export type SkillLoadBudget = {
  remainingTokens: number
  /** Only keys whose full instructions are retained in this execution's system context. */
  loadedKeys: Set<string>
}

export function availableSkillTokens(contextWindow: number, messages: unknown[], tools: unknown[], maxOutputTokens?: number): number {
  const used = countTokens(JSON.stringify(messages)) + countTokens(JSON.stringify(tools))
  const outputReserve = Math.max(4096, maxOutputTokens || 0)
  const toolReserve = Math.max(4096, Math.ceil(contextWindow * 0.08))
  const estimationMargin = Math.ceil(contextWindow * 0.1)
  return Math.max(0, Math.floor(contextWindow - used - outputReserve - toolReserve - estimationMargin))
}

export function skillInstructionTokens(instructions: string): number {
  // Account for serialization, wrapper metadata and approximate tokenizer variance.
  return Math.ceil(countTokens(JSON.stringify(instructions)) * 1.15) + 256
}

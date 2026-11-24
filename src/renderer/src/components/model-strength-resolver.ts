import { IMAGE_MODEL_REGEX } from '../../../preload/image-generation-types'
import type { ClarificationQuestion } from '../../../preload/agent-model-types'

export function isImageModelSelectionQuestion(question: ClarificationQuestion): boolean {
  if (!question.options?.length || question.agentId) return false
  const text = `${question.id} ${question.question}`
  return /image_model|生图|图片模型|画图|paint|drawing|text2img|t2i/i.test(text) ||
    question.options.every(option => IMAGE_MODEL_REGEX.test(option.value))
}

export function isModelSelectionQuestion(question: ClarificationQuestion): boolean {
  if (!question.options?.length) return false
  if (question.agentId) return true
  if (isImageModelSelectionQuestion(question)) return false
  const text = `${question.id} ${question.question}`
  return /model|模型|codex|claude|gemini|gpt|subagent/i.test(text) ||
    question.options.some(option =>
      /gpt|claude|sonnet|opus|haiku|gemini|deepseek|sol|terra|luna|astra|o1|o3|o4/i.test(option.value)
    )
}

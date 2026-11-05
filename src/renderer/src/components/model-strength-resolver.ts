import { IMAGE_MODEL_REGEX } from '../../../preload/image-generation-types'

export type ReasoningStrengthLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface ModelOption {
  label: string
  value: string
  description?: string
}

export interface ResolvedModelItem {
  id: string
  label: string
  description?: string
  provider: 'openai' | 'codex' | 'claude' | 'gemini' | 'deepseek' | 'other'
  defaultLevel: ReasoningStrengthLevel
  supportedLevels: ReasoningStrengthLevel[]
}

export const STRENGTH_LEVEL_LABELS: Record<ReasoningStrengthLevel, string> = {
  off: '关闭 / 极速',
  low: '低',
  medium: '中',
  high: '高',
  max: '极高 / 深度'
}

export const ALL_STRENGTH_LEVELS: ReasoningStrengthLevel[] = ['off', 'low', 'medium', 'high', 'max']

export function isImageModelSelectionQuestion(question: { id: string; question: string; options?: ModelOption[] }): boolean {
  if (!question.options || question.options.length === 0) return false
  const text = `${question.id} ${question.question}`.toLowerCase()
  if (/image_model|生图|图片模型|画图|paint|drawing|text2img|t2i/i.test(text)) return true
  return question.options.length > 0 && question.options.every(opt => IMAGE_MODEL_REGEX.test(opt.value))
}

export function isModelSelectionQuestion(question: { id: string; question: string; options?: ModelOption[] }): boolean {
  if (!question.options || question.options.length === 0) return false
  // 生图模型不属于文本思考强度调节模型，改由直观卡片选项呈现
  if (isImageModelSelectionQuestion(question)) return false
  const text = `${question.id} ${question.question}`.toLowerCase()
  const isModelQuery = /model|模型|codex|claude|gemini|gpt|subagent/i.test(text)
  const optionsLookLikeModels = question.options.some(opt =>
    /gpt|claude|sonnet|opus|haiku|gemini|deepseek|sol|terra|luna|astra|o1|o3|o4/i.test(opt.value)
  )
  return isModelQuery || optionsLookLikeModels
}

/**
 * 清洗模型名称：剔除括号及括号内的中文说明（如 "(主力高强度)" -> ""）
 */
export function cleanModelLabel(rawLabel: string): string {
  if (!rawLabel) return ''
  // 移除中文括号 （...） 和英文括号 (...)
  return rawLabel.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
}

/**
 * 将原始传入的各种子模型解析为带有 Provider、展示标签、推荐档位的完整模型清单
 */
export function resolveModelItems(options: ModelOption[]): ResolvedModelItem[] {
  return options.map((opt) => {
    const rawVal = opt.value.trim()
    const lower = rawVal.toLowerCase()

    let provider: ResolvedModelItem['provider'] = 'other'
    let defaultLevel: ReasoningStrengthLevel = 'medium'

    // 1. 判断所属生态/Provider
    if (lower.includes('claude') || lower === 'sonnet' || lower === 'opus' || lower === 'haiku') {
      provider = 'claude'
      if (lower.includes('opus')) defaultLevel = 'max'
      else if (lower.includes('haiku')) defaultLevel = 'low'
      else defaultLevel = 'high'
    } else if (lower.includes('gemini')) {
      provider = 'gemini'
      if (lower.includes('pro')) defaultLevel = lower.includes('thinking') ? 'max' : 'high'
      else if (lower.includes('flash')) defaultLevel = lower.includes('thinking') ? 'high' : 'medium'
      else if (lower.includes('lite') || lower.includes('8b')) defaultLevel = 'low'
    } else if (lower.includes('gpt') || lower.includes('sol') || lower.includes('terra') || lower.includes('luna') || lower.includes('astra')) {
      provider = 'codex'
      if (lower.includes('astra')) defaultLevel = 'max'
      else if (lower.includes('sol')) defaultLevel = 'high'
      else if (lower.includes('terra')) defaultLevel = 'medium'
      else if (lower.includes('luna')) defaultLevel = 'low'
    } else if (lower.includes('deepseek')) {
      provider = 'deepseek'
      defaultLevel = lower.includes('r1') || lower.includes('reasoner') ? 'max' : 'medium'
    }

    // 显式修饰词再次校准
    if (lower.includes('high') || lower.includes('max') || lower.includes('ultra')) defaultLevel = 'high'
    if (lower.includes('low') || lower.includes('mini')) defaultLevel = 'low'
    if (lower.includes('off') || lower.includes('instant') || lower.includes('turbo')) defaultLevel = 'off'

    return {
      id: rawVal,
      label: cleanModelLabel(opt.label) || rawVal,
      description: opt.description,
      provider,
      defaultLevel,
      supportedLevels: ALL_STRENGTH_LEVELS
    }
  })
}

/**
 * 在选定具体模型时，根据当前强度滑块档位计算出目标模型 ID
 * 方案 A：解除偷换模型联动，无论滑块处于什么档位，均保持用户所选的模型 ID 绝对稳定不变
 */
export function resolveTargetModelIdWithStrength(
  currentModelId: string,
  _targetLevel: ReasoningStrengthLevel,
  _allOptions: ModelOption[]
): string {
  return currentModelId
}

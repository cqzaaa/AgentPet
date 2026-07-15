import openai from '@lobehub/icons-static-svg/icons/openai.svg'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg'
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import google from '@lobehub/icons-static-svg/icons/google-color.svg'
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg'
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg'
import zhipu from '@lobehub/icons-static-svg/icons/zhipu-color.svg'
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg'
import spark from '@lobehub/icons-static-svg/icons/spark-color.svg'
import hunyuan from '@lobehub/icons-static-svg/icons/hunyuan-color.svg'
import baichuan from '@lobehub/icons-static-svg/icons/baichuan-color.svg'
import minimax from '@lobehub/icons-static-svg/icons/minimax-color.svg'
import stepfun from '@lobehub/icons-static-svg/icons/stepfun-color.svg'
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg'
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg'
import gemma from '@lobehub/icons-static-svg/icons/gemma-color.svg'
import yi from '@lobehub/icons-static-svg/icons/yi-color.svg'
import grok from '@lobehub/icons-static-svg/icons/grok.svg'
import xai from '@lobehub/icons-static-svg/icons/xai.svg'
import lobehub from '@lobehub/icons-static-svg/icons/lobehub-color.svg'

// 提供商及厂商图标映射
export const PROVIDER_ICON_MAP: Record<string, string> = {
  openai,
  deepseek,
  gemini,
  google,
  claude,
  anthropic: claude,
  ollama,
  qwen,
  zhipu,
  moonshot,
  kimi: moonshot,
  spark,
  hunyuan,
  baichuan,
  minimax,
  stepfun,
  meta,
  llama: meta,
  mistral,
  gemma,
  yi,
  grok,
  xai,
  custom: lobehub
}

/**
 * 根据大模型提供商获取对应厂商的官方图标
 * @param provider 提供商名字 (例如: 'gemini', 'deepseek', 'openai', 'ollama', 'custom')
 */
export function getProviderIcon(provider: string): string {
  const prov = provider.toLowerCase()
  return PROVIDER_ICON_MAP[prov] || PROVIDER_ICON_MAP.custom
}

/**
 * 根据模型名称和提供商，智能匹配获取对应厂商的官方图标
 * @param modelName 模型名称 (例如: 'gpt-4o', 'gemini-1.5-pro', 'deepseek-chat')
 * @param provider 大模型提供商
 */
export function getModelIcon(modelName: string, provider: string): string {
  const name = modelName.toLowerCase()
  const prov = provider.toLowerCase()

  // 1. 根据模型名称中含有的关键字进行强匹配
  if (name.includes('gpt') || name.includes('o1') || name.includes('o3') || name.includes('openai')) {
    return PROVIDER_ICON_MAP.openai
  }
  if (name.includes('claude') || name.includes('anthropic')) {
    return PROVIDER_ICON_MAP.claude
  }
  if (name.includes('gemini')) {
    return PROVIDER_ICON_MAP.gemini
  }
  if (name.includes('gemma')) {
    return PROVIDER_ICON_MAP.gemma
  }
  if (name.includes('deepseek')) {
    return PROVIDER_ICON_MAP.deepseek
  }
  if (name.includes('qwen') || name.includes('qianwen') || name.includes('tongyi')) {
    return PROVIDER_ICON_MAP.qwen
  }
  if (name.includes('glm') || name.includes('zhipu') || name.includes('cogview') || name.includes('characterglm')) {
    return PROVIDER_ICON_MAP.zhipu
  }
  if (name.includes('kimi') || name.includes('moonshot')) {
    return PROVIDER_ICON_MAP.moonshot
  }
  if (name.includes('spark') || name.includes('xunfei') || name.includes('xfyun')) {
    return PROVIDER_ICON_MAP.spark
  }
  if (name.includes('hunyuan')) {
    return PROVIDER_ICON_MAP.hunyuan
  }
  if (name.includes('baichuan')) {
    return PROVIDER_ICON_MAP.baichuan
  }
  if (name.includes('minimax') || name.includes('abab')) {
    return PROVIDER_ICON_MAP.minimax
  }
  if (name.includes('step') || name.includes('jieyue')) {
    return PROVIDER_ICON_MAP.stepfun
  }
  if (name.includes('llama') || name.includes('meta')) {
    return PROVIDER_ICON_MAP.meta
  }
  if (name.includes('mistral') || name.includes('codestral') || name.includes('mixtral')) {
    return PROVIDER_ICON_MAP.mistral
  }
  if (name.includes('yi-') || name.includes('01.ai') || name.includes('yi')) {
    return PROVIDER_ICON_MAP.yi
  }
  if (name.includes('grok')) {
    return PROVIDER_ICON_MAP.grok
  }
  if (name.includes('xai')) {
    return PROVIDER_ICON_MAP.xai
  }

  // 2. 如果模型名无法匹配，根据 provider 进行匹配
  if (PROVIDER_ICON_MAP[prov]) {
    return PROVIDER_ICON_MAP[prov]
  }

  // 3. 兜底
  return PROVIDER_ICON_MAP.custom
}

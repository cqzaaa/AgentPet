export interface ImageGenerationOptions {
  prompt: string
  imagePath?: string
  model?: string
  size?: string
  config?: {
    apiKey?: string
    baseUrl?: string
  }
}

export interface ImageGenerationResult {
  success: boolean
  model?: string
  imagePath?: string
  dataUrl?: string
  error?: string
  revisedPrompt?: string
}

export const IMAGE_MODEL_REGEX =
  /(?:image|imagen|\bimg\b|nano-?banana|grok-?imagine|imagine|mai-?image|muse-?image|flux|recraft|dall-?e|dalle|gpt-?image|gpt-?img|stable-?diffusion|\bsd(?:xl|[0-9]|\b)|ideogram|midjourney|\bmj\b|niji|firefly|phoenix|leonardo|seedream|jimeng|wanxiang|wanx|kolors|kling|cogview|hunyuan-?(?:image|dit)|doubao-?image|minimax-?image|step-?image|wenxin|yige|auraflow|lumina|hidream|pixart|omnigen|sana|bria|artguru|wombo|lexica|aperture|t2i|text-?to-?image|text2img|paint|drawing|render)/i

export function filterImageModels(models: string[]): string[] {
  return models.filter((m) => IMAGE_MODEL_REGEX.test(m))
}

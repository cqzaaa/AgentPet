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
  imagePath?: string
  dataUrl?: string
  error?: string
  revisedPrompt?: string
}

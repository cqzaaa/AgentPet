import { ModelProvider } from './types'
import {
  OpenAIProvider,
  GeminiProvider,
  DeepSeekProvider,
  OllamaProvider,
  CustomProvider
} from './providers'

export * from './types'

export class ModelRuntimeFactory {
  public static getProvider(
    provider: string,
    apiKey: string,
    baseUrl: string
  ): ModelProvider {
    const normProvider = (provider || '').toLowerCase().trim()
    switch (normProvider) {
      case 'openai':
        return new OpenAIProvider(apiKey, baseUrl)
      case 'gemini':
        return new GeminiProvider(apiKey, baseUrl)
      case 'deepseek':
        return new DeepSeekProvider(apiKey, baseUrl)
      case 'ollama':
        return new OllamaProvider(apiKey, baseUrl)
      default:
        return new CustomProvider(apiKey, baseUrl)
    }
  }
}

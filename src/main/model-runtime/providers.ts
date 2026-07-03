import { net } from 'electron'
import { ChatMessage, ChatOptions, ModelProvider } from './types'

export class OpenAICompatibleProvider implements ModelProvider {
  protected defaultBaseUrl: string = ''
  protected defaultModel: string = ''

  constructor(
    protected apiKey: string,
    protected baseUrl: string
  ) {}

  public async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatMessage> {
    const cleanApiKey = (this.apiKey || '').trim()
    const cleanBaseUrl = (this.baseUrl || this.defaultBaseUrl || '').trim().replace(/\/+$/, '')

    let url = `${cleanBaseUrl}/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (cleanApiKey) {
      headers['Authorization'] = `Bearer ${cleanApiKey}`
    }

    const requestBody: any = {
      model: options.model || this.defaultModel,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {})
      })),
      temperature: options.temperature ?? 0.7
    }

    if (options.maxTokens) {
      requestBody.max_tokens = options.maxTokens
    }

    if (options.tools && options.tools.length > 0) {
      requestBody.tools = options.tools
      requestBody.tool_choice = options.tool_choice || 'auto'
    }

    const response = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: options.signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      let displayError = errorText

      if (displayError.trim().toLowerCase().startsWith('<!doctype html') || displayError.toLowerCase().includes('<html')) {
        displayError = '服务端返回了 HTML 页面而非有效的 API 响应（通常是因为 Base URL 配置错误，例如填入了网页地址而非 API 接口地址）。请检查设置中的大模型 Base URL。'
      } else {
        try {
          const errObj = JSON.parse(errorText)
          if (errObj.error && errObj.error.message) {
            displayError = errObj.error.message
          }
        } catch (e) {
          // 忽略解析错误
        }
        if (displayError.length > 500) {
          displayError = displayError.substring(0, 500) + '... (省略过多内容)'
        }
      }

      if (response.status >= 500) {
        throw new Error(`[大模型服务端故障] 服务器遇到内部错误 (HTTP ${response.status})。可能是中转节点宕机或模型过载，请稍后重试。详情: ${displayError}`)
      } else if (response.status === 401 || response.status === 403) {
        throw new Error(`[鉴权失败] API Key 可能无效、未授权或已欠费 (HTTP ${response.status})。详情: ${displayError}`)
      } else if (response.status === 429) {
        throw new Error(`[请求限流] 您的请求过于频繁或额度已耗尽 (HTTP 429)。详情: ${displayError}`)
      }

      throw new Error(`HTTP ${response.status}: ${displayError}`)
    }

    const data: any = await response.json()
    const choice = data.choices?.[0]
    const message = choice?.message

    if (!message) {
      throw new Error('未获取到有效的模型答复结构')
    }

    let reasoning_content = message.reasoning_content || ''
    let content = message.content || ''

    if (!reasoning_content && content) {
      const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i)
      if (thinkMatch) {
        reasoning_content = thinkMatch[1].trim()
      }
    }

    const resultMessage: ChatMessage = {
      role: 'assistant',
      content,
      tool_calls: message.tool_calls,
      reasoning_content
    }

    if (data.usage) {
      resultMessage.usage = {
        prompt_tokens: data.usage.prompt_tokens || 0,
        completion_tokens: data.usage.completion_tokens || 0
      }
    }

    return resultMessage
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  protected defaultBaseUrl = 'https://api.openai.com/v1'
  protected defaultModel = 'gpt-4o-mini'
}

export class GeminiProvider extends OpenAICompatibleProvider {
  protected defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
  protected defaultModel = 'gemini-1.5-flash'
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  protected defaultBaseUrl = 'https://api.deepseek.com/v1'
  protected defaultModel = 'deepseek-chat'
}

export class OllamaProvider extends OpenAICompatibleProvider {
  protected defaultBaseUrl = 'http://localhost:11434/v1'
  protected defaultModel = 'llama3'
}

export class CustomProvider extends OpenAICompatibleProvider {
  // 遵循完全自定义的 baseUrl 与 model 行为
}

import * as fs from 'fs'
import { join } from 'path'
import { ModelRuntimeFactory, ChatMessage, ChatOptions } from '../model-runtime'
import { AgentStepEvent } from './types'
import { getActiveStorageDir } from '../tools/utils/paths'
import { toolRegistry } from '../tools/core/tool-registry'
import { mcpManager } from '../tools/mcp/mcp-manager'
import { unifiedToolExecutor } from '../tools/core/tool-executor'
import { runPurifyMemoryPipeline, appendMemorySummaryInternal } from '../api/memory'
import { sshManager } from '../tools/builtin/terminal/ssh-manager'

type WebMemorySource = {
  id: string
  title: string
  url: string
}

function getActiveChatDir(): string {
  const base = getActiveStorageDir()
  const dir = join(base, 'chat')
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {
      console.error('创建 chat 文件夹失败', e)
    }
  }
  return dir
}

export class AgentExecutor {
  private toolListCache: { full?: any[], simplified?: any[] } = {}

  private getToolImagePaths(state: any): string[] {
    const candidates = [
      state?.filePath,
      state?.imagePath,
      ...(Array.isArray(state?.imagePaths) ? state.imagePaths : [])
    ]
    return candidates
      .filter((filePath: unknown): filePath is string => typeof filePath === 'string' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(filePath))
      .filter(filePath => {
        try {
          return fs.existsSync(filePath)
        } catch {
          return false
        }
      })
  }

  private buildToolImageBlocks(filePaths: string[]): any[] {
    const blocks: any[] = []
    for (const filePath of filePaths) {
      try {
        const buffer = fs.readFileSync(filePath)
        let ext = filePath.split('.').pop()?.toLowerCase() || 'png'
        if (ext === 'jpg') ext = 'jpeg'
        const mimeType = `image/${ext}`
        blocks.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` }
        })
      } catch (err) {
        console.error('[AgentExecutor] 读取工具截图给大模型失败:', err)
      }
    }
    return blocks
  }

  private stripImageBlocksForCompatibility(messages: ChatMessage[]): number {
    let removedImages = 0
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue
      const images = message.content.filter((block: any) => block?.type === 'image_url')
      if (images.length === 0) continue
      removedImages += images.length
      const text = message.content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .filter((value: string) => value.trim())
        .join('\n\n')
      message.content = [
        text,
        '[系统提示] 当前模型接口不接受图片输入，图片已自动跳过。请基于工具返回的结构化检查、行数、单元格和验证结果继续完成任务，并明确说明视觉检查已降级。'
      ]
        .filter(Boolean)
        .join('\n\n')
    }
    return removedImages
  }

  /**
   * Web citations are transient during an agent run. Before persisting a memory,
   * turn its stable source ids into links and retain a small source index so the
   * markdown remains auditable after the chat UI has gone away.
   */
  private attachWebSourcesToMemory(content: string, sources: WebMemorySource[]): {
    content: string
    sourceIndex: string
  } {
    const sourceById = new Map(
      sources
        .filter(source => /^https?:\/\//i.test(source.url))
        .map(source => [source.id, source])
    )

    const referencedIds = new Set<string>()
    for (const match of content.matchAll(/\bS(\d+)\b/g)) {
      const id = `S${match[1]}`
      if (sourceById.has(id)) referencedIds.add(id)
    }

    const linkedContent = content.replace(/\[S(\d+)\](?!\()/g, (citation, number) => {
      const source = sourceById.get(`S${number}`)
      return source ? `[${citation}](<${source.url}>)` : citation
    })

    if (referencedIds.size === 0) return { content: linkedContent, sourceIndex: '' }

    const sourceIndex = [...referencedIds]
      .map(id => {
        const source = sourceById.get(id)!
        const title = (source.title || id).replace(/[\[\]]/g, '')
        return `- [${id} · ${title}](<${source.url}>)`
      })
      .join('\n')

    return {
      content: linkedContent,
      sourceIndex: `\n\n---\n### 网络来源（可验证）\n${sourceIndex}`
    }
  }

  private getFormattedTools(_isFrontend: boolean, simplify = false): any[] {
    const cacheKey = simplify ? 'simplified' : 'full' as const
    const cached = this.toolListCache[cacheKey]
    if (cached) return cached

    const list: any[] = []

    // 从 toolRegistry 获取所有内置工具定义
    const allTools = toolRegistry.getAllToolsInfo()
    for (const tool of Object.values(allTools)) {
      list.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      })
    }

    // 添加 MCP 外部工具
    const mcpTools = mcpManager.getTools()
    for (const tool of mcpTools) {
      list.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: simplify ? { type: 'object', properties: {} } : (tool.inputSchema || { type: 'object', properties: {} })
        }
      })
    }

    this.toolListCache[cacheKey] = list
    return list
  }

  private getFullToolDefinitionByName(name: string, isFrontend: boolean): any | null {
    const fullTools = this.getFormattedTools(isFrontend, false)
    return fullTools.find((t: any) => t.function.name === name) || null
  }

  /** Keep the parameter prompt small while retaining enough structure to validate a call. */
  private compactJsonSchema(schema: any, depth = 0): any {
    if (!schema || typeof schema !== 'object' || depth > 4) return {}

    const compact: any = {}
    if (typeof schema.type === 'string') compact.type = schema.type
    if (typeof schema.description === 'string') compact.description = schema.description.slice(0, 160)
    if (Array.isArray(schema.enum)) compact.enum = schema.enum.slice(0, 20)
    if (Array.isArray(schema.required) && schema.required.length > 0) compact.required = schema.required
    if (schema.items) compact.items = this.compactJsonSchema(schema.items, depth + 1)
    if (schema.properties && typeof schema.properties === 'object') {
      compact.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [key, this.compactJsonSchema(value, depth + 1)])
      )
    }
    return compact
  }

  private parseJsonObject(content: unknown): Record<string, any> | null {
    if (typeof content !== 'string') return null
    const candidates = [
      content.trim(),
      content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    ]

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch {
        // Try the next representation, including a fenced JSON response.
      }
    }
    return null
  }

  private hasValidToolArguments(args: unknown, schema: any): args is Record<string, any> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false
    const objectArgs = args as Record<string, any>
    const required = Array.isArray(schema?.required) ? schema.required : []
    if (required.some((key: string) => objectArgs[key] === undefined || objectArgs[key] === null || objectArgs[key] === '')) return false

    for (const [key, value] of Object.entries(objectArgs)) {
      const propertySchema = schema?.properties?.[key]
      if (!propertySchema || value === undefined || value === null) continue
      const type = propertySchema.type
      if ((type === 'string' && typeof value !== 'string') ||
          (type === 'number' && typeof value !== 'number') ||
          (type === 'integer' && (!Number.isInteger(value))) ||
          (type === 'boolean' && typeof value !== 'boolean') ||
          (type === 'array' && !Array.isArray(value)) ||
          (type === 'object' && (typeof value !== 'object' || Array.isArray(value)))) return false
    }
    return true
  }

  private async handleLongTaskAutoMemory(
    sessionId: string,
    chatHistory: ChatMessage[],
    config: { provider: string; apiKey: string; baseUrl: string; model: string; temperature: number },
    finalResponse?: string,
    webSources: WebMemorySource[] = []
  ) {
    try {
      if (!sessionId) return
      console.log('[Memory] 开始为长任务会话生成自动总结:', sessionId)

      let chatLogs = ''
      for (const msg of chatHistory) {
        if (msg.role === 'system') continue
        const contentStr = Array.isArray(msg.content)
          ? msg.content.map((b: any) => b.text || '').join('')
          : (msg.content || '')
        chatLogs += `${msg.role === 'user' ? '用户' : '助手'}: ${contentStr}\n`
      }

      const summarySystemPrompt = `你是一个经验丰富的 AI 对话与开发任务总结助手。
请你仔细阅读以下【一轮包含了用户提问、助手回答及本地系统工具调用的对话日志】，并为他们生成一段精炼、实用的 Markdown 摘要与知识沉淀。

你必须输出以下两个部分：
1. 【主题】：为本次长任务起一个清晰的主题名称（如：“Electron SQLite 数据库新增 link 字段升级”、“使用 ripgrep 实现多路混合记忆召回”等，禁止带日期，只要主题名，不超过 20 字）。
2. 【总结内容】：详细梳理出：
   - 核心任务与解决过程。
   - 成功经验与关键代码。
   - 纠错避坑（若有报错，为什么报错，怎么解决的）。
3. **字数严格限制**：【总结内容】的字数必须控制在 800 字以内，简明扼要，直击重点，剔除任何修饰性词汇。
4. **精准 Wiki 溯源**：如果对话日志中助手参考了特定的本地文件或缓存文档路径（日志中可能已有 \`<!-- 关联文件: ... -->\` 注释），在总结对应要点时，请务必在这句话的末尾**原样保留或加上**该 HTML 注释文件引用，以实现知识到文件的精准溯源。
5. **网页来源**：引用网页事实时，只能使用对话日志中出现过的 \`[S数字]\` 标识，不得编造来源名或编号。系统会在保存时将有效标识转为可点击链接并附上来源索引。
6. 你的格式必须是 JSON 格式，包含 title 和 content 字段，示例如下：
{
  "title": "主题名",
  "content": "### 💡 核心知识与经验沉淀\\n...（在具体总结的句尾保留 <!-- 关联文件: xxx --> 注释）"
}
请不要输出任何 Markdown 标记或多余的解释，只输出合法的 JSON 本身。`

      const messages: ChatMessage[] = [
        { role: 'system', content: summarySystemPrompt },
        { role: 'user', content: `【对话日志】\\n${chatLogs}\\n\\n请进行总结。` }
      ]

      const modelProvider = ModelRuntimeFactory.getProvider(config.provider, config.apiKey, config.baseUrl)
      const response = await modelProvider.chat(messages, {
        model: config.model,
        temperature: config.temperature
      })

      const responseText = typeof response.content === 'string' ? response.content.trim() : ''

      let jsonStr = responseText
      if (jsonStr.startsWith('```')) {
        const lines = jsonStr.split('\n')
        if (lines[0].trim().startsWith('```')) {
          lines.shift()
        }
        if (lines[lines.length - 1].trim().startsWith('```')) {
          lines.pop()
        }
        jsonStr = lines.join('\n').trim()
      }

      const summaryData = JSON.parse(jsonStr)
      if (summaryData.title && summaryData.content) {
        const summaryWithSources = this.attachWebSourcesToMemory(String(summaryData.content), webSources)
        const backupWithSources = this.attachWebSourcesToMemory(finalResponse || '', webSources)
        // 提取用户最开始的提问内容
        const firstUserMsg = chatHistory.find(m => m.role === 'user')
        const firstUserText = firstUserMsg
          ? (Array.isArray(firstUserMsg.content)
              ? firstUserMsg.content.map((b: any) => b.text || '').join('')
              : (firstUserMsg.content || ''))
          : ''

        let backupDialogStr = '\n\n---\n<details>\n<summary>展开查看本次对话原始备份</summary>\n\n'
        backupDialogStr += `**用户 (User)**:\n${firstUserText}\n\n`
        backupDialogStr += `**助手 (Agent)**:\n${backupWithSources.content}\n\n`
        backupDialogStr += '</details>'

        const sourceIndex = this.attachWebSourcesToMemory(
          `${summaryData.content}\n${finalResponse || ''}`,
          webSources
        ).sourceIndex
        await appendMemorySummaryInternal(sessionId, summaryData.title, summaryWithSources.content + backupDialogStr + sourceIndex)
        console.log('[Memory] 长任务自动经验总结完成并已保存。主题:', summaryData.title)
      } else {
        console.warn('[Memory] 长任务自动经验沉淀返回的 JSON 结构不正确:', responseText)
      }
    } catch (err) {
      console.error('[Memory] 长任务自动经验沉淀失败:', err)
    }
  }

  public async *run(
    config: {
      provider: string
      apiKey: string
      baseUrl: string
      model: string
      temperature: number
      maxTokens?: number
      sessionId?: string
      messageId?: number
      isBackground?: boolean
      sandboxMode?: boolean
      event?: Electron.IpcMainInvokeEvent
    },
    messages: ChatMessage[],
    workspacePath?: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<AgentStepEvent, string, unknown> {
    const { provider, apiKey, baseUrl, model, temperature, maxTokens, sessionId, sandboxMode, event } = config
    const isFrontend = !config.isBackground

    let chatHistory: ChatMessage[] = JSON.parse(JSON.stringify(messages))
    let webSourceCounter = 0
    const availableWebSourceIds = new Set<string>()
    const webSourcesForMemory: WebMemorySource[] = []
    const executedWebSearchQueries = new Set<string>()
    chatHistory.unshift({
      role: 'system',
      content: [
        '[交互控件规则]',
        'request_user_clarification 是可选的交互控件：当你判断用卡片能让用户更清楚地补充信息、选择范围、确认对象或继续普通追问时，可以主动调用。',
        '如果用户的问题已经足够明确，请先直接回答；不要因为程序规则而把普通文本强制转换成卡片。',
        '普通文本和提问控件都可以用于追问；由你根据当前上下文、用户体验和任务是否需要继续来判断。'
      ].join('\n')
    })

    if (sessionId) {
      const chatDir = getActiveChatDir()
      const safeSessionId = sessionId.replace(/[<>:"/\\|?*]/g, '_')
      const cacheDir = join(chatDir, safeSessionId, '.agentpet_cache')
      let extraContext = `

[本地文件定位规则]
1. 用户只提供文件名（例如“帮我找 erro.txt”）而没有说明目录时，不要猜测文件在其他磁盘，也不要在磁盘间自动切换。
2. 先检查当前会话附件目录和用户已明确授权的目录。若信息不足，必须调用 request_user_clarification。问题、选项和输入提示必须由当前任务及已有上下文决定，不得使用固定问题或固定选项。
3. 搜索超时只表示范围过大，绝不表示文件不存在。必须留在同一范围内缩小搜索；仍无法缩小范围时，调用 request_user_clarification 请求最有帮助的线索，而不是改搜其他磁盘。
4. 找文件名优先调用 find_files；找到候选后再用 get_file_metadata 或 read_file 验证。`

      // 1. 扫描离线网页/文档缓存
      if (fs.existsSync(cacheDir)) {
        try {
          const cacheFiles = await fs.promises.readdir(cacheDir)
          const mdCaches = cacheFiles.filter(f => f.toLowerCase().endsWith('.md'))
          if (mdCaches.length > 0) {
            extraContext += `\n\n[本地已缓存的离线网页/文档]\n当前会话下已为您抓取并缓存了以下本地网页文件：\n`
            for (const file of mdCaches) {
              const relPath = `.agentpet_cache/${file}`
              extraContext += `- 离线网页缓存: \`${relPath}\` (文件名: \`${file}\`)\n`
            }
            extraContext += `\n[网页抓取与阅读硬约束原则]：
1. 当主人的问题与上述已缓存的离线网页文件相关时，你【必须且只能】优先使用 \`read_file\` 工具读取，或使用 \`grep_content\` 检索对应的本地缓存文件。
2. 当你调用 \`web_fetch\` 抓取新网页后，若因为网页过长被系统截断（提示被截断或预览不足），你【必须且立即】使用 \`read_file\` 工具传入刚才抓取生成的本地缓存相对路径来读取全文。
3. 非必要【严禁】重复调用 \`web_fetch\` 或 \`web_search\` 去重复联网下载相同的网址或检索相同内容！\n`
          }
        } catch (err) {
          console.error('[callLlmInternal] 扫描离线网页缓存失败:', err)
        }
      }

      // 2. 检测远程 SSH 连接状态并注入系统提示
      const isSshMode = sshManager.getDeviceType(sessionId) === 'ssh'
      const sshStatus = sshManager.getStatus(sessionId)
      if (isSshMode && sshStatus.connected) {
        extraContext += `\n\n[系统状态：当前已开启远程 SSH 执行模式]
- 远程主机: \`${sshStatus.host}\`
- 登录账号: \`${sshStatus.username}\`
- 硬性约束原则：
  1. 您当前被设置为远程 SSH 操作设备。您调用的终端/命令行工具（如 \`run_command\`, \`execute_async_command\`）将在该 SSH 连接的目标服务器上执行，而非本地电脑。
  2. 远程服务器一般是 Linux 系统，您编写命令时必须使用目标操作系统兼容的 Shell 指令（如 \`ls\`, \`pwd\`, \`cat\`, \`grep\`, \`ip a\` 等），严禁使用 Windows 专用的 CMD/PowerShell 命令。
  3. 执行任务前，建议您先运行一次 \`uname -a\` 或 \`cat /etc/os-release\` 以探测并明确服务器的具体 OS 发行版和基础配置信息。`
      }

      // 3. 注入已启用的外部 MCP 工具提示
      const mcpTools = mcpManager.getTools()
      if (mcpTools.length > 0) {
        extraContext += `\n\n[系统状态：当前已挂载外部扩展工具 (MCP)]
- 你的系统已通过 Model Context Protocol (MCP) 扩展协议接入了以下外部工具。
- 用户可以直接要求你使用它们，大模型在遇到相关需求时也应主动调用。
- 已挂载扩展工具列表：
`
        for (const t of mcpTools) {
          extraContext += `- 工具名称: \`${t.name}\` | 功能描述: ${t.description || '暂无描述'}\n`
        }
      }

      if (extraContext) {
        const systemMsg = chatHistory.find((m: any) => m.role === 'system')
        if (systemMsg) {
          if (typeof systemMsg.content === 'string') {
            systemMsg.content += extraContext
          } else if (Array.isArray(systemMsg.content)) {
            systemMsg.content.push({ type: 'text', text: extraContext })
          }
        } else {
          chatHistory.unshift({ role: 'system', content: extraContext })
        }
      }
    }

    // 多模态本地图片转 base64
    for (const msg of chatHistory) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'image_url' && block.image_url && block.image_url.url && block.image_url.url.startsWith('local-file://')) {
            let localPath = ''
            try {
              const parsedUrl = new URL(block.image_url.url)
              localPath = decodeURIComponent(parsedUrl.pathname)
              if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1)
            } catch {
              localPath = block.image_url.url.replace('local-file://', '')
            }
            try {
              if (fs.existsSync(localPath)) {
                const buffer = fs.readFileSync(localPath)
                let ext = localPath.split('.').pop()?.toLowerCase() || 'jpeg'
                if (ext === 'jpg') ext = 'jpeg'
                const mimeType = `image/${ext}`
                block.image_url.url = `data:${mimeType};base64,${buffer.toString('base64')}`
              }
            } catch (err) {
              console.error('读取本地图片转换 Base64 给大模型时失败:', err)
            }
          }
        }
      }
    }

    let loopCount = 0
    const maxLoops = 100
    let totalToolCallsCount = 0
    let imageCompatibilityFallbackUsed = false

    const modelProvider = ModelRuntimeFactory.getProvider(provider, apiKey, baseUrl)
    const effectiveTools = this.getFormattedTools(isFrontend, true)

    while (loopCount < maxLoops) {
      if (abortSignal?.aborted) {
        throw new Error('UserAborted')
      }
      loopCount++

      const chatOptions: ChatOptions = {
        model,
        temperature: temperature ?? 0.7,
        signal: abortSignal
      }

      if (maxTokens) {
        chatOptions.maxTokens = maxTokens
      }

      if (effectiveTools.length > 0) {
        chatOptions.tools = effectiveTools
        chatOptions.tool_choice = 'auto'
      }

      let responseMsg: ChatMessage
      try {
        if (modelProvider.chatStream) {
          let streamedMessage: ChatMessage | null = null
          for await (const event of modelProvider.chatStream(chatHistory, chatOptions)) {
            if (event.type === 'delta') {
              if (effectiveTools.length === 0) {
                yield { type: 'text_delta', content: event.content }
              }
            } else {
              streamedMessage = event.message
            }
          }
          if (!streamedMessage) throw new Error('流式响应未包含最终消息')
          responseMsg = streamedMessage
        } else {
          responseMsg = await modelProvider.chat(chatHistory, chatOptions)
        }
      } catch (err: any) {
        const errorText = err.message || String(err)
        const mayRejectImages =
          /HTTP\s*(400|415|422)\b/i.test(errorText) ||
          /image|vision|multimodal|multi-modal|upstream request failed/i.test(errorText)
        if (!imageCompatibilityFallbackUsed && mayRejectImages) {
          const removedImages = this.stripImageBlocksForCompatibility(chatHistory)
          if (removedImages > 0) {
            imageCompatibilityFallbackUsed = true
            console.warn(
              `[AgentExecutor] 模型接口拒绝图片，已移除 ${removedImages} 张图片并降级为文本验证。`,
              errorText
            )
            yield {
              type: 'think',
              detail: '当前模型接口不支持本次图片输入，已自动跳过视觉截图，改用结构化文件校验结果继续。'
            }
            continue
          }
        }
        // 优雅降级：如果是第一次带 tools 失败（如接口不支持 tools 参数），自动删除降级
        // 排除因 API 密钥无效（如 400 Please pass a valid API key）引发的错误，防止误判
        const isApiKeyError = errorText.includes('API key') || errorText.includes('api_key') || errorText.includes('api-key') || errorText.includes('API Key') || errorText.includes('valid API key') || errorText.includes('INVALID_ARGUMENT')
        if (loopCount === 1 && chatOptions.tools && !isApiKeyError && (errorText.includes('400') || errorText.includes('tools') || errorText.includes('tool_choice') || errorText.includes('parameter') || errorText.includes('unsupported'))) {
          console.warn('API 不支持工具参数，已优雅降级为纯对话模式', errorText)
          effectiveTools.length = 0
          loopCount = 0
          continue
        }
        throw err
      }

      // 统计 Token 消耗并通知
      if (responseMsg.usage) {
        yield {
          type: 'token',
          promptTokens: responseMsg.usage.prompt_tokens,
          completionTokens: responseMsg.usage.completion_tokens
        }
      } else if (responseMsg.content) {
        // 如果 API 没有返回 usage，手动估算一个
        const textOut = typeof responseMsg.content === 'string' ? responseMsg.content : ''
        const textIn = chatHistory.map((m: any) => {
          if (Array.isArray(m.content)) {
            return m.content.map((b: any) => b.text || '').join('')
          }
          return m.content || ''
        }).join('')
        const estimatedPrompt = Math.max(1, Math.round(textIn.length * 0.5))
        const estimatedCompletion = Math.max(1, Math.round(textOut.length * 0.8))
        yield {
          type: 'token',
          promptTokens: estimatedPrompt,
          completionTokens: estimatedCompletion
        }
      }

      // 输出深度思考内容
      if (responseMsg.reasoning_content) {
        yield {
          type: 'think',
          detail: responseMsg.reasoning_content
        }
      }

      const toolCalls = responseMsg.tool_calls
      if (toolCalls && toolCalls.length > 0) {


        // 第二阶段参数填充逻辑：对 MCP 等简化工具调用补充 Schema
        for (let i = 0; i < toolCalls.length; i++) {
          const toolCall = toolCalls[i]
          const toolName = toolCall.function.name
          const fullToolDefinition = this.getFullToolDefinitionByName(toolName, isFrontend)
          const fullTool = fullToolDefinition
            ? { ...fullToolDefinition, function: { ...fullToolDefinition.function } }
            : null
          const parameterSchema = fullTool?.function.parameters

          const isMcpTool = mcpManager.hasTool(toolName)
          // 简化 Schema 仅用于帮助模型在大量 MCP 工具中选择目标。部分模型即使
          // 面对空 Schema 也会返回完整参数；这种情况下无需再发一次参数补全请求。
          // 否则，兼容性较弱的网关会在第二次请求报 400，尽管原始 MCP 调用可正常执行。
          let hasArguments = false
          try {
            const parsedArguments = this.parseJsonObject(toolCall.function.arguments)
            hasArguments = this.hasValidToolArguments(parsedArguments, parameterSchema)
          } catch {
            // 无法解析的参数仍交由第二阶段尝试修复。
          }

          if (isMcpTool && !hasArguments && fullTool && fullTool.function.parameters && Object.keys(fullTool.function.parameters.properties || {}).length > 0) {
            console.log(`[Two-Stage] 检测到简化工具调用: ${toolName}，正在启动第二阶段参数填充...`)
            try {
              const compactSchema = this.compactJsonSchema(parameterSchema)
              fullTool.function.parameters = compactSchema
              const tempHistory: ChatMessage[] = [
                ...chatHistory,
                {
                  role: 'user' as const,
                  content: `【系统提示】此工具需要输入参数。请根据以下 JSON Schema 定义重新生成此工具调用，并提供正确的 arguments 参数字段：\n${JSON.stringify(fullTool.function.parameters)}`
                },
                {
                  role: 'user' as const,
                  content: `Return only a valid JSON object of arguments for the selected MCP tool "${toolName}". Do not call a tool and do not add explanation.`
                }
              ]

              const fillOptions: ChatOptions = {
                model,
                temperature: 0.1,
                signal: abortSignal
              }

              let fillResponse: ChatMessage
              try {
                fillResponse = await modelProvider.chat(tempHistory, fillOptions)
              } catch (e: any) {
                console.warn(`[Two-Stage] 首次强绑定参数填充失败，尝试将 tool_choice 降级为 "auto" 重试... 错误详情:`, e.message || e)
                const fallbackOptions: ChatOptions = {
                  model,
                  temperature: 0.1,
                  signal: abortSignal
                }
                fillResponse = await modelProvider.chat(tempHistory, fallbackOptions)
              }

              if (fillResponse.usage) {
                yield {
                  type: 'token',
                  promptTokens: fillResponse.usage.prompt_tokens,
                  completionTokens: fillResponse.usage.completion_tokens
                }
              }

              const generatedArgs = this.parseJsonObject(fillResponse.content)
              if (this.hasValidToolArguments(generatedArgs, parameterSchema)) {
                fillResponse.tool_calls = [{
                  function: { name: toolName, arguments: JSON.stringify(generatedArgs) }
                }]
              }
              const matchedCall = fillResponse.tool_calls?.find((tc: any) => tc.function.name === toolName)
              if (matchedCall && matchedCall.function.arguments) {
                console.log(`[Two-Stage] 成功获取参数:`, matchedCall.function.arguments)
                toolCall.function.arguments = matchedCall.function.arguments
              } else {
                console.warn(`[Two-Stage] 未能从模型返回中获取到匹配的参数`)
              }
            } catch (fillErr) {
              // 参数补全是兼容性优化；保留初始调用，让 MCP 自身决定是否接受参数。
              console.warn(`[Two-Stage] 参数补全不可用，将继续执行初始 MCP 调用:`, fillErr)
            }
          }
        }

        chatHistory.push(responseMsg)

        // 1. 并行前先生成所有工具调用事件并 yield 到前端，显示“正在执行...”
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name
          let toolArgs: any = {}
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}')
          } catch (pe) {
            console.error('解析工具参数失败', pe)
          }

          let safeToolArgs: any = {}
          try {
            safeToolArgs = JSON.parse(JSON.stringify(toolArgs))
            const truncateArgs = (obj: any): any => {
              if (typeof obj === 'string' && obj.length > 1000) {
                return obj.substring(0, 1000) + '... (内容过长，为保持UI流畅前端已隐藏，后台已完整保存)'
              }
              if (Array.isArray(obj)) {
                return obj.map(val => truncateArgs(val))
              } else if (obj !== null && typeof obj === 'object') {
                const newObj: any = {}
                for (const k in obj) {
                  newObj[k] = truncateArgs(obj[k])
                }
                return newObj
              }
              return obj
            }
            safeToolArgs = truncateArgs(safeToolArgs)
          } catch (e) {
            safeToolArgs = toolArgs
          }

          yield {
            type: 'tool_call',
            name: toolName,
            args: safeToolArgs,
            id: toolCall.id
          }
        }

        // 2. 限制最大 2 个工具并行执行
        const toolExecutionResults: any[] = []
        for (let i = 0; i < toolCalls.length; i += 2) {
          const batch = toolCalls.slice(i, i + 2)
          const batchResults = await Promise.all(batch.map(async (toolCall) => {
            if (abortSignal?.aborted) {
              throw new Error('UserAborted')
            }

            const toolName = toolCall.function.name
            if (toolName !== 'trigger_memory_purify') {
              totalToolCallsCount++
            }

            let toolArgs: any = {}
            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}')
            } catch (pe) {
              console.error('解析工具参数失败', pe)
            }

            let toolResult: string
            let webSources: any[] | undefined
            let imageFilePaths: string[] = []
            if (toolName === 'trigger_memory_purify') {
              runPurifyMemoryPipeline(sessionId).catch(err => console.error('后台经验沉淀执行失败', err))
              toolResult = `[系统提示] 已成功触发后台经验沉淀 Pipeline。您的经验将在后台被提取并转化为长期记忆，您可以结束当前回答了。`
            } else if (toolName === 'web_search') {
              let query = typeof toolArgs.query === 'string' ? toolArgs.query.trim().replace(/\s+/g, ' ') : ''
              const hanCharacters = (query.match(/[\u3400-\u9fff]/g) || []).length
              if (hanCharacters === 1) {
                // The model occasionally emits the first character of a Chinese name as
                // the query. Recover the user's complete request rather than searching it.
                const latestUserMessage = [...chatHistory].reverse().find((message: any) => message.role === 'user')
                const userContent = typeof latestUserMessage?.content === 'string'
                  ? latestUserMessage.content
                  : Array.isArray(latestUserMessage?.content)
                    ? latestUserMessage.content
                      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                      .map((part: any) => part.text)
                      .join(' ')
                    : ''
                const recoveredQuery = userContent.trim().replace(/\s+/g, ' ')
                const recoveredHanCharacters = (recoveredQuery.match(/[\u3400-\u9fff]/g) || []).length
                if (recoveredHanCharacters > 1) {
                  query = recoveredQuery
                  toolArgs = { ...toolArgs, query }
                } else {
                  toolResult = '已拦截单字搜索：请使用包含完整人名、事件或主题的查询词。'
                }
              }

              if (!toolResult!) {
                if (executedWebSearchQueries.has(query)) {
                  toolResult = `已跳过重复搜索：${query}`
                } else {
                  executedWebSearchQueries.add(query)
                  const ctx = {
                    workspacePath: workspacePath || '',
                    sessionId,
                    isFrontend,
                    sandboxMode: !!sandboxMode,
                    event,
                    abortSignal
                  }
                  const res = await unifiedToolExecutor.execute(toolName, toolArgs, ctx)
                  toolResult = res.content
                  webSources = Array.isArray(res.state?.sources) ? res.state.sources : undefined
                  imageFilePaths = this.getToolImagePaths(res.state)
                }
              }
            } else {
              const ctx = {
                workspacePath: workspacePath || '',
                sessionId,
                isFrontend,
                sandboxMode: !!sandboxMode,
                event,
                abortSignal
              }
              const res = await unifiedToolExecutor.execute(toolName, toolArgs, ctx)
              toolResult = res.content
              webSources = Array.isArray(res.state?.sources) ? res.state.sources : undefined
              imageFilePaths = this.getToolImagePaths(res.state)
            }

            if (abortSignal?.aborted) {
              throw new Error('UserAborted')
            }

            if ((toolName === 'run_terminal_command' || toolName === 'run_command') && /超时|timeout/i.test(toolResult)) {
              toolResult += '\n\n[文件定位策略] 此超时不代表文件不存在。禁止改搜其他磁盘；请在同一磁盘缩小范围，或向用户询问可能的上级目录。'
            }

            let displayResult = toolResult
            if (typeof displayResult === 'string' && displayResult.length > 1000) {
              displayResult = displayResult.substring(0, 1000) + `\n\n... [工具输出内容过长(${displayResult.length}字符)，为了保持UI流畅已截断展示。大模型后台已读取完整内容。]`
            }

            let contextToolResult = toolResult
            const MAX_CONTEXT_TOOL_RESULT = 12000
            if (typeof contextToolResult === 'string' && contextToolResult.length > MAX_CONTEXT_TOOL_RESULT) {
              contextToolResult = contextToolResult.substring(0, MAX_CONTEXT_TOOL_RESULT) +
                `\n\n[系统保护警告]: 数据量过大，已被系统强制截断（仅保留前 ${MAX_CONTEXT_TOOL_RESULT} 字符）。\n🚫 严禁使用相同的参数再次无脑读取整个文件或网页！\n💡 解决方案：如果你需要后续内容，请务必在工具参数中使用 start_line 和 end_line 进行精确的分页读取，或使用 grep_content 检索精准内容。`
            }

            return {
              toolCallId: toolCall.id,
              toolName,
              displayResult,
              contextToolResult,
              webSources,
              imageFilePaths
            }
          }))
          toolExecutionResults.push(...batchResults)
        }

        const results = toolExecutionResults
        const toolImagePathsForNextTurn: string[] = []

        // 3. 异步并行执行完后，顺序 yield 工具结果事件并写入 chatHistory 历史
        for (const res of results) {
          const normalizedSources: any[] = []
          if (res.webSources?.length) {
            normalizedSources.push(...res.webSources.map((source: any) => ({ ...source, id: `S${++webSourceCounter}` })))
            normalizedSources.forEach(source => availableWebSourceIds.add(source.id))
            for (let index = 0; index < res.webSources.length; index++) {
              const oldId = res.webSources[index].id
              const newId = normalizedSources[index].id
              res.displayResult = String(res.displayResult).split(`[${oldId}]`).join(`[${newId}]`)
              res.contextToolResult = String(res.contextToolResult).split(`[${oldId}]`).join(`[${newId}]`)
            }
          }
          yield {
            type: 'tool_result',
            name: res.toolName,
            result: res.displayResult
          }
          if (normalizedSources.length) {
            webSourcesForMemory.push(...normalizedSources)
            yield { type: 'web_sources', sources: normalizedSources }
          }

          chatHistory.push({
            role: 'tool' as const,
            tool_call_id: res.toolCallId,
            name: res.toolName,
            content: res.contextToolResult
          })

          if (Array.isArray(res.imageFilePaths) && res.imageFilePaths.length > 0) {
            toolImagePathsForNextTurn.push(...res.imageFilePaths)
          }
        }

        if (toolImagePathsForNextTurn.length > 0 && !imageCompatibilityFallbackUsed) {
          const imageBlocks = this.buildToolImageBlocks(toolImagePathsForNextTurn)
          if (imageBlocks.length > 0) {
            chatHistory.push({
              role: 'user' as const,
              content: [
                {
                  type: 'text',
                  text: '以下是刚才工具截图得到的视觉内容，请直接观察图片并基于图片继续完成任务；不要再说无法查看图片。'
                },
                ...imageBlocks
              ]
            })
          }
        }

        continue
      } else {
        // 完成整个调用链
        let finalResponse = typeof responseMsg.content === 'string' ? responseMsg.content : ''
        finalResponse = finalResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        // 只保留实际由本轮联网工具产生的引用，防止模型编造来源编号。
        finalResponse = finalResponse.replace(/\[S(\d+)\]/g, (citation, number) =>
          availableWebSourceIds.has(`S${number}`) ? citation : ''
        )

        if (!finalResponse.trim() && loopCount > 1) {
          finalResponse = '⚠️ [系统提示] 大模型在执行完工具链后返回了空回复，可能是因为工具返回的数据量过大超出了大模型的上下文处理上限，或触发了安全过滤机制。'
        }

        yield {
          type: 'text',
          content: finalResponse
        }

        if (totalToolCallsCount >= 5 && sessionId) {
          console.log(`[System] 长任务正常结束，自动触发后台大模型经验总结及沉淀... (工具调用次数: ${totalToolCallsCount})`)
          this.handleLongTaskAutoMemory(sessionId, chatHistory, config, finalResponse, webSourcesForMemory).catch(e => console.error('[System] 自动经验沉淀失败:', e))
        }

        return finalResponse
      }
    }

    if (totalToolCallsCount >= 5 && sessionId) {
      console.log(`[System] 长任务因达到最大轮数上限退出，自动触发后台大模型经验总结及沉淀... (工具调用次数: ${totalToolCallsCount})`)
      this.handleLongTaskAutoMemory(sessionId, chatHistory, config, '智能代理执行工具链已达到最大轮数上限。', webSourcesForMemory).catch(e => console.error('[System] 自动经验沉淀失败:', e))
    }

    yield {
      type: 'text',
      content: '⚠️ [系统中断] 智能代理执行工具链已达到最大轮数上限(100次)，已强制结束生成。请检查是否陷入死循环。'
    }

    return '智能代理执行工具链已达到最大轮数上限。'
  }
}

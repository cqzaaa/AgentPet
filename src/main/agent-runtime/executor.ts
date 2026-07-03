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
  private getFormattedTools(_isFrontend: boolean, simplify = false): any[] {
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

    return list
  }

  private getFullToolDefinitionByName(name: string, isFrontend: boolean): any | null {
    const fullTools = this.getFormattedTools(isFrontend, false)
    return fullTools.find((t: any) => t.function.name === name) || null
  }

  private async handleLongTaskAutoMemory(
    sessionId: string,
    chatHistory: ChatMessage[],
    config: { provider: string; apiKey: string; baseUrl: string; model: string; temperature: number }
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
3. 你的格式必须是 JSON 格式，包含 title 和 content 字段，示例如下：
{
  "title": "主题名",
  "content": "### 💡 核心知识与经验沉淀\\n..."
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
        await appendMemorySummaryInternal(sessionId, summaryData.title, summaryData.content)
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
    },
    messages: ChatMessage[],
    workspacePath?: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<AgentStepEvent, string, unknown> {
    const { provider, apiKey, baseUrl, model, temperature, maxTokens, sessionId, sandboxMode } = config
    const isFrontend = !config.isBackground

    let chatHistory: ChatMessage[] = JSON.parse(JSON.stringify(messages))

    if (sessionId) {
      const chatDir = getActiveChatDir()
      const safeSessionId = sessionId.replace(/[<>:"/\\|?*]/g, '_')
      const cacheDir = join(chatDir, safeSessionId, '.agentpet_cache')
      let extraContext = ''

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
    const maxLoops = 40
    let TOOL_INTERRUPT_THRESHOLD = 10
    let totalToolCallsCount = 0
    let isLongTask = false

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
        responseMsg = await modelProvider.chat(chatHistory, chatOptions)
      } catch (err: any) {
        const errorText = err.message || String(err)
        // 优雅降级：如果是第一次带 tools 失败（如接口不支持 tools 参数），自动删除降级
        if (loopCount === 1 && chatOptions.tools && (errorText.includes('400') || errorText.includes('tools') || errorText.includes('tool_choice') || errorText.includes('parameter') || errorText.includes('unsupported'))) {
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
        const hasExtend = toolCalls.some((tc: any) => tc.function.name === 'extend_task_loop')

        if (loopCount >= TOOL_INTERRUPT_THRESHOLD && !hasExtend) {
          console.warn(`[callLlm] 工具调用已达 ${loopCount} 次，触发软中断...`)
          chatHistory.push(responseMsg)

          for (const tc of toolCalls) {
            chatHistory.push({
              role: 'tool' as const,
              tool_call_id: tc.id,
              name: tc.function.name,
              content: `[系统拦截] 调用次数已达上限(${TOOL_INTERRUPT_THRESHOLD})，本次工具被拦截未执行。\n如果你确信这是一个需要更多步骤的长任务，请立即调用 \`extend_task_loop\` 工具申请延长。\n否则，说明你可能陷入了死循环或找不到目标，请直接输出一段话向用户提问求助，不要再调用其他工具。`
            })
          }
          continue
        }

        // 第二阶段参数填充逻辑：对 MCP 等简化工具调用补充 Schema
        for (let i = 0; i < toolCalls.length; i++) {
          const toolCall = toolCalls[i]
          const toolName = toolCall.function.name
          const fullTool = this.getFullToolDefinitionByName(toolName, isFrontend)

          const isMcpTool = mcpManager.hasTool(toolName)
          if (isMcpTool && fullTool && fullTool.function.parameters && Object.keys(fullTool.function.parameters.properties || {}).length > 0) {
            console.log(`[Two-Stage] 检测到简化工具调用: ${toolName}，正在启动第二阶段参数填充...`)
            try {
              const tempHistory: ChatMessage[] = [
                ...chatHistory,
                responseMsg,
                {
                  role: 'tool' as const,
                  tool_call_id: toolCall.id,
                  name: toolName,
                  content: `【系统提示】此工具需要输入参数。请根据以下 JSON Schema 定义重新生成此工具调用，并提供正确的 arguments 参数字段：\n${JSON.stringify(fullTool.function.parameters)}`
                }
              ]

              const fillOptions: ChatOptions = {
                model,
                temperature: 0.1,
                tools: [fullTool],
                tool_choice: { type: 'function', function: { name: toolName } },
                signal: abortSignal
              }

              const fillResponse = await modelProvider.chat(tempHistory, fillOptions)

              if (fillResponse.usage) {
                yield {
                  type: 'token',
                  promptTokens: fillResponse.usage.prompt_tokens,
                  completionTokens: fillResponse.usage.completion_tokens
                }
              }

              const matchedCall = fillResponse.tool_calls?.find((tc: any) => tc.function.name === toolName)
              if (matchedCall && matchedCall.function.arguments) {
                console.log(`[Two-Stage] 成功获取参数:`, matchedCall.function.arguments)
                toolCall.function.arguments = matchedCall.function.arguments
              } else {
                console.warn(`[Two-Stage] 未能从模型返回中获取到匹配的参数`)
              }
            } catch (fillErr) {
              console.error(`[Two-Stage] 参数填充出错:`, fillErr)
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

        // 2. 利用 Promise.all 并行并发异步执行工具逻辑
        const toolExecutionPromises = toolCalls.map(async (toolCall) => {
          if (abortSignal?.aborted) {
            throw new Error('UserAborted')
          }

          const toolName = toolCall.function.name
          if (toolName !== 'extend_task_loop' && toolName !== 'trigger_memory_purify') {
            totalToolCallsCount++
          }

          let toolArgs: any = {}
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}')
          } catch (pe) {
            console.error('解析工具参数失败', pe)
          }

          let toolResult: string
          if (toolName === 'extend_task_loop') {
            isLongTask = true
            const extraLoops = typeof toolArgs.extra_loops === 'number' ? toolArgs.extra_loops : 20
            TOOL_INTERRUPT_THRESHOLD += extraLoops
            toolResult = `[系统提示] 任务链执行轮数上限已扩展至 ${TOOL_INTERRUPT_THRESHOLD} 次。请继续安心执行您的长任务，不要中断。`
          } else if (toolName === 'trigger_memory_purify') {
            runPurifyMemoryPipeline(sessionId).catch(err => console.error('后台经验沉淀执行失败', err))
            toolResult = `[系统提示] 已成功触发后台经验沉淀 Pipeline。您的经验将在后台被提取并转化为长期记忆，您可以结束当前回答了。`
          } else {
            const ctx = {
              workspacePath: workspacePath || '',
              sessionId,
              isFrontend,
              sandboxMode: !!sandboxMode,
              abortSignal
            }
            const res = await unifiedToolExecutor.execute(toolName, toolArgs, ctx)
            toolResult = res.content
          }

          if (abortSignal?.aborted) {
            throw new Error('UserAborted')
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
            contextToolResult
          }
        })

        const results = await Promise.all(toolExecutionPromises)

        // 3. 异步并行执行完后，顺序 yield 工具结果事件并写入 chatHistory 历史
        for (const res of results) {
          yield {
            type: 'tool_result',
            name: res.toolName,
            result: res.displayResult
          }

          chatHistory.push({
            role: 'tool' as const,
            tool_call_id: res.toolCallId,
            name: res.toolName,
            content: res.contextToolResult
          })
        }

        continue
      } else {
        // 完成整个调用链
        let finalResponse = typeof responseMsg.content === 'string' ? responseMsg.content : ''
        finalResponse = finalResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

        if (!finalResponse.trim() && loopCount > 1) {
          finalResponse = '⚠️ [系统提示] 大模型在执行完工具链后返回了空回复，可能是因为工具返回的数据量过大超出了大模型的上下文处理上限，或触发了安全过滤机制。'
        }

        yield {
          type: 'text',
          content: finalResponse
        }

        if ((isLongTask || totalToolCallsCount >= 5) && sessionId) {
          console.log(`[System] 长任务正常结束，自动触发后台大模型经验总结及沉淀... (工具调用次数: ${totalToolCallsCount})`)
          this.handleLongTaskAutoMemory(sessionId, chatHistory, config).catch(e => console.error('[System] 自动经验沉淀失败:', e))
        }

        return finalResponse
      }
    }

    if ((isLongTask || totalToolCallsCount >= 5) && sessionId) {
      console.log(`[System] 长任务因达到最大轮数上限退出，自动触发后台大模型经验总结及沉淀... (工具调用次数: ${totalToolCallsCount})`)
      this.handleLongTaskAutoMemory(sessionId, chatHistory, config).catch(e => console.error('[System] 自动经验沉淀失败:', e))
    }

    return '智能代理执行工具链已达到最大轮数上限。'
  }
}

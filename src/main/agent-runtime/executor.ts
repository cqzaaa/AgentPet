import * as fs from 'fs'
import { basename, isAbsolute, join, resolve } from 'path'
import { ModelRuntimeFactory, ChatMessage, ChatOptions } from '../model-runtime'
import { AgentStepEvent } from './types'
import { getActiveStorageDir, getSessionFilesDir } from '../tools/utils/paths'
import { toolRegistry } from '../tools/core/tool-registry'
import { mcpManager } from '../tools/mcp/mcp-manager'
import { unifiedToolExecutor } from '../tools/core/tool-executor'
import { runPurifyMemoryPipeline, appendMemorySummaryInternal } from '../api/memory'
import { sshManager } from '../tools/builtin/terminal/ssh-manager'
import { countMessagesTokens, countTokens } from '../tools/context/token-counter'

type WebMemorySource = {
  id: string
  title: string
  url: string
}

type MemoryValueSignals = {
  toolCalls: number
  toolNames: Set<string>
  failureFingerprints: Set<string>
  failedToolNames: Set<string>
  recoveredToolNames: Set<string>
  mutationCount: number
  generatedFileCount: number
  explicitRememberRequest: boolean
  userCorrection: boolean
  memoryAlreadySaved: boolean
}

type MemoryValueAssessment = {
  score: number
  shouldSummarize: boolean
  reasons: string[]
}

type ContextCompactionPlan = {
  start: number
  end: number
  reason: string
  beforeTokens: number
}

const LARGE_TOOL_RESULT_TOKENS = 6000
const TOOL_CONTEXT_SOFT_LIMIT = 16000
const CONTEXT_COMPACT_RATIO = 0.75
const DEFAULT_CONTEXT_WINDOW = 168000

const MUTATING_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'move_file',
  'delete_file',
  'generate_file',
  'modify_docx_file',
  'modify_xlsx_file',
  'run_office_skill',
  'manage_cron_task'
])

function messageText(message: ChatMessage | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return (message.content as unknown[])
    .filter((block): block is { type: string; text: string } => {
      if (!block || typeof block !== 'object') return false
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map(block => block.text)
    .join('\n')
}

function normalizeToolFailure(toolName: string, result: string): string {
  const normalized = result
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s"']+/gi, '<path>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s][\d:.+-]+\b/g, '<time>')
    .replace(/\b\d{6,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  return `${toolName}:${normalized}`
}

function isMutatingToolCall(toolName: string, args: unknown): boolean {
  if (MUTATING_TOOL_NAMES.has(toolName)) return true
  if (/^(?:create|update|delete|write|edit|modify|move|rename|save|apply)[_:-]/i.test(toolName)) return true
  if (toolName !== 'run_terminal_command' && toolName !== 'run_command') return false
  if (!args || typeof args !== 'object') return false
  const command = String((args as { command?: unknown }).command || '')
  return /(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|npm\s+(?:install|uninstall)|git\s+(?:apply|commit|merge|rebase)|(?:^|\s)(?:rm|mv|cp|mkdir|touch|sed\s+-i)\b|(?:^|[^>])>{1,2}(?:[^>]|$))/i.test(command)
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

  private getToolGeneratedFiles(state: any): Array<{ name: string; path: string; size: number }> {
    const files: Array<{ name: string; path: string; size: number }> = []
    const seen = new Set<string>()
    const addFile = (filePath: unknown, fileName?: unknown): void => {
      if (typeof filePath !== 'string' || !/[\\/]generated_files[\\/]/i.test(filePath)) return
      if (seen.has(filePath)) return
      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) return
        seen.add(filePath)
        files.push({
          name:
            typeof fileName === 'string' && fileName.trim()
              ? fileName.trim()
              : filePath.replace(/\\/g, '/').split('/').pop() || 'generated-file',
          path: filePath,
          size: stat.size
        })
      } catch {
        // Ignore stale or incomplete output paths.
      }
    }
    addFile(state?.file_path, state?.file_name)
    addFile(state?.filePath, state?.fileName)
    for (const item of Array.isArray(state?.files) ? state.files : []) {
      addFile(item?.file_path || item?.path, item?.file_name || item?.name)
    }
    for (const item of Array.isArray(state?.outputs) ? state.outputs : []) {
      addFile(item?.file_path || item?.path, item?.file_name || item?.name)
    }
    return files
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

  private getToolCacheDir(sessionId?: string): string {
    return join(getSessionFilesDir(sessionId), '.agentpet_cache', 'tool-results')
  }

  private safeCacheName(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    return cleaned.slice(0, 48) || 'tool'
  }

  private async writeToolCache(
    sessionId: string | undefined,
    label: string,
    content: string,
    extension: 'txt' | 'md' = 'txt'
  ): Promise<string> {
    const cacheDir = this.getToolCacheDir(sessionId)
    await fs.promises.mkdir(cacheDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const suffix = Math.random().toString(36).slice(2, 8)
    const filePath = join(cacheDir, `${stamp}-${this.safeCacheName(label)}-${suffix}.${extension}`)
    await fs.promises.writeFile(filePath, content, 'utf8')
    return resolve(filePath)
  }

  private truncateToTokenBudget(content: string, tokenBudget: number): string {
    if (countTokens(content) <= tokenBudget) return content
    let low = 0
    let high = content.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (countTokens(content.slice(0, middle)) <= tokenBudget) low = middle
      else high = middle - 1
    }
    return content.slice(0, low)
  }

  private buildCachedToolContext(toolName: string, result: string, cachePath: string): string {
    const originalTokens = countTokens(result)
    const lines = result.split(/\r?\n/)
    const head = this.truncateToTokenBudget(result, 650)
    const tailSource = lines.length > 1 ? lines.slice(-80).join('\n') : result.slice(Math.max(0, result.length - 2400))
    const tail = this.truncateToTokenBudget(tailSource, 350)
    const normalizedPath = cachePath.replace(/\\/g, '/')
    return `[工具输出已缓存]
工具: ${toolName}
原始规模: 约 ${originalTokens} tokens，${lines.length} 行
完整缓存: ${normalizedPath}

开头预览:
${head}

末尾预览:
${tail}

不要重新调用原工具获取整份内容。需要定位信息时使用：
grep_content({"pattern":"关键词","scope":"${normalizedPath}","output_mode":"content"})

需要按页阅读时使用：
read_file({"file_path":"${normalizedPath}","start_line":1,"end_line":200})`
  }

  private getContextCompactionPlan(chatHistory: ChatMessage[], contextWindow: number): ContextCompactionPlan | null {
    const beforeTokens = countMessagesTokens(chatHistory)
    const latestUserIndex = chatHistory.findLastIndex(message => message.role === 'user')
    if (latestUserIndex < 0) return null

    const currentToolTokens = chatHistory
      .slice(latestUserIndex + 1)
      .filter(message => message.role === 'tool')
      .reduce((total, message) => total + countTokens(messageText(message)), 0)
    const totalLimitReached = beforeTokens >= Math.max(24000, contextWindow * CONTEXT_COMPACT_RATIO)
    const toolLimitReached = currentToolTokens >= TOOL_CONTEXT_SOFT_LIMIT
    if (!totalLimitReached && !toolLimitReached) return null

    const currentToolCycles = chatHistory
      .map((message, index) => ({ message, index }))
      .filter(item => item.index > latestUserIndex && item.message.role === 'assistant' && item.message.tool_calls?.length)

    if (currentToolCycles.length >= 3) {
      return {
        start: latestUserIndex + 1,
        end: currentToolCycles[currentToolCycles.length - 2].index,
        reason: toolLimitReached ? '当前任务的工具输出累计超过软阈值' : '整体上下文接近窗口阈值',
        beforeTokens
      }
    }

    const firstNonSystem = chatHistory.findIndex(message => message.role !== 'system')
    const end = Math.max(firstNonSystem, latestUserIndex - 4)
    if (firstNonSystem >= 0 && end > firstNonSystem) {
      return {
        start: firstNonSystem,
        end,
        reason: '整体上下文接近窗口阈值',
        beforeTokens
      }
    }
    return null
  }

  private async compactContext(
    chatHistory: ChatMessage[],
    plan: ContextCompactionPlan,
    sessionId?: string
  ): Promise<{ archivePath: string; removedMessages: number; afterTokens: number; activeToolContextTokens: number }> {
    const removed = chatHistory.slice(plan.start, plan.end)
    const archiveText = removed.map((message, index) => {
      const toolCalls = message.tool_calls?.length
        ? `\n工具调用: ${JSON.stringify(message.tool_calls, null, 2)}`
        : ''
      return `## ${index + 1}. ${message.role}${message.name ? ` (${message.name})` : ''}\n\n${messageText(message)}${toolCalls}`
    }).join('\n\n---\n\n')
    const archivePath = await this.writeToolCache(sessionId, 'context-compaction', archiveText, 'md')
    const normalizedPath = archivePath.replace(/\\/g, '/')
    const compactItems = removed.map(message => {
      if (message.role === 'tool') {
        const body = messageText(message)
        const cachedPath = body.match(/完整缓存:\s*([^\r\n]+)/)?.[1]
        return `- 工具 ${message.name || 'unknown'}：${this.truncateToTokenBudget(body.replace(/\s+/g, ' '), 90)}${cachedPath ? `；完整缓存 ${cachedPath}` : ''}`
      }
      if (message.tool_calls?.length) {
        return `- 助手调用：${message.tool_calls.map((call: any) => call.function?.name).filter(Boolean).join('、')}`
      }
      const text = messageText(message).replace(/\s+/g, ' ').trim()
      return text ? `- ${message.role === 'user' ? '用户' : '助手'}：${this.truncateToTokenBudget(text, 120)}` : ''
    }).filter(Boolean).slice(0, 24)
    const summary: ChatMessage = {
      role: 'assistant',
      content: `[自动压缩的历史执行上下文]\n触发原因：${plan.reason}\n已归档 ${removed.length} 条旧过程消息。\n${compactItems.join('\n')}\n\n完整归档：${normalizedPath}\n需要细节时请使用 grep_content 检索该文件，或用 read_file(start_line, end_line) 分页读取。`
    }
    chatHistory.splice(plan.start, plan.end - plan.start, summary)
    return {
      archivePath: normalizedPath,
      removedMessages: removed.length,
      afterTokens: countMessagesTokens(chatHistory),
      activeToolContextTokens: chatHistory
        .slice(chatHistory.findLastIndex(message => message.role === 'user') + 1)
        .filter(message => message.role === 'tool')
        .reduce((total, message) => total + countTokens(messageText(message)), 0)
    }
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

  private assessMemoryValue(signals: MemoryValueSignals, loopCount: number, forcedStop = false): MemoryValueAssessment {
    let score = 0
    const reasons: string[] = []
    const add = (points: number, reason: string): void => {
      score += points
      reasons.push(`+${points} ${reason}`)
    }

    if (signals.explicitRememberRequest) add(5, '用户明确要求记忆或沉淀')
    if (signals.userCorrection) add(2, '用户对既有理解或方案进行了纠正')
    if (signals.recoveredToolNames.size > 0) add(4, `工具失败后恢复成功(${signals.recoveredToolNames.size})`)
    if (signals.failureFingerprints.size > 0) add(2, `出现可复盘的工具失败(${signals.failureFingerprints.size})`)
    if (signals.failureFingerprints.size >= 2) add(1, '存在多个不同失败')
    if (signals.mutationCount > 0) add(2, `产生修改型操作(${signals.mutationCount})`)
    if (signals.generatedFileCount > 0) add(2, `生成交付文件(${signals.generatedFileCount})`)
    if (signals.toolNames.size >= 3) add(1, `跨工具协作(${signals.toolNames.size}种)`)
    if (signals.toolCalls >= 5) add(1, `多步骤任务(${signals.toolCalls}次工具调用)`)
    if (signals.toolCalls >= 10) add(1, '超长工具链')
    if (loopCount >= 3) add(1, `多轮代理执行(${loopCount}轮)`)
    if (forcedStop) add(2, '任务达到最大循环上限')

    return {
      score,
      shouldSummarize: !signals.memoryAlreadySaved && score >= 4,
      reasons
    }
  }

  private recordMemoryToolResult(
    signals: MemoryValueSignals,
    toolName: string,
    success: boolean,
    result: string,
    generatedFileCount: number,
    args: unknown
  ): void {
    if (toolName === 'trigger_memory_purify') return
    signals.toolCalls++
    signals.toolNames.add(toolName)
    if (toolName === 'append_memory_summary' && success) signals.memoryAlreadySaved = true
    if (isMutatingToolCall(toolName, args) && success) signals.mutationCount++
    signals.generatedFileCount += generatedFileCount

    if (!success) {
      signals.failureFingerprints.add(normalizeToolFailure(toolName, result))
      signals.failedToolNames.add(toolName)
    } else if (signals.failedToolNames.has(toolName)) {
      signals.recoveredToolNames.add(toolName)
    }
  }

  private collectMemoryFileSources(chatHistory: ChatMessage[], workspacePath?: string): string[] {
    const sources = new Set<string>()
    const addCandidate = (value: unknown): void => {
      if (typeof value !== 'string') return
      let candidate = value.trim().replace(/^file:\/\/\/?/i, '').replace(/#L\d+(?:-L?\d+)?$/i, '')
      candidate = candidate.replace(/^<|>$/g, '').replace(/\\/g, '/')
      if (!candidate || /^https?:\/\//i.test(candidate)) return
      const resolved = isAbsolute(candidate)
        ? candidate
        : workspacePath
          ? resolve(workspacePath, candidate)
          : ''
      if (!resolved) return
      try {
        if (fs.statSync(resolved).isFile()) sources.add(resolved.replace(/\\/g, '/'))
      } catch {
        // Ignore stale paths and values that merely resemble paths.
      }
    }

    const visit = (value: unknown, key = ''): void => {
      if (typeof value === 'string') {
        if (/(?:path|file|source|target|document|image|output)/i.test(key)) addCandidate(value)
        return
      }
      if (Array.isArray(value)) {
        value.forEach(item => visit(item, key))
        return
      }
      if (!value || typeof value !== 'object') return
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        visit(childValue, childKey)
      }
    }

    for (const message of chatHistory) {
      visit(message.tool_calls, 'tool_calls')
      const content = messageText(message)
      for (const match of content.matchAll(/<!--\s*关联文件:\s*(.*?)\s*-->/g)) addCandidate(match[1])
      for (const match of content.matchAll(/\[[^\]]*\]\(<([^>]+)>\)/g)) addCandidate(match[1])
      for (const match of content.matchAll(/源文件路径:\s*([^\]\r\n]+)/g)) addCandidate(match[1])
      for (const match of content.matchAll(/(?:完整缓存|完整归档):\s*([^\r\n]+)/g)) addCandidate(match[1])
    }

    return [...sources].slice(0, 12)
  }

  private async handleLongTaskAutoMemory(
    sessionId: string,
    chatHistory: ChatMessage[],
    config: { provider: string; apiKey: string; baseUrl: string; model: string; temperature: number },
    finalResponse?: string,
    webSources: WebMemorySource[] = [],
    assessment?: MemoryValueAssessment,
    workspacePath?: string
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
        const roleName = msg.role === 'user'
          ? '用户'
          : msg.role === 'tool'
            ? `工具结果${msg.name ? `(${msg.name})` : ''}`
            : '助手'
        chatLogs += `${roleName}: ${contentStr}\n`
      }

      const summarySystemPrompt = `你是一个经验丰富的 AI 对话与开发任务总结助手。
请你仔细阅读以下【一轮包含了用户提问、助手回答及本地系统工具调用的对话日志】，并为他们生成一段精炼、实用的 Markdown 摘要与知识沉淀。

请输出一条可以长期复用的“任务经验记忆”，而不是普通聊天摘要：
1. 【主题】禁止日期，不超过 20 字。
2. content 严格使用以下 Markdown 结构；没有信息的可选小节可以省略：
   - \`### 任务结果\`：完成了什么，状态是成功、部分成功还是未解决。
   - \`### 可复用经验\`：同类问题可直接复用的做法、关键条件和判断依据。
   - \`### 错误与恢复\`：仅在确有错误时记录现象、根因、无效尝试、最终解法和防复发措施。
   - \`### 关键变更与证据\`：关键文件、命令、产物或来源，不罗列无价值的过程日志。
3. 不要把临时路径、随机 ID、时间戳、一次性输出或未经验证的猜测写成长期经验。
4. 尚未解决的问题必须明确标记“未解决”，不能把尝试方案写成成功经验。
5. content 控制在 800 字以内，优先保留根因、解决方案和验证结果。
6. 日志中的 \`<!-- 关联文件: ... -->\` 必须在对应结论句尾原样保留。
7. 网页来源只能使用日志已有的 \`[S数字]\`，不得编造。
8. 只返回包含 title 和 content 的合法 JSON：
{
  "title": "主题名",
  "content": "### 任务结果\\n...\\n\\n### 可复用经验\\n..."
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
        const assessmentSection = assessment
          ? `### 记忆价值评估\n- 评分：${assessment.score}\n- 触发依据：${assessment.reasons.join('；') || '无'}\n\n`
          : ''
        const localFileSources = this.collectMemoryFileSources(chatHistory, workspacePath)
        const localFileSection = localFileSources.length > 0
          ? `\n\n---\n### 关联文件（按需读取）\n${localFileSources.map(filePath => `- [${basename(filePath)}](<${filePath}>)`).join('\n')}\n`
          : ''
        await appendMemorySummaryInternal(
          sessionId,
          summaryData.title,
          assessmentSection + summaryWithSources.content + localFileSection + backupDialogStr + sourceIndex
        )
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
      contextWindow?: number
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
    const contextWindow = Math.max(32000, Number(config.contextWindow) || DEFAULT_CONTEXT_WINDOW)
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
    const latestUserText = messageText([...chatHistory].reverse().find(message => message.role === 'user'))
    const memorySignals: MemoryValueSignals = {
      toolCalls: 0,
      toolNames: new Set(),
      failureFingerprints: new Set(),
      failedToolNames: new Set(),
      recoveredToolNames: new Set(),
      mutationCount: 0,
      generatedFileCount: 0,
      explicitRememberRequest: /(?:记住|记下来|保存.{0,6}(?:记忆|经验)|沉淀.{0,6}(?:记忆|经验)|remember this)/i.test(latestUserText),
      userCorrection: /(?:不对|错了|你理解错|不是这个意思|应该是|我说的是)/i.test(latestUserText),
      memoryAlreadySaved: false
    }
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
            let toolArgs: any = {}
            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}')
            } catch (pe) {
              console.error('解析工具参数失败', pe)
            }

            let toolResult: string
            let toolSuccess = true
            let webSources: any[] | undefined
            let imageFilePaths: string[] = []
            let generatedFiles: Array<{ name: string; path: string; size: number }> = []
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
                  toolSuccess = false
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
                    messageId: config.messageId,
                    isFrontend,
                    sandboxMode: !!sandboxMode,
                    event,
                    abortSignal
                  }
                  const res = await unifiedToolExecutor.execute(toolName, toolArgs, ctx)
                  toolResult = res.content
                  toolSuccess = res.success
                  webSources = Array.isArray(res.state?.sources) ? res.state.sources : undefined
                  imageFilePaths = this.getToolImagePaths(res.state)
                  generatedFiles = this.getToolGeneratedFiles(res.state)
                }
              }
            } else {
              const ctx = {
                workspacePath: workspacePath || '',
                sessionId,
                messageId: config.messageId,
                isFrontend,
                sandboxMode: !!sandboxMode,
                event,
                abortSignal
              }
              const res = await unifiedToolExecutor.execute(toolName, toolArgs, ctx)
              toolResult = res.content
              toolSuccess = res.success
              webSources = Array.isArray(res.state?.sources) ? res.state.sources : undefined
              imageFilePaths = this.getToolImagePaths(res.state)
              generatedFiles = this.getToolGeneratedFiles(res.state)
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
            let toolCachePath: string | undefined
            if (typeof contextToolResult === 'string' && countTokens(contextToolResult) > LARGE_TOOL_RESULT_TOKENS) {
              try {
                toolCachePath = await this.writeToolCache(sessionId, toolName, contextToolResult)
                contextToolResult = this.buildCachedToolContext(toolName, contextToolResult, toolCachePath)
                displayResult += `\n\n完整工具输出已缓存，可按需检索或分页读取：${toolCachePath.replace(/\\/g, '/')}`
              } catch (cacheError) {
                console.error('[AgentExecutor] 缓存大型工具输出失败，降级为截断上下文:', cacheError)
                contextToolResult = this.truncateToTokenBudget(contextToolResult, LARGE_TOOL_RESULT_TOKENS) +
                  '\n\n[系统保护] 工具输出缓存失败，当前仅保留截断内容。后续请使用 grep_content 或 read_file 分页缩小读取范围。'
              }
            }

            return {
              toolCallId: toolCall.id,
              toolName,
              toolSuccess,
              toolArgs,
              displayResult,
              contextToolResult,
              toolCachePath,
              webSources,
              imageFilePaths,
              generatedFiles
            }
          }))
          toolExecutionResults.push(...batchResults)
        }

        const results = toolExecutionResults
        const toolImagePathsForNextTurn: string[] = []

        // 3. 异步并行执行完后，顺序 yield 工具结果事件并写入 chatHistory 历史
        for (const res of results) {
          this.recordMemoryToolResult(
            memorySignals,
            res.toolName,
            res.toolSuccess,
            res.contextToolResult,
            Array.isArray(res.generatedFiles) ? res.generatedFiles.length : 0,
            res.toolArgs
          )
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
            result: res.displayResult,
            contextTokens: countTokens(res.contextToolResult)
          }
          if (res.generatedFiles?.length) {
            yield { type: 'generated_files', files: res.generatedFiles }
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

        const compactionPlan = this.getContextCompactionPlan(chatHistory, contextWindow)
        if (compactionPlan) {
          yield { type: 'context_compaction', status: 'started', beforeTokens: compactionPlan.beforeTokens }
          try {
            const compacted = await this.compactContext(chatHistory, compactionPlan, sessionId)
            yield {
              type: 'context_compaction',
              status: 'completed',
              beforeTokens: compactionPlan.beforeTokens,
              afterTokens: compacted.afterTokens,
              archivePath: compacted.archivePath,
              removedMessages: compacted.removedMessages,
              activeToolContextTokens: compacted.activeToolContextTokens
            }
          } catch (compactionError) {
            console.error('[AgentExecutor] 自动压缩上下文失败:', compactionError)
            yield {
              type: 'context_compaction',
              status: 'failed',
              beforeTokens: compactionPlan.beforeTokens,
              detail: compactionError instanceof Error ? compactionError.message : String(compactionError)
            }
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

        const memoryAssessment = this.assessMemoryValue(memorySignals, loopCount)
        console.log(`[Memory] 本轮记忆价值评分: ${memoryAssessment.score}`, memoryAssessment.reasons)
        if (memoryAssessment.shouldSummarize && sessionId) {
          console.log(`[System] 检测到高价值任务，自动触发后台经验总结及沉淀... (评分: ${memoryAssessment.score})`)
          this.handleLongTaskAutoMemory(
            sessionId,
            chatHistory,
            config,
            finalResponse,
            webSourcesForMemory,
            memoryAssessment,
            workspacePath
          ).catch(e => console.error('[System] 自动经验沉淀失败:', e))
        }

        return finalResponse
      }
    }

    const forcedStopMemoryAssessment = this.assessMemoryValue(memorySignals, loopCount, true)
    console.log(`[Memory] 最大轮数退出时记忆价值评分: ${forcedStopMemoryAssessment.score}`, forcedStopMemoryAssessment.reasons)
    if (forcedStopMemoryAssessment.shouldSummarize && sessionId) {
      console.log(`[System] 高价值任务达到最大轮数上限，自动触发后台经验总结及沉淀... (评分: ${forcedStopMemoryAssessment.score})`)
      this.handleLongTaskAutoMemory(
        sessionId,
        chatHistory,
        config,
        '智能代理执行工具链已达到最大轮数上限。',
        webSourcesForMemory,
        forcedStopMemoryAssessment,
        workspacePath
      ).catch(e => console.error('[System] 自动经验沉淀失败:', e))
    }

    yield {
      type: 'text',
      content: '⚠️ [系统中断] 智能代理执行工具链已达到最大轮数上限(100次)，已强制结束生成。请检查是否陷入死循环。'
    }

    return '智能代理执行工具链已达到最大轮数上限。'
  }
}

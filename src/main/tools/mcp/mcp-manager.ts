import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { McpNameMapper } from './mcp-name-mapper.js'

export interface McpServerConfig {
  id: string
  name: string
  url: string
  apiKey: string
  type?: 'sse' | 'stream' | 'auto'
  enabled: boolean
  description?: string
  tools?: any[] // 工具定义缓存字段
  timeout?: number // 超时时间（秒），可选
}

export class McpManager {
  private static instance: McpManager
  private connections: Map<string, { client: Client; transport: SSEClientTransport | StreamableHTTPClientTransport; tools: any[]; config: McpServerConfig }> = new Map()
  private pendingConfigs: McpServerConfig[] = []
  public systemMcpConfig: { servers: McpServerConfig[] } = { servers: [] }
  private toolsCache: Record<string, any[]> = {}


  private constructor() {
    this.loadSystemMcpConfig()
  }

  public static getInstance(): McpManager {
    if (!McpManager.instance) {
      McpManager.instance = new McpManager()
    }
    return McpManager.instance
  }

  // 设置配置但不立即连接（懒加载模式）
  public setConfigs(configs: McpServerConfig[]) {
    // 1. 同步将缓存的 tools 还原到新配置的内存对象中，防 tools 缓存丢失
    this.systemMcpConfig.servers = configs.map(s => {
      if (this.toolsCache[s.id]) {
        return { ...s, tools: this.toolsCache[s.id] }
      }
      return s
    })

    this.pendingConfigs = this.systemMcpConfig.servers.filter(c => c.enabled && c.url)
    console.log(`[MCP] 已加载 ${this.pendingConfigs.length} 个 MCP 服务配置（懒加载模式，将在首次使用时连接）`)

    // 同时断开已不再启用的旧连接
    const enabledIds = this.pendingConfigs.map(c => c.id)
    for (const [id, conn] of this.connections.entries()) {
      if (!enabledIds.includes(id)) {
        console.log(`[MCP] 断开已禁用的服务: ${conn.config.name} (${id})`)
        conn.client.close().catch(() => {})
        this.connections.delete(id)
      }
    }
  }

  // 仅在首次加载、且发现有启用服务未缓存工具 Schema 时，才进行后台连接以拉取定义
  public async ensureConnected(): Promise<void> {
    const configsToConnect = this.systemMcpConfig.servers.filter(
      s => s.enabled && s.url && (!s.tools || s.tools.length === 0)
    )
    if (configsToConnect.length === 0) return

    const needingConnection = configsToConnect.filter(config => !this.connections.has(config.id))
    if (needingConnection.length === 0) return

    console.log(`[MCP] 发现 ${needingConnection.length} 个未缓存工具定义的服务，执行初始化拉取连接...`)
    await this.connectAll(needingConnection)
  }

  public async connectAll(configs: McpServerConfig[]) {
    const configsToConnect = configs.filter(c => c.enabled && c.url)
    const activeIds = configsToConnect.map(c => c.id)

    // 1. 关闭不再活动或被禁用的连接
    for (const [id, conn] of this.connections.entries()) {
      if (!activeIds.includes(id)) {
        console.log(`[MCP] 断开并移除服务: ${conn.config.name} (${id})`)
        try {
          await conn.client.close()
        } catch (e) {
          console.error(`[MCP] 关闭客户端 ${id} 失败`, e)
        }
        this.connections.delete(id)
      }
    }

    // 2. 并发连接所有需要启用的服务
    await Promise.all(configsToConnect.map(async (config) => {
      const existing = this.connections.get(config.id)
      
      // 如果已存在连接，且参数没有变化，则无需重连
      if (existing && existing.config.url === config.url && existing.config.apiKey === config.apiKey && existing.config.type === config.type) {
        return
      }

      // 否则，先断开旧连接
      if (existing) {
        console.log(`[MCP] 配置变更，正在重新连接服务: ${config.name}`)
        try {
          await existing.client.close()
        } catch {}
        this.connections.delete(config.id)
      }

      console.log(`[MCP] 正在建立服务连接: ${config.name} -> ${config.url}`)
      try {
        const headers: Record<string, string> = {}
        if (config.apiKey) {
          headers['Authorization'] = `Bearer ${config.apiKey}`
        }

        let transport: StreamableHTTPClientTransport | SSEClientTransport
        let client = new Client(
          { name: 'AgentPet-Client', version: '1.0.0' },
          { capabilities: {} }
        )

        const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
        )

        const mcpType = config.type || 'stream'

        if (mcpType === 'stream') {
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 使用 Streamable HTTP 协议连接成功`)
        } else if (mcpType === 'sse') {
          transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 使用 SSE 协议连接成功`)
        } else {
          // auto 模式
          try {
            transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
            await Promise.race([client.connect(transport), connectTimeout(5000)])
            console.log(`[MCP] 服务 ${config.name} 使用 Streamable HTTP 协议连接成功`)
          } catch (httpErr: any) {
            console.warn(`[MCP] Streamable HTTP 连接失败 (${httpErr.message})，正在回退到 SSE 协议...`)
            client = new Client(
              { name: 'AgentPet-Client', version: '1.0.0' },
              { capabilities: {} }
            )
            transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
            await Promise.race([client.connect(transport), connectTimeout(5000)])
            console.log(`[MCP] 服务 ${config.name} 使用 SSE 协议连接成功（降级）`)
          }
        }

        const response = await client.listTools()
        const tools = response.tools || []
        
        this.connections.set(config.id, { client, transport, tools, config })
        this.updateServerToolsCache(config.id, tools)
        console.log(`[MCP] 服务 ${config.name} 连接成功！加载了 ${tools.length} 个外部工具`)
      } catch (err) {
        console.error(`[MCP] 服务 ${config.name} 连接失败:`, err)
      }
    }))
  }

  // 针对单个服务进行单独连接（被呼叫时按需触发）
  public async connectSingleServer(config: McpServerConfig): Promise<boolean> {
    console.log(`[MCP] 正在建立单体服务连接: ${config.name} -> ${config.url}`)
    try {
      const headers: Record<string, string> = {}
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`
      }

      let transport: StreamableHTTPClientTransport | SSEClientTransport
      let client = new Client(
        { name: 'AgentPet-Client', version: '1.0.0' },
        { capabilities: {} }
      )

      const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
      )

      const mcpType = config.type || 'stream'

      if (mcpType === 'stream') {
        transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
        await Promise.race([client.connect(transport), connectTimeout(5000)])
      } else if (mcpType === 'sse') {
        transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
        await Promise.race([client.connect(transport), connectTimeout(5000)])
      } else {
        try {
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
        } catch {
          client = new Client(
            { name: 'AgentPet-Client', version: '1.0.0' },
            { capabilities: {} }
          )
          transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
          await Promise.race([client.connect(transport), connectTimeout(5000)])
        }
      }

      const response = await client.listTools()
      const tools = response.tools || []

      this.connections.set(config.id, { client, transport, tools, config })
      this.updateServerToolsCache(config.id, tools)
      console.log(`[MCP] 服务 ${config.name} 按需握手成功！更新了 ${tools.length} 个工具`)
      return true
    } catch (err) {
      console.error(`[MCP] 握手单体服务 ${config.name} 失败:`, err)
      return false
    }
  }

  // 更新工具缓存并持久化写入磁盘缓存文件
  private updateServerToolsCache(serverId: string, tools: any[]) {
    let changed = false
    const oldTools = this.toolsCache[serverId] || []
    if (JSON.stringify(oldTools) !== JSON.stringify(tools)) {
      this.toolsCache[serverId] = tools
      changed = true
    }

    // 同时也要更新内存中 systemMcpConfig 的内容，保证后续 getTools 等在内存中可用
    this.systemMcpConfig.servers = this.systemMcpConfig.servers.map(s => {
      if (s.id === serverId) {
        return { ...s, tools }
      }
      return s
    })

    if (changed) {
      try {
        const cachePath = join(app.getPath('userData'), 'mcp_tools_cache.json')
        fs.writeFileSync(cachePath, JSON.stringify(this.toolsCache, null, 2), 'utf8')
        console.log(`[MCP] 已将服务 ${serverId} 的工具描述列表成功写入本地缓存磁盘文件`)
      } catch (e) {
        console.error('[MCP] 写入本地工具缓存文件失败:', e)
      }
    }
  }


  private async reconnectServer(id: string): Promise<boolean> {
    const conn = this.connections.get(id)
    if (!conn) return false
    const config = conn.config

    console.log(`[MCP] 正在尝试重连服务: ${config.name} (${id})`)
    try {
      try {
        await conn.client.close()
      } catch {}
      this.connections.delete(id)

      const headers: Record<string, string> = {}
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`
      }

      let transport: StreamableHTTPClientTransport | SSEClientTransport
      let client = new Client(
        { name: 'AgentPet-Client', version: '1.0.0' },
        { capabilities: {} }
      )

      const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
      )

      const mcpType = config.type || 'stream'

      if (mcpType === 'stream') {
        transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
        await Promise.race([client.connect(transport), connectTimeout(5000)])
        console.log(`[MCP] 服务 ${config.name} 重连成功 (Streamable HTTP)`)
      } else if (mcpType === 'sse') {
        transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
        await Promise.race([client.connect(transport), connectTimeout(5000)])
        console.log(`[MCP] 服务 ${config.name} 重连成功 (SSE)`)
      } else {
        try {
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 重连成功 (Streamable HTTP)`)
        } catch (httpErr: any) {
          console.warn(`[MCP] 服务 ${config.name} 重连 Streamable HTTP 失败，回退到 SSE...`)
          client = new Client(
            { name: 'AgentPet-Client', version: '1.0.0' },
            { capabilities: {} }
          )
          transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 重连成功 (SSE)`)
        }
      }

      const response = await client.listTools()
      const tools = response.tools || []

      this.connections.set(config.id, { client, transport, tools, config })
      this.updateServerToolsCache(config.id, tools)
      return true
    } catch (err) {
      console.error(`[MCP] 服务 ${config.name} 重连失败:`, err)
      return false
    }
  }

  public async disconnectAll() {
    for (const conn of this.connections.values()) {
      try {
        await conn.client.close()
      } catch {}
    }
    this.connections.clear()
  }

  public getTools(): any[] {
    const allTools: any[] = []
    for (const server of this.systemMcpConfig.servers) {
      if (!server.enabled) continue
      
      const conn = this.connections.get(server.id)
      let serverTools: any[] = []
      if (conn) {
        serverTools = conn.tools
      } else if (server.tools && Array.isArray(server.tools)) {
        serverTools = server.tools
      }

      // 将每一个工具名称转化为安全的模型端 API 名字
      for (const t of serverTools) {
        allTools.push({
          ...t,
          name: McpNameMapper.toSafeModelName(t.name)
        })
      }
    }
    return allTools
  }

  public getActiveServers(): any[] {
    const list: any[] = []
    for (const conn of this.connections.values()) {
      list.push({
        id: conn.config.id,
        name: conn.config.name,
        url: conn.config.url,
        description: conn.config.description || '',
        toolsCount: conn.tools.length
      })
    }
    return list
  }

  public hasTool(name: string): boolean {
    const realName = McpNameMapper.toOriginalName(name)
    for (const server of this.systemMcpConfig.servers) {
      if (!server.enabled) continue
      
      const conn = this.connections.get(server.id)
      if (conn && conn.tools.some((t: any) => t.name === realName)) {
        return true
      }
      if (server.tools && Array.isArray(server.tools) && server.tools.some((t: any) => t.name === realName)) {
        return true
      }
    }
    return false
  }
  public async executeTool(name: string, args: any, abortSignal?: AbortSignal, isRetry = false): Promise<string> {
    const realName = McpNameMapper.toOriginalName(name)
    let targetServer: McpServerConfig | null = null
    for (const server of this.systemMcpConfig.servers) {
      if (!server.enabled) continue
      
      const conn = this.connections.get(server.id)
      if (conn && conn.tools.some((t: any) => t.name === realName)) {
        targetServer = server
        break
      }
      if (server.tools && Array.isArray(server.tools) && server.tools.some((t: any) => t.name === realName)) {
        targetServer = server
        break
      }
    }

    if (!targetServer) {
      return `错误：未在任何已启用的 MCP 服务中找到工具: ${name}`
    }

    let targetConn = this.connections.get(targetServer.id)
    if (!targetConn) {
      console.log(`[MCP] 工具 ${realName} 被调用，触发对服务 ${targetServer.name} 的按需握手连接...`)
      const success = await this.connectSingleServer(targetServer)
      if (!success) {
        return `错误：工具 ${realName} 被调用，但建立服务连接 ${targetServer.name} 失败`
      }
      targetConn = this.connections.get(targetServer.id)
    }

    if (!targetConn) {
      return `错误：未在任何已连接的 MCP 服务中找到工具: ${realName}`
    }

    const targetConnId = targetServer.id

    let timeoutMs = 60000 // 默认放宽到 60 秒
    if (args && typeof args.timeout_seconds === 'number') {
      timeoutMs = args.timeout_seconds * 1000
    } else if (targetServer.timeout && typeof targetServer.timeout === 'number') {
      timeoutMs = targetServer.timeout * 1000
    }

    let timer: NodeJS.Timeout | null = null
    let onAbort: (() => void) | null = null

    try {
      const promises: Promise<any>[] = []

      // 1. 启动工具调用
      const callPromise = targetConn.client.callTool({ name: realName, arguments: args })
      promises.push(callPromise)

      // 2. 注入超时限制
      if (timeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP 工具调用超时（限制 ${timeoutMs / 1000} 秒）`)), timeoutMs)
        })
        promises.push(timeoutPromise)
      }

      // 3. 注入中止信号
      if (abortSignal) {
        if (abortSignal.aborted) {
          throw new Error('UserAborted')
        }
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('UserAborted'))
          abortSignal.addEventListener('abort', onAbort)
        })
        promises.push(abortPromise)
      }

      const response = await Promise.race(promises)

      if (response && response.content) {
        return (response.content as any[])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
      }
      return 'MCP 工具执行完毕，但未返回可读文本。'
    } catch (err: any) {
      console.error(`[MCP] 调用外部工具 ${realName} 失败`, err)

      if (err.message === 'UserAborted') {
        throw err
      }

      if (!isRetry) {
        console.log(`[MCP] 检测到服务 ${targetConn.config.name} 的连接可能已失效/报错，正在尝试自动重连...`)
        const success = await this.reconnectServer(targetConnId)
        if (success) {
          console.log(`[MCP] 服务 ${targetConn.config.name} 重连成功，正在重新执行工具 ${name}...`)
          return this.executeTool(name, args, abortSignal, true)
        }
      }

      return `错误：调用外部 MCP 工具失败: ${err.message || err}`
    } finally {
      if (timer) clearTimeout(timer)
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort)
      }
    }
  }


  public loadSystemMcpConfig() {
    try {
      const configPath = join(app.getPath('userData'), 'system_mcp_config.json')
      const cachePath = join(app.getPath('userData'), 'mcp_tools_cache.json')
      let parsed: any = null
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf8')
        try {
          parsed = JSON.parse(data)
        } catch {}
      }

      if (parsed && Array.isArray(parsed.servers)) {
        this.systemMcpConfig = { servers: parsed.servers }
      } else {
        this.systemMcpConfig = { servers: [] }
      }

      // 尝试加载工具定义缓存
      if (fs.existsSync(cachePath)) {
        try {
          const cacheData = fs.readFileSync(cachePath, 'utf8')
          this.toolsCache = JSON.parse(cacheData)
        } catch {
          this.toolsCache = {}
        }
      }

      // 将缓存的 tools 还原到内存中的 servers 对象中，供系统运行时调用
      this.systemMcpConfig.servers = this.systemMcpConfig.servers.map(s => {
        if (this.toolsCache[s.id]) {
          return { ...s, tools: this.toolsCache[s.id] }
        }
        return s
      })

      this.setConfigs(this.systemMcpConfig.servers)
    } catch (e) {
      console.error('加载全局 MCP 配置文件失败:', e)
    }
  }

  public saveSystemMcpConfig(config: any) {
    try {
      const configPath = join(app.getPath('userData'), 'system_mcp_config.json')
      // 过滤掉大体积的 tools 缓存字段，使主配置文件保持精炼
      const cleanedConfig = {
        ...config,
        servers: (config.servers || []).map((s: any) => {
          const { tools: _t, ...rest } = s
          return rest
        })
      }
      fs.writeFileSync(configPath, JSON.stringify(cleanedConfig, null, 2), 'utf8')
    } catch (e) {
      console.error('保存全局 MCP 配置文件失败:', e)
    }
  }

}

export const mcpManager = McpManager.getInstance()

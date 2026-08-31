import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { McpNameMapper } from './mcp-name-mapper.js'
import {
  loadSecureSystemMcpConfig,
  sanitizeSystemMcpConfig,
  saveSecureSystemMcpConfig
} from '../../security/secure-mcp-config'
import type { RuntimeMcpConfig } from '../../security/mcp-config-store'
import type { ToolTraceEvent } from '../core/types'

export interface McpServerConfig {
  id: string
  name: string
  url: string
  apiKey: string
  hasApiKey?: boolean
  type?: 'sse' | 'stream' | 'auto'
  enabled: boolean
  description?: string
  tools?: any[] // 工具定义缓存字段
  timeout?: number // 超时时间（秒），可选
}

type McpClientTransport =
  | SSEClientTransport
  | StreamableHTTPClientTransport

interface McpTraceCapture {
  attempt: number
  report: (event: ToolTraceEvent) => Promise<void>
  request?: any
  response?: any
  requestId?: string | number
}

interface McpConnection {
  client: Client
  transport: McpClientTransport
  tools: any[]
  config: McpServerConfig
  pendingToolTraces: McpTraceCapture[]
  toolTracesByRequestId: Map<string | number, McpTraceCapture>
  connectionTrace?: {
    report: (event: ToolTraceEvent) => Promise<void>
    responseWrites: Promise<void>[]
  }
  connectionTracesByRequestId: Map<string | number, { method: string }>
}

export class McpManager {
  private static instance: McpManager
  private connections: Map<string, McpConnection> = new Map()
  private pendingConfigs: McpServerConfig[] = []
  public systemMcpConfig: { servers: McpServerConfig[] } = { servers: [] }
  private toolsCache: Record<string, any[]> = {}


  private constructor() {}

  private isLegacyPaddleMcpConfig(config: McpServerConfig): boolean {
    const legacy = config as unknown as { preset?: string; type?: string }
    return legacy.preset === 'paddleocr-aistudio' || legacy.type === 'stdio'
  }

  private isRunnable(config: McpServerConfig): boolean {
    return Boolean(config.url)
  }

  private displayEndpoint(config: McpServerConfig): string {
    return config.url
  }

  private createTransport(config: McpServerConfig): McpClientTransport {
    const headers: Record<string, string> = {}
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    if (config.type === 'sse') {
      return new SSEClientTransport(new URL(config.url), {
        eventSourceInitDict: { headers }
      } as any)
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers }
    })
  }

  private transportName(transport: McpClientTransport): 'sse' | 'streamable-http' {
    return transport instanceof SSEClientTransport ? 'sse' : 'streamable-http'
  }

  /**
   * Installs a passive JSON-RPC tap after the SDK has connected. The tap keeps
   * the SDK's original handlers intact while retaining the exact messages it
   * generated and parsed, including JSON-RPC ids and error envelopes.
   */
  private createConnection(
    client: Client,
    transport: McpClientTransport,
    tools: any[],
    config: McpServerConfig,
    connectionTrace?: (event: ToolTraceEvent) => Promise<void>
  ): McpConnection {
    const connection: McpConnection = {
      client,
      transport,
      tools,
      config,
      pendingToolTraces: [],
      toolTracesByRequestId: new Map(),
      connectionTrace: connectionTrace ? { report: connectionTrace, responseWrites: [] } : undefined,
      connectionTracesByRequestId: new Map()
    }
    const transportAny = transport as any
    const originalSend = transportAny.send.bind(transport)
    const originalOnMessage = transportAny.onmessage?.bind(transport)

    transportAny.send = async (message: any, options?: any): Promise<void> => {
      const messages = Array.isArray(message) ? message : [message]
      const request = messages.find(item => item?.method === 'tools/call')
      const capture = request ? connection.pendingToolTraces.shift() : undefined
      if (capture) {
        capture.request = request
        if (typeof request.id === 'string' || typeof request.id === 'number') {
          capture.requestId = request.id
          connection.toolTracesByRequestId.set(request.id, capture)
        }
        await capture.report({
          type: 'mcp/request',
          data: {
            server: {
              id: config.id,
              name: config.name,
              endpoint: this.displayEndpoint(config),
              transport: this.transportName(transport)
            },
            attempt: capture.attempt,
            request
          }
        })
      }
      if (!capture && connection.connectionTrace) {
        for (const connectionMessage of messages) {
          if (!connectionMessage?.method) continue
          if (typeof connectionMessage.id === 'string' || typeof connectionMessage.id === 'number') {
            connection.connectionTracesByRequestId.set(connectionMessage.id, {
              method: connectionMessage.method
            })
          }
          await connection.connectionTrace.report({
            type: 'mcp/request',
            data: {
              phase: 'connection',
              server: {
                id: config.id,
                name: config.name,
                endpoint: this.displayEndpoint(config),
                transport: this.transportName(transport)
              },
              request: connectionMessage
            }
          })
        }
      }
      await originalSend(message, options)
    }

    transportAny.onmessage = (message: any, extra?: any): void => {
      if (typeof message?.id === 'string' || typeof message?.id === 'number') {
        const capture = connection.toolTracesByRequestId.get(message.id)
        if (capture) capture.response = message
        const connectionRequest = connection.connectionTracesByRequestId.get(message.id)
        if (connectionRequest && connection.connectionTrace) {
          const write = connection.connectionTrace.report({
            type: 'mcp/response',
            data: {
              phase: 'connection',
              requestMethod: connectionRequest.method,
              server: {
                id: config.id,
                name: config.name,
                endpoint: this.displayEndpoint(config),
                transport: this.transportName(transport)
              },
              response: message
            }
          })
          connection.connectionTrace.responseWrites.push(write)
          connection.connectionTracesByRequestId.delete(message.id)
        }
      }
      originalOnMessage?.(message, extra)
    }
    return connection
  }

  private releaseTraceCapture(connection: McpConnection, capture: McpTraceCapture): void {
    const pendingIndex = connection.pendingToolTraces.indexOf(capture)
    if (pendingIndex >= 0) connection.pendingToolTraces.splice(pendingIndex, 1)
    if (capture.requestId !== undefined) connection.toolTracesByRequestId.delete(capture.requestId)
  }

  private async finishConnectionTrace(connection: McpConnection): Promise<void> {
    const trace = connection.connectionTrace
    if (!trace) return
    await Promise.all(trace.responseWrites)
    connection.connectionTrace = undefined
    connection.connectionTracesByRequestId.clear()
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

    this.pendingConfigs = this.systemMcpConfig.servers.filter(
      c => c.enabled && this.isRunnable(c)
    )
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
      s => s.enabled && this.isRunnable(s) && (!s.tools || s.tools.length === 0)
    )
    if (configsToConnect.length === 0) return

    const needingConnection = configsToConnect.filter(config => !this.connections.has(config.id))
    if (needingConnection.length === 0) return

    console.log(`[MCP] 发现 ${needingConnection.length} 个未缓存工具定义的服务，执行初始化拉取连接...`)
    await this.connectAll(needingConnection)
  }

  public async connectAll(configs: McpServerConfig[]) {
    const configsToConnect = configs.filter(c => c.enabled && this.isRunnable(c))
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
      if (
        existing &&
        existing.config.url === config.url &&
        existing.config.apiKey === config.apiKey &&
        existing.config.type === config.type
      ) {
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

      console.log(`[MCP] 正在建立服务连接: ${config.name} -> ${this.displayEndpoint(config)}`)
      try {
        let transport: McpClientTransport
        let client = new Client(
          { name: 'AgentPet-Client', version: '1.0.0' },
          { capabilities: {} }
        )

        const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
        )

        const mcpType = config.type || 'stream'

        if (mcpType === 'stream') {
          transport = this.createTransport(config)
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 使用 Streamable HTTP 协议连接成功`)
        } else if (mcpType === 'sse') {
          transport = this.createTransport(config)
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 使用 SSE 协议连接成功`)
        } else {
          // auto 模式
          try {
            transport = this.createTransport({ ...config, type: 'stream' })
            await Promise.race([client.connect(transport), connectTimeout(5000)])
            console.log(`[MCP] 服务 ${config.name} 使用 Streamable HTTP 协议连接成功`)
          } catch (httpErr: any) {
            console.warn(`[MCP] Streamable HTTP 连接失败 (${httpErr.message})，正在回退到 SSE 协议...`)
            client = new Client(
              { name: 'AgentPet-Client', version: '1.0.0' },
              { capabilities: {} }
            )
            transport = this.createTransport({ ...config, type: 'sse' })
            await Promise.race([client.connect(transport), connectTimeout(5000)])
            console.log(`[MCP] 服务 ${config.name} 使用 SSE 协议连接成功（降级）`)
          }
        }

        const response = await client.listTools()
        const tools = response.tools || []
        
        this.connections.set(config.id, this.createConnection(client, transport, tools, config))
        this.updateServerToolsCache(config.id, tools)
        console.log(`[MCP] 服务 ${config.name} 连接成功！加载了 ${tools.length} 个外部工具`)
      } catch (err) {
        console.error(`[MCP] 服务 ${config.name} 连接失败:`, err)
      }
    }))
  }

  // 针对单个服务进行单独连接（被呼叫时按需触发）
  public async connectSingleServer(
    config: McpServerConfig,
    traceEvent?: (event: ToolTraceEvent) => void | Promise<void>
  ): Promise<boolean> {
    console.log(
      `[MCP] 正在建立单体服务连接: ${config.name} -> ${this.displayEndpoint(config)}`
    )
    const reportConnectionTrace = async (event: ToolTraceEvent): Promise<void> => {
      if (!traceEvent) return
      try {
        await traceEvent(event)
      } catch (error) {
        console.warn('[MCP] 写入连接轨迹失败', error)
      }
    }
    await reportConnectionTrace({
      type: 'mcp/connection',
      data: {
        status: 'connecting',
        server: {
          id: config.id,
          name: config.name,
          endpoint: this.displayEndpoint(config),
          configuredTransport: config.type || 'stream'
        }
      }
    })
    let connection: McpConnection | undefined
    try {
      let transport: McpClientTransport
      let client = new Client(
        { name: 'AgentPet-Client', version: '1.0.0' },
        { capabilities: {} }
      )

      const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
      )

      const mcpType = config.type || 'stream'

      if (mcpType === 'stream') {
        transport = this.createTransport(config)
        connection = this.createConnection(client, transport, [], config, reportConnectionTrace)
        await Promise.race([client.connect(transport), connectTimeout(5000)])
      } else if (mcpType === 'sse') {
        transport = this.createTransport(config)
        connection = this.createConnection(client, transport, [], config, reportConnectionTrace)
        await Promise.race([client.connect(transport), connectTimeout(5000)])
      } else {
        try {
          transport = this.createTransport({ ...config, type: 'stream' })
          connection = this.createConnection(client, transport, [], config, reportConnectionTrace)
          await Promise.race([client.connect(transport), connectTimeout(5000)])
        } catch (httpError) {
          if (connection) await this.finishConnectionTrace(connection)
          await reportConnectionTrace({
            type: 'mcp/connection',
            data: {
              status: 'fallback',
              server: {
                id: config.id,
                name: config.name,
                endpoint: this.displayEndpoint(config)
              },
              from: 'streamable-http',
              to: 'sse',
              reason: httpError instanceof Error ? httpError.message : String(httpError)
            }
          })
          client = new Client(
            { name: 'AgentPet-Client', version: '1.0.0' },
            { capabilities: {} }
          )
          transport = this.createTransport({ ...config, type: 'sse' })
          connection = this.createConnection(client, transport, [], config, reportConnectionTrace)
          await Promise.race([client.connect(transport), connectTimeout(5000)])
        }
      }

      const response = await client.listTools()
      const tools = response.tools || []

      if (!connection) throw new Error('MCP 连接对象未初始化')
      connection.tools = tools
      await this.finishConnectionTrace(connection)
      this.connections.set(config.id, connection)
      await reportConnectionTrace({
        type: 'mcp/connection',
        data: {
          status: 'ready',
          server: {
            id: config.id,
            name: config.name,
            endpoint: this.displayEndpoint(config),
            transport: this.transportName(connection.transport)
          },
          toolsCount: tools.length
        }
      })
      this.updateServerToolsCache(config.id, tools)
      console.log(`[MCP] 服务 ${config.name} 按需握手成功！更新了 ${tools.length} 个工具`)
      return true
    } catch (err) {
      console.error(`[MCP] 握手单体服务 ${config.name} 失败:`, err)
      if (connection) await this.finishConnectionTrace(connection)
      await reportConnectionTrace({
        type: 'mcp/error',
        data: {
          phase: 'connection',
          server: {
            id: config.id,
            name: config.name,
            endpoint: this.displayEndpoint(config),
            ...(connection ? { transport: this.transportName(connection.transport) } : {})
          },
          error: {
            name: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : String(err)
          }
        }
      })
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

      let transport: McpClientTransport
      let client = new Client(
        { name: 'AgentPet-Client', version: '1.0.0' },
        { capabilities: {} }
      )

      const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
      )

      const mcpType = config.type || 'stream'

      if (mcpType === 'stream') {
        transport = this.createTransport(config)
        await Promise.race([client.connect(transport), connectTimeout(5000)])
        console.log(`[MCP] 服务 ${config.name} 重连成功 (Streamable HTTP)`)
      } else if (mcpType === 'sse') {
        transport = this.createTransport(config)
        await Promise.race([client.connect(transport), connectTimeout(5000)])
        console.log(`[MCP] 服务 ${config.name} 重连成功 (SSE)`)
      } else {
        try {
          transport = this.createTransport({ ...config, type: 'stream' })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 重连成功 (Streamable HTTP)`)
        } catch (httpErr: any) {
          console.warn(`[MCP] 服务 ${config.name} 重连 Streamable HTTP 失败，回退到 SSE...`)
          client = new Client(
            { name: 'AgentPet-Client', version: '1.0.0' },
            { capabilities: {} }
          )
          transport = this.createTransport({ ...config, type: 'sse' })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 重连成功 (SSE)`)
        }
      }

      const response = await client.listTools()
      const tools = response.tools || []

      this.connections.set(config.id, this.createConnection(client, transport, tools, config))
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
    for (const server of this.systemMcpConfig.servers) {
      if (!server.enabled || !this.isRunnable(server)) continue
      
      const conn = this.connections.get(server.id)
      let toolsCount = 0
      let status = 'disconnected'
      
      if (conn) {
        toolsCount = conn.tools.length
        status = 'connected'
      } else if (server.tools && Array.isArray(server.tools)) {
        toolsCount = server.tools.length
        status = 'loaded'
      }

      list.push({
        id: server.id,
        name: server.name,
        url: this.displayEndpoint(server),
        description: server.description || '',
        toolsCount,
        status
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

  public async getServerTools(serverId: string): Promise<any[]> {
    const server = this.systemMcpConfig.servers.find(item => item.id === serverId)
    if (!server || !server.enabled || !this.isRunnable(server)) return []
    if (!this.connections.has(server.id)) {
      const connected = await this.connectSingleServer(server)
      if (!connected) return []
    }
    return [...(this.connections.get(server.id)?.tools || [])]
  }

  public async executeTool(
    name: string,
    args: any,
    abortSignal?: AbortSignal,
    isRetry = false,
    traceEvent?: (event: ToolTraceEvent) => void | Promise<void>
  ): Promise<string> {
    const reportTrace = async (event: ToolTraceEvent): Promise<void> => {
      if (!traceEvent) return
      try {
        await traceEvent(event)
      } catch (error) {
        console.warn('[MCP] 写入协议轨迹失败', error)
      }
    }
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
      const success = await this.connectSingleServer(targetServer, traceEvent)
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
    const capture: McpTraceCapture = {
      attempt: isRetry ? 2 : 1,
      report: reportTrace
    }
    targetConn.pendingToolTraces.push(capture)

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
      await reportTrace({
        type: 'mcp/response',
        data: {
          server: {
            id: targetServer.id,
            name: targetServer.name,
            endpoint: this.displayEndpoint(targetServer),
            transport: this.transportName(targetConn.transport)
          },
          attempt: capture.attempt,
          response: capture.response ?? {
            captureUnavailable: true,
            sdkResult: response
          }
        }
      })

      if (response && response.content) {
        return (response.content as any[])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
      }
      return 'MCP 工具执行完毕，但未返回可读文本。'
    } catch (err: any) {
      console.error(`[MCP] 调用外部工具 ${realName} 失败`, err)
      await reportTrace({
        type: 'mcp/error',
        data: {
          server: {
            id: targetServer.id,
            name: targetServer.name,
            endpoint: this.displayEndpoint(targetServer),
            transport: this.transportName(targetConn.transport)
          },
          attempt: capture.attempt,
          ...(capture.request !== undefined ? { request: capture.request } : {}),
          ...(capture.response !== undefined ? { response: capture.response } : {}),
          error: {
            name: err?.name || 'Error',
            message: err?.message || String(err)
          }
        }
      })

      if (err.message === 'UserAborted') {
        throw err
      }

      if (!isRetry) {
        console.log(`[MCP] 检测到服务 ${targetConn.config.name} 的连接可能已失效/报错，正在尝试自动重连...`)
        const success = await this.reconnectServer(targetConnId)
        if (success) {
          console.log(`[MCP] 服务 ${targetConn.config.name} 重连成功，正在重新执行工具 ${name}...`)
          return this.executeTool(name, args, abortSignal, true, traceEvent)
        }
      }

      return `错误：调用外部 MCP 工具失败: ${err.message || err}`
    } finally {
      this.releaseTraceCapture(targetConn, capture)
      if (timer) clearTimeout(timer)
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort)
      }
    }
  }


  public loadSystemMcpConfig(): { servers: McpServerConfig[] } {
    try {
      const cachePath = join(app.getPath('userData'), 'mcp_tools_cache.json')
      const loaded = loadSecureSystemMcpConfig()
      const loadedServers = loaded.servers as McpServerConfig[]
      const servers = loadedServers.filter(server => !this.isLegacyPaddleMcpConfig(server))
      if (servers.length !== loadedServers.length) {
        saveSecureSystemMcpConfig({ servers })
      }
      this.systemMcpConfig = { servers }
      if (loaded.secretMigrationPending) {
        console.warn('[Secrets] MCP credential migration is pending because OS encryption is unavailable')
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
      this.systemMcpConfig = { servers: [] }
    }
    return this.systemMcpConfig
  }

  public saveSystemMcpConfig(config: Record<string, unknown>): { servers: McpServerConfig[] } {
    const rawServers = Array.isArray(config.servers) ? config.servers as McpServerConfig[] : []
    const saved = saveSecureSystemMcpConfig({
      ...config,
      servers: rawServers.filter(server => !this.isLegacyPaddleMcpConfig(server))
    })
    this.systemMcpConfig = { servers: saved.servers as McpServerConfig[] }
    this.setConfigs(this.systemMcpConfig.servers)
    return this.systemMcpConfig
  }

  public getSanitizedSystemMcpConfig(): RuntimeMcpConfig {
    return sanitizeSystemMcpConfig(this.systemMcpConfig as RuntimeMcpConfig)
  }

}

export const mcpManager = McpManager.getInstance()

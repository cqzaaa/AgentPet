import readline from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import { AcpUpdateBuffer } from './update-buffer'
import { IdlePool } from '../idle-pool'
import { createAcpObjectStreamPair } from '../acp-object-stream'
import {
  killProcessTree,
  resolveExecutable,
  spawnAgentProcess
} from '../process-utils'
import type {
  ExternalAgentDefinition,
  ExternalAgentModel,
  ExternalAgentProtocolEvent
} from '../types'

const PROBE_TIMEOUT_MS = 20_000
const PROMPT_TIMEOUT_MS = 30 * 60_000
const STDERR_LIMIT = 32_768

interface RpcMessage {
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code?: number; message?: string; data?: unknown }
}

class CodexInternalRpc {
  public uses = 0
  private closedError?: Error
  private readonly closeListeners = new Set<(error: Error) => void>()
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly notificationListeners = new Set<(message: RpcMessage) => void>()
  public stderr = ''

  constructor(public readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-STDERR_LIMIT) })
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (!line.trim()) return
      let message: RpcMessage
      try { message = JSON.parse(line) as RpcMessage } catch { return }
      if (message.id !== undefined && !message.method) {
        const id = Number(message.id)
        const waiter = this.pending.get(id)
        if (!waiter) return
        this.pending.delete(id)
        if (message.error) waiter.reject(new Error(message.error.message || `Codex RPC error ${message.error.code}`))
        else waiter.resolve(message.result)
        return
      }
      if (message.id !== undefined && message.method) {
        void this.write({ id: message.id, error: { code: -32601, message: `不支持的交互请求：${message.method}` } }).catch(error => this.rejectAll(error))
        return
      }
      this.notificationListeners.forEach(listener => listener(message))
    })
    child.once('error', error => this.rejectAll(error))
    child.once('close', code => this.rejectAll(new Error(`Codex App Server 已退出（${code ?? 'unknown'}）`)))
    child.stdin.on('error', error => this.rejectAll(error))
  }

  public request(method: string, params: unknown, timeoutMs = PROBE_TIMEOUT_MS): Promise<any> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 在 ${Math.round(timeoutMs / 1000)} 秒内未响应`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) }
      })
      void this.write({ id, method, params }).catch(error => this.rejectAll(error))
    })
  }

  public notify(method: string, params: unknown = {}): Promise<void> {
    return this.write({ method, params })
  }

  public onNotification(listener: (message: RpcMessage) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  public get healthy(): boolean {
    return !this.closedError && !this.child.killed && this.child.exitCode === null && this.uses < 8
  }

  public onClose(listener: (error: Error) => void): () => void {
    if (this.closedError) listener(this.closedError)
    else this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  private write(message: RpcMessage): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError)
    const line = `${JSON.stringify(message)}\n`
    if (this.child.stdin.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) {
      return Promise.reject(new Error('Codex RPC 写入队列超过容量限制'))
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(line, error => error ? reject(error) : resolve())
    })
  }

  private rejectAll(error: Error): void {
    this.closedError = error
    this.pending.forEach(waiter => waiter.reject(error))
    this.pending.clear()
    this.closeListeners.forEach(listener => listener(error))
    this.closeListeners.clear()
  }
}

const processPool = new IdlePool<CodexInternalRpc>(rpc => killProcessTree(rpc.child), rpc => rpc.healthy)
export const disposeCodexProcessPool = (): Promise<void> => processPool.dispose()

export interface CodexAcpStreamPair {
  clientStream: acp.Stream
  dispose: () => Promise<void>
}

export class CodexAcpBridge {
  private disposed = false
  private updates?: AcpUpdateBuffer
  private currentCwd: string
  private configuredModel?: string
  private activeRpc: CodexInternalRpc | null = null
  private startingRpc: CodexInternalRpc | null = null

  constructor(private readonly definition: ExternalAgentDefinition, cwd: string, model?: string) {
    this.currentCwd = cwd
    this.configuredModel = model
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    this.updates?.dispose()
    const rpc = this.activeRpc
    const starting = this.startingRpc
    this.activeRpc = null
    this.startingRpc = null
    if (rpc) await killProcessTree(rpc.child)
    if (starting && starting !== rpc) await killProcessTree(starting.child)
  }

  private acquireProcess() {
    // Include launch environment and workspace, never share an in-flight process.
    const key = JSON.stringify([this.definition, this.currentCwd, process.env])
    return processPool.acquire(key, () => this.startCodexProcess())
  }

  public createServer(): acp.AgentApp {
    const server = acp.agent({
      name: 'Codex ACP Bridge'
    })

    server.onRequest(acp.methods.agent.initialize, async () => {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          prompts: {},
          tools: {},
          sessionCapabilities: {}
        },
        agentInfo: {
          name: 'Codex App Server (ACP Bridge)',
          version: '1.0.0'
        }
      }
    })

    server.onRequest(acp.methods.agent.session.new, async ({ params }) => {
      if (params.cwd) {
        this.currentCwd = params.cwd
      }
      return {
        sessionId: `codex-session-${Date.now()}`,
        configOptions: []
      }
    })

    server.onNotification(acp.methods.agent.session.cancel, async () => {
      await this.dispose()
    })

    server.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const promptText = this.extractPromptText(params.prompt)
      try {
        return await this.executeCodexPrompt(params.sessionId, promptText, client)
      } catch (error) {
        throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error))
      }
    })

    return server
  }

  public async listModels(): Promise<ExternalAgentModel[]> {
    const lease = await this.acquireProcess()
    const rpc = lease.value
    let reusable = false
    try {
      const response = await rpc.request('model/list', { limit: 100, includeHidden: false })
      reusable = true
      return (Array.isArray(response?.data) ? response.data : []).map((model: any) => ({
        id: String(model.model || model.id),
        name: String(model.displayName || model.model || model.id),
        description: typeof model.description === 'string' ? model.description : undefined,
        source: 'cli' as const
      }))
    } finally {
      await lease.release(reusable)
    }
  }

  private extractPromptText(prompt: unknown): string {
    if (typeof prompt === 'string') return prompt
    if (Array.isArray(prompt)) {
      return prompt.map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text
        return ''
      }).join('\n')
    }
    if (prompt && typeof prompt === 'object' && 'text' in prompt && typeof (prompt as { text: unknown }).text === 'string') {
      return String((prompt as { text: string }).text)
    }
    return String(prompt || '')
  }

  private async startCodexProcess(): Promise<CodexInternalRpc> {
    const resolved = await resolveExecutable(this.definition.executable, this.definition.executableAliases)
    if (this.disposed) throw new Error('Codex ACP 连接已关闭')
    if (!resolved) throw new Error('未找到 Codex CLI，请先安装 Codex，或把 codex 命令加入 PATH')
    const child = spawnAgentProcess(resolved, this.definition.args && this.definition.args.length ? this.definition.args : ['app-server'], {
      cwd: this.currentCwd,
      env: this.definition.env
    })
    const rpc = new CodexInternalRpc(child)
    this.startingRpc = rpc
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'agentpet', title: 'AgentPet ACP Bridge', version: '1.0.0' },
        capabilities: {}
      })
      await rpc.notify('initialized')
      return rpc
    } catch (error) {
      await killProcessTree(child)
      const suffix = rpc.stderr.trim() ? `\nCLI stderr: ${rpc.stderr.trim()}` : ''
      throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`)
    } finally {
      if (this.startingRpc === rpc) this.startingRpc = null
    }
  }

  private async executeCodexPrompt(
    sessionId: string,
    prompt: string,
    client: acp.AgentContext
  ): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'max_tokens' }> {
    const lease = await this.acquireProcess()
    const rpc = lease.value
    if (this.disposed) {
      await lease.release(false)
      throw new Error('Codex ACP 连接已关闭')
    }
    rpc.uses++
    this.activeRpc = rpc
    let reusable = false
    const updates = new AcpUpdateBuffer(value => client.notify(acp.methods.client.session.update, value), {
      pause: () => rpc.child.stdout.pause(),
      resume: () => rpc.child.stdout.resume(),
      fail: () => { void killProcessTree(rpc.child) }
    })
    this.updates = updates

    try {
      const threadResult = await rpc.request('thread/start', {
        cwd: this.currentCwd,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        serviceName: 'agentpet',
        ephemeral: true,
        ...(this.configuredModel && this.configuredModel !== 'default' ? { model: this.configuredModel } : {})
      })
      const threadId = String(threadResult?.thread?.id || '')
      if (!threadId) throw new Error('Codex 未返回 thread id')

      let finish!: (value: any) => void
      let fail!: (error: Error) => void
      const completed = new Promise<any>((resolve, reject) => { finish = resolve; fail = reject })
      // A process exit can arrive before turn/start has returned.
      void completed.catch(() => {})
      const unsubscribeClose = rpc.onClose(fail)
      const timeout = setTimeout(() => fail(new Error('Codex 任务执行超时')), PROMPT_TIMEOUT_MS)

      const unsubscribe = rpc.onNotification(message => {
        if (message.params?.threadId && message.params.threadId !== threadId) return
        const item = message.params?.item

        // 1. 文件变更/工具调用状态
        if (message.method === 'item/completed' && /file.?change/i.test(String(item?.type || ''))) {
          const title = '文件修改'
          const toolCallId = `file-change-${Date.now()}`
          updates.notify({
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title,
              name: 'file_edit',
              status: 'completed',
              rawInput: item?.changes
            }
          })
        }

        // 2. 文本增量
        if (message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') {
          updates.notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: message.params.delta
              }
            }
          })
        }

        // 3. turn 完成通知
        if (message.method === 'turn/completed' && message.params?.threadId === threadId) {
          finish(message.params.turn)
        }
      })

      try {
        await rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }]
        }, PROBE_TIMEOUT_MS)

        const turn = await completed
        if (turn?.status === 'failed') {
          throw new Error(turn.error?.message || 'Codex 任务失败')
        }
        await updates.finish()
        reusable = true
        return { stopReason: 'end_turn' }
      } finally {
        clearTimeout(timeout)
        unsubscribe()
        unsubscribeClose()
      }
    } finally {
      this.activeRpc = null
      updates.dispose()
      this.updates = undefined
      await lease.release(reusable && !this.disposed)
    }
  }
}

/**
 * 创建 Codex In-Memory ACP 管道，供 ACP 客户端直连使用
 */
export function createCodexAcpConnection(
  definition: ExternalAgentDefinition,
  cwd: string,
  model?: string,
  onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>
): CodexAcpStreamPair {
  const bridge = new CodexAcpBridge(definition, cwd, model)
  const server = bridge.createServer()

  const transport = createAcpObjectStreamPair(onProtocolEvent)
  const serverConnection = server.connect(transport.agentStream)
  const clientStream = transport.clientStream

  return {
    clientStream,
    dispose: async () => {
      try {
        await bridge.dispose()
      } finally {
        try {
          serverConnection.close()
        } finally {
          transport.dispose()
        }
      }
    }
  }
}

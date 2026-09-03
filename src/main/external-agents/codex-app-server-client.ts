import readline from 'node:readline'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ExternalAgentDefinition, ExternalAgentModel, ExternalAgentProbeResult, ExternalAgentRunResult } from './types'
import { classifyAgentError, killProcessTree, resolveExecutable, spawnAgentProcess } from './process-utils'

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

class CodexRpcConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly notificationListeners = new Set<(message: RpcMessage) => void>()
  public stderr = ''

  public constructor(public readonly child: ChildProcessWithoutNullStreams) {
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
        this.write({ id: message.id, error: { code: -32601, message: `AgentPet 暂不支持交互请求：${message.method}` } })
        return
      }
      this.notificationListeners.forEach(listener => listener(message))
    })
    child.once('error', error => this.rejectAll(error))
    child.once('close', code => this.rejectAll(new Error(`Codex App Server 已退出（${code ?? 'unknown'}）`)))
  }

  public request(method: string, params: unknown, timeoutMs = PROBE_TIMEOUT_MS): Promise<any> {
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
      this.write({ id, method, params })
    })
  }

  public notify(method: string, params: unknown = {}): void {
    this.write({ method, params })
  }

  public onNotification(listener: (message: RpcMessage) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  private write(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private rejectAll(error: Error): void {
    this.pending.forEach(waiter => waiter.reject(error))
    this.pending.clear()
  }
}

async function startConnection(definition: ExternalAgentDefinition, cwd: string): Promise<CodexRpcConnection> {
  const resolved = await resolveExecutable(definition.executable, definition.executableAliases)
  if (!resolved) throw new Error('未找到 Codex CLI，请先安装 Codex，或把 codex 命令加入 PATH')
  const child = spawnAgentProcess(resolved, definition.args, { cwd, env: definition.env })
  const rpc = new CodexRpcConnection(child)
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'agentpet', title: 'AgentPet', version: '1.0.0' },
      capabilities: {}
    })
    rpc.notify('initialized')
    return rpc
  } catch (error) {
    await killProcessTree(child)
    const suffix = rpc.stderr.trim() ? `\nCLI stderr: ${rpc.stderr.trim()}` : ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`)
  }
}

export class CodexAppServerClient {
  public async isInstalled(definition: ExternalAgentDefinition): Promise<boolean> {
    return Boolean(await resolveExecutable(definition.executable, definition.executableAliases))
  }

  public async probe(definition: ExternalAgentDefinition, cwd: string): Promise<ExternalAgentProbeResult> {
    const startedAt = Date.now()
    const installed = await this.isInstalled(definition)
    if (!installed) {
      return {
        agentId: definition.id,
        status: 'missing',
        installed: false,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        error: '未找到 Codex CLI'
      }
    }
    let rpc: CodexRpcConnection | undefined
    try {
      rpc = await startConnection(definition, cwd)
      const account = await rpc.request('account/read', { refreshToken: false })
      if (account?.requiresOpenaiAuth && !account?.account) {
        return {
          agentId: definition.id,
          status: 'auth_required',
          installed: true,
          agentInfo: { name: 'Codex App Server' },
          capabilities: { protocol: 'codex-app-server', execution: 'automated' },
          latencyMs: Date.now() - startedAt,
          checkedAt: Date.now(),
          error: 'Codex CLI 已安装，但尚未登录'
        }
      }
      return {
        agentId: definition.id,
        status: 'ready',
        installed: true,
        agentInfo: { name: 'Codex App Server' },
        capabilities: { protocol: 'codex-app-server', execution: 'automated' },
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now()
      }
    } catch (error) {
      return {
        agentId: definition.id,
        status: classifyAgentError(error),
        installed: true,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (rpc) await killProcessTree(rpc.child)
    }
  }

  public async listModels(definition: ExternalAgentDefinition, cwd: string): Promise<ExternalAgentModel[]> {
    const rpc = await startConnection(definition, cwd)
    try {
      const response = await rpc.request('model/list', { limit: 100, includeHidden: false })
      return (Array.isArray(response?.data) ? response.data : []).map((model: any) => ({
        id: String(model.model || model.id),
        name: String(model.displayName || model.model || model.id),
        description: typeof model.description === 'string' ? model.description : undefined,
        source: 'cli' as const
      }))
    } finally {
      await killProcessTree(rpc.child)
    }
  }

  public async runPrompt(
    definition: ExternalAgentDefinition,
    cwd: string,
    prompt: string,
    onUpdate?: (update: unknown) => void,
    model?: string
  ): Promise<ExternalAgentRunResult> {
    const rpc = await startConnection(definition, cwd)
    let text = ''
    const artifactPaths = new Set<string>()
    try {
      const threadResult = await rpc.request('thread/start', {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        serviceName: 'agentpet',
        ephemeral: true,
        ...(model && model !== 'default' ? { model } : {})
      })
      const threadId = String(threadResult?.thread?.id || '')
      if (!threadId) throw new Error('Codex 未返回 thread id')

      let finish!: (value: any) => void
      let fail!: (error: Error) => void
      const completed = new Promise<any>((resolve, reject) => { finish = resolve; fail = reject })
      const timeout = setTimeout(() => fail(new Error('Codex 任务执行超时')), PROMPT_TIMEOUT_MS)
      const unsubscribe = rpc.onNotification(message => {
        onUpdate?.(message)
        const item = message.params?.item
        if (message.method === 'item/completed' && /file.?change/i.test(String(item?.type || ''))) {
          for (const change of Array.isArray(item?.changes) ? item.changes : []) {
            const changedPath = String(change?.path || '').trim()
            if (changedPath) artifactPaths.add(path.isAbsolute(changedPath) ? path.normalize(changedPath) : path.resolve(cwd, changedPath))
          }
        }
        if (message.method === 'item/agentMessage/delta' && typeof message.params?.delta === 'string') {
          text += message.params.delta
        }
        if (message.method === 'turn/completed' && message.params?.threadId === threadId) finish(message.params.turn)
      })
      try {
        const turnResult = await rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }]
        }, PROBE_TIMEOUT_MS)
        const turn = await completed
        if (turn?.status === 'failed') throw new Error(turn.error?.message || 'Codex 任务失败')
        return {
          agentId: definition.id,
          sessionId: threadId,
          text,
          stopReason: String(turn?.status || turnResult?.turn?.status || 'completed'),
          artifactPaths: [...artifactPaths]
        }
      } finally {
        clearTimeout(timeout)
        unsubscribe()
      }
    } finally {
      await killProcessTree(rpc.child)
    }
  }
}

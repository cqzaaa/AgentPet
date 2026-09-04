import os from 'node:os'
import { openLoginTerminal } from './login-terminal'
import path from 'node:path'
import { BUILTIN_EXTERNAL_AGENTS } from './catalog'
import { AcpExternalAgentClient } from './acp-client'
import { CodexAppServerClient } from './codex-app-server-client'
import { LocalCliAgentClient } from './local-cli-client'
import { AntigravityAcpBridge, createAntigravityAcpConnection } from './bridges/antigravity-bridge'
import { ClaudeAcpBridge, createClaudeAcpConnection } from './bridges/claude-bridge'
import { CodexAcpBridge, createCodexAcpConnection, disposeCodexProcessPool } from './bridges/codex-bridge'
import { clearExecutableCache, classifyAgentError, resolveExecutable } from './process-utils'
import { ExternalAgentStore } from './store'
import type {
  ExternalAgentDefinition,
  ExternalAgentListItem,
  ExternalAgentProbeResult,
  ExternalAgentProtocolEvent,
  ExternalAgentModel,
  ExternalAgentRunRequest,
  ExternalAgentRunResult,
  ExternalAgentUpsertInput
} from './types'

export class ExternalAgentManager {
  private readonly store = new ExternalAgentStore()
  private readonly client = new AcpExternalAgentClient()
  private readonly codexClient = new CodexAppServerClient()
  private readonly localCliClient = new LocalCliAgentClient()
  private readonly probes = new Map<string, ExternalAgentProbeResult>()
  private readonly loginWindows = new Set<string>()

  public async getModelStatus(agentId: string, cwd?: string, configuredModel?: string) {
    try {
      return { status: 'ready', models: await this.listModels(agentId, cwd, configuredModel) }
    } catch (error) {
      return { status: classifyAgentError(error), models: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  public async login(agentId: string): Promise<void> {
    const definition = BUILTIN_EXTERNAL_AGENTS.find(agent => agent.id === agentId)
    const loginArgs: Record<string, string[]> = { antigravity: [], 'claude-code': ['auth', 'login'], codex: ['login'] }
    if (!definition || !Object.hasOwn(loginArgs, agentId)) throw new Error('请在该 Agent 的终端中手动登录')
    if (process.platform !== 'win32') throw new Error('请在系统终端中运行对应 CLI 登录')
    if (this.loginWindows.has(agentId)) throw new Error('正在打开登录终端，请稍候')
    this.loginWindows.add(agentId)
    try {
      const executable = await resolveExecutable(definition.executable, definition.executableAliases)
      if (!executable) throw new Error(`未找到 ${definition.executable}`)
      await openLoginTerminal(executable, loginArgs[agentId], definition.env)
      this.probes.delete(agentId)
    } finally {
      this.loginWindows.delete(agentId)
    }
  }

  public async dispose(): Promise<void> {
    this.client.dispose()
    await disposeCodexProcessPool()
  }

  public async list(): Promise<ExternalAgentListItem[]> {
    const definitions = [...BUILTIN_EXTERNAL_AGENTS, ...await this.store.list()]
    return Promise.all(definitions.map(async definition => {
      const previous = this.probes.get(definition.id)
      if (previous) return { ...definition, probe: previous }
      if (definition.protocol === 'internal') {
        return {
          ...definition,
          probe: {
            agentId: definition.id,
            status: 'ready' as const,
            installed: true,
            latencyMs: 0,
            checkedAt: Date.now()
          }
        }
      }
      const installed = await this.clientFor(definition).isInstalled(definition)
      return {
        ...definition,
        probe: installed ? null : {
          agentId: definition.id,
          status: 'missing' as const,
          installed: false,
          latencyMs: 0,
          checkedAt: 0,
          error: `未在 PATH 中找到 ${definition.detectExecutable || definition.executable}`
        }
      }
    }))
  }

  public async probe(agentId: string, cwd?: string): Promise<ExternalAgentProbeResult> {
    const definition = await this.find(agentId)
    if (definition.protocol === 'internal') {
      return {
        agentId,
        status: 'ready',
        installed: true,
        latencyMs: 0,
        checkedAt: Date.now()
      }
    }
    const result = await this.clientFor(definition).probe(definition, this.normalizeCwd(cwd))
    this.probes.set(agentId, result)
    return result
  }

  public async upsert(input: ExternalAgentUpsertInput): Promise<ExternalAgentDefinition> {
    clearExecutableCache()
    if (input.id && BUILTIN_EXTERNAL_AGENTS.some(agent => agent.id === input.id)) {
      throw new Error('内置 Agent 不能通过自定义接口覆盖')
    }
    const saved = await this.store.upsert(input)
    this.probes.delete(saved.id)
    return saved
  }

  public async delete(agentId: string): Promise<boolean> {
    if (BUILTIN_EXTERNAL_AGENTS.some(agent => agent.id === agentId)) {
      throw new Error('内置 Agent 不能删除')
    }
    this.probes.delete(agentId)
    return this.store.delete(agentId)
  }

  public async runPrompt(
    request: ExternalAgentRunRequest,
    onUpdate?: (update: unknown) => void | Promise<void>,
    onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>,
    options?: { signal?: AbortSignal }
  ): Promise<ExternalAgentRunResult> {
    if (!request.prompt?.trim()) throw new Error('prompt 不能为空')
    const definition = await this.find(request.agentId)
    if (!definition.enabled) throw new Error(`Agent ${definition.name} 已被禁用`)
    if (definition.protocol === 'internal') {
      throw new Error('AgentPet 默认 Agent 由现有对话运行时执行')
    }
    const cwd = this.normalizeCwd(request.cwd)
    if (definition.protocol === 'claude-stream-json') {
      const connection = createClaudeAcpConnection(definition, cwd, request.model, onProtocolEvent)
      return this.client.runPrompt(
        definition,
        cwd,
        request.prompt.trim(),
        onUpdate as any,
        onProtocolEvent,
        {
          customStream: connection.clientStream,
          onDispose: connection.dispose,
          signal: options?.signal,
          model: request.model
        }
      )
    }
    if (definition.protocol === 'codex-app-server') {
      const connection = createCodexAcpConnection(definition, cwd, request.model, onProtocolEvent)
      return this.client.runPrompt(
        definition,
        cwd,
        request.prompt.trim(),
        onUpdate as any,
        onProtocolEvent,
        {
          customStream: connection.clientStream,
          onDispose: connection.dispose,
          signal: options?.signal,
          model: request.model
        }
      )
    }
    if (definition.protocol === 'antigravity-json') {
      const connection = createAntigravityAcpConnection(definition, cwd, request.model, onProtocolEvent)
      return this.client.runPrompt(
        definition,
        cwd,
        request.prompt.trim(),
        onUpdate as any,
        onProtocolEvent,
        {
          customStream: connection.clientStream,
          onDispose: connection.dispose,
          signal: options?.signal,
          model: request.model
        }
      )
    }
    return this.client.runPrompt(definition, cwd, request.prompt.trim(), onUpdate, onProtocolEvent, options)
  }

  public async describe(agentId: string): Promise<Pick<ExternalAgentDefinition, 'id' | 'name' | 'protocol'>> {
    const definition = await this.find(agentId)
    return { id: definition.id, name: definition.name, protocol: definition.protocol }
  }

  public async listModels(agentId: string, cwd?: string, configuredModel?: string): Promise<ExternalAgentModel[]> {
    const definition = await this.find(agentId)
    const normalizedCwd = this.normalizeCwd(cwd)
    if (definition.protocol === 'internal') {
      return [{ id: configuredModel || 'default', name: configuredModel || '当前对话模型', source: 'configured' }]
    }
    if (definition.protocol === 'codex-app-server') {
      const bridge = new CodexAcpBridge(definition, normalizedCwd, configuredModel)
      return bridge.listModels()
    }
    if (definition.protocol === 'claude-stream-json') {
      const bridge = new ClaudeAcpBridge(definition, normalizedCwd, configuredModel)
      return bridge.listModels()
    }
    if (definition.protocol === 'antigravity-json') {
      const bridge = new AntigravityAcpBridge(definition, normalizedCwd, configuredModel)
      return bridge.listModels()
    }
    const probe = await this.probe(agentId, normalizedCwd)
    const options = Array.isArray(probe.configOptions) ? probe.configOptions : []
    const modelOption = options.find((option: any) => /model/i.test(String(option?.id || option?.name || option?.category || ''))) as any
    const choices = modelOption?.options || modelOption?.values || []
    const models = (Array.isArray(choices) ? choices : []).map((choice: any) => ({
      id: String(choice?.value || choice?.id || choice?.name),
      name: String(choice?.name || choice?.label || choice?.value || choice?.id),
      description: typeof choice?.description === 'string' ? choice.description : undefined,
      source: 'acp' as const
    })).filter((model: ExternalAgentModel) => model.id && model.id !== 'undefined')
    return models.length ? models : [{ id: 'default', name: 'ACP Agent 默认模型', source: 'acp' }]
  }

  private async find(agentId: string): Promise<ExternalAgentDefinition> {
    const definitions = [...BUILTIN_EXTERNAL_AGENTS, ...await this.store.list()]
    const definition = definitions.find(agent => agent.id === agentId)
    if (!definition) throw new Error(`找不到 Agent：${agentId}`)
    return definition
  }

  private normalizeCwd(cwd?: string): string {
    const candidate = cwd?.trim() || os.tmpdir()
    return path.resolve(candidate)
  }

  private clientFor(definition: ExternalAgentDefinition): {
    isInstalled: (value: ExternalAgentDefinition) => Promise<boolean>
    probe: (value: ExternalAgentDefinition, cwd: string) => Promise<ExternalAgentProbeResult>
  } {
    if (definition.protocol === 'claude-stream-json') {
      return {
        isInstalled: def => this.localCliClient.isInstalled(def),
        probe: async (def, cwd) => {
          const connection = createClaudeAcpConnection(def, cwd)
          return this.client.probe(def, cwd, {
            customStream: connection.clientStream,
            onDispose: connection.dispose
          })
        }
      }
    }
    if (definition.protocol === 'codex-app-server') {
      return {
        isInstalled: def => this.codexClient.isInstalled(def),
        probe: async (def, cwd) => {
          const connection = createCodexAcpConnection(def, cwd)
          return this.client.probe(def, cwd, {
            customStream: connection.clientStream,
            onDispose: connection.dispose
          })
        }
      }
    }
    if (definition.protocol === 'antigravity-json') {
      return {
        isInstalled: def => this.localCliClient.isInstalled(def),
        probe: async (def, cwd) => {
          const connection = createAntigravityAcpConnection(def, cwd)
          return this.client.probe(def, cwd, {
            customStream: connection.clientStream,
            onDispose: connection.dispose
          })
        }
      }
    }
    return this.client
  }
}

export const externalAgentManager = new ExternalAgentManager()

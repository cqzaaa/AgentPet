import os from 'node:os'
import path from 'node:path'
import { BUILTIN_EXTERNAL_AGENTS } from './catalog'
import { AcpExternalAgentClient } from './acp-client'
import { CodexAppServerClient } from './codex-app-server-client'
import { LocalCliAgentClient } from './local-cli-client'
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
    onUpdate?: (update: unknown) => void,
    onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void
  ): Promise<ExternalAgentRunResult> {
    if (!request.prompt?.trim()) throw new Error('prompt 不能为空')
    const definition = await this.find(request.agentId)
    if (!definition.enabled) throw new Error(`Agent ${definition.name} 已被禁用`)
    if (definition.protocol === 'internal') {
      throw new Error('AgentPet 默认 Agent 由现有对话运行时执行')
    }
    const cwd = this.normalizeCwd(request.cwd)
    if (definition.protocol === 'claude-stream-json') {
      return this.localCliClient.runClaude(definition, cwd, request.prompt.trim(), onUpdate, request.model)
    }
    if (definition.protocol === 'codex-app-server') {
      return this.codexClient.runPrompt(definition, cwd, request.prompt.trim(), onUpdate, request.model)
    }
    if (definition.protocol === 'antigravity-json') {
      return this.localCliClient.runAntigravity(definition, cwd, request.prompt.trim(), onUpdate, request.model, onProtocolEvent)
    }
    return this.client.runPrompt(definition, cwd, request.prompt.trim(), onUpdate, onProtocolEvent)
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
    if (definition.protocol === 'codex-app-server') return this.codexClient.listModels(definition, normalizedCwd)
    if (definition.protocol === 'claude-stream-json') {
      return [
        { id: 'default', name: '默认（CLI 当前配置）', source: 'cli-alias' },
        { id: 'sonnet', name: 'Sonnet', source: 'cli-alias' },
        { id: 'opus', name: 'Opus', source: 'cli-alias' }
      ]
    }
    if (definition.protocol === 'antigravity-json') {
      return this.localCliClient.listAntigravityModels(definition, normalizedCwd)
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
    if (definition.protocol === 'codex-app-server') return this.codexClient
    if (definition.protocol === 'claude-stream-json' || definition.protocol === 'antigravity-json') return this.localCliClient
    return this.client
  }
}

export const externalAgentManager = new ExternalAgentManager()

import readline from 'node:readline'
import * as acp from '@agentclientprotocol/sdk'
import { AcpUpdateBuffer } from './update-buffer'
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

const OUTPUT_LIMIT = 32_768

export interface AntigravityAcpBridgeOptions {
  definition: ExternalAgentDefinition
  cwd: string
  model?: string
}

export interface AntigravityAcpStreamPair {
  clientStream: acp.Stream
  dispose: () => Promise<void>
}

export class AntigravityAcpBridge {
  private disposed = false
  private updates?: AcpUpdateBuffer
  private childProcess: ReturnType<typeof spawnAgentProcess> | null = null
  private currentCwd: string
  private configuredModel?: string

  constructor(private readonly definition: ExternalAgentDefinition, cwd: string, model?: string) {
    this.currentCwd = cwd
    this.configuredModel = model
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    this.updates?.dispose()
    const child = this.childProcess
    this.childProcess = null
    if (child) await killProcessTree(child)
  }

  public createServer(): acp.AgentApp {
    const server = acp.agent({
      name: 'Antigravity ACP Bridge'
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
          name: 'Antigravity CLI (ACP Bridge)',
          version: '1.0.0'
        }
      }
    })

    server.onRequest(acp.methods.agent.session.new, async ({ params }) => {
      if (params.cwd) {
        this.currentCwd = params.cwd
      }
      const sessionId = `agy-session-${Date.now()}`
      return {
        sessionId,
        configOptions: []
      }
    })

    server.onNotification(acp.methods.agent.session.cancel, async () => {
      await this.dispose()
    })

    server.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const promptText = this.extractPromptText(params.prompt)
      try {
        return await this.executeAgyPrompt(params.sessionId, promptText, client)
      } catch (error) {
        throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error))
      }
    })

    return server
  }

  public async listModels(): Promise<ExternalAgentModel[]> {
    const resolved = await resolveExecutable(this.definition.executable, this.definition.executableAliases)
    if (!resolved) throw new Error('未找到 agy CLI')
    const child = spawnAgentProcess(resolved, ['models'], { cwd: this.currentCwd, env: this.definition.env })
    let output = ''
    child.stdout.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT) })
    child.stderr.on('data', chunk => { output = `${output}\n${String(chunk)}`.slice(-OUTPUT_LIMIT) })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { void killProcessTree(child); reject(new Error('Antigravity CLI 模型检测超时')) }, 30_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', value => { clearTimeout(timer); resolve(value) })
    })
    if (code !== 0 || /please sign in|not logged|login/i.test(output)) {
      throw new Error(output.trim() || `agy models 退出码 ${code}`)
    }
    return output.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/fetching available models/i.test(line))
      .map(line => {
        const id = line.split(/\s{2,}|\t/)[0].replace(/^[-*]\s*/, '').trim()
        return { id, name: line.replace(/^[-*]\s*/, ''), source: 'cli' as const }
      }).filter(model => model.id)
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

  private async executeAgyPrompt(
    sessionId: string,
    prompt: string,
    client: acp.AgentContext
  ): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'max_tokens' }> {
    const resolved = await resolveExecutable(this.definition.executable, this.definition.executableAliases)
    if (this.disposed) throw new Error('Antigravity ACP 连接已关闭')
    if (!resolved) throw new Error('未找到 agy CLI')

    const args = [
      '--new-project',
      '--output-format', 'stream-json',
      '--mode', 'accept-edits',
      '--dangerously-skip-permissions',
      '--print-timeout', '30m'
    ]

    if (this.definition.args && this.definition.args.length > 0) {
      for (const arg of this.definition.args) {
        if (!args.includes(arg)) args.push(arg)
      }
    }

    if (this.configuredModel && this.configuredModel !== 'default') {
      args.push('--model', this.configuredModel)
    }

    const executionPrompt = `${prompt}\n\n[AgentPet 协作执行要求]\n- 只修改当前工作区内完成任务所必需的源码文件。\n- 不要额外创建计划、分析或交付说明文档；将说明写在最终回复中。\n- 即使某个检查工具无法获得权限或执行失败，也必须在结束前返回最终正文，明确已完成内容、修改文件和未完成检查。`
    args.push(`--print=${executionPrompt}`)

    const child = spawnAgentProcess(resolved, args, { cwd: this.currentCwd, env: this.definition.env })
    this.childProcess = child

    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-OUTPUT_LIMIT)
    })

    const lines = readline.createInterface({ input: child.stdout })

    const updates = new AcpUpdateBuffer(value => client.notify(acp.methods.client.session.update, value), {
      pause: () => { lines.pause(); child.stdout.pause() },
      resume: () => { lines.resume(); child.stdout.resume() },
      fail: () => { void killProcessTree(child) }
    })
    this.updates = updates

    let hasStreamedText = false

    lines.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const event = JSON.parse(trimmed)
        const update = event?.step_update

        // 1. 响应文本 / agent 状态更新
        if (update?.step_type === 'agent_response') {
          if (update?.usage) {
            updates.notify({
              sessionId,
              update: {
                sessionUpdate: 'session_info_update',
                _meta: {
                  'agentpet/usage': {
                    inputTokens: Number(update.usage.input_tokens) || 0,
                    outputTokens: Number(update.usage.output_tokens) || 0
                  }
                }
              }
            })
          }
        }

        // 2. 工具调用转换
        if (update?.step_type === 'tool') {
          const toolCallId = String(update.step_id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
          const toolName = String(update.tool_name || update?.tool_info?.name || 'tool')

          if (update.state === 'ACTIVE') {
            updates.notify({
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId,
                title: `调用 ${toolName}`,
                name: toolName,
                status: 'in_progress',
                rawInput: update.tool_info?.parameters
              }
            })
          } else if (update.state === 'DONE') {
            updates.notify({
              sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: 'completed',
                rawOutput: update.tool_info?.output
              }
            })
          } else if (update.state === 'ERROR') {
            updates.notify({
              sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: 'failed',
                rawOutput: update.tool_info?.error?.message || '工具执行失败'
              }
            })
          }
        }

        // 3. 结果产出
        if (event?.event === 'result') {
          const responseText = event.result?.response
          if (typeof responseText === 'string' && responseText.trim()) {
            hasStreamedText = true
            updates.notify({
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: responseText
                }
              }
            })
          }
        }
      } catch {
        // 非 JSON 行，若包含有用文本可作为流输出
        if (trimmed && !hasStreamedText && !trimmed.startsWith('{')) {
          updates.notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `${trimmed}\n`
              }
            }
          })
        }
      }
    })

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })

    this.childProcess = null

    await updates.finish()
    updates.dispose()
    this.updates = undefined

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Antigravity CLI 异常退出（退出码 ${exitCode}）`)
    }

    return { stopReason: 'end_turn' }
  }
}

/**
 * 创建 In-Memory ACP 管道，并支持协议日志抓包
 */
export function createAntigravityAcpConnection(
  definition: ExternalAgentDefinition,
  cwd: string,
  model?: string,
  onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>
): AntigravityAcpStreamPair {
  const bridge = new AntigravityAcpBridge(definition, cwd, model)
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

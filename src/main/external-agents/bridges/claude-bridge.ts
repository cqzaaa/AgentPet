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

export interface ClaudeAcpStreamPair {
  clientStream: acp.Stream
  dispose: () => Promise<void>
}

export class ClaudeAcpBridge {
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
      name: 'Claude Code ACP Bridge'
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
          name: 'Claude Code CLI (ACP Bridge)',
          version: '1.0.0'
        }
      }
    })

    server.onRequest(acp.methods.agent.session.new, async ({ params }) => {
      if (params.cwd) {
        this.currentCwd = params.cwd
      }
      return {
        sessionId: `claude-session-${Date.now()}`,
        configOptions: []
      }
    })

    server.onNotification(acp.methods.agent.session.cancel, async () => {
      await this.dispose()
    })

    server.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const promptText = this.extractPromptText(params.prompt)
      try {
        return await this.executeClaudePrompt(params.sessionId, promptText, client)
      } catch (error) {
        throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error))
      }
    })

    return server
  }

  public listModels(): ExternalAgentModel[] {
    return [
      { id: 'default', name: '默认（CLI 当前配置）', source: 'cli-alias' },
      { id: 'sonnet', name: 'Sonnet', source: 'cli-alias' },
      { id: 'opus', name: 'Opus', source: 'cli-alias' }
    ]
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

  private async executeClaudePrompt(
    sessionId: string,
    prompt: string,
    client: acp.AgentContext
  ): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'max_tokens' }> {
    const resolved = await resolveExecutable(this.definition.executable, this.definition.executableAliases)
    if (this.disposed) throw new Error('Claude ACP 连接已关闭')
    if (!resolved) throw new Error('未找到 Claude Code CLI')

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits'
    ]

    if (this.definition.args && this.definition.args.length > 0) {
      for (const arg of this.definition.args) {
        if (!args.includes(arg)) args.push(arg)
      }
    }

    if (this.configuredModel && this.configuredModel !== 'default') {
      args.push('--model', this.configuredModel)
    }

    const child = spawnAgentProcess(resolved, args, { cwd: this.currentCwd, env: this.definition.env })
    this.childProcess = child
    child.stdin.end(prompt)

    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-OUTPUT_LIMIT)
    })

    const lines = readline.createInterface({ input: child.stdout })
    let hasStreamedText = false
    const updates = new AcpUpdateBuffer(value => client.notify(acp.methods.client.session.update, value), {
      pause: () => { lines.pause(); child.stdout.pause() },
      resume: () => { lines.resume(); child.stdout.resume() },
      fail: () => { void killProcessTree(child) }
    })
    this.updates = updates

    lines.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const event = JSON.parse(trimmed) as any

        // 1. 流式文本增量
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && typeof event.event.delta?.text === 'string') {
          hasStreamedText ||= event.event.delta.text.length > 0
          updates.notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: event.event.delta.text
              }
            }
          })
        }

        // 2. 工具调用捕获
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block?.type === 'tool_use') {
              const toolName = String(block.name || 'tool')
              const toolCallId = String(block.id || `tool-${Date.now()}`)
              updates.notify({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId,
                  title: `调用 ${toolName}`,
                  name: toolName,
                  status: 'in_progress',
                  rawInput: block.input
                }
              })
            }
          }
        }

        // 3. 最终结果
        if (event.type === 'result' && !hasStreamedText && typeof event.result === 'string' && event.result.trim()) {
          updates.notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: event.result
              }
            }
          })
        }
      } catch {
        // 非 JSON 行降级输出
        if (trimmed && !trimmed.startsWith('{')) {
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
      throw new Error(stderr.trim() || `Claude Code 异常退出（退出码 ${exitCode}）`)
    }

    return { stopReason: 'end_turn' }
  }
}

/**
 * 创建 Claude Code In-Memory ACP 管道，供 ACP 客户端直连使用
 */
export function createClaudeAcpConnection(
  definition: ExternalAgentDefinition,
  cwd: string,
  model?: string,
  onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>
): ClaudeAcpStreamPair {
  const bridge = new ClaudeAcpBridge(definition, cwd, model)
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

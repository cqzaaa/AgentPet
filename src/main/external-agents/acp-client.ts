import { Readable, Transform, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import * as acp from '@agentclientprotocol/sdk'
import { classifyAgentError, killProcessTree, resolveExecutable, spawnAgentProcess } from './process-utils'
import type {
  ExternalAgentDefinition,
  ExternalAgentProtocolEvent,
  ExternalAgentProbeResult,
  ExternalAgentRunResult
} from './types'

const PROBE_TIMEOUT_MS = 35_000
const PROMPT_TIMEOUT_MS = 30 * 60_000
const STDERR_LIMIT = 16_384

type AcpWireDirection = ExternalAgentProtocolEvent['direction']

function wireMessageId(value: unknown): string | number | null | undefined {
  if (!value || typeof value !== 'object' || !('id' in value)) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined
}

function wireMessageMethod(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('method' in value)) return undefined
  const method = (value as { method?: unknown }).method
  return typeof method === 'string' ? method : undefined
}

function createAcpWireTaps(onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void): {
  outbound: Transform
  inbound: Transform
} {
  const pendingClientRequests = new Map<string, string>()
  const pendingAgentRequests = new Map<string, string>()

  const createTap = (direction: AcpWireDirection): Transform => {
    const decoder = new StringDecoder('utf8')
    let buffer = ''

    const emitLine = (source: string): void => {
      const line = source.endsWith('\r') ? source.slice(0, -1) : source
      if (!line.trim() || !onProtocolEvent) return
      let payload: unknown
      try {
        payload = JSON.parse(line)
      } catch {
        onProtocolEvent({
          protocol: 'acp-v1',
          direction,
          messageType: 'invalid',
          byteLength: Buffer.byteLength(line),
          payload: { raw: line }
        })
        return
      }

      const method = wireMessageMethod(payload)
      const id = wireMessageId(payload)
      let messageType: ExternalAgentProtocolEvent['messageType'] = Array.isArray(payload)
        ? 'batch'
        : method
          ? id === undefined ? 'notification' : 'request'
          : id !== undefined ? 'response' : 'invalid'
      let correlatedMethod = method

      if (messageType === 'request' && id !== undefined) {
        const requests = direction === 'client_to_agent' ? pendingClientRequests : pendingAgentRequests
        requests.set(String(id), method || '')
      } else if (messageType === 'response' && id !== undefined) {
        const requests = direction === 'client_to_agent' ? pendingAgentRequests : pendingClientRequests
        correlatedMethod = requests.get(String(id)) || undefined
        requests.delete(String(id))
      }

      onProtocolEvent({
        protocol: 'acp-v1',
        direction,
        messageType,
        method: correlatedMethod,
        id,
        byteLength: Buffer.byteLength(line),
        payload
      })
    }

    return new Transform({
      transform(chunk, _encoding, callback) {
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          emitLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
        callback(null, chunk)
      },
      flush(callback) {
        buffer += decoder.end()
        if (buffer) emitLine(buffer)
        callback()
      }
    })
  }

  return {
    outbound: createTap('client_to_agent'),
    inbound: createTap('agent_to_client')
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(`ACP 操作在 ${Math.round(timeoutMs / 1000)} 秒内未完成`))
    }, timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

interface AcpConnectionResult {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string }
  capabilities?: Record<string, unknown>
  modes?: unknown
  configOptions?: unknown[]
  sessionId: string
  text?: string
  stopReason?: string
}

export class AcpExternalAgentClient {
  public async isInstalled(definition: ExternalAgentDefinition): Promise<boolean> {
    return Boolean(await resolveExecutable(definition.detectExecutable || definition.executable, definition.executableAliases))
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
        error: `未在 PATH 中找到 ${definition.detectExecutable || definition.executable}`
      }
    }

    try {
      const result = await this.connect(definition, cwd)
      return {
        agentId: definition.id,
        status: 'ready',
        installed: true,
        protocolVersion: result.protocolVersion,
        agentInfo: result.agentInfo,
        capabilities: result.capabilities,
        modes: result.modes,
        configOptions: result.configOptions,
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
    }
  }

  public async runPrompt(
    definition: ExternalAgentDefinition,
    cwd: string,
    prompt: string,
    onUpdate?: (update: acp.SessionUpdate) => void,
    onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void
  ): Promise<ExternalAgentRunResult> {
    const result = await this.connect(definition, cwd, prompt, onUpdate, PROMPT_TIMEOUT_MS, onProtocolEvent)
    return {
      agentId: definition.id,
      sessionId: result.sessionId,
      text: result.text || '',
      stopReason: result.stopReason || 'unknown'
    }
  }

  private async connect(
    definition: ExternalAgentDefinition,
    cwd: string,
    prompt?: string,
    onUpdate?: (update: acp.SessionUpdate) => void,
    timeoutMs = PROBE_TIMEOUT_MS,
    onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void
  ): Promise<AcpConnectionResult> {
    const resolved = await resolveExecutable(definition.executable, definition.executableAliases)
    if (!resolved) throw new Error(`ACP 启动命令不存在：${definition.executable}`)

    const child = spawnAgentProcess(resolved, definition.args, { cwd, env: definition.env })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT)
    })

    const wireTaps = createAcpWireTaps(onProtocolEvent)
    wireTaps.outbound.pipe(child.stdin)
    child.stdout.pipe(wireTaps.inbound)
    const stream = acp.ndJsonStream(
      Writable.toWeb(wireTaps.outbound) as WritableStream<Uint8Array>,
      Readable.toWeb(wireTaps.inbound) as ReadableStream<Uint8Array>
    )
    const client = acp.client({ name: 'AgentPet' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const reject = params.options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always')
        return reject
          ? { outcome: { outcome: 'selected' as const, optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' as const } }
      })

    const operation = client.connectWith(stream, async ctx => {
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}
      })
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`不支持的 ACP 协议版本：${initialized.protocolVersion}`)
      }

      return ctx.buildSession(cwd).withSession(async session => {
        const base: AcpConnectionResult = {
          protocolVersion: initialized.protocolVersion,
          agentInfo: initialized.agentInfo || undefined,
          capabilities: initialized.agentCapabilities as Record<string, unknown> | undefined,
          modes: session.modes,
          configOptions: session.newSessionResponse.configOptions || undefined,
          sessionId: session.sessionId
        }
        if (!prompt) return base

        void session.prompt(prompt)
        let text = ''
        for (;;) {
          const message = await session.nextUpdate()
          if (message.kind === 'stop') {
            return { ...base, text, stopReason: message.stopReason }
          }
          onUpdate?.(message.update)
          if (message.update.sessionUpdate === 'agent_message_chunk' && message.update.content.type === 'text') {
            text += message.update.content.text
          }
        }
      })
    })

    try {
      return await withTimeout(operation, timeoutMs, () => { void killProcessTree(child) })
    } catch (error) {
      const suffix = stderr.trim() ? `\nCLI stderr: ${stderr.trim()}` : ''
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}${suffix}`)
    } finally {
      await killProcessTree(child)
    }
  }
}

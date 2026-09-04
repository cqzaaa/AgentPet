/**
 * @file acp-client.ts
 * @description Agent Client Protocol (ACP) 客户端实现
 * 
 * 职责定位：
 * 1. 作为 AgentPet 与外部 Coding Agent（如 Antigravity, Claude Code, Codex）之间的通信核心；
 * 2. 基于 JSON-RPC 2.0 规范，提供全双工双向调用的状态机驱动；
 * 3. 抹平底层载体差异：既支持子进程 stdio 通信，也支持内存虚拟 Stream 桥接（Bridge 模式）；
 * 4. 内置 WireTap 中间人抓包，实现协议层报文无感录制，支持轨迹面板可视化审计；
 * 5. 管理 Agent 完整生命周期：探针检测 (probe)、协议握手 (initialize)、会话创建 (session.new)、任务下发 (session.prompt)、反向权限审批 (requestPermission) 与优雅销毁。
 */

import { Readable, Transform, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import * as acp from '@agentclientprotocol/sdk'
import { createAcpProtocolRecorder } from './acp-protocol-recorder'
import { classifyAgentError, killProcessTree, resolveExecutable, spawnAgentProcess } from './process-utils'
import type {
  ExternalAgentDefinition,
  ExternalAgentProtocolEvent,
  ExternalAgentProbeResult,
  ExternalAgentRunResult
} from './types'

/** 探针环境检测的默认超时时间（35 秒） */
const PROBE_TIMEOUT_MS = 35_000
/** 任务下发执行的最大超时时间（30 分钟） */
const PROMPT_TIMEOUT_MS = 30 * 60_000
/** 收集外部 CLI 错误输出（stderr）的最大字节限制（16KB），防止内存膨胀 */
const STDERR_LIMIT = 16_384

/** ACP 通信链路的方向定义：客户端到Agent (outbound) 或 Agent到客户端 (inbound) */
type AcpWireDirection = ExternalAgentProtocolEvent['direction']

/**
 * 创建 ACP Wire Taps（协议层分流器 / 抓包监听器）
 * 
 * 原理：
 * 插入在原始字节管道（如 stdio）与上层 ndJsonStream 之间，充当双向透明中间件：
 * 1. 透明穿透：字节流原封不动 pipe 给对端，不增加网络/IO 阻断；
 * 2. 旁路抓包：按行（\n）解码 JSON，自动识别是 request、response 还是 notification；
 * 3. 请求响应配对关联：维护两个方向的 pending 请求队列，使得异步返回的 response 报文也能关联出其原本调用的 method；
 * 4. 触发回调：通过 onProtocolEvent 将报文派发至持久化存储，供前端轨迹页面（Trajectory）审查。
 */
export function createAcpWireTaps(onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>): {
  outbound: Transform
  inbound: Transform
} {
  const record = createAcpProtocolRecorder(onProtocolEvent)

  const createTap = (direction: AcpWireDirection): Transform => {
    const decoder = new StringDecoder('utf8')
    let buffer = ''

    // 解析单行 ndJSON 并生成抓包事件
    const emitLine = async (source: string): Promise<void> => {
      const line = source.endsWith('\r') ? source.slice(0, -1) : source
      if (!line.trim() || !onProtocolEvent) return
      let payload: unknown
      try {
        payload = JSON.parse(line)
      } catch {
        // 非法 JSON 报文时标记为 invalid，保留原报文排查
        await onProtocolEvent({
          protocol: 'acp-v1',
          direction,
          messageType: 'invalid',
          byteLength: Buffer.byteLength(line),
          payload: { raw: line }
        })
        return
      }

      await record(direction, payload, Buffer.byteLength(line))
    }

    // Node.js Transform 流，按 \n 换行符切割行
    return new Transform({
      transform(chunk, _encoding, callback) {
        void (async () => {
          buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          // 缓冲区保护：单次报文缓冲超过 8MB 则拦截，防止内存攻击
          if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error('ACP 报文缓冲超过容量限制')
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            await emitLine(buffer.slice(0, newline))
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
          }
        })().then(() => callback(null, chunk), error => callback(error))
      },
      flush(callback) {
        buffer += decoder.end()
        void (buffer ? emitLine(buffer) : Promise.resolve()).then(() => callback(), error => callback(error))
      }
    })
  }

  return {
    outbound: createTap('client_to_agent'), // 客户端流向 Agent 的数据流
    inbound: createTap('agent_to_client')   // Agent 流向客户端的数据流
  }
}

/**
 * 带有超时控制的通用异步执行包装器
 * 
 * @param promise 原始执行任务
 * @param timeoutMs 超时时间（毫秒）
 * @param onTimeout 超时触发时的清理回调（如杀死子进程、发送取消通知等）
 */
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

/**
 * ACP 核心连接握手与执行的综合返回值
 */
interface AcpConnectionResult {
  /** 性能指标（初始化耗时、首字耗时、总耗时等） */
  performance?: ExternalAgentRunResult['performance']
  /** 对端返回的 ACP 协议主版本号 */
  protocolVersion: number
  /** Agent 自身的信息（名称、版本等） */
  agentInfo?: { name?: string; version?: string }
  /** Agent 支持的能力集（prompts, tools 等） */
  capabilities?: Record<string, unknown>
  /** Agent 支持的工作模式列表 */
  modes?: unknown
  /** 该 Session 暴露的配置项（如可选模型、思考强度等） */
  configOptions?: unknown[]
  /** 会话唯一标识 */
  sessionId: string
  /** Agent 输出的聚合完整文本正文 */
  text?: string
  /** 任务终止原因（如 'end_turn', 'cancelled', 'max_tokens'） */
  stopReason?: string
}

/**
 * 连接 ACP 时的可选参数配置
 */
export interface AcpConnectOptions {
  /** 自定义底层流（如通过 Bridge 桥接时的内存虚拟双向流） */
  customStream?: any
  /** 销毁清理回调（用于释放桥接层资源） */
  onDispose?: () => Promise<void> | void
  /** 指定执行所采用的模型 ID */
  model?: string
  /** 外部取消信号，用于响应用户的停止按钮 */
  signal?: AbortSignal
}

/**
 * ACP 外部智能体客户端
 * 
 * 核心功能：
 * 1. 负责检测系统中外部 Agent 的可用性（probe）；
 * 2. 调度执行特定 Agent 的任务（runPrompt）；
 * 3. 维护连接生命周期、心跳与异常恢复。
 */
export class AcpExternalAgentClient {
  /** 当前正在执行中的活跃任务的 AbortController 集合，便于统一销毁 */
  private readonly active = new Set<AbortController>()

  /** 销毁客户端，强制终止所有当前活跃中的 ACP 任务 */
  public dispose(): void {
    for (const controller of this.active) controller.abort()
  }

  /**
   * 检查该外部 Agent 的可执行文件是否已在操作系统 PATH 中安装
   */
  public async isInstalled(definition: ExternalAgentDefinition): Promise<boolean> {
    return Boolean(await resolveExecutable(definition.detectExecutable || definition.executable, definition.executableAliases))
  }

  /**
   * 环境探针：探测 Agent 的健康状态及协议支持度
   * 
   * 流程：
   * 1. 检查命令行文件是否存在；
   * 2. 发起轻量级连接并执行 agent.initialize 握手；
   * 3. 收集协议版本、支持的模式与配置项；
   * 4. 测量网络/本地进程握手延迟（latencyMs）。
   */
  public async probe(definition: ExternalAgentDefinition, cwd: string, options?: AcpConnectOptions): Promise<ExternalAgentProbeResult> {
    const startedAt = Date.now()
    const installed = await this.isInstalled(definition)
    if (!installed) {
      await options?.onDispose?.()
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
      // 探针阶段不传 prompt，仅完成初始化与会话创建即可退出
      const result = await this.connect(definition, cwd, undefined, undefined, PROBE_TIMEOUT_MS, undefined, options)
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

  /**
   * 任务执行入口：向指定的外部 Agent 发送 Prompt 并流式接收执行反馈
   * 
   * @param definition 外部 Agent 的静态配置定义
   * @param cwd 当前任务绑定的工作空间目录
   * @param prompt 组装后的任务目标与提示词
   * @param onUpdate 实时业务流式通知回调（文字块、思考流、工具调用）
   * @param onProtocolEvent 底层原始 JSON-RPC 报文抓包回调
   * @param options 取消信号与模型等连接选项
   */
  public async runPrompt(
    definition: ExternalAgentDefinition,
    cwd: string,
    prompt: string,
    onUpdate?: (update: acp.SessionUpdate) => void | Promise<void>,
    onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>,
    options?: AcpConnectOptions
  ): Promise<ExternalAgentRunResult> {
    const result = await this.connect(definition, cwd, prompt, onUpdate, PROMPT_TIMEOUT_MS, onProtocolEvent, options)
    return {
      agentId: definition.id,
      sessionId: result.sessionId,
      text: result.text || '',
      stopReason: result.stopReason || 'unknown',
      performance: result.performance
    }
  }

  /**
   * 底层核心驱动：建立 ACP 管道连接并驱动会话状态机
   * 
   * 执行全流程：
   * 1. 【管道建立】：根据入参决定使用 customStream（Bridge 内存流）还是 spawnAgentProcess（CLI 真实子进程）；
   * 2. 【旁路抓包】：若开启协议审计，挂载 createAcpWireTaps 插入 stdio 与 ndJsonStream 之间录制字节流；
   * 3. 【协议适配】：通过 acp.ndJsonStream 将字节流（Uint8Array）包装为双向 JSON-RPC 消息流；
   * 4. 【双向绑定】：初始化 acp.client，并挂载 onRequest 处理器响应 Agent 的反向权限请求（全双工调用）；
   * 5. 【协议握手】：发送 agent.initialize 握手协商协议版本与能力集；
   * 6. 【会话管理】：调用 ctx.buildSession 绑定 cwd 并触发 agent.session.new；
   * 7. 【指令流转】：下发 session.prompt，通过 session.nextUpdate 异步迭代流式读取增量事件（文本、工具调用等）；
   * 8. 【优雅收敛】：捕获 stop 终止态，统计耗时性能，完成进程树与流的终结清理。
   */
  private async connect(
    definition: ExternalAgentDefinition,
    cwd: string,
    prompt?: string,
    onUpdate?: (update: acp.SessionUpdate) => void | Promise<void>,
    timeoutMs = PROBE_TIMEOUT_MS,
    onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>,
    options?: AcpConnectOptions
  ): Promise<AcpConnectionResult> {
    const startedAt = performance.now()
    // 性能指标统计（总耗时、握手耗时、会话创建耗时、首字响应耗时、事件总帧数）
    const metrics = { elapsedMs: 0, initializeMs: 0, sessionMs: 0, firstTextMs: undefined as number | undefined, updateCount: 0 }
    let stream: any
    let child: ReturnType<typeof spawnAgentProcess> | null = null
    let stderr = ''

    // 检查调用前是否已经被外部 AbortSignal 取消
    if (options?.signal?.aborted) {
      await options.onDispose?.()
      throw new Error('Agent 任务已取消')
    }

    // 模式 1：外部提供了自定义流（例如 Claude/Antigravity/Codex 的内存 Bridge 桥接模式）
    if (options?.customStream) {
      stream = options.customStream
    } else {
      // 模式 2：标准原生 ACP CLI 模式，解析可执行文件并直接启动子进程
      const resolved = await resolveExecutable(definition.executable, definition.executableAliases)
      if (!resolved) throw new Error(`ACP 启动命令不存在：${definition.executable}`)

      child = spawnAgentProcess(resolved, definition.args, { cwd, env: definition.env })
      // 收集 stderr 错误输出，在异常时排查根因
      child.stderr.on('data', chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT)
      })

      if (onProtocolEvent) {
        // 挂载 WireTap 抓包器，在子进程 stdio 上插入双向监听
        const wireTaps = createAcpWireTaps(onProtocolEvent)
        wireTaps.outbound.pipe(child.stdin)
        child.stdout.pipe(wireTaps.inbound)
        child.stdin.on('error', error => wireTaps.outbound.destroy(error))
        child.stdout.on('error', error => wireTaps.inbound.destroy(error))
        // 将包装好的抓包 Transform 流转为标准的 ndJsonStream
        stream = acp.ndJsonStream(
          Writable.toWeb(wireTaps.outbound) as WritableStream<Uint8Array>,
          Readable.toWeb(wireTaps.inbound) as ReadableStream<Uint8Array>
        )
      } else {
        // 无需抓包时，直接将子进程 stdin / stdout 包装为 ndJsonStream
        stream = acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        )
      }
    }

    // 统一定义销毁清理逻辑（杀死子进程树、释放自定义 Bridge）
    let disposed: Promise<void> | undefined
    const dispose = (): Promise<void> => disposed ??= (async () => {
      if (child) await killProcessTree(child)
      await options?.onDispose?.()
    })()

    // 维护当前任务的取消控制器
    const controller = new AbortController()
    this.active.add(controller)
    let cancelSession: (() => void) | undefined
    let rejectCancelled!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
    const onProcessError = (error: Error): void => { rejectCancelled(error) }
    child?.once('error', onProcessError)

    const abort = (): void => {
      controller.abort()
    }
    const onAbort = (): void => {
      cancelSession?.()
      rejectCancelled(new Error('Agent 任务已取消'))
      void dispose().catch(() => {})
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    options?.signal?.addEventListener('abort', abort, { once: true })

    // 初始化 ACP Client，定义宿主客户端身份为 'AgentPet'
    const client = acp.client({ name: 'AgentPet' })
      // 【全双工反向调用】：Agent 在运行过程中如果需要执行危险操作，会主动向 Client 申请权限
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const reject = params.options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always')
        return reject
          ? { outcome: { outcome: 'selected' as const, optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' as const } }
      })

    // 连接 stream 并进入 ACP 核心交互上下文
    const operation = client.connectWith(stream, async ctx => {
      // Step 1: 协议初始化握手（agent.initialize）
      const initializeStartedAt = performance.now()
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}
      })
      metrics.initializeMs = performance.now() - initializeStartedAt
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`不支持的 ACP 协议版本：${initialized.protocolVersion}`)
      }

      // Step 2: 创建并绑定工作区会话（agent.session.new）
      const sessionStartedAt = performance.now()
      return ctx.buildSession(cwd).withSession(async session => {
        metrics.sessionMs = performance.now() - sessionStartedAt
        // 注册取消通知回调，通知 Agent 中断当前会话
        cancelSession = () => {
          void ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {})
        }
        const base: AcpConnectionResult = {
          protocolVersion: initialized.protocolVersion,
          agentInfo: initialized.agentInfo || undefined,
          capabilities: initialized.agentCapabilities as Record<string, unknown> | undefined,
          modes: session.modes,
          configOptions: session.newSessionResponse.configOptions || undefined,
          sessionId: session.sessionId
        }
        // 如果是探针（probe）调用，没有 prompt，则完成会话建立后即可直接返回
        if (!prompt) return base

        // Step 3: 下发任务指令（agent.session.prompt）
        void session.prompt(prompt).catch(() => {}) // 错误会通过 nextUpdate 异步向上抛出

        let text = ''
        // Step 4: 异步轮询事件队列，流式消费 Agent 发来的增量通知
        for (;;) {
          const message = await session.nextUpdate()
          // 收到 stop 标志表示当前任务已彻底执行完毕
          if (message.kind === 'stop') {
            metrics.elapsedMs = performance.now() - startedAt
            return { ...base, text, stopReason: message.stopReason, performance: metrics }
          }
          metrics.updateCount++
          // 记录首字响应延迟（TTFT: Time To First Token）
          if (message.update.sessionUpdate === 'agent_message_chunk' && message.update.content.type === 'text') {
            metrics.firstTextMs ??= performance.now() - startedAt
            text += message.update.content.text
          }
          // 将通知实时推送给外层上层业务（更新画板 UI / 终端控制台）
          await onUpdate?.(message.update)
        }
      })
    })

    try {
      if (options?.signal?.aborted) abort()
      // 将业务操作与取消 Promise 竞态竞争，并设置最大超时
      return await withTimeout(Promise.race([operation, cancelled]), timeoutMs, () => {
        cancelSession?.()
        void dispose().catch(() => {})
      })
    } catch (error) {
      const suffix = stderr.trim() ? `\nCLI stderr: ${stderr.trim()}` : ''
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}${suffix}`)
    } finally {
      // 清理事件监听器与活跃句柄，保证无内存泄露
      options?.signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', onAbort)
      this.active.delete(controller)
      await dispose()
      child?.removeListener('error', onProcessError)
    }
  }
}

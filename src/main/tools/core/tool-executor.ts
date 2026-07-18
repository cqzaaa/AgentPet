import { toolRegistry } from './tool-registry'
import { auditPipeline } from '../security/audit-pipeline'
import { permissionManager } from '../security/permission-manager'
import { ToolContext, ToolResult } from './types'
import { mcpManager } from '../mcp/mcp-manager'

export class UnifiedToolExecutor {
  private static instance: UnifiedToolExecutor

  private constructor() {}

  public static getInstance(): UnifiedToolExecutor {
    if (!UnifiedToolExecutor.instance) {
      UnifiedToolExecutor.instance = new UnifiedToolExecutor()
    }
    return UnifiedToolExecutor.instance
  }

  public async execute(
    name: string,
    args: any,
    context: ToolContext
  ): Promise<ToolResult> {
    const manifest = toolRegistry.getManifest(name)
    const executor = toolRegistry.getExecutor(name)

    if (!manifest || !executor) {
      if (mcpManager.hasTool(name)) {
        try {
          const content = await mcpManager.executeTool(name, args, context.abortSignal)
          return { content, success: true }
        } catch (err: any) {
          if (err.message === 'UserAborted') {
            throw err
          }
          return {
            content: `MCP 外部工具执行失败: ${err.message || err}`,
            success: false,
            error: { message: err.message || String(err) }
          }
        }
      }
      return {
        content: `错误：未知工具: ${name}`,
        success: false
      }
    }


    // 1. 安全审计
    const auditResult = await auditPipeline.audit(name, args, manifest, context)
    if (auditResult.blocked) {
      return {
        content: `[安全拦截] 该操作已被安全管道拦截。原因: ${auditResult.reason}`,
        success: false
      }
    }

    if (auditResult.requireApproval) {
      // 触发弹窗授权
      const approvalCommand = name === 'rpa_run_workflow'
        ? `${name} ${JSON.stringify({
          workflow_id: args.workflow_id,
          input_keys: args.inputs && typeof args.inputs === 'object' ? Object.keys(args.inputs) : []
        })}`
        : args.command || `${name} ${JSON.stringify(args)}`
      const approved = await permissionManager.requestCommandPermission({
        command: approvalCommand,
        execCwd: args.cwd || context.workspacePath,
        sessionId: context.sessionId,
        warning: auditResult.warning,
        sender: context.event?.sender
      })

      if (!approved) {
        return {
          content: `[安全提示] 用户拒绝了工具 ${name} 的执行。`,
          success: false
        }
      }
    }

    // 2. 执行工具（带超时控制）
    const api = manifest.api.find(a => a.name === name)
    let timeoutMs = api?.timeout || 30000
    if (args && typeof args.timeout_seconds === 'number') {
      timeoutMs = args.timeout_seconds * 1000
    }

    let timer: NodeJS.Timeout | null = null
    let onAbort: (() => void) | null = null

    try {
      const promises: Promise<any>[] = []
      
      const execPromise = executor.execute(name, args, context)
      promises.push(execPromise)

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`工具执行超时（限制 ${timeoutMs / 1000} 秒）`)), timeoutMs)
        })
        promises.push(timeoutPromise)
      }

      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          throw new Error('UserAborted')
        }
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('UserAborted'))
          context.abortSignal!.addEventListener('abort', onAbort)
        })
        promises.push(abortPromise)
      }

      return await Promise.race(promises)
    } catch (err: any) {
      if (err.message === 'UserAborted') {
        throw err
      }
      return {
        content: `执行工具 ${name} 失败: ${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (context.abortSignal && onAbort) {
        context.abortSignal.removeEventListener('abort', onAbort)
      }
    }
  }

  /**
   * 并发执行多个工具调用 (并发度限制)
   */
  public async executeBatch(
    calls: Array<{ name: string; args: any }>,
    context: ToolContext,
    concurrency = 6
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length)
    let index = 0

    const worker = async () => {
      while (index < calls.length) {
        const myIndex = index++
        const call = calls[myIndex]
        const clonedContext = { ...context } // 不可变上下文
        try {
          results[myIndex] = await this.execute(call.name, call.args, clonedContext)
        } catch (err: any) {
          results[myIndex] = {
            content: `并发执行失败: ${err.message || err}`,
            success: false
          }
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, calls.length) }, worker)
    await Promise.all(workers)
    return results
  }
}

export const unifiedToolExecutor = UnifiedToolExecutor.getInstance()

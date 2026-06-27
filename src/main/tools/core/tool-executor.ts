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
          const content = await mcpManager.executeTool(name, args)
          return { content, success: true }
        } catch (err: any) {
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
      const approved = await permissionManager.requestCommandPermission({
        command: args.command || '',
        execCwd: args.cwd || context.workspacePath,
        warning: auditResult.warning
      })

      if (!approved) {
        return {
          content: `[安全提示] 用户拒绝了此终端命令的执行。指令内容: "${args.command}"`,
          success: false
        }
      }
    }

    // 2. 执行工具（带超时控制）
    const api = manifest.api.find(a => a.name === name)
    const timeoutMs = api?.timeout || 30000

    try {
      const execPromise = executor.execute(name, args, context)
      const timeoutPromise = new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`工具执行超时（限制 ${timeoutMs / 1000} 秒）`)), timeoutMs)
      )

      return await Promise.race([execPromise, timeoutPromise])
    } catch (err: any) {
      return {
        content: `执行工具 ${name} 失败: ${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
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

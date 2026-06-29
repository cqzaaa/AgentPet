import { ToolManifest, ToolContext } from '../core/types'
import { isReadOnlyCommand, checkCommandSafety } from './safety-checker'

export interface AuditResult {
  blocked: boolean
  requireApproval: boolean
  warning?: string
  reason?: string
}

export class AuditPipeline {
  private static instance: AuditPipeline

  private constructor() {}

  public static getInstance(): AuditPipeline {
    if (!AuditPipeline.instance) {
      AuditPipeline.instance = new AuditPipeline()
    }
    return AuditPipeline.instance
  }

  public async audit(
    toolName: string,
    args: Record<string, any>,
    manifest: ToolManifest,
    _context: ToolContext
  ): Promise<AuditResult> {
    const api = manifest.api.find(a => a.name === toolName)
    
    // 如果是 never，免除所有人工干预/审批
    if (api?.humanIntervention === 'never') {
      return { blocked: false, requireApproval: false }
    }

    // 处理命令行工具安全审计 (例如 run_terminal_command 或 run_command)
    if (toolName === 'run_terminal_command' || toolName === 'run_command') {
      const command = args.command || ''
      
      // 1. 只读或无害查询命令自动放行 (不需弹窗)
      if (isReadOnlyCommand(command)) {
        return { blocked: false, requireApproval: false }
      }

      // 2. 检查是否有高危操作
      const safety = checkCommandSafety(command)
      if (!safety.safe) {
        return {
          blocked: false,
          requireApproval: true,
          warning: safety.warning
        }
      }
    }

    // 处理内置文件删除工具安全审计 (delete_file)
    if (toolName === 'delete_file') {
      const filePath = args.file_path || ''
      return {
        blocked: false,
        requireApproval: true,
        warning: `检测到 AI 助理正在请求调用内置删除工具 'delete_file' 物理删除路径：${filePath}。系统默认不开启自动删除权限，此操作必须经由您手动核对批准后方可执行。`
      }
    }

    // 默认不需要审批
    return { blocked: false, requireApproval: false }
  }
}

export const auditPipeline = AuditPipeline.getInstance()

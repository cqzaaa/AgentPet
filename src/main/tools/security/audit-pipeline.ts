import { ToolManifest, ToolContext } from '../core/types'
import { checkCommandSafety, isReadOnlyCommand, looksLikeReadOnlyInspection } from './safety-checker'

export interface AuditResult {
  blocked: boolean
  requireApproval: boolean
  warning?: string
  reason?: string
}

export class AuditPipeline {
  private static instance: AuditPipeline

  private constructor() {
    // Singleton: use getInstance().
  }

  public static getInstance(): AuditPipeline {
    if (!AuditPipeline.instance) {
      AuditPipeline.instance = new AuditPipeline()
    }
    return AuditPipeline.instance
  }

  public async audit(
    toolName: string,
    args: Record<string, unknown>,
    manifest: ToolManifest,
    context: ToolContext
  ): Promise<AuditResult> {
    const api = manifest.api.find((a) => a.name === toolName)
    const permissionMode = context.sandboxMode
    const command = typeof args.command === 'string' ? args.command : ''

    // 完全访问权限放行全部操作，包括删除及其他高敏感操作。
    if (permissionMode === false) {
      return { blocked: false, requireApproval: false }
    }

    if (api?.humanIntervention === 'never') {
      return { blocked: false, requireApproval: false }
    }

    if (api?.humanIntervention === 'required' && permissionMode !== 'assist') {
      return {
        blocked: false,
        requireApproval: true,
        warning: `工具 ${toolName} 将执行可能改变外部状态的操作，请核对参数后确认。`
      }
    }

    // Office skills preserve the existing policy: read-only inspection is automatic,
    // while creating or modifying a file uses the regular approval flow.
    if (toolName === 'run_office_skill') {
      const action = typeof args.action === 'string' ? args.action.toLowerCase() : ''
      if ((action === 'create' || action === 'modify') && permissionMode !== 'assist') {
        return {
          blocked: false,
          requireApproval: true,
          warning: `Office Skill ${String(args.skill || '')} 将生成新的文档文件，请核对参数后确认。`
        }
      }
      return { blocked: false, requireApproval: false }
    }

    if (toolName === 'run_terminal_command' || toolName === 'run_command') {
      // Allow pure inspection commands without interrupting the user. This is
      // segment-based, so code text such as PowerShell Add-Type is not mistaken
      // for the CMD "type" command.
      if (isReadOnlyCommand(command)) {
        return { blocked: false, requireApproval: false }
      }

      const safety = checkCommandSafety(command)
      if (!safety.safe) {
        return {
          blocked: false,
          requireApproval: true,
          warning: safety.warning
        }
      }

      if (looksLikeReadOnlyInspection(command)) {
        return {
          blocked: false,
          requireApproval: true,
          warning:
            '命令包含只读查看片段，但还混合了未识别或可能改变状态的操作。请核对完整命令后再允许。'
        }
      }
    }

    if (toolName === 'delete_file') {
      const filePath = typeof args.file_path === 'string' ? args.file_path : ''
      return {
        blocked: false,
        requireApproval: true,
        warning: `检测到 AI 正在请求删除文件：${filePath}。请手动核对批准后再执行。`
      }
    }

    // “帮我审批”自动放行普通写入、修改和执行；删除及安全
    // 检查识别出的高风险命令仍然走用户确认。
    if (permissionMode === 'assist') {
      if (toolName === 'run_terminal_command' || toolName === 'run_command') {
        const safety = checkCommandSafety(command)
        if (!safety.safe) {
          return { blocked: false, requireApproval: true, warning: safety.warning }
        }
      }
      return { blocked: false, requireApproval: false }
    }

    return { blocked: false, requireApproval: false }
  }
}

export const auditPipeline = AuditPipeline.getInstance()

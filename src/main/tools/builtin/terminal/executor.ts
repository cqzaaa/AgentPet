import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { ShellKind, shellManager } from './shell-manager'
import { sshManager } from './ssh-manager'
import { getSessionFilesDir, resolveSessionPath } from '../../utils/paths'

function resolveShell(value: unknown, fallback: ShellKind): ShellKind {
  if (value === undefined || value === null) return fallback
  if (value === 'powershell' || value === 'bash' || value === 'cmd') return value
  throw new Error(`不支持的 shell: ${String(value)}。可选值为 powershell、bash、cmd。`)
}

export class TerminalExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      if (api === 'run_terminal_command') {
        const { command } = args
        const isSsh = Boolean(context.sessionId && sshManager.getDeviceType(context.sessionId) === 'ssh')
        const shell = resolveShell(args.shell, isSsh ? 'bash' : 'powershell')

        // 动态覆盖超时时间，若模型传入了 timeout_seconds 则换算为毫秒，否则默认 120 秒
        let cmdTimeout = 120000
        if (typeof args.timeout_seconds === 'number') {
          cmdTimeout = args.timeout_seconds * 1000
        }

        if (isSsh) {
          // SSH 模式下不传递本地物理盘符的路径作为 cwd
          const { stdout, stderr } = await sshManager.executeCommand(context.sessionId!, command, undefined)
          return {
            content: `[远程 SSH 命令执行输出 | shell: ${shell}]\n${stdout || ''}\n${stderr ? '[错误输出]\n' + stderr : ''}`,
            success: true
          }
        }

        const execCwd = getSessionFilesDir(context.sessionId)
        // run_terminal_command 同步执行，传入动态超时与中止信号
        const { stdout, stderr, exitCode } = await shellManager.exec(command, shell, {
          cwd: execCwd,
          timeout: cmdTimeout,
          signal: context.abortSignal
        } as any)
        const combinedOutput = `${stdout}\n${stderr}`
        const permissionDenied = /access is denied|拒绝访问|system error 5|unauthorizedaccess/i.test(combinedOutput)
        const noOutputNonZero = exitCode !== 0 && !stdout.trim() && !stderr.trim()
        const guidance = permissionDenied
          ? '[权限不足] 当前应用进程没有完成该操作所需的系统权限。请停止使用等价命令重复尝试，并告知用户需要以管理员身份运行或授权提升权限。'
          : noOutputNonZero
            ? '[结果说明] 命令未返回匹配内容。对于查询、搜索或状态检查，这通常表示“未找到/未运行”，不等同于终端执行器故障。'
            : ''
        const output = [
          `[命令执行完成 | shell: ${shell} | exit_code: ${exitCode}]`,
          stdout || '',
          stderr ? `[stderr]\n${stderr}` : '',
          !stdout && !stderr ? '(无输出)' : '',
          guidance
        ].filter(Boolean).join('\n')
        return {
          content: output,
          state: { exitCode, stdout, stderr },
          success: true
        }
      }

      if (api === 'run_command') {
        const { command, description, cwd } = args
        const isSsh = Boolean(context.sessionId && sshManager.getDeviceType(context.sessionId) === 'ssh')
        const shell = resolveShell(args.shell, isSsh ? 'bash' : 'powershell')

        if (isSsh) {
          // 过滤 Windows 本地物理路径，非 Windows 物理路径才被视作远程路径带给 SSH
          let remoteCwd: string | undefined = undefined
          if (cwd && !cwd.includes(':\\') && !cwd.includes(':/')) {
            remoteCwd = cwd
          }
          const session = sshManager.startSshShellSession(context.sessionId!, command, remoteCwd)
          return {
            content: `[远程 SSH 命令已启动 | shell: ${shell}]\nshell_id: ${session.id}\n命令: ${command}\n${description ? '描述: ' + description + '\n' : ''}使用 get_command_output 获取输出，使用 kill_command 终止命令。`,
            state: { shell_id: session.id, command, shell },
            success: true
          }
        }

        const execCwd = cwd
          ? resolveSessionPath(cwd, context.sessionId)
          : getSessionFilesDir(context.sessionId)
        const session = shellManager.startSession(command, shell, execCwd)
        return {
          content: `[命令已启动 | shell: ${shell}]\nshell_id: ${session.id}\n命令: ${command}\n${description ? '描述: ' + description + '\n' : ''}使用 get_command_output 获取输出，使用 kill_command 终止命令。`,
          state: { shell_id: session.id, command, shell },
          success: true
        }
      }

      if (api === 'get_command_output') {
        const { shell_id, filter } = args
        if (!shell_id) {
          return { content: '错误：缺少必要参数 shell_id', success: false }
        }

        const { output, isRunning } = shellManager.getOutput(shell_id, filter)
        const status = isRunning ? '运行中' : '已结束'
        return {
          content: `[命令状态: ${status}]\n${output || '(无输出)'}`,
          success: true
        }
      }

      if (api === 'kill_command') {
        const { shell_id } = args
        if (!shell_id) {
          return { content: '错误：缺少必要参数 shell_id', success: false }
        }

        const success = shellManager.killSession(shell_id)
        if (success) {
          return { content: `[命令已终止] shell_id: ${shell_id}`, success: true }
        } else {
          return { content: `错误：未找到会话 ${shell_id}`, success: false }
        }
      }

      return { content: `未知的操作类型: ${api}`, success: false }
    } catch (err: any) {
      return {
        content: `终端执行异常: ${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    }
  }

  public getApiNames(): string[] {
    return ['run_command', 'get_command_output', 'kill_command', 'run_terminal_command']
  }

}

export const terminalExecutor = new TerminalExecutor()

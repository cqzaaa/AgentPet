import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { shellManager } from './shell-manager'
import { getActiveStorageDir } from '../../utils/paths'

export class TerminalExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      if (api === 'run_terminal_command') {
        const { command } = args
        const execCwd = this.resolveCwd(context.sessionId, context.workspacePath)

        const { stdout, stderr } = await shellManager.execWithBash(command, { cwd: execCwd })
        return {
          content: `[命令执行输出]\n${stdout || ''}\n${stderr ? '[错误输出]\n' + stderr : ''}`,
          success: true
        }
      }

      if (api === 'run_command') {
        const { command, description, cwd } = args
        const execCwd = cwd || this.resolveCwd(context.sessionId, context.workspacePath)

        const session = shellManager.startSession(command, execCwd)
        return {
          content: `[命令已启动]\nshell_id: ${session.id}\n命令: ${command}\n${description ? '描述: ' + description + '\n' : ''}使用 get_command_output 获取输出，使用 kill_command 终止命令。`,
          state: { shell_id: session.id, command },
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

  private resolveCwd(sessionId?: string, workspacePath?: string): string {
    let execCwd = os.homedir()
    if (sessionId) {
      const sessionDir = join(getActiveStorageDir(), 'chat', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'))
      if (fs.existsSync(sessionDir)) {
        execCwd = sessionDir
      }
    }
    if (execCwd === os.homedir() && workspacePath && fs.existsSync(workspacePath)) {
      execCwd = workspacePath
    }
    return execCwd
  }
}

export const terminalExecutor = new TerminalExecutor()

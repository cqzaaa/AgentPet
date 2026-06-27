import * as fs from 'fs'
import * as path from 'path'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface ShellSession {
  id: string
  process: any
  output: string
  isRunning: boolean
  startTime: number
  command: string
}

export class ShellManager {
  private static instance: ShellManager
  private sessions = new Map<string, ShellSession>()
  private nextShellId = 1

  private constructor() {
    // 每5分钟清理一次过期会话（超过1小时）
    setInterval(() => this.cleanupOldSessions(), 300000)
  }

  public static getInstance(): ShellManager {
    if (!ShellManager.instance) {
      ShellManager.instance = new ShellManager()
    }
    return ShellManager.instance
  }

  // 获取 bash 路径（优先使用 Git Bash）
  public getBashPath(): string | null {
    if (process.env.GIT_BASH && fs.existsSync(process.env.GIT_BASH)) {
      return process.env.GIT_BASH
    }

    try {
      const { execSync } = require('child_process')
      const gitPath = execSync('where git', { encoding: 'utf-8' }).trim().split('\n')[0].trim()
      if (gitPath) {
        const gitDir = path.dirname(path.dirname(gitPath))
        const bashCandidates = [
          path.join(gitDir, 'bin', 'bash.exe'),
          path.join(gitDir, 'usr', 'bin', 'bash.exe'),
          path.join(gitDir, 'Git', 'bin', 'bash.exe'),
          path.join(gitDir, 'Git', 'usr', 'bin', 'bash.exe'),
        ]
        for (const bashPath of bashCandidates) {
          if (fs.existsSync(bashPath)) {
            return bashPath
          }
        }
      }
    } catch (e) {}

    const commonPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'D:\\Program Files\\Git\\bin\\bash.exe',
      'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
      (process.env.ProgramFiles || '') + '\\Git\\bin\\bash.exe',
      (process.env['ProgramFiles(x86)'] || '') + '\\Git\\bin\\bash.exe',
    ].filter(Boolean)

    for (const bashPath of commonPaths) {
      if (fs.existsSync(bashPath)) {
        return bashPath
      }
    }
    return null
  }

  // 检测命令类型
  public detectCommandType(command: string): 'powershell' | 'cmd' | 'bash' {
    const cmd = command.trim().toLowerCase()
    const powershellPatterns = [
      /^powershell\b/i, /^pwsh\b/i, /\bget-childitem\b/i, /\bget-process\b/i,
      /\bget-service\b/i, /\bget-item\b/i, /\bset-item\b/i, /\bnew-item\b/i,
      /\bremove-item\b/i, /\binvoke-/i, /\bwrite-output\b/i, /\bwrite-host\b/i,
      /\bformat-table\b/i, /\bselect-object\b/i, /\bwhere-object\b/i,
      /\bforeach-object\b/i, /\b-sort-object\b/i, /\bmeasure-object\b/i,
      /\bconvertto-/i, /\bconvertfrom-/i, /\bimport-module\b/i,
      /\bexport-module\b/i, /\badd-type\b/i, /\[math\]::/i, /\bpsobject\b/i
    ]

    const cmdPatterns = [
      /^wmic\b/i, /^systeminfo\b/i, /^ipconfig\b/i, /^ping\b/i, /^tracert\b/i,
      /^netstat\b/i, /^tasklist\b/i, /^taskkill\b/i, /^schtasks\b/i, /^reg\b/i,
      /^sc\b/i, /^net\b/i, /^dir\b/i, /^type\b/i, /^copy\b/i, /^move\b/i,
      /^del\b/i, /^rd\b/i, /^md\b/i, /^mkdir\b/i, /^rmdir\b/i, /^echo\b/i,
      /^set\b/i, /^cls\b/i, /^color\b/i, /^title\b/i, /^timeout\b/i,
      /^start\b/i, /^assoc\b/i, /^ftype\b/i, /^for\b/i, /^if\b/i
    ]

    const bashPatterns = [
      /^ls\b/i, /^du\b/i, /^df\b/i, /^grep\b/i, /^find\b/i, /^awk\b/i,
      /^sed\b/i, /^cat\b/i, /^head\b/i, /^tail\b/i, /^sort\b/i, /^uniq\b/i,
      /^wc\b/i, /^chmod\b/i, /^chown\b/i, /^mkdir\b/i, /^rm\b/i, /^cp\b/i,
      /^mv\b/i, /^tar\b/i, /^gzip\b/i, /^gunzip\b/i, /^ssh\b/i, /^scp\b/i,
      /^rsync\b/i, /^git\b/i, /^npm\b/i, /^node\b/i, /^python\b/i, /^pip\b/i,
      /^curl\b/i, /^wget\b/i, /^docker\b/i, /^kubectl\b/i
    ]

    if (powershellPatterns.some(p => p.test(cmd))) return 'powershell'
    if (cmdPatterns.some(p => p.test(cmd))) return 'cmd'
    if (bashPatterns.some(p => p.test(cmd))) return 'bash'

    if (cmd.includes(' 2>/dev/null') || (cmd.includes(' | ') && cmd.includes('grep')) ||
        cmd.includes('$( ') || cmd.includes('`') || (cmd.includes('&&') && !cmd.includes('&'))) {
      return 'bash'
    }

    if ((cmd.includes('$(') && !cmd.includes('$()')) || cmd.includes('| %') || cmd.includes('|?') ||
        cmd.includes('$_') || cmd.includes('$PSVersionTable')) {
      return 'powershell'
    }

    return 'cmd'
  }

  // 使用 bash 执行命令（同步）
  public async execWithBash(command: string, options: { cwd?: string; timeout?: number } = {}) {
    const bashPath = this.getBashPath()
    const cmd = command.trim()

    const isAlreadyWrapped =
      /^powershell\s+-Command\s+/i.test(cmd) ||
      /^pwsh\s+-Command\s+/i.test(cmd) ||
      /^bash\s+-c\s+/i.test(cmd) ||
      /^sh\s+-c\s+/i.test(cmd) ||
      /^cmd\s+\/c\s+/i.test(cmd)

    if (isAlreadyWrapped) {
      return execAsync(cmd, options)
    }

    const commandType = this.detectCommandType(cmd)

    switch (commandType) {
      case 'powershell':
        return execAsync(`powershell -Command "${cmd.replace(/"/g, '\\"')}"`, {
          ...options,
          shell: 'powershell.exe',
        })
      case 'bash':
        if (bashPath) {
          return execAsync(`"${bashPath}" -c "${cmd.replace(/"/g, '\\"')}"`, {
            ...options,
            shell: bashPath,
          })
        } else {
          return execAsync(`sh -c "${cmd.replace(/"/g, '\\"')}"`, options)
        }
      case 'cmd':
      default:
        return execAsync(cmd, { ...options, shell: 'cmd.exe' })
    }
  }

  // 启动异步 shell 会话
  public startSession(command: string, cwd?: string): ShellSession {
    const shellId = `shell_${this.nextShellId++}`
    const bashPath = this.getBashPath()

    let proc: any
    if (bashPath) {
      proc = spawn(bashPath, ['-c', command], {
        cwd: cwd || process.cwd(),
        shell: bashPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } else {
      proc = spawn(command, [], {
        cwd: cwd || process.cwd(),
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    }

    const session: ShellSession = {
      id: shellId,
      process: proc,
      output: '',
      isRunning: true,
      startTime: Date.now(),
      command,
    }

    proc.stdout.on('data', (data: Buffer) => {
      session.output += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      session.output += data.toString()
    })

    proc.on('close', (code: number) => {
      session.isRunning = false
      session.output += `\n[进程退出，退出码: ${code}]`
    })

    proc.on('error', (err: Error) => {
      session.isRunning = false
      session.output += `\n[错误: ${err.message}]`
    })

    this.sessions.set(shellId, session)
    return session
  }

  // 获取 shell 会话的新输出
  public getOutput(shellId: string, filter?: string): { output: string; isRunning: boolean } {
    const session = this.sessions.get(shellId)
    if (!session) {
      return { output: `错误: 未找到会话 ${shellId}`, isRunning: false }
    }

    let output = session.output
    if (filter) {
      try {
        const regex = new RegExp(filter, 'gm')
        const matches = output.match(regex)
        output = matches ? matches.join('\n') : ''
      } catch (e) {}
    }

    return { output, isRunning: session.isRunning }
  }

  // 终止 shell 会话
  public killSession(shellId: string): boolean {
    const session = this.sessions.get(shellId)
    if (!session) {
      return false
    }

    if (session.isRunning) {
      session.process.kill('SIGTERM')
      setTimeout(() => {
        if (session.isRunning) {
          session.process.kill('SIGKILL')
        }
      }, 2000)
    }

    this.sessions.delete(shellId)
    return true
  }

  // 清理过期会话
  private cleanupOldSessions() {
    const now = Date.now()
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.startTime > 3600000) { // 1小时
        if (session.isRunning) {
          session.process.kill('SIGKILL')
        }
        this.sessions.delete(id)
      }
    }
  }
}

export const shellManager = ShellManager.getInstance()

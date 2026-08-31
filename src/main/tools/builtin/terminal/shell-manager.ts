import * as fs from 'fs'
import * as path from 'path'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import * as iconv from 'iconv-lite'

const execAsync = promisify(exec)

export type ShellKind = 'powershell' | 'bash' | 'cmd'

function decodeOutputBuffer(data: Buffer | string): string {
  if (typeof data === 'string') return data
  const utf8Str = data.toString('utf8')
  if (process.platform === 'win32' && utf8Str.includes('\uFFFD')) {
    try {
      return iconv.decode(data, 'cp936')
    } catch (e) {
      return utf8Str
    }
  }
  return utf8Str
}

export interface ShellSession {
  id: string
  process: any
  output: string
  isRunning: boolean
  startTime: number
  command: string
}

export interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type ShellOutputHandler = (chunk: string) => void

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

  // 同步执行命令。shell 由调用方显式指定；本机未指定时固定使用 PowerShell，避免猜测命令语法。
  public async exec(command: string, shell: ShellKind = 'powershell', options: { cwd: string; timeout?: number; signal?: AbortSignal; onOutput?: ShellOutputHandler; env?: NodeJS.ProcessEnv }): Promise<ShellExecResult> {
    const bashPath = this.getBashPath()
    const cmd = command.trim()

    const runExec = async (cmdStr: string, execOptions: any) => {
      try {
        if (!options.onOutput) {
          const result: any = await execAsync(cmdStr, { ...execOptions, encoding: 'buffer' })
          return {
            stdout: decodeOutputBuffer(result.stdout),
            stderr: decodeOutputBuffer(result.stderr),
            exitCode: 0
          }
        }

        return await new Promise<ShellExecResult>((resolve, reject) => {
          const child = exec(cmdStr, { ...execOptions, encoding: 'buffer' }, (error: any, stdout: Buffer, stderr: Buffer) => {
            const normalizedStdout = decodeOutputBuffer(stdout || Buffer.alloc(0))
            const normalizedStderr = decodeOutputBuffer(stderr || Buffer.alloc(0))
            if (!error) {
              resolve({ stdout: normalizedStdout, stderr: normalizedStderr, exitCode: 0 })
              return
            }
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
              reject(error)
              return
            }
            if (error?.killed || error?.code === 'ETIMEDOUT' || /timed?\s*out/i.test(String(error?.message || ''))) {
              const timeoutError: any = new Error(`命令执行超时${execOptions.timeout ? `（限制 ${execOptions.timeout / 1000} 秒）` : ''}`)
              timeoutError.code = 'ETIMEDOUT'
              timeoutError.stdout = normalizedStdout
              timeoutError.stderr = normalizedStderr
              reject(timeoutError)
              return
            }
            if (typeof error?.code === 'number') {
              resolve({ stdout: normalizedStdout, stderr: normalizedStderr, exitCode: error.code })
              return
            }
            reject(error)
          })
          const forward = (data: Buffer | string) => options.onOutput?.(decodeOutputBuffer(data))
          child.stdout?.on('data', forward)
          child.stderr?.on('data', forward)
        })
      } catch (err: any) {
        const stdout = err.stdout !== undefined ? decodeOutputBuffer(err.stdout) : ''
        const stderr = err.stderr !== undefined ? decodeOutputBuffer(err.stderr) : ''
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err
        if (err?.killed || err?.code === 'ETIMEDOUT' || /timed?\s*out/i.test(String(err?.message || ''))) {
          const timeoutError: any = new Error(`命令执行超时${execOptions.timeout ? `（限制 ${execOptions.timeout / 1000} 秒）` : ''}`)
          timeoutError.code = 'ETIMEDOUT'
          timeoutError.stdout = stdout
          timeoutError.stderr = stderr
          throw timeoutError
        }
        if (typeof err?.code === 'number') {
          return { stdout, stderr, exitCode: err.code }
        }
        throw err
      }
    }

    switch (shell) {
      case 'powershell':
        const psCmd = process.platform === 'win32'
          ? `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmd}`
          : cmd
        return runExec(psCmd, {
          ...options,
          shell: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        })
      case 'bash':
        if (bashPath) {
          return runExec(cmd, {
            ...options,
            shell: bashPath,
          })
        }
        if (process.platform !== 'win32') {
          return runExec(cmd, { ...options, shell: 'sh' })
        }
        throw new Error('未找到 Git Bash。请安装 Git for Windows，或改用 shell=powershell。')
      case 'cmd':
      default:
        if (process.platform !== 'win32') {
          throw new Error('shell=cmd 仅支持 Windows。')
        }
        const cmdCmd = process.platform === 'win32'
          ? `chcp 65001 >nul && ${cmd}`
          : cmd
        return runExec(cmdCmd, { ...options, shell: 'cmd.exe' })
    }
  }


  /** Execute a trusted executable with an argument vector and no command shell. */
  public async execFile(
    executable: string,
    args: string[],
    options: { cwd: string; timeout?: number; signal?: AbortSignal; onOutput?: ShellOutputHandler }
  ): Promise<ShellExecResult> {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONNOUSERSITE: '1',
          PIP_DISABLE_PIP_VERSION_CHECK: '1',
          PIP_NO_INPUT: '1'
        }
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        callback()
      }
      const abort = (): void => {
        child.kill()
        finish(() => reject(new Error('UserAborted')))
      }
      const timer = options.timeout && options.timeout > 0
        ? setTimeout(() => {
            child.kill()
            finish(() => reject(new Error(`命令执行超时（限制 ${options.timeout! / 1000} 秒）`)))
          }, options.timeout)
        : undefined

      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', data => {
        const chunk = decodeOutputBuffer(data)
        stdout += chunk
        options.onOutput?.(chunk)
      })
      child.stderr.on('data', data => {
        const chunk = decodeOutputBuffer(data)
        stderr += chunk
        options.onOutput?.(chunk)
      })
      child.on('error', error => finish(() => reject(error)))
      child.on('close', code => finish(() => resolvePromise({ stdout, stderr, exitCode: code ?? -1 })))
    })
  }

  // 启动异步 shell 会话
  public startSession(command: string, shell: ShellKind = 'powershell', cwd: string, onOutput?: ShellOutputHandler, env?: NodeJS.ProcessEnv): ShellSession {
    const shellId = `shell_${this.nextShellId++}`
    const bashPath = this.getBashPath()

    let proc: any
    if (shell === 'bash') {
      const bashExecutable = bashPath || (process.platform !== 'win32' ? 'sh' : null)
      if (!bashExecutable) {
        throw new Error('未找到 Git Bash。请安装 Git for Windows，或改用 shell=powershell。')
      }
      proc = spawn(bashExecutable, ['-lc', command], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } else if (shell === 'powershell') {
      const psCommand = process.platform === 'win32'
        ? `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
        : command
      proc = spawn(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } else {
      if (process.platform !== 'win32') {
        throw new Error('shell=cmd 仅支持 Windows。')
      }
      const finalCommand = process.platform === 'win32' ? `chcp 65001 >nul && ${command}` : command
      proc = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', finalCommand] : ['-c', finalCommand], {
        cwd,
        env,
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

    const appendOutput = (data: Buffer | string) => {
      const chunk = decodeOutputBuffer(data)
      session.output += chunk
      onOutput?.(chunk)
    }
    proc.stdout.on('data', appendOutput)

    proc.stderr.on('data', appendOutput)

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

  // 注册外部会话（如远程 SSH 异步通道）
  public registerSession(session: ShellSession): void {
    this.sessions.set(session.id, session)
  }

  // 终止 shell 会话
  public killSession(shellId: string): boolean {
    const session = this.sessions.get(shellId)
    if (!session) {
      return false
    }

    if (session.isRunning) {
      if (session.process && typeof session.process.kill === 'function') {
        session.process.kill('SIGTERM')
        setTimeout(() => {
          if (session.isRunning) {
            try { session.process.kill('SIGKILL') } catch (e) {}
          }
        }, 2000)
      } else if (session.process && typeof session.process.destroy === 'function') {
        try { session.process.destroy() } catch (e) {}
      }
      session.isRunning = false
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

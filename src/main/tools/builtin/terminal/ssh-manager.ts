import { Client } from 'ssh2'
import { shellManager, ShellSession } from './shell-manager'

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
}

export class SshManager {
  private static instance: SshManager
  // 按 sessionId 缓存每个会话的 SSH Client 实例
  private clients = new Map<string, Client>()
  // 按 sessionId 缓存 SSH 的配置，供状态查询使用
  private configs = new Map<string, SshConfig>()
  // 按 sessionId 缓存当前的执行设备类型 ('local' | 'ssh')
  private deviceTypes = new Map<string, 'local' | 'ssh'>()
  private nextShellId = 1

  private constructor() {}

  public static getInstance(): SshManager {
    if (!SshManager.instance) {
      SshManager.instance = new SshManager()
    }
    return SshManager.instance
  }

  /**
   * 设置与获取会话的执行设备类型
   */
  public setDeviceType(sessionId: string, type: 'local' | 'ssh'): void {
    this.deviceTypes.set(sessionId, type)
  }

  public getDeviceType(sessionId: string): 'local' | 'ssh' {
    return this.deviceTypes.get(sessionId) || 'local'
  }

  /**
   * 测试 SSH 连接是否畅通
   */
  public async testConnection(config: SshConfig): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      const conn = new Client()
      let hasResolved = false

      const timeout = setTimeout(() => {
        if (!hasResolved) {
          hasResolved = true
          conn.end()
          resolve({ success: false, message: '连接超时，请检查 IP 端口或网络设置。' })
        }
      }, 10000)

      conn.on('ready', () => {
        if (!hasResolved) {
          hasResolved = true
          clearTimeout(timeout)
          conn.end()
          resolve({ success: true, message: '连接成功！' })
        }
      })

      conn.on('error', (err: any) => {
        if (!hasResolved) {
          hasResolved = true
          clearTimeout(timeout)
          conn.end()
          resolve({ success: false, message: `连接失败: ${err.message || String(err)}` })
        }
      })

      try {
        conn.connect({
          host: config.host,
          port: config.port || 22,
          username: config.username,
          password: config.password || undefined,
          privateKey: config.privateKey || undefined,
          readyTimeout: 10000
        })
      } catch (e: any) {
        if (!hasResolved) {
          hasResolved = true
          clearTimeout(timeout)
          resolve({ success: false, message: `参数错误: ${e.message || String(e)}` })
        }
      }
    })
  }

  /**
   * 建立并保存正式的 SSH 连接
   */
  public async connect(sessionId: string, config: SshConfig): Promise<{ success: boolean; message?: string }> {
    // 如果已经存在连接，先断开它
    this.disconnect(sessionId)

    return new Promise((resolve) => {
      const conn = new Client()
      let hasResolved = false

      const timeout = setTimeout(() => {
        if (!hasResolved) {
          hasResolved = true
          conn.end()
          resolve({ success: false, message: '连接超时。' })
        }
      }, 15000)

      conn.on('ready', () => {
        if (!hasResolved) {
          hasResolved = true
          clearTimeout(timeout)
          this.clients.set(sessionId, conn)
          this.configs.set(sessionId, config)
          resolve({ success: true, message: '成功建立远程 SSH 连接' })
        }
      })

      conn.on('error', (err: any) => {
        if (!hasResolved) {
          hasResolved = true
          clearTimeout(timeout)
          conn.end()
          resolve({ success: false, message: err.message || String(err) })
        } else {
          // 运行中出错，进行清理
          this.disconnect(sessionId)
        }
      })

      conn.on('close', () => {
        this.clients.delete(sessionId)
        this.configs.delete(sessionId)
      })

      try {
        conn.connect({
          host: config.host,
          port: config.port || 22,
          username: config.username,
          password: config.password || undefined,
          privateKey: config.privateKey || undefined,
          readyTimeout: 15000
        })
      } catch (e: any) {
        if (!hasResolved) {
          hasResolved = true
          clearTimeout(timeout)
          resolve({ success: false, message: `配置参数错误: ${e.message || String(e)}` })
        }
      }
    })
  }

  /**
   * 断开指定会话的 SSH 连接
   */
  public disconnect(sessionId: string): void {
    const conn = this.clients.get(sessionId)
    if (conn) {
      try {
        conn.end()
      } catch (e) {
        console.error('断开 SSH 失败:', e)
      }
      this.clients.delete(sessionId)
    }
    this.configs.delete(sessionId)
    this.deviceTypes.delete(sessionId)
  }

  /**
   * 获取当前会话的 SSH 状态
   */
  public getStatus(sessionId: string): { connected: boolean; host?: string; username?: string } {
    const conn = this.clients.get(sessionId)
    const config = this.configs.get(sessionId)
    if (conn && config) {
      return {
        connected: true,
        host: config.host,
        username: config.username
      }
    }
    return { connected: false }
  }

  /**
   * 执行 SSH 命令并搜集输出
   */
  public async executeCommand(
    sessionId: string,
    command: string,
    cwd?: string
  ): Promise<{ stdout: string; stderr: string }> {
    const conn = this.clients.get(sessionId)
    if (!conn) {
      throw new Error('未连接远程 SSH 服务器，请先进行 SSH 连接。')
    }

    return new Promise((resolve, reject) => {
      // 在远程服务器上，利用 cd 命令来实现 cwd 的效果
      let finalCommand = command
      if (cwd) {
        // 使用 Linux 常见的 cd 指令包装
        finalCommand = `cd "${cwd.replace(/"/g, '\\"')}" && ${command}`
      }

      conn.exec(finalCommand, (err, stream) => {
        if (err) {
          return reject(err)
        }

        let stdout = ''
        let stderr = ''

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        stream.on('close', (code: number) => {
          // 可以在这里根据 exit code 处理异常，但为了工具返回，通常返回 stdout 和 stderr
          resolve({ stdout, stderr })
        })
      })
    })
  }

  /**
   * 启动远程 SSH 异步 shell 会话
   */
  public startSshShellSession(
    sessionId: string,
    command: string,
    cwd?: string
  ): ShellSession {
    const conn = this.clients.get(sessionId)
    if (!conn) {
      throw new Error('未连接远程 SSH 服务器，请先进行 SSH 连接。')
    }

    const shellId = `ssh_shell_${this.nextShellId++}`
    let finalCommand = command
    if (cwd) {
      finalCommand = `cd "${cwd.replace(/"/g, '\\"')}" && ${command}`
    }

    // 预定义空 session
    const session: ShellSession = {
      id: shellId,
      process: null, // 将在 exec 回调中填充流引用
      output: `[远程 SSH 异步命令启动]\n命令: ${command}\n`,
      isRunning: true,
      startTime: Date.now(),
      command
    }

    conn.exec(finalCommand, (err, stream) => {
      if (err) {
        session.isRunning = false
        session.output += `\n[连接通道启动失败: ${err.message || String(err)}]`
        return
      }

      session.process = stream

      stream.on('data', (data: Buffer) => {
        session.output += data.toString()
      })

      stream.stderr.on('data', (data: Buffer) => {
        session.output += data.toString()
      })

      stream.on('close', (code: number) => {
        session.isRunning = false
        session.output += `\n[远程进程退出，退出码: ${code}]`
      })

      stream.on('error', (streamErr: Error) => {
        session.isRunning = false
        session.output += `\n[远程流异常: ${streamErr.message}]`
      })
    })

    // 注册到全局 shellManager 以便轮询 getOutput 或关闭
    shellManager.registerSession(session)
    return session
  }
}

export const sshManager = SshManager.getInstance()

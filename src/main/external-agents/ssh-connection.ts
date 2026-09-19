import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'
import * as acp from '@agentclientprotocol/sdk'
import { resolveExecutable } from './process-utils'
import type { ExternalAgentDefinition } from './types'

export interface SshConnectionInput {
  host: string
  user: string
  port?: number
  passwordRef: string
  agentId: string
}

export interface SshConnectionResult {
  ok: boolean
  ssh: { ok: boolean; message: string }
  cli?: { ok: boolean; message: string }
  needsHostTrust?: boolean
}

export class SshHostTrustRequiredError extends Error {
  constructor() {
    super('尚未信任此服务器，请先确认主机指纹')
    this.name = 'SshHostTrustRequiredError'
  }
}

export async function openVerifiedSsh(input: Pick<SshConnectionInput, 'host' | 'user' | 'port'>, password: string, signal?: AbortSignal): Promise<Client> {
  const host = String(input.host || '').trim()
  const user = String(input.user || '').trim()
  const port = input.port === undefined ? 22 : Number(input.port)
  if (!host || host.startsWith('-') || !/^[a-zA-Z0-9_.:-]+$/.test(host)) throw new Error('请输入有效的服务器地址')
  if (!user || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(user)) throw new Error('请输入有效的 SSH 用户名')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1–65535 之间')
  if (!password) throw new Error('请输入 SSH 登录密码')
  if (signal?.aborted) throw new Error('远端任务已取消')
  const keys = await trustedHostKeys(host, port)
  if (signal?.aborted) throw new Error('远端任务已取消')
  return new Promise<Client>((resolve, reject) => {
    const client = new Client()
    let settled = false
    let rejectedHostKey = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      try { client.end() } catch { /* Connection may not have opened yet. */ }
      reject(error)
    }
    const onAbort = (): void => fail(new Error('远端任务已取消'))
    const timer = setTimeout(() => fail(new Error('SSH 连接超时')), 12000)
    signal?.addEventListener('abort', onAbort, { once: true })
    client.once('ready', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(client)
    })
    client.on('error', (error) => fail(new Error(rejectedHostKey ? '服务器主机密钥与本机记录不匹配' : error.message)))
    try {
      client.connect({
        host, port, username: user, password, readyTimeout: 10000,
        hostVerifier: (key) => {
          const trusted = keys.has(key.toString('base64'))
          if (!trusted) rejectedHostKey = true
          return trusted
        }
      })
    } catch (error) {
      fail(error instanceof Error ? error : new Error('SSH 连接失败'))
    }
  })
}

async function trustedHostKeys(host: string, port: number): Promise<Set<string>> {
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  if (!existsSync(knownHosts)) throw new SshHostTrustRequiredError()
  const keygen = await resolveExecutable('ssh-keygen', ['ssh-keygen.exe'])
  if (!keygen) throw new Error('本机未找到 ssh-keygen，无法验证服务器指纹')
  const lookup = port === 22 ? host : `[${host}]:${port}`
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(keygen, ['-F', lookup, '-f', knownHosts], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.once('error', reject)
    child.once('close', () => resolve(stdout))
  })
  const keys = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length >= 3 && /^(ssh-|ecdsa-)/.test(fields[1]) && /^[A-Za-z0-9+/]+={0,2}$/.test(fields[2])) {
      keys.add(fields[2])
    }
  }
  if (!keys.size) throw new SshHostTrustRequiredError()
  return keys
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export async function testSshConnection(input: SshConnectionInput, password: string, agent: ExternalAgentDefinition): Promise<SshConnectionResult> {
  const host = String(input.host || '').trim()
  const user = String(input.user || '').trim()
  const port = input.port === undefined ? 22 : Number(input.port)
  const executable = agent.executable
  if (!host || host.startsWith('-') || !/^[a-zA-Z0-9_.:-]+$/.test(host))
    throw new Error('请输入有效的服务器地址')
  if (!user || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(user))
    throw new Error('请输入有效的 SSH 用户名')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SSH 端口必须在 1–65535 之间')
  if (!password) throw new Error('请输入 SSH 登录密码')
  if (!executable || executable.startsWith('-') || !/^[a-zA-Z0-9._/-]+$/.test(executable))
    throw new Error('远端 CLI 命令无效，请使用命令名或绝对路径')

  const keys = await trustedHostKeys(host, port)
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    let sshReady = false
    let rejectedHostKey = false
    const finish = (result: SshConnectionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch { /* Connection may have failed before opening. */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish(sshReady
      ? { ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: '远端 CLI 检测超时' } }
      : { ok: false, ssh: { ok: false, message: 'SSH 连接超时，请检查服务器地址、网络和密码' } }), 30000)
    client.once('ready', () => {
      sshReady = true
      const command = `bash -lc ${shellQuote(`command -v ${shellQuote(executable)} >/dev/null 2>&1 && ${shellQuote(executable)} --version`)}`
      client.exec(command, (error, stream) => {
        if (error) {
          finish({ ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: error.message } })
          return
        }
        let output = ''
        stream.on('data', (chunk: Buffer) => { output = (output + String(chunk)).slice(-2048) })
        stream.stderr.on('data', (chunk: Buffer) => { output = (output + String(chunk)).slice(-2048) })
        stream.once('error', (error) => finish({ ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: error.message } }))
        stream.once('close', (code) => {
          const ok = code === 0
          if (ok && agent.protocol === 'acp-v1') {
            const acpCommand = `bash -lc ${shellQuote(`exec ${[executable, ...agent.args].map(shellQuote).join(' ')}`)}`
            client.exec(acpCommand, (acpError, acpStream) => {
              if (acpError) {
                finish({ ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: `ACP 启动失败：${acpError.message}` } })
                return
              }
              let responseBuffer = ''
              let acpStderr = ''
              acpStream.stderr.on('data', (chunk: Buffer) => { acpStderr = (acpStderr + String(chunk)).slice(-1024) })
              acpStream.once('error', (error) => finish({ ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: error.message } }))
              acpStream.on('data', (chunk: Buffer) => {
                responseBuffer += String(chunk)
                if (responseBuffer.length > 8192) {
                  finish({ ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: 'ACP 握手响应过长' } })
                  return
                }
                let newline = responseBuffer.indexOf('\n')
                while (newline >= 0 && !settled) {
                  const line = responseBuffer.slice(0, newline).trim()
                  responseBuffer = responseBuffer.slice(newline + 1)
                  try {
                    const response = JSON.parse(line) as { id?: number; result?: { protocolVersion?: number }; error?: { message?: string } }
                    if (response.id === 1) {
                      const supported = response.result?.protocolVersion === acp.PROTOCOL_VERSION
                      finish({
                        ok: supported,
                        ssh: { ok: true, message: 'SSH 登录成功' },
                        cli: { ok: supported, message: supported ? `${agent.name} ACP 握手成功` : response.error?.message || 'ACP 协议版本不匹配' }
                      })
                    }
                  } catch { /* Ignore non-JSON startup output until the ACP response arrives. */ }
                  newline = responseBuffer.indexOf('\n')
                }
              })
              acpStream.once('close', () => {
                if (!settled) finish({ ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: `ACP 未完成握手${acpStderr.trim() ? `：${acpStderr.trim().slice(-300)}` : ''}` } })
              })
              try {
                acpStream.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} } })}\n`)
              } catch (error) {
                finish({ ok: false, ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: error instanceof Error ? error.message : 'ACP 握手发送失败' } })
              }
            })
            return
          }
          finish({
            ok,
            ssh: { ok: true, message: 'SSH 登录成功' },
            cli: {
              ok,
              message: ok
                ? `${executable} 可启动${output.trim() ? ` · ${output.trim().split(/\r?\n/).slice(-1)[0]}` : ''}`
                : `${executable} 未找到或无法启动${output.trim() ? `：${output.trim().slice(-300)}` : ''}`
            }
          })
        })
      })
    })
    client.once('error', (error) => finish({
      ok: false,
      ...(sshReady
        ? { ssh: { ok: true, message: 'SSH 登录成功' }, cli: { ok: false, message: error.message } }
        : { ssh: { ok: false, message: rejectedHostKey ? '服务器主机密钥与本机记录不匹配，请检查服务器指纹' : error.message } })
    }))
    try {
      client.connect({
        host,
        port,
        username: user,
        password,
        readyTimeout: 10000,
        hostVerifier: (key) => {
          const trusted = keys.has(key.toString('base64'))
          if (!trusted) rejectedHostKey = true
          return trusted
        }
      })
    } catch (error) {
      finish({ ok: false, ssh: { ok: false, message: error instanceof Error ? error.message : 'SSH 连接失败' } })
    }
  })
}

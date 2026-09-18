import * as acp from '@agentclientprotocol/sdk'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { Client, ClientChannel, SFTPWrapper, Stats } from 'ssh2'
import { loadAgentSshPassword } from '../security/agent-ssh-password'
import type { WorkflowNodeConnection } from '../../preload/workflow-types'
import { AcpExternalAgentClient, createAcpWireTaps } from './acp-client'
import { openVerifiedSsh } from './ssh-connection'
import type { ExternalAgentDefinition, ExternalAgentProtocolEvent, ExternalAgentRunRequest, ExternalAgentRunResult } from './types'

const MAX_ARTIFACT_FILES = 500
const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function remoteCommand(command: string): string {
  return `bash -lc ${quote(command)}`
}

function execChannel(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => error ? reject(error) : resolve(channel))
  })
}

async function resolveRemoteCwd(client: Client, configured?: string): Promise<string> {
  const requested = configured?.trim()
  if (requested && (!path.posix.isAbsolute(requested) || requested.includes('\0')))
    throw new Error('远端工作目录必须是 Linux 绝对路径')
  const command = requested ? `cd -- ${quote(requested)} && pwd -P` : 'pwd -P'
  const channel = await execChannel(client, remoteCommand(command))
  return new Promise((resolve, reject) => {
    let output = ''
    let stderr = ''
    const timer = setTimeout(() => {
      channel.destroy()
      reject(new Error('读取远端工作目录超时'))
    }, 10000)
    channel.on('data', (chunk: Buffer) => { output = (output + String(chunk)).slice(-4096) })
    channel.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-1024) })
    channel.once('error', (error) => { clearTimeout(timer); reject(error) })
    channel.once('close', (code) => {
      clearTimeout(timer)
      const cwd = output.trim().split(/\r?\n/).at(-1) || ''
      if (code === 0 && path.posix.isAbsolute(cwd)) resolve(cwd)
      else reject(new Error(stderr.trim() || '远端工作目录不存在或不可访问'))
    })
  })
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => error ? reject(error) : resolve(sftp))
  })
}

function lstat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (error, stats) => error ? reject(error) : resolve(stats))
  })
}

function readdir(sftp: SFTPWrapper, remotePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, entries) => error ? reject(error) : resolve(entries.map(entry => entry.filename)))
  })
}

function fastGet(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => error ? reject(error) : resolve())
  })
}

function safeLocalPath(root: string, remoteRoot: string, remotePath: string): string {
  const relative = path.posix.relative(remoteRoot, remotePath)
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative))
    throw new Error(`产物不在远端工作目录内：${remotePath}`)
  const segments = relative.split('/').filter(Boolean).map(segment => segment.replace(/[<>:"\\|?*\x00-\x1f]/g, '_'))
  return path.join(root, ...segments)
}

async function downloadArtifacts(
  client: Client,
  text: string,
  remoteCwd: string,
  localCwd: string,
  runId: string,
  stepId: string,
  onProgress?: (detail: string) => Promise<void>
): Promise<string[]> {
  const declared = [...new Set(text.split(/\r?\n/)
    .map(line => line.match(/^ARTIFACT:\s*(.+)$/i)?.[1]?.trim())
    .filter((value): value is string => Boolean(value)))]
  if (!declared.length) return []
  const outputRoot = path.join(localCwd, 'remote-artifacts', runId.replace(/[^a-zA-Z0-9_-]/g, '_'), stepId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const sftp = await openSftp(client)
  let files = 0
  let bytes = 0
  const downloaded: string[] = []
  const seen = new Set<string>()
  const copy = async (remotePath: string): Promise<void> => {
    if (seen.has(remotePath)) return
    seen.add(remotePath)
    const stats = await lstat(sftp, remotePath)
    if (stats.isSymbolicLink()) throw new Error(`不复制符号链接：${remotePath}`)
    const localPath = safeLocalPath(outputRoot, remoteCwd, remotePath)
    if (stats.isDirectory()) {
      await fs.mkdir(localPath, { recursive: true })
      for (const name of await readdir(sftp, remotePath)) {
        if (name !== '.' && name !== '..') await copy(path.posix.join(remotePath, name))
      }
      return
    }
    if (!stats.isFile()) return
    files++
    bytes += stats.size
    if (files > MAX_ARTIFACT_FILES || bytes > MAX_ARTIFACT_BYTES)
      throw new Error('远端产物超过 500 个文件或 200 MB，请缩小输出范围')
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    const temporaryPath = `${localPath}.part`
    try {
      await fastGet(sftp, remotePath, temporaryPath)
      await fs.rename(temporaryPath, localPath)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
    downloaded.push(localPath)
    await onProgress?.(`已下载远端产物 ${files} 个文件`)
  }
  try {
    for (const declaredPath of declared) {
      const remotePath = path.posix.resolve(remoteCwd, declaredPath)
      await copy(remotePath)
    }
  } finally {
    sftp.end()
  }
  return downloaded
}

export async function runRemoteAcpPrompt(
  client: AcpExternalAgentClient,
  definition: ExternalAgentDefinition,
  request: ExternalAgentRunRequest,
  connection: WorkflowNodeConnection,
  runId: string,
  stepId: string,
  onUpdate?: (update: unknown) => void | Promise<void>,
  onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>,
  options?: { signal?: AbortSignal; onProgress?: (detail: string) => Promise<void> }
): Promise<ExternalAgentRunResult> {
  if (definition.protocol !== 'acp-v1') throw new Error(`${definition.name} 的 SSH 任务执行尚未接入，目前仅支持远端 CLI 检测`)
  if (!connection.passwordRef) throw new Error('SSH 节点缺少已保存的登录密码')
  const ssh = await openVerifiedSsh({ host: connection.host || '', user: connection.user || '', port: connection.port }, loadAgentSshPassword(connection.passwordRef), options?.signal)
  const onAbort = (): void => { ssh.end() }
  options?.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const remoteCwd = await resolveRemoteCwd(ssh, connection.remoteCwd)
    await options?.onProgress?.(`已连接远端工作目录 ${remoteCwd}`)
    const executable = definition.executable
    if (!executable || executable.startsWith('-') || !/^[a-zA-Z0-9._/-]+$/.test(executable))
      throw new Error('远端 ACP 命令无效')
    const command = remoteCommand(`cd -- ${quote(remoteCwd)} && exec ${[executable, ...definition.args].map(quote).join(' ')}`)
    const channel = await execChannel(ssh, command)
    let stderr = ''
    channel.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-2048) })
    const wireTaps = onProtocolEvent ? createAcpWireTaps(onProtocolEvent) : null
    if (wireTaps) {
      wireTaps.outbound.pipe(channel)
      channel.pipe(wireTaps.inbound)
      channel.once('error', (error) => wireTaps.inbound.destroy(error))
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(wireTaps?.outbound || channel) as WritableStream<Uint8Array>,
      Readable.toWeb(wireTaps?.inbound || channel) as ReadableStream<Uint8Array>
    )
    let result: ExternalAgentRunResult
    try {
      result = await client.runPrompt(definition, remoteCwd, request.prompt, onUpdate as any, onProtocolEvent, {
        customStream: stream,
        onDispose: () => { wireTaps?.outbound.destroy(); wireTaps?.inbound.destroy(); channel.destroy() },
        signal: options?.signal,
        model: request.model
      })
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `\n远端 CLI: ${stderr.trim()}` : ''}`)
    }
    try {
      result.artifactPaths = await downloadArtifacts(ssh, result.text, remoteCwd, request.cwd, runId, stepId, options?.onProgress)
    } catch (error) {
      throw new Error(`远端文件下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return result
  } finally {
    options?.signal?.removeEventListener('abort', onAbort)
    ssh.end()
  }
}

import * as acp from '@agentclientprotocol/sdk'
import { createHash } from 'node:crypto'
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

interface RemoteWorkspace {
  path: string
  home: string
  automatic: boolean
}

async function execText(client: Client, command: string, timeoutMessage: string): Promise<string> {
  const channel = await execChannel(client, remoteCommand(command))
  return new Promise((resolve, reject) => {
    let settled = false
    let output = ''
    let stderr = ''
    const finish = (error?: Error, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value || '')
    }
    const timer = setTimeout(() => {
      channel.destroy()
      finish(new Error(timeoutMessage))
    }, 10000)
    channel.on('data', (chunk: Buffer) => { output = (output + String(chunk)).slice(-4096) })
    channel.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-2048) })
    channel.once('error', (error) => finish(error))
    channel.once('close', (code) => {
      if (code === 0) finish(undefined, output.trim())
      else finish(new Error(stderr.trim() || `远端命令退出，代码 ${code ?? '未知'}`))
    })
  })
}

function workspaceName(localCwd: string): string {
  const resolved = path.resolve(localCwd)
  const base = path.basename(resolved)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'workspace'
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 8)
  return `${base}-${suffix}`
}

async function resolveRemoteCwd(client: Client, configured: string | undefined, localCwd: string): Promise<RemoteWorkspace> {
  const requested = configured?.trim()
  if (requested && (!path.posix.isAbsolute(requested) || requested.includes('\0')))
    throw new Error('远端工作目录必须是 Linux 绝对路径')
  const homeOutput = await execText(client, 'printf "%s\\n" "$HOME"', '读取远端用户目录超时')
  const home = homeOutput.split(/\r?\n/).at(-1)?.trim() || ''
  if (!path.posix.isAbsolute(home)) throw new Error('无法确定远端用户目录')

  if (requested) {
    const output = await execText(client, `cd -- ${quote(requested)} && pwd -P`, '读取远端工作目录超时')
    const resolved = output.split(/\r?\n/).at(-1)?.trim() || ''
    if (!path.posix.isAbsolute(resolved)) throw new Error('远端工作目录不存在或不可访问')
    return { path: resolved, home, automatic: false }
  }

  const generated = path.posix.join(home, '.agentpet', 'workspaces', workspaceName(localCwd))
  const output = await execText(client, `mkdir -p -- ${quote(generated)} && cd -- ${quote(generated)} && pwd -P`, '创建远端工作目录超时')
  const resolved = output.split(/\r?\n/).at(-1)?.trim() || ''
  if (!path.posix.isAbsolute(resolved)) throw new Error('自动创建远端工作目录失败')
  return { path: resolved, home, automatic: true }
}

function workspacePrompt(prompt: string, remoteCwd: string): string {
  return [
    'REMOTE WORKSPACE CONTRACT (mandatory):',
    `- The only workspace for this task is: ${remoteCwd}`,
    '- The ACP host may show a different default workspace. Ignore that default.',
    `- Before every shell or file operation, explicitly operate inside ${remoteCwd}.`,
    '- Do not inspect or modify ~/.openclaw/workspace or any unrelated project.',
    `- Keep every created or modified deliverable under ${remoteCwd}.`,
    '- Do not send the completion summary before tool calls. After the last tool call finishes, send a final summary.',
    '- In the final response, list each deliverable on its own line as: ARTIFACT: <absolute path>',
    '',
    prompt
  ].join('\n')
}

function completedWorkspaceLocations(update: acp.SessionUpdate, remoteCwd: string): string[] {
  const record = update as Record<string, unknown>
  if (record.sessionUpdate !== 'tool_call_update' || record.status !== 'completed' || !Array.isArray(record.locations)) return []
  return record.locations.flatMap((location) => {
    if (!location || typeof location !== 'object') return []
    const remotePath = (location as Record<string, unknown>).path
    if (typeof remotePath !== 'string' || !remotePath.trim()) return []
    const resolved = path.posix.resolve(remoteCwd, remotePath.trim())
    const relative = path.posix.relative(remoteCwd, resolved)
    return relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative) ? [] : [resolved]
  })
}

function findWorkspaceViolation(update: acp.SessionUpdate, workspace: RemoteWorkspace): string | undefined {
  if (!update || typeof update !== 'object') return undefined
  const record = update as Record<string, unknown>
  if (record.sessionUpdate !== 'tool_call' || typeof record.title !== 'string') return undefined
  const title = record.title
  const cdPattern = /\bcd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g
  for (const match of title.matchAll(cdPattern)) {
    const candidate = (match[1] || match[2] || match[3] || '').trim()
    if (!candidate || candidate === '.') continue
    const expanded = candidate === '~' ? workspace.home : candidate.startsWith('~/') ? path.posix.join(workspace.home, candidate.slice(2)) : candidate
    const resolved = path.posix.resolve(workspace.path, expanded)
    const relative = path.posix.relative(workspace.path, resolved)
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return candidate
  }
  return undefined
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
  const segments = relative
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      [...segment].map((character) => (character.charCodeAt(0) < 32 || /[<>:"\\|?*]/.test(character) ? '_' : character)).join('')
    )
  return path.join(root, ...segments)
}

async function downloadArtifacts(
  client: Client,
  text: string,
  observedPaths: Iterable<string>,
  remoteCwd: string,
  localCwd: string,
  runId: string,
  stepId: string,
  onProgress?: (detail: string) => Promise<void>
): Promise<string[]> {
  const declared = [...new Set([
    ...text.split(/\r?\n/)
      .map(line => line.match(/^ARTIFACT:\s*(.+)$/i)?.[1]?.trim())
      .filter((value): value is string => Boolean(value)),
    ...observedPaths
  ])]
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
    const workspace = await resolveRemoteCwd(ssh, connection.remoteCwd, request.cwd)
    const remoteCwd = workspace.path
    await options?.onProgress?.(`${workspace.automatic ? '已自动创建并连接' : '已连接'}远端工作目录 ${remoteCwd}`)
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
    let updateSequence = 0
    let lastAgentMessageSequence = -1
    let lastToolSequence = -1
    let sawToolCall = false
    const observedArtifactPaths = new Set<string>()
    try {
      const guardedUpdate = async (update: acp.SessionUpdate): Promise<void> => {
        updateSequence++
        const record = update as Record<string, unknown>
        if (record.sessionUpdate === 'agent_message_chunk') {
          const content = record.content as Record<string, unknown> | undefined
          if (content?.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
            lastAgentMessageSequence = updateSequence
          }
        }
        if (record.sessionUpdate === 'tool_call' || record.sessionUpdate === 'tool_call_update') {
          sawToolCall = true
          lastToolSequence = updateSequence
        }
        for (const artifactPath of completedWorkspaceLocations(update, remoteCwd)) observedArtifactPaths.add(artifactPath)
        const violation = findWorkspaceViolation(update, workspace)
        if (violation) throw new Error(`OpenClaw 尝试离开指定远端工作目录：${violation}（要求：${remoteCwd}）`)
        await onUpdate?.(update)
      }
      result = await client.runPrompt(definition, remoteCwd, workspacePrompt(request.prompt, remoteCwd), guardedUpdate, onProtocolEvent, {
        customStream: stream,
        onDispose: () => { wireTaps?.outbound.destroy(); wireTaps?.inbound.destroy(); channel.destroy() },
        signal: options?.signal,
        model: request.model
      })
      if (sawToolCall && lastAgentMessageSequence <= lastToolSequence) {
        throw new Error(`OpenClaw 在工具调用后未返回最终结果（stopReason: ${result.stopReason || 'unknown'}），将从远端工作区继续重试`)
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `\n远端 CLI: ${stderr.trim()}` : ''}`)
    }
    try {
      result.artifactPaths = await downloadArtifacts(ssh, result.text, observedArtifactPaths, remoteCwd, request.cwd, runId, stepId, options?.onProgress)
    } catch (error) {
      throw new Error(`远端文件下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return result
  } finally {
    options?.signal?.removeEventListener('abort', onAbort)
    ssh.end()
  }
}

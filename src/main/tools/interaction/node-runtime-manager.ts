import { app, BrowserWindow, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import { dirname, join, resolve } from 'path'

import JSZip from 'jszip'

import { buildManagedNodeEnvironment, type ManagedNodeRuntimeInfo } from './node-runtime-environment'

const NODE_VERSION = process.versions.node
const NODE_ARCHIVE_NAME = `node-v${NODE_VERSION}-win-x64`
const NODE_DOWNLOAD_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE_NAME}.zip`

interface PendingRequest {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  sessionId?: string
}

interface InstallEventContext {
  requestId: number
  sessionId?: string
  messageId?: number
  target: BrowserWindow
}

function runtimeInfo(): ManagedNodeRuntimeInfo {
  const rootDir = join(app.getPath('userData'), 'runtimes', 'node-runtime')
  const nodeDir = join(rootDir, NODE_ARCHIVE_NAME)
  return {
    rootDir,
    nodeDir,
    nodePath: join(nodeDir, 'node.exe'),
    npmPath: join(nodeDir, 'npm.cmd'),
    prefixDir: join(nodeDir, 'agentpet-packages'),
    cacheDir: join(rootDir, 'npm-cache'),
    nodeVersion: NODE_VERSION
  }
}

function sendInstallEvent(
  context: InstallEventContext,
  type: 'office_runtime_progress' | 'office_runtime_complete' | 'office_runtime_error',
  detail: string,
  progress: number
): void {
  if (context.target.isDestroyed()) return
  context.target.webContents.send('api:llm-tool-event', {
    type,
    requestId: context.requestId,
    detail,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    timestamp: Date.now(),
    messageId: context.messageId,
    sessionId: context.sessionId
  })
}

async function downloadBuffer(
  url: string,
  signal: AbortSignal | undefined,
  onProgress: (ratio: number) => void
): Promise<Buffer> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）：${url}`)
  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.byteLength
    if (total > 0) onProgress(received / total)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

async function extractArchive(archiveBytes: Buffer, rootDir: string): Promise<void> {
  const archive = await JSZip.loadAsync(archiveBytes)
  const destinationRoot = resolve(rootDir)
  for (const entry of Object.values(archive.files)) {
    const normalizedName = entry.name.replace(/\\/g, '/')
    const target = resolve(rootDir, normalizedName)
    if (target !== destinationRoot && !target.startsWith(`${destinationRoot}\\`)) {
      throw new Error(`Node 压缩包包含非法路径：${entry.name}`)
    }
    if (entry.dir) {
      await fs.promises.mkdir(target, { recursive: true })
      continue
    }
    await fs.promises.mkdir(dirname(target), { recursive: true })
    await fs.promises.writeFile(target, await entry.async('nodebuffer'))
  }
}

async function validateRuntime(info: ManagedNodeRuntimeInfo): Promise<boolean> {
  if (!fs.existsSync(info.nodePath) || !fs.existsSync(info.npmPath)) return false
  return await new Promise(resolvePromise => {
    const child = spawn(info.nodePath, ['--version'], {
      cwd: info.nodeDir,
      windowsHide: true,
      shell: false,
      env: buildManagedNodeEnvironment(info),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill(), 15_000)
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise(false)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise(code === 0 && output.trim() === `v${info.nodeVersion}`)
    })
  })
}

class NodeRuntimeManager {
  private pending = new Map<number, PendingRequest>()
  // Keep ids disjoint from the Python runtime manager while sharing the generic runtime card.
  private nextRequestId = 1_000_000
  private installPromise: Promise<ManagedNodeRuntimeInfo> | null = null

  constructor() {
    ipcMain.on('api:node-runtime-response', (_event, data) => {
      const requestId = Number(data?.requestId)
      const pending = this.pending.get(requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve(Boolean(data?.approved))
    })
  }

  public async ensure(
    context: { sessionId?: string; messageId?: number; event?: { sender: WebContents }; abortSignal?: AbortSignal }
  ): Promise<ManagedNodeRuntimeInfo> {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('当前 AgentPet Node 运行环境暂仅支持 Windows x64')
    }
    const info = runtimeInfo()
    if (await validateRuntime(info)) return info

    const target = context.event?.sender
      ? BrowserWindow.fromWebContents(context.event.sender)
      : BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!target || target.isDestroyed()) throw new Error('无法显示 AgentPet Node 运行环境安装卡片')

    const requestId = this.nextRequestId++
    const approved = await new Promise<boolean>(resolvePromise => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolvePromise(false)
      }, 10 * 60 * 1000)
      this.pending.set(requestId, { resolve: resolvePromise, timer, sessionId: context.sessionId })
      target.webContents.send('api:llm-tool-event', {
        type: 'office_runtime_request',
        requestId,
        request: {
          title: '安装 AgentPet Node 运行环境',
          description: '供 AgentPet 执行 Node.js 脚本及安装脚本依赖。运行时、npm 包与缓存均位于 AgentPet 独立目录，不修改系统 Node。',
          downloadSize: '预计下载 30–40 MB，基础运行时约占用 80–120 MB',
          installPath: info.rootDir
        },
        timestamp: Date.now(),
        messageId: context.messageId,
        sessionId: context.sessionId
      })
    })
    if (!approved) throw new Error('NODE_RUNTIME_INSTALL_CANCELLED: 用户取消了 AgentPet Node 运行环境安装')

    const eventContext = { requestId, sessionId: context.sessionId, messageId: context.messageId, target }
    if (!this.installPromise) {
      this.installPromise = this.install(info, eventContext, context.abortSignal).finally(() => {
        this.installPromise = null
      })
    }
    return await this.installPromise
  }

  public environment(info: ManagedNodeRuntimeInfo): NodeJS.ProcessEnv {
    return buildManagedNodeEnvironment(info)
  }

  public cancelPending(sessionId?: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (sessionId && pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve(false)
    }
  }

  private async install(
    info: ManagedNodeRuntimeInfo,
    eventContext: InstallEventContext,
    signal?: AbortSignal
  ): Promise<ManagedNodeRuntimeInfo> {
    try {
      sendInstallEvent(eventContext, 'office_runtime_progress', '正在准备 Node 隔离目录', 3)
      await fs.promises.mkdir(dirname(info.rootDir), { recursive: true })
      if (fs.existsSync(info.rootDir)) await fs.promises.rm(info.rootDir, { recursive: true, force: true })
      await fs.promises.mkdir(info.rootDir, { recursive: true })

      sendInstallEvent(eventContext, 'office_runtime_progress', '正在下载 AgentPet Node 运行环境', 8)
      const archive = await downloadBuffer(NODE_DOWNLOAD_URL, signal, ratio => {
        sendInstallEvent(eventContext, 'office_runtime_progress', `正在下载 Node（${Math.round(ratio * 100)}%）`, 8 + ratio * 65)
      })
      sendInstallEvent(eventContext, 'office_runtime_progress', '正在解压并配置 Node/npm', 76)
      await extractArchive(archive, info.rootDir)
      await Promise.all([
        fs.promises.mkdir(info.prefixDir, { recursive: true }),
        fs.promises.mkdir(info.cacheDir, { recursive: true })
      ])
      await fs.promises.writeFile(join(info.rootDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        nodeVersion: info.nodeVersion,
        source: NODE_DOWNLOAD_URL,
        prefixDir: info.prefixDir,
        installedAt: new Date().toISOString()
      }, null, 2), 'utf8')
      if (!(await validateRuntime(info))) throw new Error('Node 运行环境安装后验证失败')
      sendInstallEvent(eventContext, 'office_runtime_complete', 'AgentPet Node 运行环境安装完成', 100)
      return info
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[NodeRuntime] AgentPet Node 运行环境安装失败：', message)
      sendInstallEvent(eventContext, 'office_runtime_error', 'AgentPet Node 运行环境安装失败，请检查网络连接后重试', 100)
      throw new Error('AgentPet Node 运行环境安装失败，请检查网络连接后重试')
    }
  }
}

export const nodeRuntimeManager = new NodeRuntimeManager()

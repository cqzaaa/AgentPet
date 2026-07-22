import { app, shell, BrowserWindow, ipcMain, screen, protocol, net, Tray, Menu, dialog, Notification, session, clipboard, nativeImage, desktopCapturer, globalShortcut } from 'electron'
import { join, basename, dirname, extname } from 'path'
import { registerMemoryAPIs, getLastCleanupTime } from './api/memory'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as fs from 'fs'
import * as os from 'os'
import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'
import { EdgeTTS } from 'node-edge-tts'
import JSZip from 'jszip'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import * as Papa from 'papaparse'
import ExcelJS from 'exceljs'

const ATTACHMENT_TEXT_PREVIEW_LIMIT = 30000

function limitAttachmentTextPreview(content: string): string {
  if (content.length <= ATTACHMENT_TEXT_PREVIEW_LIMIT) return content
  return `${content.slice(0, ATTACHMENT_TEXT_PREVIEW_LIMIT)}\n\n[附件文本预读已截断：原文共 ${content.length} 个字符，仅保留前 ${ATTACHMENT_TEXT_PREVIEW_LIMIT} 个字符。需要完整内容时请使用文件工具分段读取；需要版式转换时请使用 Office PDF 转换工具。]`
}

import { toolRegistry } from './tools/core/tool-registry'
import { registerBuiltinTools } from './tools/builtin'
import { mcpManager } from './tools/mcp/mcp-manager'
import { permissionManager } from './tools/security/permission-manager'
import { clarificationManager } from './tools/interaction/clarification-manager'
import { credentialManager } from './tools/interaction/credential-manager'
import { officeRuntimeManager } from './tools/interaction/office-runtime-manager'
import { sshManager } from './tools/builtin/terminal/ssh-manager'
import { AgentExecutor } from './agent-runtime'
import { ModelRuntimeFactory } from './model-runtime'





// 限制单实例运行，防止重复打开导致多个托盘图标和数据库占用冲突
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
  process.exit(0)
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    if (agentWindow && !agentWindow.isDestroyed()) {
      if (agentWindow.isMinimized()) agentWindow.restore()
      agentWindow.show()
      agentWindow.focus()
    }
  })
}

// 强制使用 Electron 的 net.fetch 代理 Node 的全局 fetch，以继承系统/代理工具（如 Clash/V2ray）的代理设置
// 解决 MCP SDK 或内部请求抛出 fetch failed: ECONNRESET 的问题
globalThis.fetch = net.fetch as any;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 本地环境变量 .env 极简解析加载器
try {
  const envFile = join(process.cwd(), '.env')
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8')
    content.split(/\r?\n/).forEach(line => {
      // 过滤注释和空白
      if (line.trim().startsWith('#')) return
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/)
      if (match) {
        const key = match[1]
        let value = match[2] || ''
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
        process.env[key] = value.trim()
      }
    })
    console.log('[Env] 本地环境变量 .env 加载成功')
  }
} catch (e) {
  console.error('[Env] 读取本地 .env 失败', e)
}

// ---------------------------------------------------------
// [自定义数据存储目录]
// 1. 优先读取 .env 或系统环境变量中的 USER_DATA_PATH
// 2. 否则，如果是打包后的应用，尝试在 exe 同级目录下创建/使用 data 文件夹（便携模式，避免占用 C 盘）
// ---------------------------------------------------------
if (process.env.USER_DATA_PATH) {
  app.setPath('userData', process.env.USER_DATA_PATH)
  console.log('[DataPath] 使用环境变量自定义目录:', process.env.USER_DATA_PATH)
} else if (app.isPackaged) {
  const exeDir = dirname(app.getPath('exe'))
  const portableDataPath = join(exeDir, 'data')
  try {
    if (!fs.existsSync(portableDataPath)) {
      fs.mkdirSync(portableDataPath, { recursive: true })
    }
    app.setPath('userData', portableDataPath)
    console.log('[DataPath] 启用便携模式，数据存储于:', portableDataPath)
  } catch (e) {
    console.warn('[DataPath] 无法在安装目录创建 data 文件夹(可能无权限)，退回默认 AppData 目录:', e)
  }
}

import { WechatBotManager } from './wechatBot'
import * as rpaStorage from './rpa/rpaStorage'
import { PlaywrightRpaExecutor } from './rpa/playwrightExecutor'
import { RpaElementPicker } from './rpa/rpaElementPicker'
import { RpaBrowserRecorder } from './rpa/rpaBrowserRecorder'
import { captureDesktopTarget, focusDesktopWindow, listDesktopWindows, showWindowsDesktop } from './rpa/rpaDesktopPicker'
import { startDesktopRecording } from './rpa/rpaDesktopRecorder'
import { createRecordingController } from './rpa/rpaRecordingController'
import { createRpaRunController } from './rpa/rpaRunController'
import { getRpaSecretService } from './rpa/security/rpa-secret-service-provider'
import type { RpaSecretRef, RpaSurface } from './rpa/domain/types'
import {
  loadSecureSystemLlmConfig,
  sanitizeSystemLlmConfig,
  saveSecureSystemLlmConfig
} from './security/secure-llm-config'
import { DEFAULT_LLM_CONFIG, type RuntimeLlmConfig } from './security/llm-config-store'
import {
  clearPaddleOcrToken,
  hasPaddleOcrToken,
  setPaddleOcrToken
} from './security/paddle-ocr-token'

let wechatBotManager: WechatBotManager | null = null
let systemLlmConfig: RuntimeLlmConfig = { ...DEFAULT_LLM_CONFIG }
let systemMcpConfig: any = { servers: [] }
let isRpaRecordingActive = false
let activeRpaRecordingController: Awaited<ReturnType<typeof createRecordingController>> | null = null
const activeRpaRunControllers = new Map<string, Awaited<ReturnType<typeof createRpaRunController>>>()

function loadSystemLlmConfig() {
  try {
    systemLlmConfig = loadSecureSystemLlmConfig()
    if (systemLlmConfig.secretMigrationPending) {
      console.warn('[Secrets] System LLM credential migration is pending because OS encryption is unavailable')
    }
  } catch (e) {
    console.error('[Secrets] Failed to load the system LLM configuration', e)
  }
}

// 提高 Windows 下透明窗口和 Live2D WebGL 渲染的稳定性，防止 GPU 进程 TDR 崩溃或睡眠后唤醒黑屏
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('use-angle', 'd3d11')
// 已移除 `--expose-gc` 和 `--max-old-space-size`，以防 Electron 渲染进程中 PixiJS 启动时因 GC 启发式算法改变而导致 OOM崩溃。
// 限制 HTTP 缓存和媒体缓存的大小，防止内存长期驻留过大缓存
app.commandLine.appendSwitch('disk-cache-size', '1048576')
app.commandLine.appendSwitch('media-cache-size', '1048576')

// 自定义协议必须在 app.whenReady 之前注册！
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'live2d',
    privileges: {
      standard: true,    // 将 live2d:// 当作标准 URL，支持相对路径
      secure: true,      // 当作安全来源，与 https 等价
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: 'wechat-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
      stream: true
    }
  }
])

function trimPhysicalMemory(): void {
  // Disabled to prevent native crashes
}

function runImmediateGarbageCollection(): void {
  // Disabled to prevent native crashes
}

// 窗口尺寸
const winWidth = 260
const winHeight = 300
const windowsAppUserModelId = 'com.electron.app'

let agentWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let rpaScheduleTimer: NodeJS.Timeout | null = null
let isCheckingRpaSchedules = false

function isRpaScheduleDue(task: rpaStorage.RpaTaskManifest, now: Date): boolean {
  if (task.enabled === false || !task.schedule || task.schedule.type === 'manual') return false
  const lastRunAt = task.lastScheduledRunAt ? new Date(task.lastScheduledRunAt).getTime() : 0

  if (task.schedule.type === 'interval') {
    const intervalMinutes = Math.max(1, Number(task.schedule.intervalMinutes) || 60)
    const baseline = lastRunAt || new Date(task.createdAt || now.toISOString()).getTime()
    return Number.isFinite(baseline) && now.getTime() - baseline >= intervalMinutes * 60_000
  }

  const [hour, minute] = String(task.schedule.dailyTime || '09:00').split(':').map(Number)
  const target = new Date(now)
  target.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0)
  return now.getTime() >= target.getTime() && lastRunAt < target.getTime()
}

async function runDueRpaSchedules(): Promise<void> {
  if (isCheckingRpaSchedules || !agentWindow || agentWindow.isDestroyed()) return
  isCheckingRpaSchedules = true
  try {
    const now = new Date()
    const tasks = await rpaStorage.loadManifest()
    for (const task of tasks) {
      if (!isRpaScheduleDue(task, now) || PlaywrightRpaExecutor.getActive(task.id)) continue
      const flow = await rpaStorage.loadTaskFlow(task.id)
      if (!flow) {
        await rpaStorage.updateManifestTask(task.id, { lastRunStatus: 'failed', lastRunTime: now.toLocaleString() })
        continue
      }
      await rpaStorage.updateManifestTask(task.id, {
        lastScheduledRunAt: now.toISOString(),
        lastRunStatus: 'running'
      })
      try {
        await PlaywrightRpaExecutor.run(task.id, flow.nodes, flow.edges, agentWindow.webContents)
      } catch (error) {
        console.error(`[RPA Scheduler] 启动任务 ${task.id} 失败`, error)
        await rpaStorage.updateManifestTask(task.id, { lastRunStatus: 'failed', lastRunTime: new Date().toLocaleString() })
      }
    }
  } finally {
    isCheckingRpaSchedules = false
  }
}

function startRpaScheduleMonitor(): void {
  if (rpaScheduleTimer) clearInterval(rpaScheduleTimer)
  setTimeout(() => void runDueRpaSchedules(), 15_000)
  rpaScheduleTimer = setInterval(() => void runDueRpaSchedules(), 30_000)
}
let inputWindow: BrowserWindow | null = null
const quickChatWidth = 520
let agentHiddenForQuickChat = false
let petWidgetReady = false
let pendingPetChat: { text: string; isNewSession?: boolean; imagePath?: string } | null = null
let pendingAgentInput: string = '' // 缓存快捷输入框传递过来的待发送文本
let tray: Tray | null = null
let customModelDir = ''
const activeNotifications = new Set<Notification>()
let customModelFile = ''

let screenshotWindows: BrowserWindow[] = []
const screenshotMap = new Map<string, string>()

async function startScreenshot(): Promise<void> {
  closeScreenshotWindows()

  // 立即显示快捷输入窗口（如果未创建则创建之）
  if (!inputWindow || inputWindow.isDestroyed()) {
    createInputWindow()
  } else {
    if (inputWindow.isMinimized()) inputWindow.restore()
    inputWindow.show()
  }

  // 临时隐藏快捷输入窗口，避免其遮挡截图画面
  if (inputWindow && !inputWindow.isDestroyed()) {
    inputWindow.hide()
  }

  const displays = screen.getAllDisplays()

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(...displays.map(d => d.bounds.width * d.scaleFactor)),
        height: Math.max(...displays.map(d => d.bounds.height * d.scaleFactor))
      }
    })

    screenshotMap.clear()

    for (const display of displays) {
      let source = sources.find(s => s.display_id === display.id.toString())
      if (!source) {
        const index = displays.indexOf(display)
        if (index < sources.length) {
          source = sources[index]
        }
      }

      if (source) {
        screenshotMap.set(display.id.toString(), source.thumbnail.toDataURL())
      }
    }

    for (const display of displays) {
      const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        fullscreen: process.platform !== 'darwin',
        enableLargerThanScreen: true,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          sandbox: false
        }
      })

      win.setMenu(null)

      const screenshotUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
        ? `${process.env['ELECTRON_RENDERER_URL']}/#/screenshot?displayId=${display.id}&scaleFactor=${display.scaleFactor}&width=${display.bounds.width}&height=${display.bounds.height}`
        : `${pathToFileURL(join(__dirname, '../renderer/index.html')).toString()}#/screenshot?displayId=${display.id}&scaleFactor=${display.scaleFactor}&width=${display.bounds.width}&height=${display.bounds.height}`

      win.loadURL(screenshotUrl)

      win.on('ready-to-show', () => {
        win.show()
        win.focus()
      })

      screenshotWindows.push(win)
    }
  } catch (err) {
    console.error('Failed to capture screen:', err)
  }
}

function closeScreenshotWindows(): void {
  for (const win of screenshotWindows) {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
  screenshotWindows = []
}

async function saveBase64ImageInternal(dataUrl: string): Promise<{ path: string; name: string } | null> {
  try {
    const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!matches) return null
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1]
    const base64Data = matches[2]
    const buffer = Buffer.from(base64Data, 'base64')
    const tempDir = join(os.tmpdir(), 'agentpet_clipboard')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    const fileName = `clipboard_${Date.now()}.${ext}`
    const filePath = join(tempDir, fileName)
    await fs.promises.writeFile(filePath, buffer)
    return { path: filePath, name: fileName }
  } catch (e: any) {
    console.error('保存图片失败:', e)
    return null
  }
}
const activeLlmAbortControllers = new Map<string, AbortController>()
const abortedSessionIds = new Set<string>()
// 跟踪每个会话最近上传的 xlsx 文件，用于 generate_file 时自动复制数据验证
const sessionLastXlsxMap: Map<string, string> = new Map()

async function copyFolderRecursive(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(src)) return
  await fs.promises.mkdir(dest, { recursive: true })
  const entries = await fs.promises.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyFolderRecursive(srcPath, destPath)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

function createAgentWindow(openParams?: { taskId: string; logId: string }): void {
  // 打开 Agent 窗口时自动关闭虚拟体和快捷输入窗口，释放渲染进程和 Live2D GPU 资源
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
  }
  if (inputWindow && !inputWindow.isDestroyed()) {
    inputWindow.close()
  }

  if (agentWindow) {
    showAgentWindow(agentWindow)
    if (openParams) {
      agentWindow.webContents.send('api:open-cron-log-details', openParams.taskId, openParams.logId)
    }
    return
  }

  agentWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    frame: false,
    resizable: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      plugins: true
    }
  })

  // 禁用默认菜单栏
  agentWindow.setMenu(null)

  let agentUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}/#/agent`
    : `${pathToFileURL(join(__dirname, '../renderer/index.html')).toString()}#/agent`

  if (openParams) {
    agentUrl += `?openTaskId=${openParams.taskId}&openLogId=${openParams.logId}`
  }

  agentWindow.loadURL(agentUrl)

  // 让链接在系统浏览器中打开，而不是弹出新窗口
  agentWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  agentWindow.on('ready-to-show', () => {
    if (agentWindow && !agentWindow.isDestroyed()) {
      showAgentWindow(agentWindow)
    }
    // 窗口就绪后，如果有待投递的通知则发送（数据在 localStorage 中）
    if (pendingAgentInput && agentWindow && !agentWindow.isDestroyed()) {
      agentWindow.webContents.send('pending-input')
      pendingAgentInput = ''
    }
  })

  agentWindow.on('closed', () => {
    agentWindow = null
    runImmediateGarbageCollection()
  })
}

// 注册 Agent 窗口控制 IPC 监听
ipcMain.on('minimize-agent-window', () => {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.minimize()
  }
})

ipcMain.on('maximize-agent-window', () => {
  if (agentWindow && !agentWindow.isDestroyed()) {
    if (agentWindow.isMaximized()) {
      agentWindow.unmaximize()
    } else {
      agentWindow.maximize()
    }
  }
})

ipcMain.on('close-agent-window', () => {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.hide()
  }
})

ipcMain.handle('api:is-agent-window-maximized', () => {
  if (agentWindow && !agentWindow.isDestroyed()) {
    return agentWindow.isMaximized()
  }
  return false
})


function createInputWindow(x?: number, y?: number, initialImage?: { path: string; base64: string; width: number; height: number }): void {
  if (agentWindow && !agentWindow.isDestroyed() && agentWindow.isVisible()) {
    agentWindow.hide()
    agentHiddenForQuickChat = true
  }

  if (inputWindow) {
    if (inputWindow.isMinimized()) inputWindow.restore()
    if (x !== undefined && y !== undefined) {
      inputWindow.setBounds({ x, y, width: quickChatWidth, height: 90 })
    }
    inputWindow.focus()
    if (initialImage) {
      inputWindow.webContents.send('api:set-screenshot-image', initialImage)
    }
    return
  }

  let targetX = x
  let targetY = y

  if (targetX === undefined || targetY === undefined) {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: scrWidth, height: scrHeight } = primaryDisplay.workArea
    targetX = Math.round(scrWidth / 2 - quickChatWidth / 2)
    targetY = Math.round(scrHeight * 0.22)
  }

  inputWindow = new BrowserWindow({
    width: quickChatWidth,
    height: 90,
    x: targetX,
    y: targetY,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  inputWindow.setMenu(null)

  const inputUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}/#/chat-input`
    : `${pathToFileURL(join(__dirname, '../renderer/index.html')).toString()}#/chat-input`

  inputWindow.loadURL(inputUrl)

  inputWindow.on('ready-to-show', () => {
    inputWindow?.show()
    inputWindow?.focus()
    if (initialImage) {
      setTimeout(() => {
        if (inputWindow && !inputWindow.isDestroyed()) {
          inputWindow.webContents.send('api:set-screenshot-image', initialImage)
        }
      }, 150)
    }
  })

  inputWindow.on('closed', () => {
    inputWindow = null
    if (agentHiddenForQuickChat && agentWindow && !agentWindow.isDestroyed()) {
      agentHiddenForQuickChat = false
      showAgentWindow(agentWindow)
    } else {
      agentHiddenForQuickChat = false
    }
    runImmediateGarbageCollection()
  })
}

function showOrCreateMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

function createTray(): void {
  if (tray) return
  tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示虚拟体',
      click: () => {
        showOrCreateMainWindow()
      }
    },
    {
      label: '快捷聊天',
      click: () => {
        createInputWindow()
      }
    },
    {
      label: '打开窗口',
      click: () => {
        createAgentWindow()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])
  tray.setToolTip('agentpet')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    createAgentWindow()
  })
}

let ipcWindowHandlersRegistered = false

function showAgentWindow(win: BrowserWindow): void {
  const wasAlwaysOnTop = win.isAlwaysOnTop()
  let restoredAlwaysOnTop = false

  const restoreAlwaysOnTop = (): void => {
    if (restoredAlwaysOnTop || win.isDestroyed()) return
    restoredAlwaysOnTop = true
    win.setAlwaysOnTop(wasAlwaysOnTop)
  }

  const activate = (forceTop = false): void => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.setFocusable(true)
    if (!win.isVisible()) win.show()
    if (forceTop) win.setAlwaysOnTop(true)
    win.show()
    win.moveTop()
    win.focus()
    app.focus({ steal: true })
  }

  activate(true)
  setTimeout(() => activate(true), 80)
  setTimeout(() => {
    activate(true)
    restoreAlwaysOnTop()
  }, 320)
  setTimeout(restoreAlwaysOnTop, 1000)
}

function createWindow(): void {
  petWidgetReady = false
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: scrWidth, height: scrHeight } = primaryDisplay.workArea

  // 默认靠右下角
  const defaultX = scrWidth - winWidth - 20
  const defaultY = scrHeight - winHeight - 20

  // Create the browser window.
  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: defaultX,
    y: defaultY,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      plugins: true
    }
  })

  mainWindow = win

  win.webContents.on('did-start-loading', () => {
    petWidgetReady = false
  })

  win.on('closed', () => {
    mainWindow = null
    petWidgetReady = false
    runImmediateGarbageCollection()
  })

  win.on('ready-to-show', () => {
    win.show()
    // 初始开启穿透，直到鼠标移动到宠物元素上
    win.setIgnoreMouseEvents(true, { forward: true })
    if (!is.dev) {
      win.webContents.openDevTools({ mode: 'detach' })
    }

    // 启动 3 秒后自动执行一次即时垃圾回收和内存修剪
    // 清除启动初始化阶段（模块加载、Live2D 纹理载入等）产生的大量临时内存垃圾
    setTimeout(() => {
      runImmediateGarbageCollection()
    }, 3000)
  })

  win.on('blur', () => {
    win.webContents.send('window-blur')
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // IPC 监听只注册一次，防止窗口重建时重复注册导致崩溃
  if (!ipcWindowHandlersRegistered) {
    ipcWindowHandlersRegistered = true

    // 注册窗口拖动 IPC 监听
    ipcMain.on('start-drag', () => {
      // 拖拽开始，无需特殊处理
    })

    ipcMain.on('move-window', (event, dx: number, dy: number) => {
      const targetWin = BrowserWindow.fromWebContents(event.sender)
      if (targetWin) {
        const [x, y] = targetWin.getPosition()
        targetWin.setPosition(x + dx, y + dy)
      }
    })

    ipcMain.on('end-drag', () => {
      // 拖拽结束，无需边缘贴合半隐藏逻辑
    })
    ipcMain.on('set-ignore-mouse-events', (_, ignore: boolean, options?: { forward: boolean }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setIgnoreMouseEvents(ignore, options)
      }
    })

    ipcMain.on('set-window-size', (event, width: number, height: number, anchor?: 'bottom' | 'top') => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) {
        const [oldW, oldH] = win.getSize()
        const [oldX, oldY] = win.getPosition()
        const newW = Math.round(width)
        const newH = Math.round(height)

        let newX = oldX
        let newY = oldY

        if (anchor === 'top') {
          // 保持顶部中心点不变
          newX = Math.round((oldX + oldW / 2) - newW / 2)
          newY = oldY
        } else {
          // 默认保持底部中心点不变 (适合桌宠)
          newX = Math.round((oldX + oldW / 2) - newW / 2)
          newY = Math.round((oldY + oldH) - newH)
        }

        win.setBounds({
          x: newX,
          y: newY,
          width: newW,
          height: newH
        })
      }
    })

    ipcMain.on('open-agent-window', () => {
      createAgentWindow()
    })

    // 转发快捷聊天窗口发出的会话更新通知到 Agent 窗口
    ipcMain.on('api:wechat-session-updated', (_, sessionId?: string) => {
      if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.webContents.send('api:wechat-session-updated', sessionId)
      }
    })

    ipcMain.on('hide-window', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close()
      }
      if (inputWindow && !inputWindow.isDestroyed()) {
        inputWindow.close()
      }
    })

    ipcMain.on('open-input-window', () => {
      createInputWindow()
    })

    ipcMain.on('close-input-window', () => {
      if (inputWindow && !inputWindow.isDestroyed()) {
        inputWindow.close()
      }
    })

    const deliverPendingPetChat = (): void => {
      if (!pendingPetChat || !petWidgetReady || !mainWindow || mainWindow.isDestroyed()) return
      const request = pendingPetChat
      pendingPetChat = null
      mainWindow.webContents.send('chat-to-pet', request.text, request.isNewSession, request.imagePath)
    }

    ipcMain.on('pet-widget-ready', (event) => {
      if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return
      petWidgetReady = true
      deliverPendingPetChat()
    })

    ipcMain.on('send-chat-to-pet', (_, text: string, isNewSession?: boolean, imagePath?: string) => {
      pendingPetChat = { text, isNewSession, imagePath }
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
      deliverPendingPetChat()
    })

    // 截图相关 IPC 通信注册
    ipcMain.on('api:start-screenshot', () => {
      startScreenshot()
    })

    ipcMain.handle('api:get-screenshot-by-display-id', (_, displayId: string) => {
      return screenshotMap.get(displayId) || ''
    })

    ipcMain.on('api:cancel-screenshot', () => {
      closeScreenshotWindows()
      // 取消截图时重新显示快捷输入窗口
      if (inputWindow && !inputWindow.isDestroyed()) {
        inputWindow.show()
        inputWindow.focus()
      }
    })

    ipcMain.on('api:complete-screenshot', async (_, croppedBase64: string, bounds: { x: number; y: number; width: number; height: number }) => {
      closeScreenshotWindows()

      let imagePath = ''
      try {
        const result = await saveBase64ImageInternal(croppedBase64)
        if (result) {
          imagePath = result.path
        }
      } catch (err) {
        console.error('Failed to save screenshot image:', err)
      }

      if (!imagePath) return

      // 计算快捷窗口的最佳显示坐标 (400x90 规格，贴合屏幕安全距离)
      const inputWidth = quickChatWidth
      const inputHeight = 90
      let targetX = bounds.x + (bounds.width - inputWidth) / 2
      let targetY = bounds.y + bounds.height + 10

      const activeDisplay = screen.getDisplayMatching(bounds)
      const workArea = activeDisplay.workArea

      if (targetX < workArea.x) {
        targetX = workArea.x + 10
      } else if (targetX + inputWidth > workArea.x + workArea.width) {
        targetX = workArea.x + workArea.width - inputWidth - 10
      }

      if (targetY + inputHeight > workArea.y + workArea.height) {
        // 空间不足以放在下方，则放在上方
        targetY = bounds.y - inputHeight - 10
      }
      if (targetY < workArea.y) {
        targetY = workArea.y + 10
      }

      const payload = {
        path: imagePath,
        base64: croppedBase64,
        width: bounds.width,
        height: bounds.height
      }

      if (inputWindow && !inputWindow.isDestroyed()) {
        inputWindow.setBounds({
          x: Math.round(targetX),
          y: Math.round(targetY),
          width: inputWidth,
          height: inputHeight
        })
        inputWindow.show()
        inputWindow.focus()
        inputWindow.webContents.send('api:set-screenshot-image', payload)
      } else {
        createInputWindow(Math.round(targetX), Math.round(targetY), payload)
      }
    })

    // 转发桌宠生成的 LLM 回复到快捷输入框，并通知 Agent 窗口刷新会话
    ipcMain.on('api:send-pet-reply-to-input', (_, responseText: string) => {
      if (inputWindow && !inputWindow.isDestroyed()) {
        inputWindow.webContents.send('pet-reply-response', responseText)
      }
    })

    // 从快捷输入框向完整对话窗口传递待发送文本的通知（数据在 localStorage 中）
    ipcMain.on('api:send-pending-input', () => {
      if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.webContents.send('pending-input')
      } else {
        // 窗口尚未创建，标记有待投递通知
        pendingAgentInput = '__pending__'
      }
    })

    // Agent 窗口初始化时检查是否有待投递的通知
    ipcMain.handle('api:get-pending-input', () => {
      const hasPending = !!pendingAgentInput
      pendingAgentInput = ''
      return hasPending ? '__pending__' : ''
    })

  } // end of ipcWindowHandlersRegistered guard
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // 恢复物理持久化的大模型配置，保证后台微信 Bot 在前端就绪前能拿到有效密钥
  registerBuiltinTools()
  loadSystemLlmConfig()
  systemMcpConfig = mcpManager.loadSystemMcpConfig()


  // Set app user model id for windows
  electronApp.setAppUserModelId(windowsAppUserModelId)

  // 配置地理定位权限处理器，允许渲染进程获取系统定位
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'geolocation') {
      const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      dialog.showMessageBox(activeWin, {
        type: 'question',
        buttons: ['允许', '拒绝'],
        defaultId: 0,
        cancelId: 1,
        title: '地理定位授权',
        message: '“AgentPet” 想要获取您的电脑地理位置定位，是否允许？',
        detail: '允许定位将使桌面助理能获取您当前的位置以提供对应城市的天气、时间等服务。'
      }).then(({ response }) => {
        callback(response === 0)
      }).catch(() => {
        callback(false)
      })
    } else {
      callback(false)
    }
  })

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'geolocation') {
      return true
    }
    return false
  })

  // Default open or close DevTools by F12 in development
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册 live2d:// 协议，将请求映射到 resources/live2d/ 目录
  // 开发模式：process.cwd()/resources/live2d
  // 生产模式：process.resourcesPath/live2d
  const live2dRoot = is.dev
    ? join(process.cwd(), 'resources', 'live2d')
    : join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'live2d')

  protocol.handle('live2d', async (request) => {
    try {
      const url = new URL(request.url)
      let filePath = ''
      if (url.host === 'custom' && customModelDir) {
        filePath = join(customModelDir, url.pathname)
      } else {
        filePath = join(live2dRoot, url.pathname)
      }
      const fileUrl = pathToFileURL(filePath).toString()
      const response = await net.fetch(fileUrl)
      // 添加 CORS 头，允许 XHR 加载模型文件
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD')
      return new Response(response.body, { status: response.status, headers })
    } catch (e) {
      console.error('[live2d protocol]', e)
      return new Response('Not Found', { status: 404 })
    }
  })

  protocol.handle('wechat-file', async (request) => {
    try {
      const url = new URL(request.url)
      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const segments = relativePath.split('/')
      let filePath = ''

      if (segments.length >= 2 && segments[0] === 'local') {
        if (segments.length >= 3) {
          // 新格式：wechat-file://local/<safeSessionId>/<fileName>
          const safeSessionId = segments[1]
          const fileName = segments.slice(2).join('/')
          filePath = join(getActiveStorageDir(), 'chat', safeSessionId, 'wechat_files', fileName)
        } else {
          // 旧格式：wechat-file://local/<fileName>
          const fileName = segments.slice(1).join('/')
          filePath = join(getActiveStorageDir(), 'wechat_files', fileName)
        }
      }

      if (!filePath) {
        return new Response('Bad Request', { status: 400 })
      }

      // 安全检查：文件必须位于允许的目录内
      const allowedBases = [
        join(getActiveStorageDir(), 'chat'),
        join(getActiveStorageDir(), 'wechat_files')
      ]
      if (!allowedBases.some(base => filePath.startsWith(base))) {
        return new Response('Access Denied', { status: 403 })
      }

      const fileUrl = pathToFileURL(filePath).toString()
      const response = await net.fetch(fileUrl)
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD')
      return new Response(response.body, { status: response.status, headers })
    } catch (e) {
      console.error('[wechat-file protocol]', e)
      return new Response('Not Found', { status: 404 })
    }
  })

  const mimeTypes: Record<string, string> = {
    // 图片
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jfif': 'image/jpeg',
    '.pjpe': 'image/jpeg',
    '.pjpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.jxl': 'image/jxl',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.cur': 'image/x-icon',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.apng': 'image/apng',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    // 视频
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv',
    '.3gp': 'video/3gpp',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.mpe': 'video/mpeg',
    '.mpv': 'video/mpeg',
    // 音频
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.aac': 'audio/aac',
    '.m4a': 'audio/x-m4a',
    '.flac': 'audio/flac',
    '.opus': 'audio/opus',
    '.weba': 'audio/webm',
    '.amr': 'audio/amr',
    '.mid': 'audio/midi',
    '.midi': 'audio/midi',
    '.aif': 'audio/x-aiff',
    '.aiff': 'audio/x-aiff',
    '.aifc': 'audio/x-aiff',
    // 版式文档
    '.pdf': 'application/pdf',
    '.epub': 'application/epub+zip',
    '.ofd': 'application/ofd',
    '.xps': 'application/vnd.ms-xpsdocument',
    '.oxps': 'application/oxps',
    // Office 文字
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.docm': 'application/vnd.ms-word.document.macroenabled.12',
    '.doc': 'application/msword',
    '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    '.dotm': 'application/vnd.ms-word.template.macroenabled.12',
    '.dot': 'application/msword',
    '.rtf': 'application/rtf',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.fodt': 'application/vnd.oasis.opendocument.text-flat-xml',
    '.wps': 'application/vnd.ms-works',
    // Office 表格
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
    '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    '.xlt': 'application/vnd.ms-excel',
    '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    '.xltm': 'application/vnd.ms-excel.template.macroenabled.12',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.fods': 'application/vnd.oasis.opendocument.spreadsheet-flat-xml',
    '.numbers': 'application/vnd.apple.numbers',
    '.et': 'application/vnd.ms-excel',
    // Office 演示
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pptm': 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pps': 'application/vnd.ms-powerpoint',
    '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
    '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
    '.potm': 'application/vnd.ms-powerpoint.template.macroenabled.12',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.fodp': 'application/vnd.oasis.opendocument.presentation-flat-xml',
    '.key': 'application/vnd.apple.keynote',
    '.dps': 'application/vnd.ms-powerpoint',
    // 文本 / 代码
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.tsv': 'text/tab-separated-values; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.ts': 'application/typescript; charset=utf-8',
    '.tsx': 'text/typescript-jsx; charset=utf-8',
    '.jsx': 'text/javascript-jsx; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    // 压缩包
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.bz2': 'application/x-bzip2',
    '.xz': 'application/x-xz',
    // 邮件
    '.eml': 'message/rfc822',
    '.msg': 'application/vnd.ms-outlook',
    '.mbox': 'application/mbox',
    // 协同绘图
    '.drawio': 'application/vnd.jgraph.mxfile',
    '.dio': 'application/vnd.jgraph.mxfile',
    '.excalidraw': 'application/json; charset=utf-8',
    '.tldraw': 'application/json; charset=utf-8',
    // CAD
    '.dxf': 'image/vnd.dxf',
    '.dwg': 'image/vnd.dwg',
    '.dwf': 'model/vnd.dwf',
    '.step': 'model/step',
    '.stp': 'model/step',
    '.iges': 'model/iges',
    '.igs': 'model/iges',
    '.ifc': 'model/ifc',
    '.sat': 'model/sat',
    '.sab': 'model/sat',
    '.x_t': 'model/x-parasolid-transmission',
    '.x_b': 'model/x-parasolid-binary',
    '.3dm': 'model/3dm',
    '.skp': 'model/skp',
    '.sldprt': 'model/sldprt',
    '.sldasm': 'model/sldasm',
    '.gds': 'application/x-gdsii',
    '.oas': 'application/x-oasis',
    '.oasis': 'application/x-oasis',
    // 3D
    '.gltf': 'model/gltf+json',
    '.glb': 'model/gltf-binary',
    '.obj': 'model/obj',
    '.stl': 'model/stl',
    '.fbx': 'model/fbx',
    '.dae': 'model/vnd.collada+xml',
    '.ply': 'model/ply',
    '.3mf': 'model/3mf',
    '.3ds': 'model/3ds',
    '.usd': 'model/usd',
    '.usda': 'model/usd',
    '.usdc': 'model/usd',
    '.usdz': 'model/vnd.usdz+zip',
    '.wrl': 'model/vrml',
    '.vrml': 'model/vrml',
    // GIS
    '.geojson': 'application/geo+json',
    '.topojson': 'application/json; charset=utf-8',
    '.kml': 'application/vnd.google-earth.kml+xml',
    '.kmz': 'application/vnd.google-earth.kmz',
    '.gpx': 'application/gpx+xml',
    '.shp': 'application/octet-stream',
    // 资产
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.eot': 'application/vnd.ms-fontobject',
    '.psd': 'image/vnd.adobe.photoshop',
    '.psb': 'image/vnd.adobe.photoshop',
    '.ai': 'application/postscript',
    '.eps': 'application/postscript',
    '.ps': 'application/postscript',
    '.webarchive': 'application/x-webarchive',
    '.sqlite': 'application/x-sqlite3',
    '.sqlite3': 'application/x-sqlite3',
    '.db': 'application/x-sqlite3',
    '.wasm': 'application/wasm',
    '.parquet': 'application/x-parquet',
    '.avro': 'application/x-avro',
  }

  protocol.handle('local-file', async (request) => {
    try {
      // local-file 协议注册了 standard:true，Chromium 会将 local-file://C:/path 中的 C: 当 hostname 解析
      // 渲染层统一使用 local-file:///C:/path（三斜杠），此时 pathname=/C:/path
      // 部分第三方组件解析时可能将 URL 自动缩减变形为双斜杠形式，导致盘符冒号丢失（例如 local-file://c/Users/...)
      const parsedUrl = new URL(request.url)
      let filePath = decodeURIComponent(parsedUrl.pathname)
      
      if (parsedUrl.host && /^[A-Za-z]$/.test(parsedUrl.host)) {
        // 兼容第三方库篡改 URL：提取被误当作 hostname 的单字盘符，并拼回盘符冒号
        filePath = `${parsedUrl.host}:${filePath}`
      } else if (/^\/[A-Za-z]:\//.test(filePath)) {
        // Windows 绝对路径：/C:/path → C:/path
        filePath = filePath.slice(1)
      }
      
      const ext = extname(filePath).toLowerCase()
      const contentType = mimeTypes[ext] || 'application/octet-stream'
      
      const buffer = await fs.promises.readFile(filePath)
      const headers = new Headers()
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD')
      headers.set('Content-Type', contentType)
      headers.set('Content-Length', buffer.length.toString())
      return new Response(buffer, { status: 200, headers })
    } catch (e) {
      console.error('[local-file protocol error]', e)
      return new Response('Not Found', { status: 404 })
    }
  })

  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('api:rpa-pick-element', async (_, url: string) => {
    return await RpaElementPicker.pick(url)
  })
  ipcMain.handle('api:list-rpa-desktop-windows', async () => {
    const excludedProcessIds = new Set([process.pid, ...BrowserWindow.getAllWindows().map(window => window.webContents.getOSProcessId())])
    return (await listDesktopWindows()).filter(window => !excludedProcessIds.has(window.processId))
  })
  ipcMain.handle('api:normalize-rpa-recorded-actions', async (_, actions: any[]) => {
    if (!Array.isArray(actions) || actions.length === 0) return actions
    const chineseInputLanguageIds = new Set([0x0804, 0x0404, 0x0c04, 0x1004, 0x1404])
    const candidates = actions.map((action, index) => ({ action, index })).filter(({ action }) =>
      action?.type === 'desktop_type' && !action?.sensitive && !action?.normalizationSource && typeof action?.value === 'string' &&
      (
        /[a-z][a-z']*[1-9 ]/i.test(action.value) ||
        (chineseInputLanguageIds.has(Number(action.inputLanguage)) && /^[a-z][a-z']{1,}$/i.test(action.value.trim()))
      )
    )
    if (candidates.length === 0) return actions
    try {
      const llmConfig = loadSecureSystemLlmConfig()
      if (llmConfig.provider !== 'ollama' && !llmConfig.apiKey) return actions
      const provider = ModelRuntimeFactory.getProvider(llmConfig.provider, llmConfig.apiKey, llmConfig.baseUrl)
      const payload = candidates.map(({ action, index }) => ({
        index,
        raw: action.value,
        processName: action.processName || '',
        windowTitle: action.windowTitle || ''
      }))
      const prompt = `你是中文输入法录制结果还原器。输入 raw 是用户录制时产生的物理按键序列：英文字母表示拼音，数字 1-9 表示选择对应序号的候选词，空格通常表示选择第一个候选词。请结合常见中文输入法候选顺序，将明确的序列还原成最终上屏文字。例如 niu1 通常还原为“牛”。如果无法高置信度确定，normalized 必须等于 raw，confidence 填 low。只返回严格 JSON 数组，不要 Markdown。格式：[{
        "index": 0, "raw": "niu1", "normalized": "牛", "confidence": "high"
      }]。待处理数据：${JSON.stringify(payload)}`
      const result = await provider.chat([{ role: 'user', content: prompt }], {
        model: llmConfig.model,
        temperature: 0
      })
      const content = typeof result.content === 'string' ? result.content.trim() : ''
      const jsonText = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const normalized = JSON.parse(jsonText)
      if (!Array.isArray(normalized)) return actions
      const replacements = new Map<number, { raw: string; normalized: string; confidence: string }>()
      for (const item of normalized) {
        const index = Number(item?.index)
        const raw = String(item?.raw || '')
        let value = String(item?.normalized || '')
        if (/[㐀-鿿]/.test(value) && /[1-9]\s*$/.test(raw)) {
          value = value.replace(/[1-9]\s*$/, '')
        }
        const confidence = String(item?.confidence || '').toLowerCase()
        if (Number.isInteger(index) && value && value !== raw && ['high', 'medium'].includes(confidence)) {
          replacements.set(index, { raw, normalized: value, confidence })
        }
      }
      return actions.map((action, index) => {
        const replacement = replacements.get(index)
        return replacement ? {
          ...action,
          value: replacement.normalized,
          rawRecordedValue: replacement.raw,
          normalizationSource: 'model',
          normalizationConfidence: replacement.confidence,
          label: `桌面输入 ${replacement.normalized}`
        } : action
      })
    } catch (error) {
      console.warn('[RPA Recorder] 输入法文本模型还原失败，保留原始录制值:', error)
      return actions
    }
  })
  ipcMain.handle('api:complete-rpa-recording-processing', () => {
    activeRpaRecordingController?.closeSilently()
    activeRpaRecordingController = null
    return true
  })
  ipcMain.handle('api:rpa-record-actions', async (_, input: string | {
    url?: string
    mode?: 'browser' | 'desktop'
    desktopTarget?: { processId: number; processName?: string; windowTitle?: string }
  }) => {
    if (isRpaRecordingActive) throw new Error('已有录制会话正在进行')
    isRpaRecordingActive = true

    const options = typeof input === 'string' ? { url: input, mode: 'browser' as const } : input
    const mode = options.mode || 'browser'
    const url = options.url || (mode === 'desktop' ? 'about:blank' : 'https://')
    const shortcut = 'CommandOrControl+Shift+F12'
    const browserSessionId = `visual-${Date.now()}`
    const recordingStartedAt = Date.now()
    const targetLabel = mode === 'browser'
      ? url
      : options.desktopTarget?.windowTitle || options.desktopTarget?.processName || 'Windows 桌面'

    let desktopRecording: ReturnType<typeof startDesktopRecording> | null = null
    let recordingController: Awaited<ReturnType<typeof createRecordingController>> | null = null
    let finishDesktopOnly: (() => void) | null = null
    let finishRequested = false

    const focusInitialDesktop = (): void => {
      setTimeout(() => {
        if (options.desktopTarget?.processId) void focusDesktopWindow(options.desktopTarget.processId)
        else void showWindowsDesktop()
      }, 220)
    }

    const requestFinish = (): void => {
      finishRequested = true
      recordingController?.setFinalizing()
      if (mode === 'browser') void RpaBrowserRecorder.finish(browserSessionId)
      else finishDesktopOnly?.()
    }

    try {
      recordingController = await createRecordingController({ mode, targetLabel, onFinish: requestFinish })
      activeRpaRecordingController?.closeSilently()
      activeRpaRecordingController = recordingController
      if (mode === 'desktop') {
        const agentProcessIds = [process.pid, ...BrowserWindow.getAllWindows().map(window => window.webContents.getOSProcessId())]
          .filter(pid => pid > 0)
        desktopRecording = startDesktopRecording({
          excludeProcessIds: agentProcessIds
        })
      }

      const registered = globalShortcut.register(shortcut, () => {
        requestFinish()
      })
      if (!registered) console.warn(`[RPA Recorder] 无法注册结束快捷键 ${shortcut}，仍可使用悬浮控制卡结束`)

      let browserActions: any[] = []
      if (mode === 'browser') {
        const browserPromise = RpaBrowserRecorder.record(url, browserSessionId, {
          showOverlay: false
        })
        if (finishRequested) void RpaBrowserRecorder.finish(browserSessionId)
        browserActions = await browserPromise
      } else {
        focusInitialDesktop()
        await new Promise<void>(resolve => {
          finishDesktopOnly = resolve
          if (finishRequested) resolve()
        })
      }

      const desktopActions = desktopRecording ? await desktopRecording.stop() : []
      recordingController.setFinalizing()
      const initialDesktopActions = mode === 'desktop' && !options.desktopTarget
        ? [{ type: 'desktop_focus', showDesktop: true, label: '显示 Windows 桌面', recordedAt: recordingStartedAt }]
        : []
      return [...initialDesktopActions, ...browserActions, ...desktopActions].sort((a, b) => Number(a.recordedAt || 0) - Number(b.recordedAt || 0))
    } finally {
      globalShortcut.unregister(shortcut)
      if (desktopRecording) await desktopRecording.stop().catch(() => [])
      isRpaRecordingActive = false
    }
  })

  // 1. 初始化存储配置与动态目录管理
  const configPath = join(app.getPath('userData'), 'config.json')

  const readConfig = (): any => {
    try {
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf-8')
        return JSON.parse(data)
      }
    } catch (e) {
      console.error('读取 config.json 失败', e)
    }
    return {}
  }

  const writeConfig = (newConfig: any): void => {
    try {
      const current = readConfig()
      const merged = { ...current, ...newConfig }
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8')
    } catch (e) {
      console.error('写入 config.json 失败', e)
    }
  }

  let customStoragePath = ''
  let sandboxMode = true
  let avatarConfigs: Record<string, any> = {}
  try {
    const config = readConfig()
    customStoragePath = config.storagePath || ''
    customModelDir = config.customModelDir || ''
    customModelFile = config.customModelFile || ''
    sandboxMode = config.sandboxMode !== false // 默认为 true
    avatarConfigs = config.avatarConfigs || {}
  } catch (e) {
    console.error('读取存储路径配置失败', e)
  }

  const getActiveStorageDir = (): string => {
    if (customStoragePath) {
      try {
        if (!fs.existsSync(customStoragePath)) {
          fs.mkdirSync(customStoragePath, { recursive: true })
        }
        return customStoragePath
      } catch (e) {
        console.error('自定义存储路径无效，退回默认路径', e)
      }
    }
    return app.getPath('userData')
  }

  const resolveLocalPath = (filePath: string): string => {
    if (!filePath || typeof filePath !== 'string') return filePath
    let resolved = filePath
    if (resolved.startsWith('local-file:///')) {
      resolved = resolved.replace('local-file:///', '')
      if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1)
      resolved = decodeURIComponent(resolved)
    } else if (resolved.startsWith('local-file://')) {
      resolved = resolved.replace('local-file://', '')
      if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1)
      resolved = decodeURIComponent(resolved)
    } else if (resolved.startsWith('wechat-file://')) {
      const relativePath = decodeURIComponent(resolved.replace('wechat-file://', '').replace(/^\/+/, ''))
      const segments = relativePath.split('/')
      if (segments.length >= 3 && segments[0] === 'local') {
        // 新格式：wechat-file://local/<safeSessionId>/<fileName>
        const safeSessionId = segments[1]
        const fileName = segments.slice(2).join('/')
        resolved = join(getActiveStorageDir(), 'chat', safeSessionId, 'wechat_files', fileName)
      } else if (segments.length >= 2 && segments[0] === 'local') {
        // 旧格式：wechat-file://local/<fileName>
        const fileName = segments.slice(1).join('/')
        resolved = join(getActiveStorageDir(), 'wechat_files', fileName)
      }
    }
    return resolved
  }

  const getActiveSkillsDir = (): string => {
    const base = getActiveStorageDir()
    const dir = join(base, 'skills')
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        console.error('创建 skills 文件夹失败', e)
      }
    }
    return dir
  }

  // 触发一次默认初始化
  getActiveSkillsDir()

  const getActiveChatDir = (): string => {
    const base = getActiveStorageDir()
    const dir = join(base, 'chat')
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        console.error('创建 chat 文件夹失败', e)
      }
    }
    return dir
  }

  // 触发一次 chat 目录初始化
  getActiveChatDir()

  const getActiveLive2DDir = (): string => {
    const base = getActiveStorageDir()
    const dir = join(base, 'live2d')
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        console.error('创建 live2d 文件夹失败', e)
      }
    }
    return dir
  }

  // 触发一次 live2d 目录初始化
  getActiveLive2DDir()

  const getActiveMemoryDir = (): string => {
    const base = getActiveStorageDir()
    const dir = join(base, 'memory')
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        console.error('创建 memory 文件夹失败', e)
      }
    }
    return dir
  }

  // 触发一次 memory 目录初始化
  getActiveMemoryDir()

  // 生成文件目录管理（支持按会话隔离）
  const getGeneratedFilesDir = (sessionId?: string): string => {
    const base = getActiveStorageDir()
    let dir: string
    if (sessionId) {
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      dir = join(base, 'chat', safeSessionId, 'generated_files')
    } else {
      dir = join(base, 'generated_files')
    }
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        console.error('创建 generated_files 文件夹失败', e)
      }
    }
    return dir
  }
  getGeneratedFilesDir()

  // 2. CPU/内存及系统状态获取
  function getCpuUsageInfo(): { totalIdle: number; totalTick: number } {
    const cpus = os.cpus()
    let totalIdle = 0
    let totalTick = 0
    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times]
      }
      totalIdle += cpu.times.idle
    })
    return { totalIdle, totalTick }
  }
  let lastCpuStats = getCpuUsageInfo()

  ipcMain.handle('api:get-system-info', async () => {
    const endCpu = getCpuUsageInfo()
    const idleDiff = endCpu.totalIdle - lastCpuStats.totalIdle
    const tickDiff = endCpu.totalTick - lastCpuStats.totalTick
    lastCpuStats = endCpu

    let cpuUsage = 0
    if (tickDiff > 0) {
      cpuUsage = Math.round((1 - idleDiff / tickDiff) * 100)
    }
    if (cpuUsage < 0) cpuUsage = 0
    if (cpuUsage > 100) cpuUsage = 100

    return {
      cpuModel: os.cpus()[0]?.model || 'Unknown CPU',
      cpuCount: os.cpus().length,
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      platform: os.platform(),
      release: os.release(),
      uptime: Math.round(process.uptime()),
      sysUptime: Math.round(os.uptime()),
      cpuUsage
    }
  })

  // 3. 存储路径设置与技能目录管理
  ipcMain.handle('api:set-storage-path', async (_, pathStr: string) => {
    try {
      const oldBaseDir = getActiveStorageDir()
      const newBaseDir = pathStr ? pathStr.trim() : app.getPath('userData')

      if (oldBaseDir === newBaseDir) {
        return oldBaseDir
      }

      // 确保新顶头目录及各模块子目录存在
      if (!fs.existsSync(newBaseDir)) {
        fs.mkdirSync(newBaseDir, { recursive: true })
      }

      // 自动迁移 skills, chat, live2d, memory 四个模块子目录
      const modules = ['skills', 'chat', 'live2d', 'memory']
      for (const mod of modules) {
        const oldModPath = join(oldBaseDir, mod)
        const newModPath = join(newBaseDir, mod)
        if (fs.existsSync(oldModPath)) {
          await copyFolderRecursive(oldModPath, newModPath)
          try {
            await fs.promises.rm(oldModPath, { recursive: true, force: true })
          } catch (err) {
            console.error(`删除旧模块目录失败 ${oldModPath}:`, err)
          }
        } else {
          await fs.promises.mkdir(newModPath, { recursive: true })
        }
      }

      // 如果自定义虚拟形象的路径 customModelDir 之前是在旧顶头目录下，进行路径的相对重定向重写
      if (customModelDir && customModelDir.startsWith(oldBaseDir)) {
        const relativeModelDir = customModelDir.substring(oldBaseDir.length)
        customModelDir = join(newBaseDir, relativeModelDir)
        writeConfig({ customModelDir })
      }

      customStoragePath = pathStr ? pathStr.trim() : ''
      writeConfig({ storagePath: customStoragePath })

      return getActiveStorageDir()
    } catch (e: any) {
      console.error(e)
      throw new Error(`迁移存储路径失败: ${e.message}`)
    }
  })

  ipcMain.handle('api:get-storage-path', () => {
    return customStoragePath
  })

  const listToolCacheDirs = async (): Promise<string[]> => {
    const chatDir = getActiveChatDir()
    const entries = await fs.promises.readdir(chatDir, { withFileTypes: true }).catch(() => [])
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(chatDir, entry.name, '.agentpet_cache', 'tool-results'))
      .filter(cacheDir => fs.existsSync(cacheDir))
  }

  const collectDirectoryStats = async (directory: string): Promise<{ fileCount: number; totalBytes: number }> => {
    let fileCount = 0
    let totalBytes = 0
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const target = join(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = await collectDirectoryStats(target)
        fileCount += nested.fileCount
        totalBytes += nested.totalBytes
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(target).catch(() => null)
        if (stat) {
          fileCount++
          totalBytes += stat.size
        }
      }
    }
    return { fileCount, totalBytes }
  }

  ipcMain.handle('api:get-tool-cache-stats', async () => {
    const cacheDirs = await listToolCacheDirs()
    let fileCount = 0
    let totalBytes = 0
    for (const cacheDir of cacheDirs) {
      const stats = await collectDirectoryStats(cacheDir)
      fileCount += stats.fileCount
      totalBytes += stats.totalBytes
    }
    return { fileCount, totalBytes }
  })

  ipcMain.handle('api:clear-tool-cache', async () => {
    const cacheDirs = await listToolCacheDirs()
    let deletedDirectories = 0
    for (const cacheDir of cacheDirs) {
      await fs.promises.rm(cacheDir, { recursive: true, force: true })
      deletedDirectories++
    }
    return { success: true, deletedDirectories }
  })

  ipcMain.handle('api:get-sandbox-mode', () => {
    return sandboxMode
  })

  ipcMain.handle('api:set-sandbox-mode', (_, enabled: boolean) => {
    sandboxMode = !!enabled
    writeConfig({ sandboxMode })
    return sandboxMode
  })

  ipcMain.handle('api:test-ssh-connection', async (_, config) => {
    return sshManager.testConnection(config)
  })

  ipcMain.handle('api:connect-ssh', async (_, sessionId: string, config) => {
    return sshManager.connect(sessionId, config)
  })

  ipcMain.handle('api:disconnect-ssh', async (_, sessionId: string) => {
    sshManager.disconnect(sessionId)
  })

  ipcMain.handle('api:get-ssh-status', async (_, sessionId: string) => {
    return sshManager.getStatus(sessionId)
  })

  ipcMain.handle('api:set-execution-device', async (_, sessionId: string, type: 'local' | 'ssh') => {
    sshManager.setDeviceType(sessionId, type)
  })

  ipcMain.handle('api:get-execution-device', async (_, sessionId: string) => {
    return sshManager.getDeviceType(sessionId)
  })

  ipcMain.handle('api:save-chat-file', async (_, sessionId: string, fileName: string, arrayBuffer: ArrayBuffer) => {
    try {
      const chatDir = getActiveChatDir()
      // 将特殊字符替换掉，防止路径穿越
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      const sessionDir = join(chatDir, safeSessionId)
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true })
      }

      const safeFileName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_')
      const uniqueFileName = `${Date.now()}_${safeFileName}`
      const targetPath = join(sessionDir, uniqueFileName)

      const buffer = Buffer.from(arrayBuffer)
      fs.writeFileSync(targetPath, buffer)
      // 跟踪 xlsx 文件，用于 generate_file 时自动复制数据验证
      if (/\.(xlsx|xls)$/i.test(fileName)) {
        sessionLastXlsxMap.set(sessionId, targetPath)
      }
      return { name: fileName, path: targetPath, safeName: uniqueFileName }
    } catch (e: any) {
      console.error('保存聊天附件失败', e)
      throw new Error(`保存聊天附件失败: ${e.message}`)
    }
  })

  // 从文件路径读取文件并保存为会话附件（用于剪贴板图片等场景）
  ipcMain.handle('api:attach-file-from-path', async (_, filePath: string, sessionId: string) => {
    try {
      const buffer = await fs.promises.readFile(filePath)
      const fileName = filePath.split(/[\\/]/).pop() || 'file'
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      const chatDir = getActiveChatDir()
      const sessionDir = join(chatDir, safeSessionId)
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true })
      }
      const safeFileName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_')
      const uniqueFileName = `${Date.now()}_${safeFileName}`
      const targetPath = join(sessionDir, uniqueFileName)
      await fs.promises.writeFile(targetPath, buffer)

      const ext = fileName.split('.').pop()?.toLowerCase() || ''
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']
      const isImage = imageExts.includes(ext)

      // 图片不设 content —— 发送给 LLM 时走 image_url 通道（真正的视觉理解）
      // 非图片文件也不设 content（由前端解析文档内容）
      return {
        name: fileName,
        path: targetPath,
        safeName: uniqueFileName,
        isImage
      }
    } catch (e: any) {
      console.error('从路径附加文件失败:', e)
      return null
    }
  })

  // 将文件复制到当前会话目录（用于跨会话复制文件，确保路径有效）
  ipcMain.handle('api:copy-to-chat-file', async (_, sessionId: string, sourcePath: string) => {
    try {
      // 如果源文件存在，直接复制
      if (fs.existsSync(sourcePath)) {
        const chatDir = getActiveChatDir()
        const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const sessionDir = join(chatDir, safeSessionId)
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true })
        }
        const baseName = basename(sourcePath)
        const safeFileName = baseName.replace(/[^a-zA-Z0-9_.-]/g, '_')
        const uniqueFileName = `${Date.now()}_${safeFileName}`
        const targetPath = join(sessionDir, uniqueFileName)
        await fs.promises.copyFile(sourcePath, targetPath)
        // 跟踪 xlsx 文件
        if (/\.(xlsx|xls)$/i.test(sourcePath)) {
          sessionLastXlsxMap.set(sessionId, targetPath)
        }
        return { path: targetPath, exists: true }
      }
      // 源文件不存在
      return { path: sourcePath, exists: false }
    } catch (e: any) {
      console.error('复制文件到会话目录失败', e)
      return { path: sourcePath, exists: false }
    }
  })



  // 从剪贴板读取文件路径（Windows CF_HDROP）或图片
  ipcMain.handle('api:read-clipboard-files', async () => {
    try {
      // 1. 尝试读取 Windows 文件拖拽/复制格式 (FileNameW)
      const fileNameWBuf = clipboard.readBuffer('FileNameW')
      if (fileNameWBuf && fileNameWBuf.length > 0) {
        let pathStr = fileNameWBuf.toString('utf16le')
        pathStr = pathStr.replace(/\0/g, '') // 移除 null terminator
        if (pathStr) {
          try {
            if (fs.existsSync(pathStr)) {
              return { type: 'files', paths: [pathStr] }
            }
          } catch (e) {
            console.error('检查剪贴板文件路径失败:', e)
          }
        }
      }

      // 2. 尝试读取剪贴板图片
      const img = clipboard.readImage()
      if (img && !img.isEmpty()) {
        const tempDir = join(os.tmpdir(), 'agentpet_clipboard')
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true })
        const fileName = `clipboard_${Date.now()}.png`
        const filePath = join(tempDir, fileName)
        fs.writeFileSync(filePath, img.toPNG())
        return { type: 'image', path: filePath, name: fileName }
      }

      return null
    } catch (err) {
      console.error('读取剪贴板文件失败:', err)
      return null
    }
  })

  ipcMain.on('api:copy-text', (_, text: string) => {
    try {
      clipboard.writeText(text || '')
    } catch (err) {
      console.error('主进程写入剪贴板异常:', err)
    }
  })

  // 复制图片到剪贴板（支持 local-file:///、wechat-file:/// 和 http/https URL）
  ipcMain.handle('api:copy-image', async (_, imageUrl: string) => {
    try {
      let img: Electron.NativeImage

      if (imageUrl.startsWith('local-file:///')) {
        // local-file:///C:/path → C:/path
        let filePath = imageUrl.replace('local-file:///', '')
        if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
        img = nativeImage.createFromPath(filePath)
      } else if (imageUrl.startsWith('wechat-file://')) {
        const relativePath = decodeURIComponent(imageUrl.replace('wechat-file://', '').replace(/^\/+/, ''))
        const segments = relativePath.split('/')
        let filePath = ''
        if (segments.length >= 3 && segments[0] === 'local') {
          // 新格式：wechat-file://local/<safeSessionId>/<fileName>
          const safeSessionId = segments[1]
          const fileName = segments.slice(2).join('/')
          filePath = join(getActiveStorageDir(), 'chat', safeSessionId, 'wechat_files', fileName)
        } else if (segments.length >= 2 && segments[0] === 'local') {
          // 旧格式：wechat-file://local/<fileName>
          const fileName = segments.slice(1).join('/')
          filePath = join(getActiveStorageDir(), 'wechat_files', fileName)
        }
        img = nativeImage.createFromPath(filePath)
      } else if (imageUrl.startsWith('data:image/')) {
        // base64 data URL
        img = nativeImage.createFromDataURL(imageUrl)
      } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        // 远程图片：先下载再写入剪贴板
        const response = await net.fetch(imageUrl)
        const buffer = Buffer.from(await response.arrayBuffer())
        img = nativeImage.createFromBuffer(buffer)
      } else {
        return { success: false, error: '不支持的图片 URL 格式' }
      }

      if (img.isEmpty()) {
        return { success: false, error: '图片加载失败，可能文件已被删除' }
      }

      clipboard.writeImage(img)
      return { success: true }
    } catch (err: any) {
      console.error('复制图片到剪贴板失败:', err)
      return { success: false, error: err.message || String(err) }
    }
  })

  ipcMain.handle('api:open-local-file', async (_, url: string) => {
    try {
      const filePath = resolveLocalPath(url)
      if (filePath === url) {
        return { success: false, error: '不支持的文件协议' }
      }

      if (!fs.existsSync(filePath)) {
        return { success: false, error: `文件不存在：${filePath}` }
      }

      const err = await shell.openPath(filePath)
      if (err) {
        return { success: false, error: `打开文件失败：${err}` }
      }
      return { success: true }
    } catch (e: any) {
      console.error('打开本地文件失败:', e)
      return { success: false, error: e.message || String(e) }
    }
  })

  // 复制文件到剪贴板（支持在资源管理器中粘贴，同时支持文本粘贴）
  ipcMain.handle('api:copy-files', async (_, { filePaths, text }: { filePaths: string[]; text?: string }) => {
    try {
      if (!filePaths || filePaths.length === 0) {
        return { success: false, error: '没有可复制的文件' }
      }
      // 验证文件存在
      const validPaths = filePaths.filter(p => {
        try { return fs.existsSync(p) } catch { return false }
      })
      if (validPaths.length === 0) {
        return { success: false, error: '文件不存在' }
      }
      // 构建 CF_HDROP 格式的 DROPFILES 结构
      const encodedPaths = validPaths.map(p => Buffer.from(p + '\0', 'utf16le'))
      const totalPathBytes = encodedPaths.reduce((sum, b) => sum + b.length, 0) + 2
      const dropFiles = Buffer.alloc(20 + totalPathBytes)
      dropFiles.writeUInt32LE(20, 0)
      dropFiles.writeUInt32LE(0, 4)
      dropFiles.writeUInt32LE(0, 8)
      dropFiles.writeInt32LE(0, 12)
      dropFiles.writeInt32LE(1, 16)
      let offset = 20
      for (const buf of encodedPaths) {
        buf.copy(dropFiles, offset)
        offset += buf.length
      }
      // 同时写入文件格式和文本格式，这样粘贴到资源管理器是文件，粘贴到文本框是文本
      const writeObj: any = {
        CF_HDROP: dropFiles
      }
      if (text) {
        writeObj.text = text
      }
      clipboard.write(writeObj)
      return { success: true }
    } catch (err: any) {
      console.error('复制文件到剪贴板失败:', err)
      return { success: false, error: err.message || String(err) }
    }
  })

  // 显示原生右键菜单（复制图片）
  ipcMain.on('api:show-image-context-menu', (_, imageUrl: string) => {
    const menu = Menu.buildFromTemplate([
      {
        label: '📋 复制图片',
        click: async () => {
          try {
            let img: Electron.NativeImage
            if (imageUrl.startsWith('local-file:///')) {
              let filePath = imageUrl.replace('local-file:///', '')
              if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
              img = nativeImage.createFromPath(filePath)
            } else if (imageUrl.startsWith('wechat-file://')) {
              const relativePath = decodeURIComponent(imageUrl.replace('wechat-file://', '').replace(/^\/+/, ''))
              const segments = relativePath.split('/')
              let filePath = ''
              if (segments.length >= 3 && segments[0] === 'local') {
                // 新格式：wechat-file://local/<safeSessionId>/<fileName>
                const safeSessionId = segments[1]
                const fileName = segments.slice(2).join('/')
                filePath = join(getActiveStorageDir(), 'chat', safeSessionId, 'wechat_files', fileName)
              } else if (segments.length >= 2 && segments[0] === 'local') {
                // 旧格式：wechat-file://local/<fileName>
                const fileName = segments.slice(1).join('/')
                filePath = join(getActiveStorageDir(), 'wechat_files', fileName)
              }
              img = nativeImage.createFromPath(filePath)
            } else if (imageUrl.startsWith('data:image/')) {
              img = nativeImage.createFromDataURL(imageUrl)
            } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
              const response = await net.fetch(imageUrl)
              const buffer = Buffer.from(await response.arrayBuffer())
              img = nativeImage.createFromBuffer(buffer)
            } else {
              return
            }
            if (!img.isEmpty()) clipboard.writeImage(img)
          } catch (err) {
            console.error('原生菜单复制图片失败:', err)
          }
        }
      }
    ])
    menu.popup()
  })

  // 显示原生右键菜单（复制文本）
  ipcMain.on('api:show-text-context-menu', (_, selectedText: string) => {
    if (!selectedText) return
    const menu = Menu.buildFromTemplate([
      {
        label: '📋 复制',
        click: () => {
          clipboard.writeText(selectedText)
        }
      }
    ])
    menu.popup()
  })

  // 显示原生右键菜单（桌宠右键菜单）
  ipcMain.on('api:show-pet-context-menu', () => {
    const menu = Menu.buildFromTemplate([
      {
        label: '💬 快捷聊天',
        click: () => {
          createInputWindow()
        }
      },
      {
        label: '💻 打开窗口',
        click: () => {
          createAgentWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: '👁️ 隐藏桌宠',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.close()
          }
          if (inputWindow && !inputWindow.isDestroyed()) {
            inputWindow.close()
          }
        }
      }
    ])
    menu.popup()
  })

  ipcMain.handle('api:abort-llm', (_, sessionId?: string) => {
    if (sessionId) {
      abortedSessionIds.add(sessionId)
      const controller = activeLlmAbortControllers.get(sessionId)
      if (controller) {
        try { controller.abort() } catch (_) { /* ignore */ }
        activeLlmAbortControllers.delete(sessionId)
      }
    } else {
      for (const controller of activeLlmAbortControllers.values()) {
        try { controller.abort() } catch (_) { /* ignore */ }
      }
      activeLlmAbortControllers.clear()
    }
    permissionManager.clearPendingPermissions()
    clarificationManager.cancelPending(sessionId)
    credentialManager.cancelPending(sessionId)
    officeRuntimeManager.cancelPending(sessionId)

    return true
  })

  ipcMain.handle('api:show-notification', async (_, title: string, body: string) => {
    try {
      const notification = new Notification({
        title,
        body,
        icon: icon
      })
      activeNotifications.add(notification)
      const releaseNotification = (): void => {
        activeNotifications.delete(notification)
      }
      notification.on('click', () => {
        releaseNotification()
        notification.close()
        app.focus({ steal: true })
        createAgentWindow()
      })
      notification.on('close', releaseNotification)
      notification.on('failed', releaseNotification)
      notification.show()
      return true
    } catch (err) {
      console.error('发送通知失败', err)
      return false
    }
  })

  ipcMain.on('api:trigger-bubble', (_, text: string, details?: string, taskId?: string, logId?: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('api:show-bubble', text, details, taskId, logId)
    }
  })

  ipcMain.on('api:request-open-cron-log-details', (_, taskId: string, logId: string) => {
    createAgentWindow({ taskId, logId })
  })

  // 获取工具摘要（用于大模型了解可用工具）
  ipcMain.handle('api:get-tools-summary', async () => {
    try {
      return toolRegistry.getToolsSummary()
    } catch (error) {
      console.error('获取工具摘要失败:', error)
      return '获取工具摘要失败'
    }
  })

  // 获取工具详细文档
  ipcMain.handle('api:get-tool-documentation', async (_, toolName: string) => {
    try {
      return toolRegistry.getToolDocumentation(toolName)
    } catch (error) {
      console.error('获取工具文档失败:', error)
      return `获取工具 ${toolName} 的文档失败`
    }
  })

  // 获取所有工具信息
  ipcMain.handle('api:get-all-tools-info', async () => {
    try {
      return {
        tools: toolRegistry.getAllToolsInfo(),
        categories: toolRegistry.getCategories(),
        count: toolRegistry.getToolCount()
      }
    } catch (error) {
      console.error('获取工具信息失败:', error)
      return null
    }
  })

  // 重新加载工具定义（支持热更新）
  ipcMain.handle('api:reload-tools', async () => {
    try {
      toolRegistry.reload()
      return { success: true, count: toolRegistry.getToolCount() }
    } catch (error) {
      console.error('重新加载工具失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })


  ipcMain.handle('api:get-cron-tasks', async () => {
    try {
      let tasks: any[] = []
      const cronPath = join(getActiveStorageDir(), 'cron_tasks.json')
      if (fs.existsSync(cronPath)) {
        const data = await fs.promises.readFile(cronPath, 'utf-8')
        tasks = JSON.parse(data)
      }

      // 混入系统内置只读定时任务
      const lastCleanup = getLastCleanupTime()
      const lastTriggeredStr = lastCleanup ? new Date(lastCleanup).toLocaleString('zh-CN', { hour12: false }) : '从未执行'
      
      tasks.push({
        id: 'system:memory-cleanup',
        name: '记忆定时清理',
        interval: 15 * 24 * 60 * 60, // 15天以秒为单位
        isActive: true,
        isSystem: true, // 只读标识，禁用操作按钮
        action: '计算所有记忆的实时衰减强度，物理删除 sNow < 0.2 的深度遗忘记忆。',
        lastTriggered: lastTriggeredStr,
        triggerCount: lastCleanup ? 1 : 0, // 简单记录执行次数
        logs: [
          {
            id: 'system-log',
            time: lastTriggeredStr,
            status: lastCleanup ? 'success' : 'idle',
            message: lastCleanup ? `记忆清理任务于 ${lastTriggeredStr} 成功执行。` : '等待首次运行触发。'
          }
        ]
      })

      return tasks
    } catch (e) {
      console.error('读取 cron_tasks.json 失败', e)
    }
    return null
  })

  ipcMain.handle('api:save-cron-tasks', async (_, tasks: any[]) => {
    try {
      const cronPath = join(getActiveStorageDir(), 'cron_tasks.json')
      await fs.promises.writeFile(cronPath, JSON.stringify(tasks, null, 2), 'utf-8')
      return true
    } catch (e) {
      console.error('保存 cron_tasks.json 失败', e)
      return false
    }
  })


  // 通用选择文件夹
  ipcMain.handle('api:select-directory', async (event, options?: { title?: string }) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: options?.title || '选择文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // 获取自定义模型信息
  ipcMain.handle('api:get-custom-model', () => {
    return { customModelDir, customModelFile }
  })

  // 选择模型文件夹并查找 .model3.json
  ipcMain.handle('api:select-model-dir', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: '选择 Live2D 虚拟体文件夹',
      defaultPath: getActiveLive2DDir(),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const externalDir = result.filePaths[0]
    const files = await fs.promises.readdir(externalDir)
    const modelFile = files.find(f => f.toLowerCase().endsWith('.model3.json'))
    if (!modelFile) {
      throw new Error('所选文件夹中未找到 .model3.json 配置文件，请确认文件夹是否正确。')
    }

    // 拷贝到统一存储目录下的 live2d/ 目录中
    const targetParentDir = join(getActiveStorageDir(), 'live2d')
    if (!fs.existsSync(targetParentDir)) {
      fs.mkdirSync(targetParentDir, { recursive: true })
    }
    const modelFolderName = basename(externalDir)
    const localModelDir = join(targetParentDir, modelFolderName)

    // 物理复制
    await copyFolderRecursive(externalDir, localModelDir)

    customModelDir = localModelDir
    customModelFile = modelFile

    writeConfig({ customModelDir, customModelFile })

    // 通知挂件窗口刷新形象
    mainWindow?.webContents.send('model-updated')

    return { customModelDir, customModelFile }
  })

  // 清空自定义模型形象
  ipcMain.handle('api:clear-custom-model', () => {
    customModelDir = ''
    customModelFile = ''
    writeConfig({ customModelDir: '', customModelFile: '' })

    // 通知挂件窗口恢复默认形象
    mainWindow?.webContents.send('model-updated')
    return null
  })

  // 获取挂件加载的 live2d 模型 URL
  ipcMain.handle('api:get-model-url', () => {
    if (customModelDir && customModelFile) {
      const fullPath = join(customModelDir, customModelFile)
      if (fs.existsSync(fullPath)) {
        return `live2d://custom/${customModelFile}`
      }
    }
    return 'live2d://live2d/Resources/Mao/Mao.model3.json'
  })

  // 获取已导入的所有虚拟体列表
  ipcMain.handle('api:get-avatars-list', async () => {
    try {
      const live2dDir = getActiveLive2DDir()
      const entries = await fs.promises.readdir(live2dDir, { withFileTypes: true })
      const list: any[] = []

      // 添加默认形象
      const defaultConfig = avatarConfigs['default'] || {}
      list.push({
        id: 'default',
        name: defaultConfig.name || 'Mao',
        dir: '',
        configFile: '',
        languageStyle: defaultConfig.languageStyle || 'normal',
        voice: defaultConfig.voice || 'zh-CN-XiaoxiaoNeural',
        scale: defaultConfig.scale ?? 1.0,
        xOffset: defaultConfig.xOffset ?? 0,
        yOffset: defaultConfig.yOffset ?? 0,
        isDefault: true
      })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDirPath = join(live2dDir, entry.name)
          const files = await fs.promises.readdir(subDirPath)
          const modelFile = files.find(f => f.toLowerCase().endsWith('.model3.json'))
          if (modelFile) {
            const cfg = avatarConfigs[subDirPath] || {}
            list.push({
              id: subDirPath,
              name: cfg.name || entry.name,
              dir: subDirPath,
              configFile: modelFile,
              languageStyle: cfg.languageStyle || 'normal',
              voice: cfg.voice || 'zh-CN-XiaoxiaoNeural',
              scale: cfg.scale ?? 1.0,
              xOffset: cfg.xOffset ?? 0,
              yOffset: cfg.yOffset ?? 0,
              isDefault: false
            })
          }
        }
      }
      return list
    } catch (e) {
      console.error('获取虚拟体列表失败', e)
      return []
    }
  })

  // 保存虚拟体参数
  ipcMain.handle('api:save-avatar-config', async (_, { id, name, languageStyle, voice, scale, xOffset, yOffset }) => {
    try {
      if (!avatarConfigs[id]) {
        avatarConfigs[id] = {}
      }
      avatarConfigs[id].name = name
      avatarConfigs[id].languageStyle = languageStyle
      if (voice) avatarConfigs[id].voice = voice
      avatarConfigs[id].scale = scale ?? 1.0
      avatarConfigs[id].xOffset = xOffset ?? 0
      avatarConfigs[id].yOffset = yOffset ?? 0
      writeConfig({ avatarConfigs })

      // 如果当前修改的是正在使用的虚拟体，立即通知挂件重新渲染
      const isCurrentActive = (id === 'default' && !customModelDir) || (id === customModelDir)
      if (isCurrentActive) {
        mainWindow?.webContents.send('model-updated')
      }

      return true
    } catch (e) {
      console.error('保存虚拟体配置失败', e)
      return false
    }
  })

  // TTS 语音合成
  ipcMain.handle('api:synthesize-tts', async (_, { text, voice }: { text: string; voice: string }) => {
    try {
      const tmpFile = join(app.getPath('temp'), `agentpet_tts_${Date.now()}.mp3`)
      const ttsEngine = new EdgeTTS({
        voice: voice || 'zh-CN-XiaoxiaoNeural',
        lang: 'zh-CN',
        rate: 'default',
        pitch: 'default',
        volume: 'default'
      })
      await ttsEngine.ttsPromise(text, tmpFile)
      const buffer = fs.readFileSync(tmpFile)
      fs.unlinkSync(tmpFile)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (e) {
      console.error('TTS 合成失败', e)
      return null
    }
  })

  // 将 TTS 音频发送到挂件窗口播放
  ipcMain.handle('api:play-tts-audio', async (_, audioBuffer: ArrayBuffer) => {
    try {
      mainWindow?.webContents.send('play-tts-audio', audioBuffer)
      return true
    } catch (e) {
      console.error('发送 TTS 音频失败', e)
      return false
    }
  })

  // 一键切换至已归档的虚拟体
  ipcMain.handle('api:switch-avatar', async (_, { dir, configFile }) => {
    try {
      customModelDir = dir
      customModelFile = configFile
      writeConfig({ customModelDir, customModelFile })

      // 通知挂件刷新
      mainWindow?.webContents.send('model-updated')
      return { customModelDir, customModelFile }
    } catch (e: any) {
      console.error(e)
      throw new Error(`切换虚拟体失败: ${e.message}`)
    }
  })

  // 物理删除已归档的虚拟体
  ipcMain.handle('api:delete-avatar', async (_, dirPath) => {
    try {
      if (dirPath === customModelDir) {
        throw new Error('不能删除当前正在使用的虚拟体。')
      }
      if (fs.existsSync(dirPath)) {
        await fs.promises.rm(dirPath, { recursive: true, force: true })
      }
      return true
    } catch (e: any) {
      console.error(e)
      throw new Error(`删除虚拟体失败: ${e.message}`)
    }
  })

  // 动态获取 Ollama 本地拉取的模型列表
  ipcMain.handle('api:get-ollama-models', async (_, baseUrl: string) => {
    try {
      const urlObj = new URL(baseUrl || 'http://localhost:11434/v1')
      const tagsUrl = `${urlObj.protocol}//${urlObj.host}/api/tags`
      const response = await net.fetch(tagsUrl)
      if (response.ok) {
        const data: any = await response.json()
        return data.models?.map((m: any) => m.name) || []
      }
    } catch (e) {
      console.error('获取 Ollama 本地模型列表失败', e)
    }
    return []
  })

  // 动态获取大模型服务商的模型列表
  ipcMain.handle('api:get-models', async (_, config: { provider: string; apiKey?: string; baseUrl: string; credentialScope?: 'system' | 'wechat' }) => {
    const { provider, baseUrl } = config
    const scopedApiKey = config.credentialScope === 'wechat'
      ? wechatBotManager?.getRuntimeLlmConfig().apiKey
      : systemLlmConfig.apiKey
    const apiKey = config.apiKey || scopedApiKey || ''

    // 如果是 ollama，优先用原有的 api/tags 获取方式
    if (provider === 'ollama') {
      try {
        const urlObj = new URL(baseUrl || 'http://localhost:11434/v1')
        const tagsUrl = `${urlObj.protocol}//${urlObj.host}/api/tags`
        const response = await net.fetch(tagsUrl)
        if (response.ok) {
          const data: any = await response.json()
          const list = data.models?.map((m: any) => m.name) || []
          if (list.length > 0) return list
        }
        throw new Error(`HTTP ${response.status}: 获取 Ollama 模型失败`)
      } catch (e: any) {
        console.error('获取 Ollama 本地模型列表失败', e)
        throw new Error(`获取 Ollama 模型列表失败: ${e.message || e}`)
      }
    }

    // 通用 OpenAI 兼容的 models 接口
    try {
      let url = ''
      const headers: any = {
        'Content-Type': 'application/json'
      }
      if (provider === 'gemini') {
        const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
        url = `${effectiveBaseUrl}/models`
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      } else if (provider === 'openai') {
        const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1'
        url = `${effectiveBaseUrl}/models`
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      } else if (provider === 'deepseek') {
        const effectiveBaseUrl = baseUrl || 'https://api.deepseek.com/v1'
        url = `${effectiveBaseUrl}/models`
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      } else if (provider === 'ollama') {
        const effectiveBaseUrl = baseUrl || 'http://localhost:11434/v1'
        url = `${effectiveBaseUrl}/models`
      } else {
        // custom
        url = `${baseUrl}/models`
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      }

      const response = await net.fetch(url, {
        method: 'GET',
        headers
      })

      if (response.ok) {
        const data: any = await response.json()
        if (data && Array.isArray(data.data)) {
          return data.data.map((m: any) => m.id)
        }
        throw new Error('未获取到有效的模型列表结构')
      } else {
        const errText = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}${errText ? ': ' + errText : ''}`)
      }
    } catch (e: any) {
      console.error('获取通用模型列表失败', e)
      throw new Error(`获取模型列表失败: ${e.message || e}`)
    }
  })

  let db: Database | null = null

  const getDB = async (): Promise<Database> => {
    const chatDir = getActiveChatDir()
    const dbPath = join(chatDir, 'chat.db')

    if (db) {
      if (db.config.filename !== dbPath) {
        try {
          await db.close()
        } catch (ce) {
          console.error('关闭旧数据库连接失败', ce)
        }
        db = null
      }
    }

    if (!db) {
      db = await open({
        filename: dbPath,
        driver: sqlite3.Database
      })
      // 开启外键支持和 WAL 模式
      await db.exec('PRAGMA foreign_keys = ON')
      await db.exec('PRAGMA journal_mode = WAL')
      await db.exec('PRAGMA synchronous = NORMAL')
      // 创建表（默认包含 user_id 列）
      await db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT,
          time TEXT,
          pinned INTEGER DEFAULT 0,
          user_id TEXT DEFAULT 'system',
          context_summary TEXT DEFAULT '',
          created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          sender TEXT,
          text TEXT,
          time TEXT,
          is_thinking INTEGER DEFAULT 0,
          tool_steps TEXT,
          file_info TEXT,
          file_infos TEXT,
          is_error INTEGER DEFAULT 0,
          user_id TEXT DEFAULT 'system',
          is_summarized INTEGER DEFAULT 0,
          prompt_info TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS persona_memories (
          id TEXT PRIMARY KEY,
          fact TEXT NOT NULL,
          strength REAL DEFAULT 1.0,
          last_accessed_at INTEGER,
          created_at INTEGER,
          category TEXT DEFAULT 'profile',
          keywords TEXT,
          embedding TEXT,
          link TEXT
        );
        CREATE TABLE IF NOT EXISTS memory_entity_links (
          memory_id TEXT,
          entity_name TEXT NOT NULL,
          created_at INTEGER,
          PRIMARY KEY (memory_id, entity_name),
          FOREIGN KEY (memory_id) REFERENCES persona_memories(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_persona_memories_category ON persona_memories(category);
        CREATE INDEX IF NOT EXISTS idx_persona_memories_category_strength ON persona_memories(category, strength);
        CREATE INDEX IF NOT EXISTS idx_memory_entity_links_memory_id ON memory_entity_links(memory_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      `)

      // 动态升级旧数据库表结构，为已创建的表添加 user_id 字段
      try {
        await db.get("SELECT user_id FROM sessions LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT 'system'")
          console.log("成功升级 SQLite sessions 表结构，加入 user_id 列")
        } catch (alterErr) {
          console.error("升级 sessions 表结构添加 user_id 失败", alterErr)
        }
      }
      try {
        await db.get("SELECT user_id FROM messages LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE messages ADD COLUMN user_id TEXT DEFAULT 'system'")
          console.log("成功升级 SQLite messages 表结构，加入 user_id 列")
        } catch (alterErr) {
          console.error("升级 messages 表结构添加 user_id 失败", alterErr)
        }
      }
      // 动态升级：为老数据库添加 file_infos 列（多附件/上传图片持久化）
      try {
        await db.get("SELECT file_infos FROM messages LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE messages ADD COLUMN file_infos TEXT")
          console.log("成功升级 SQLite messages 表结构，加入 file_infos 列")
        } catch (alterErr) {
          console.error("升级 messages 表结构添加 file_infos 失败", alterErr)
        }
      }
      // 动态升级：为老数据库添加 pinned 列（会话置顶）
      try {
        await db.get("SELECT pinned FROM sessions LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0")
          console.log("成功升级 SQLite sessions 表结构，加入 pinned 列")
        } catch (alterErr) {
          console.error("升级 sessions 表结构添加 pinned 失败", alterErr)
        }
      }
      // 动态升级：为老数据库添加 is_summarized 列（用于上下文总结）
      try {
        await db.get("SELECT is_summarized FROM messages LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE messages ADD COLUMN is_summarized INTEGER DEFAULT 0")
          console.log("成功升级 SQLite messages 表结构，加入 is_summarized 列")
        } catch (alterErr) {
          console.error("升级 messages 表结构添加 is_summarized 失败", alterErr)
        }
      }
      // 动态升级：为老数据库添加 prompt_info 列（用于提示词及模型配置查看）
      try {
        await db.get("SELECT prompt_info FROM messages LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE messages ADD COLUMN prompt_info TEXT")
          console.log("成功升级 SQLite messages 表结构，加入 prompt_info 列")
        } catch (alterErr) {
          console.error("升级 messages 表结构添加 prompt_info 失败", alterErr)
        }
      }
      // 动态升级：为老数据库 sessions 表添加 context_summary 列（用于上下文摘要回注）
      try {
        await db.get("SELECT context_summary FROM sessions LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE sessions ADD COLUMN context_summary TEXT DEFAULT ''")
          console.log("成功升级 SQLite sessions 表结构，加入 context_summary 列")
        } catch (alterErr) {
          console.error("升级 sessions 表结构添加 context_summary 失败", alterErr)
        }
      }
      // 动态升级：为老数据库 sessions 表添加 created_at 列（用于保存创建会话的时间）
      try {
        await db.get("SELECT created_at FROM sessions LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE sessions ADD COLUMN created_at TEXT")
          // 将已有的 created_at 初始化为 time (兼容旧会话数据)
          await db.exec("UPDATE sessions SET created_at = time WHERE created_at IS NULL")
          console.log("成功升级 SQLite sessions 表结构，加入 created_at 列")
        } catch (alterErr) {
          console.error("升级 sessions 表结构添加 created_at 失败", alterErr)
        }
      }
      // 动态升级：为 persona_memories 添加 category, keywords, embedding 字段
      try {
        await db.get("SELECT category FROM persona_memories LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE persona_memories ADD COLUMN category TEXT DEFAULT 'profile'")
          console.log("成功升级 SQLite persona_memories 表结构，加入 category 列")
        } catch (alterErr) {
          console.error("升级 persona_memories 表结构添加 category 失败", alterErr)
        }
      }
      try {
        await db.get("SELECT keywords FROM persona_memories LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE persona_memories ADD COLUMN keywords TEXT")
          console.log("成功升级 SQLite persona_memories 表结构，加入 keywords 列")
        } catch (alterErr) {
          console.error("升级 persona_memories 表结构添加 keywords 失败", alterErr)
        }
      }
      try {
        await db.get("SELECT embedding FROM persona_memories LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE persona_memories ADD COLUMN embedding TEXT")
          console.log("成功升级 SQLite persona_memories 表结构，加入 embedding 列")
        } catch (alterErr) {
          console.error("升级 persona_memories 表结构添加 embedding 失败", alterErr)
        }
      }
      try {
        await db.get("SELECT link FROM persona_memories LIMIT 1")
      } catch (e) {
        try {
          await db.exec("ALTER TABLE persona_memories ADD COLUMN link TEXT")
          console.log("成功升级 SQLite persona_memories 表结构，加入 link 列")
        } catch (alterErr) {
          console.error("升级 persona_memories 表结构添加 link 失败", alterErr)
        }
      }
    }

    return db
  }

  const migrateOldSessionsIfExist = async (): Promise<void> => {
    const chatDir = getActiveChatDir()
    const oldJsonPath = join(chatDir, 'sessions.json')

    if (fs.existsSync(oldJsonPath)) {
      console.log('检测到旧的 sessions.json 历史文件，正在迁移到 SQLite...')
      try {
        const dataStr = fs.readFileSync(oldJsonPath, 'utf-8')
        const sessions = JSON.parse(dataStr)
        if (Array.isArray(sessions)) {
          const database = await getDB()

          await database.run('BEGIN TRANSACTION')
          try {
            for (const s of sessions) {
              await database.run(
                'INSERT OR REPLACE INTO sessions (id, name, time, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
                s.id, s.name || '新会话', s.time || '', s.userId || 'system', s.createdAt || s.time || ''
              )
              if (Array.isArray(s.messages)) {
                for (const m of s.messages) {
                  const msgId = String(m.id || `${Date.now()}-${Math.random()}`)
                  const sender = m.sender || 'system'
                  const text = m.text || ''
                  const time = m.time || ''
                  const isThinking = m.isThinking ? 1 : 0
                  const toolSteps = m.toolSteps ? JSON.stringify(m.toolSteps) : null
                  const fileInfo = m.fileInfo ? JSON.stringify(m.fileInfo) : null
                  const fileInfos = m.fileInfos
                    ? JSON.stringify(m.fileInfos.map((f: any) => { const { objectUrl: _o, ...rest } = f; return rest }))
                    : null
                  const isError = m.isError ? 1 : 0
                  const userId = m.userId || 'system'
                  const isSummarized = m.isSummarized ? 1 : 0

                  await database.run(`
                    INSERT OR REPLACE INTO messages 
                    (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, file_infos, is_error, user_id, is_summarized) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  `, msgId, s.id, sender, text, time, isThinking, toolSteps, fileInfo, fileInfos, isError, userId, isSummarized)
                }
              }
            }
            await database.run('COMMIT')
            console.log('数据迁移成功！')
          } catch (txErr) {
            await database.run('ROLLBACK')
            throw txErr
          }
        }
        // 迁移成功后重命名备份
        const backupPath = join(chatDir, 'sessions.json.bak')
        fs.renameSync(oldJsonPath, backupPath)
        console.log(`已将旧配置文件重命名为: ${backupPath}`)
      } catch (e) {
        console.error('迁移旧 sessions.json 历史记录失败', e)
      }
    }
  }

  // 读取本地聊天记录
  ipcMain.handle('api:get-local-sessions', async (_, options?: { loadAll?: boolean; activeSessionId?: string; todayOnly?: boolean }) => {
    try {
      await migrateOldSessionsIfExist()

      const database = await getDB()
      const now = new Date()
      const todayDash = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const todaySlash = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`
      const sessionDateFilter = options?.todayOnly
        ? 'WHERE created_at LIKE ? OR created_at LIKE ? OR time LIKE ? OR time LIKE ?'
        : ''
      const sessionDateParams = options?.todayOnly
        ? [`${todayDash}%`, `${todaySlash}%`, `${todayDash}%`, `${todaySlash}%`]
        : []
      const dbSessions = await database.all(`
        SELECT id, name, time, pinned, user_id, context_summary, created_at
        FROM sessions
        ${sessionDateFilter}
        ORDER BY created_at DESC
      `, ...sessionDateParams)
      const fallbackActiveSession = dbSessions.find((s: any) => s.pinned !== 1 && !s.id.startsWith('wechat:')) || dbSessions[0]
      const requestedActiveSession = dbSessions.find((session: any) => session.id === options?.activeSessionId)
      const activeSessionId = requestedActiveSession?.id || fallbackActiveSession?.id

      let dbMessages: any[] = []
      if (dbSessions.length > 0) {
        const activeMessageColumns = `
          m.rowid AS msg_rowid, m.id, m.session_id, m.sender, m.text, m.time,
          m.is_thinking, m.tool_steps, m.file_info, m.file_infos, m.is_error,
          m.user_id, m.is_summarized,
          CASE WHEN m.prompt_info IS NOT NULL THEN 1 ELSE 0 END AS has_prompt_info
        `
        const previewMessageColumns = `
          m.rowid AS msg_rowid, m.id, m.session_id, m.sender, m.text, m.time,
          m.is_thinking, m.file_info, m.file_infos, m.is_error, m.user_id, m.is_summarized,
          CASE WHEN m.prompt_info IS NOT NULL THEN 1 ELSE 0 END AS has_prompt_info
        `
        const activeMessages = activeSessionId
          ? await database.all(`
              SELECT ${activeMessageColumns}
              FROM messages m
              WHERE m.session_id = ?
              ORDER BY m.rowid DESC
              LIMIT 20
            `, activeSessionId)
          : []
        const previewSessionIds = dbSessions
          .map((session: any) => session.id)
          .filter((sessionId: string) => sessionId !== activeSessionId)
        const previewMessages = previewSessionIds.length > 0
          ? await database.all(`
              SELECT ${previewMessageColumns}
              FROM messages m
              INNER JOIN (
                SELECT session_id, MAX(rowid) AS msg_rowid
                FROM messages
                WHERE session_id IN (${previewSessionIds.map(() => '?').join(', ')})
                GROUP BY session_id
              ) latest ON latest.msg_rowid = m.rowid
            `, ...previewSessionIds)
          : []
        dbMessages = [...activeMessages, ...previewMessages]
      }

      // 将消息按 session_id 分组
      const messagesBySession: Record<string, any[]> = {}
      for (const m of dbMessages as any[]) {
        let toolSteps = undefined
        if (m.tool_steps) {
          try { toolSteps = JSON.parse(m.tool_steps) } catch (e) { console.error(e) }
        }
        let fileInfo = undefined
        if (m.file_info) {
          try {
            const fi = JSON.parse(m.file_info)
            const { objectUrl: _o, ...restFi } = fi
            fileInfo = restFi
          } catch (e) { console.error(e) }
        }
        let fileInfos = undefined
        if (m.file_infos) {
          try {
            const arr = JSON.parse(m.file_infos)
            fileInfos = arr.map((f: any) => { const { objectUrl: _o, ...rest } = f; return rest })
          } catch (e) { console.error(e) }
        }
        let restoredId: string | number = m.id
        if (/^\d+$/.test(m.id)) {
          const num = Number(m.id)
          if (String(num) === m.id) {
            restoredId = num
          }
        }

        const msgObj = {
          id: restoredId,
          msg_rowid: m.msg_rowid,
          sender: m.sender,
          text: m.text,
          time: m.time,
          isThinking: m.is_thinking === 1,
          toolSteps,
          fileInfo,
          fileInfos,
          isError: m.is_error === 1,
          userId: m.user_id || 'system',
          isSummarized: m.is_summarized === 1,
          hasPromptInfo: m.has_prompt_info === 1
        }

        if (!messagesBySession[m.session_id]) {
          messagesBySession[m.session_id] = []
        }
        messagesBySession[m.session_id].push(msgObj)
      }

      const result: any[] = []
      for (const s of dbSessions as any[]) {
        const msgs = messagesBySession[s.id] || []
        // 重新恢复正常的时间升序排列
        msgs.sort((a, b) => a.msg_rowid - b.msg_rowid)

        result.push({
          id: s.id,
          name: s.name,
          time: s.time,
          createdAt: s.created_at,
          pinned: s.id.startsWith('wechat:') ? true : (s.pinned === 1),
          userId: s.user_id || 'system',
          contextSummary: s.context_summary || '',
          messages: msgs
        })
      }
      return result
    } catch (e) {
      console.error('从 SQLite 读取聊天记录失败', e)
    }
    return null
  })

  ipcMain.handle('api:get-message-prompt-info', async (_, messageId: string | number) => {
    try {
      const database = await getDB()
      const row = await database.get('SELECT prompt_info FROM messages WHERE id = ?', String(messageId))
      if (!row?.prompt_info) return null
      return JSON.parse(row.prompt_info)
    } catch (e) {
      console.error('读取消息 prompt_info 失败', e)
      return null
    }
  })

  type SessionMutation =
    | { type: 'session-upsert'; session: any }
    | { type: 'session-update'; sessionId: string; updates: any }
    | { type: 'session-delete'; sessionId: string }
    | { type: 'message-upsert'; sessionId: string; message: any; sessionTime?: string }
    | { type: 'messages-upsert'; messages: any[] }
    | { type: 'message-delete'; messageId: string }
    | { type: 'refresh'; sessionId?: string }

  const broadcastSessionMutation = (sourceWebContentsId: number | undefined, mutation: SessionMutation) => {
    const windows = [mainWindow, agentWindow, inputWindow]
    for (const window of windows) {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) continue
      if (sourceWebContentsId !== undefined && window.webContents.id === sourceWebContentsId) continue
      window.webContents.send('api:sessions-updated', mutation)
    }
  }

  // 创建会话
  ipcMain.handle('api:create-session', async (event, session: any) => {
    try {
      const database = await getDB()
      const isWechat = session.id?.startsWith('wechat:')
      const createdAt = session.createdAt || session.time || new Date().toLocaleString('zh-CN', { hour12: false })
      const insertResult = await database.run(
        'INSERT OR IGNORE INTO sessions (id, name, time, pinned, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        session.id,
        session.name || '(未命名)',
        session.time,
        (session.pinned || isWechat) ? 1 : 0,
        session.userId || 'system',
        createdAt
      )
      if (!insertResult?.changes) {
        console.warn('[Session] 拒绝创建重复会话 ID:', session.id)
        return false
      }
      broadcastSessionMutation(event.sender.id, {
        type: 'session-upsert',
        session: {
          ...session,
          createdAt,
          messages: Array.isArray(session.messages) ? session.messages : [],
          pinned: Boolean(session.pinned || isWechat),
          userId: session.userId || 'system'
        }
      })
      return true
    } catch (e) {
      console.error('创建会话失败', e)
      return false
    }
  })

  // 更新会话
  ipcMain.handle('api:update-session', async (event, sessionId: string, updates: any) => {
    try {
      const database = await getDB()
      const keys = Object.keys(updates)
      if (keys.length === 0) return true
      const sets: string[] = []
      const values: any[] = []
      for (const key of keys) {
        let dbKey = key
        if (key === 'userId') dbKey = 'user_id'
        if (key === 'contextSummary') dbKey = 'context_summary'
        let val = updates[key]
        if (key === 'pinned') {
          val = (val || sessionId.startsWith('wechat:')) ? 1 : 0
        }
        sets.push(`${dbKey} = ?`)
        values.push(val)
      }
      values.push(sessionId)
      const sql = `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`
      await database.run(sql, ...values)
      broadcastSessionMutation(event.sender.id, {
        type: 'session-update',
        sessionId,
        updates: {
          ...updates,
          ...(Object.prototype.hasOwnProperty.call(updates, 'pinned')
            ? { pinned: Boolean(updates.pinned || sessionId.startsWith('wechat:')) }
            : {})
        }
      })
      return true
    } catch (e) {
      console.error('更新会话失败', e)
      return false
    }
  })

  // 确保微信会话存在（使用 INSERT OR IGNORE 避开级联删除，并且默认置顶）
  ipcMain.handle('api:ensure-wechat-session', async (event, sessionId: string, nickname: string) => {
    try {
      const database = await getDB()
      const timeStr = new Date().toLocaleString('zh-CN', { hour12: false })
      const insertResult = await database.run(
        'INSERT OR IGNORE INTO sessions (id, name, time, pinned, user_id, created_at) VALUES (?, ?, ?, 1, ?, ?)',
        sessionId,
        nickname,
        timeStr,
        sessionId.replace('wechat:', ''),
        timeStr
      )
      // 如果已存在但未置顶，强制置顶
      await database.run(
        'UPDATE sessions SET pinned = 1 WHERE id = ?',
        sessionId
      )
      if ((insertResult.changes || 0) > 0) {
        broadcastSessionMutation(event.sender.id, {
          type: 'session-upsert',
          session: {
            id: sessionId,
            name: nickname,
            time: timeStr,
            createdAt: timeStr,
            pinned: true,
            userId: sessionId.replace('wechat:', ''),
            messages: []
          }
        })
      } else {
        broadcastSessionMutation(event.sender.id, {
          type: 'session-update',
          sessionId,
          updates: { pinned: true }
        })
      }
      return true
    } catch (e) {
      console.error('确保微信会话存在失败', e)
      return false
    }
  })

  // 删除会话
  ipcMain.handle('api:delete-session', async (event, sessionId: string) => {
    try {
      const database = await getDB()
      await database.run('DELETE FROM sessions WHERE id = ?', sessionId)

      // 如果删除的是微信会话，同步从微信活跃好友列表中清除该记录
      if (sessionId.startsWith('wechat:') && wechatBotManager) {
        const userId = sessionId.replace('wechat:', '')
        wechatBotManager.removeActiveChat(userId)
      }

      const chatDir = getActiveChatDir()
      const safe1 = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      const safe2 = sessionId.replace(/[<>:"/\\|?*]/g, '_')

      const path1 = join(chatDir, safe1)
      const path2 = join(chatDir, safe2)

      try {
        if (fs.existsSync(path1)) {
          await shell.trashItem(path1)
        }
        if (safe2 !== safe1 && fs.existsSync(path2)) {
          await shell.trashItem(path2)
        }
      } catch (err) {
        console.error(`删除会话附件目录失败 (${sessionId}):`, err)
      }

      broadcastSessionMutation(event.sender.id, { type: 'session-delete', sessionId })
      return true
    } catch (e) {
      console.error('删除会话失败', e)
      return false
    }
  })

  const messageUpsertSql = `
    INSERT INTO messages
      (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, file_infos, is_error, user_id, is_summarized, prompt_info)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      sender = excluded.sender,
      text = excluded.text,
      time = excluded.time,
      is_thinking = excluded.is_thinking,
      tool_steps = excluded.tool_steps,
      file_info = excluded.file_info,
      file_infos = excluded.file_infos,
      is_error = excluded.is_error,
      user_id = excluded.user_id,
      is_summarized = excluded.is_summarized,
      prompt_info = COALESCE(excluded.prompt_info, messages.prompt_info)
  `

  const serializeMessageForDb = (m: any) => {
    const msgId = String(m.id)
    const sender = m.sender || 'system'
    const text = m.text || ''
    const time = m.time || ''
    const isThinking = m.isThinking ? 1 : 0
    const toolSteps = m.toolSteps ? JSON.stringify(m.toolSteps) : null
    const fileInfo = m.fileInfo ? JSON.stringify(m.fileInfo) : null
    const fileInfos = m.fileInfos
      ? JSON.stringify(m.fileInfos.map((f: any) => { const { objectUrl: _o, ...rest } = f; return rest }))
      : null
    const isError = m.isError ? 1 : 0
    const userId = m.userId || 'system'
    const isSummarized = m.isSummarized ? 1 : 0
    const promptInfo = m.promptInfo ? JSON.stringify(m.promptInfo) : null
    return {
      msgId,
      sender,
      text,
      time,
      userId,
      values: [msgId, m.sessionId, sender, text, time, isThinking, toolSteps, fileInfo, fileInfos, isError, userId, isSummarized, promptInfo]
    }
  }

  // 保存消息
  ipcMain.handle('api:save-message', async (event, m: any) => {
    try {
      const database = await getDB()
      const serialized = serializeMessageForDb(m)
      const { sender, text, time, userId } = serialized
      await database.run(messageUpsertSql, ...serialized.values)

      // 每次保存消息时，同步更新会话的最后活跃时间以维持正确的最近会话列表排序
      await database.run('UPDATE sessions SET time = ? WHERE id = ?', time, m.sessionId)

      broadcastSessionMutation(event.sender.id, {
        type: 'message-upsert',
        sessionId: m.sessionId,
        sessionTime: time,
        message: {
          ...m,
          id: m.id,
          sender,
          text,
          time,
          isThinking: Boolean(m.isThinking),
          isError: Boolean(m.isError),
          userId,
          isSummarized: Boolean(m.isSummarized)
        }
      })
      return true
    } catch (e) {
      console.error('保存消息失败', e)
      return false
    }
  })

  // 批量保存消息 (使用事务优化，合并通知以消除频繁 IPC/渲染带来的卡顿)
  ipcMain.handle('api:save-messages', async (event, messages: any[]) => {
    try {
      if (!Array.isArray(messages) || messages.length === 0) return true
      const database = await getDB()
      const latestSessionTimes = new Map<string, string>()
      
      await database.run('BEGIN TRANSACTION')
      for (const m of messages) {
        const serialized = serializeMessageForDb(m)
        await database.run(messageUpsertSql, ...serialized.values)
        if (m.sessionId) latestSessionTimes.set(m.sessionId, serialized.time)
      }
      for (const [sessionId, time] of latestSessionTimes) {
        await database.run('UPDATE sessions SET time = ? WHERE id = ?', time, sessionId)
      }
      await database.run('COMMIT')
      broadcastSessionMutation(event.sender.id, {
        type: 'messages-upsert',
        messages: messages.map(message => ({
          ...message,
          isThinking: Boolean(message.isThinking),
          isError: Boolean(message.isError),
          isSummarized: Boolean(message.isSummarized)
        }))
      })
      return true
    } catch (e) {
      console.error('批量保存消息失败', e)
      try {
        const database = await getDB()
        await database.run('ROLLBACK')
      } catch (_) {}
      return false
    }
  })

  // 删除消息
  ipcMain.handle('api:delete-message', async (event, messageId: string) => {
    try {
      const database = await getDB()
      await database.run('DELETE FROM messages WHERE id = ?', messageId)
      broadcastSessionMutation(event.sender.id, { type: 'message-delete', messageId })
      return true
    } catch (e) {
      console.error('删除消息失败', e)
      return false
    }
  })

  registerMemoryAPIs({
    getDB,
    getActiveChatDir,
    getActiveStorageDir,
    getSystemLlmConfig: () => systemLlmConfig,
    callLlmInternal
  })

  ipcMain.handle('api:get-skills-path', () => {
    return getActiveSkillsDir()
  })

  ipcMain.handle('api:open-skills-folder', async () => {
    await shell.openPath(getActiveSkillsDir())
  })

  const unzipSkillPack = async (zipPath: string, destDir: string): Promise<void> => {
    try {
      const data = await fs.promises.readFile(zipPath)
      const zip = await JSZip.loadAsync(data)
      if (!fs.existsSync(destDir)) {
        await fs.promises.mkdir(destDir, { recursive: true })
      }
      for (const [filename, file] of Object.entries(zip.files)) {
        if (file.dir) {
          await fs.promises.mkdir(join(destDir, filename), { recursive: true })
        } else {
          const fileData = await file.async('nodebuffer')
          const filePath = join(destDir, filename)
          await fs.promises.mkdir(dirname(filePath), { recursive: true })
          await fs.promises.writeFile(filePath, fileData)
        }
      }
      console.log(`[Skills] 成功解压技能包: ${basename(zipPath)} 到 ${destDir}`)
    } catch (e) {
      console.error(`[Skills] 解压技能包失败: ${zipPath}`, e)
    }
  }

  const readSkillsFolder = async (): Promise<any[]> => {
    try {
      const skillsPath = getActiveSkillsDir()
      const files = await fs.promises.readdir(skillsPath)
      const list: any[] = []
      for (const file of files) {
        if (file.toLowerCase().endsWith('.zip')) {
          const filePath = join(skillsPath, file)
          const stat = await fs.promises.stat(filePath)
          
          // 自动解压处理
          const folderName = file.substring(0, file.length - 4)
          const folderPath = join(skillsPath, folderName)
          let needsUnzip = false
          
          if (!fs.existsSync(folderPath)) {
            needsUnzip = true
          } else {
            const folderStat = await fs.promises.stat(folderPath)
            if (folderStat.mtime.getTime() < stat.mtime.getTime()) {
              needsUnzip = true
            }
          }
          
          if (needsUnzip) {
            console.log(`[Skills] 检测到技能包 ${file} 未解压或有更新，正在进行解压...`)
            await unzipSkillPack(filePath, folderPath)
          }

          list.push({
            name: file,
            size: stat.size,
            mtime: stat.mtime.toISOString()
          })
        }
      }
      return list
    } catch (e) {
      console.error(e)
      return []
    }
  }

  ipcMain.handle('api:get-skills-list', async () => {
    return await readSkillsFolder()
  })

  ipcMain.handle('api:upload-skill-pack', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return []
    const result = await dialog.showOpenDialog(window, {
      title: '选择 ZIP 技能包',
      defaultPath: getActiveSkillsDir(),
      filters: [{ name: 'Zip Files', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return await readSkillsFolder()
    }

    const skillsPath = getActiveSkillsDir()
    for (const filePath of result.filePaths) {
      const destPath = join(skillsPath, basename(filePath))
      await fs.promises.copyFile(filePath, destPath)
    }

    return await readSkillsFolder()
  })

  ipcMain.handle('api:delete-skill', async (_, name: string) => {
    try {
      const skillsPath = getActiveSkillsDir()
      const filePath = join(skillsPath, name)
      if (fs.existsSync(filePath)) {
        await shell.trashItem(filePath)
      }
      // 同时清理对应的解包文件夹
      if (name.toLowerCase().endsWith('.zip')) {
        const folderName = name.substring(0, name.length - 4)
        const folderPath = join(skillsPath, folderName)
        if (fs.existsSync(folderPath)) {
          await shell.trashItem(folderPath)
        }
      }
    } catch (e) {
      console.error(e)
    }
    return await readSkillsFolder()
  })

  // 辅助递归寻找 skill.md (限制深度，防止超大目录卡死)
  async function findSkillMds(dirPath: string, maxDepth = 4, currentDepth = 0): Promise<string[]> {
    if (currentDepth > maxDepth) return []
    let results: string[] = []
    try {
      const items = await fs.promises.readdir(dirPath, { withFileTypes: true })
      for (const item of items) {
        if (item.isDirectory()) {
          const subResults = await findSkillMds(join(dirPath, item.name), maxDepth, currentDepth + 1)
          results = results.concat(subResults)
        } else if (item.isFile() && item.name.toLowerCase() === 'skill.md') {
          results.push(join(dirPath, item.name))
        }
      }
    } catch (e) {
      // 忽略无法读取的目录
    }
    return results
  }

  // 获取已启用的技能中的 SKILL.md 内容作为 System Prompt
  ipcMain.handle('api:get-active-skills-prompt', async (_, enabledSkillNames: string[]) => {
    try {
      if (!enabledSkillNames || enabledSkillNames.length === 0) return ''
      const skillsPath = getActiveSkillsDir()
      const prompts: string[] = []
      
      for (const zipName of enabledSkillNames) {
        const folderName = zipName.toLowerCase().endsWith('.zip') 
          ? zipName.substring(0, zipName.length - 4)
          : zipName
        const folderPath = join(skillsPath, folderName)
        
        if (fs.existsSync(folderPath)) {
          const mdPaths = await findSkillMds(folderPath)
          for (const mdPath of mdPaths) {
            const content = await fs.promises.readFile(mdPath, 'utf-8')
            if (content.trim()) {
              let relativeName = mdPath.replace(folderPath, '').replace(/^[\\/]/, '')
              prompts.push(`### 技能规约: ${folderName} [${relativeName}]\n${content.trim()}`)
            }
          }
        }
      }
      
      return prompts.join('\n\n---\n\n')
    } catch (e) {
      console.error('[Skills] 获取已启用技能提示词失败:', e)
      return ''
    }
  })

  // 4.5. 文本文件选择与加载接口（支持 PDF/Word/Excel/CSV 等格式）
  ipcMain.handle('api:select-file', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: '选择上传的文件',
      properties: ['openFile'],
      filters: [
        { name: '文档文件', extensions: ['pdf', 'docx', 'xlsx', 'xls', 'csv'] },
        { name: '文本与代码文件', extensions: ['txt', 'md', 'js', 'jsx', 'ts', 'tsx', 'json', 'html', 'css', 'py', 'java', 'c', 'cpp', 'sh', 'bat', 'yml', 'yaml', 'ini', 'xml'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const filePath = result.filePaths[0]
    const name = basename(filePath)
    const ext = name.split('.').pop()?.toLowerCase() || ''

    try {
      let content = ''

      if (ext === 'pdf') {
        // PDF 文件解析
        const buffer = await fs.promises.readFile(filePath)
        const parser = new PDFParse({ data: buffer })
        const textResult = await parser.getText()
        content = limitAttachmentTextPreview(textResult.text || '')
        if (!content.trim()) {
          content = '[PDF 文件已加载，但未能提取到文本内容（可能是扫描件或纯图片 PDF）]'
        }
      } else if (ext === 'docx') {
        // Word 文档解析
        const buffer = await fs.promises.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        content = result.value || ''
        if (!content.trim()) {
          content = '[Word 文档已加载，但内容为空]'
        }
      } else if (ext === 'xlsx' || ext === 'xls') {
        // Excel 文件解析
        const workbook = XLSX.readFile(filePath)
        const sheets: string[] = []
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const csv = XLSX.utils.sheet_to_csv(sheet)
          if (csv.trim()) {
            // 过滤掉模板表达式（如 ${erd.cloud.pdm...}），这些是源工具的占位符
            const cleaned = csv.replace(/\$\{[^}]*\}/g, '').replace(/,{2,}/g, ',').replace(/^,+|,+$/gm, '')
            sheets.push(`[工作表: ${sheetName}]\n${cleaned}`)
          }
        }
        content = sheets.join('\n\n') || '[Excel 文件已加载，但内容为空]'
      } else if (ext === 'csv') {
        // CSV 文件解析
        const csvContent = await fs.promises.readFile(filePath, 'utf-8')
        const parsed = Papa.parse(csvContent, { header: true })
        if (parsed.data && parsed.data.length > 0) {
          // 转为可读的文本格式
          const headers = parsed.meta.fields || []
          const rows = parsed.data.slice(0, 500) as any[] // 限制最多 500 行
          content = `列名: ${headers.join(', ')}\n\n`
          content += rows.map((row, i) => `第${i + 1}行: ${headers.map(h => `${h}=${row[h] ?? ''}`).join(', ')}`).join('\n')
          if ((parsed.data as any[]).length > 500) {
            content += `\n\n... 共 ${parsed.data.length} 行，已截取前 500 行`
          }
        } else {
          content = '[CSV 文件已加载，但内容为空]'
        }
      } else {
        // 纯文本文件（txt, md, js, json 等）
        content = await fs.promises.readFile(filePath, 'utf-8')
      }

      return { name, path: filePath, content }
    } catch (e: any) {
      throw new Error(`读取文件失败: ${e.message}`)
    }
  })

  // 解析指定路径的文档文件内容（供粘贴/拖拽文件时使用）
  ipcMain.handle('api:select-attachment-files', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return []
    const result = await dialog.showOpenDialog(window, {
      title: '选择聊天附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '常用附件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'html', 'css', 'xml', 'yaml', 'yml', 'zip', 'rar', '7z', 'mp3', 'wav', 'flac', 'ogg', 'mp4', 'avi', 'mkv', 'mov'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('api:parse-file-content', async (_, filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    try {
      if (ext === 'pdf') {
        const buffer = await fs.promises.readFile(filePath)
        const parser = new PDFParse({ data: buffer })
        const textResult = await parser.getText()
        return limitAttachmentTextPreview(textResult.text || '') || '[PDF 未能提取到文本内容]'
      } else if (ext === 'docx') {
        const buffer = await fs.promises.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        return result.value || '[Word 文档内容为空]'
      } else if (ext === 'xlsx' || ext === 'xls') {
        const workbook = XLSX.readFile(filePath)
        const sheets: string[] = []
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const csv = XLSX.utils.sheet_to_csv(sheet)
          if (csv.trim()) sheets.push(`[工作表: ${sheetName}]\n${csv}`)
        }
        return sheets.join('\n\n') || '[Excel 文件内容为空]'
      } else if (ext === 'csv') {
        const csvContent = await fs.promises.readFile(filePath, 'utf-8')
        const parsed = Papa.parse(csvContent, { header: true })
        if (parsed.data && parsed.data.length > 0) {
          const headers = parsed.meta.fields || []
          const rows = parsed.data.slice(0, 500) as any[]
          let text = `列名: ${headers.join(', ')}\n\n`
          text += rows.map((row, i) => `第${i + 1}行: ${headers.map(h => `${h}=${row[h] ?? ''}`).join(', ')}`).join('\n')
          if ((parsed.data as any[]).length > 500) text += `\n\n... 共 ${parsed.data.length} 行，已截取前 500 行`
          return text
        }
        return '[CSV 文件内容为空]'
      } else {
        return await fs.promises.readFile(filePath, 'utf-8')
      }
    } catch (e: any) {
      return `[文件解析失败: ${e.message}]`
    }
  })

  // 解析文件为 HTML（用于富文本预览，保留排版）
  ipcMain.handle('api:parse-file-html', async (_, filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    try {
      if (ext === 'docx') {
        const buffer = await fs.promises.readFile(filePath)
        const result = await mammoth.convertToHtml({ buffer })
        const html = result.value || ''
        if (!html.trim()) return '<p style="color:#999">[Word 文档内容为空]</p>'
        // 包装基础样式
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: -apple-system, "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.7; color: #1e293b; padding: 16px; margin: 0; }
          table { border-collapse: collapse; width: 100%; margin: 12px 0; }
          td, th { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; }
          th { background: #f1f5f9; font-weight: 600; }
          h1 { font-size: 22px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
          h2 { font-size: 18px; }
          h3 { font-size: 16px; }
          img { max-width: 100%; height: auto; }
          p { margin: 0 0 10px 0; }
          ul, ol { padding-left: 20px; }
          blockquote { border-left: 3px solid #cbd5e1; padding-left: 12px; color: #64748b; margin: 10px 0; }
        </style></head><body>${html}</body></html>`
      } else if (ext === 'xlsx' || ext === 'xls') {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.readFile(filePath)
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: -apple-system, "Microsoft YaHei", sans-serif; font-size: 13px; padding: 16px; margin: 0; color: #1e293b; }
          table { border-collapse: collapse; width: 100%; margin: 12px 0; }
          td, th { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; font-size: 12px; }
          th { background: #f1f5f9; font-weight: 600; position: sticky; top: 0; }
          .sheet-title { font-size: 15px; font-weight: 700; margin: 16px 0 8px; color: #334155; }
        </style></head><body>`
        for (const ws of workbook.worksheets) {
          html += `<div class="sheet-title">📊 ${ws.name}</div><table>`
          ws.eachRow((row, rowNumber) => {
            html += '<tr>'
            row.eachCell({ includeEmpty: true }, (cell) => {
              const tag = rowNumber === 1 ? 'th' : 'td'
              const val = cell.value !== null && cell.value !== undefined ? String(cell.value) : ''
              html += `<${tag}>${val}</${tag}>`
            })
            html += '</tr>'
          })
          html += '</table>'
        }
        html += '</body></html>'
        return html
      } else if (ext === 'csv') {
        const csvContent = await fs.promises.readFile(filePath, 'utf-8')
        const parsed = Papa.parse(csvContent, { header: true })
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: -apple-system, sans-serif; font-size: 13px; padding: 16px; margin: 0; }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #cbd5e1; padding: 4px 8px; font-size: 12px; }
          th { background: #f1f5f9; font-weight: 600; }
        </style></head><body><table>`
        if (parsed.meta.fields) {
          html += '<tr>' + parsed.meta.fields.map(f => `<th>${f}</th>`).join('') + '</tr>'
        }
        for (const row of (parsed.data as any[]).slice(0, 200)) {
          html += '<tr>' + Object.values(row).map(v => `<td>${v ?? ''}</td>`).join('') + '</tr>'
        }
        html += '</table></body></html>'
        return html
      } else {
        // 普通文本文件
        const text = await fs.promises.readFile(filePath, 'utf-8')
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: Consolas, Monaco, monospace; font-size: 13px; line-height: 1.5; padding: 16px; margin: 0; white-space: pre-wrap; word-break: break-all; color: #1e293b; }
        </style></head><body>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</body></html>`
      }
    } catch (e: any) {
      return `<p style="color:red">预览失败: ${e.message}</p>`
    }
  })

  // 读取文件为 base64（供 docx-preview 等前端库使用）
  ipcMain.handle('api:read-file-base64', async (_, filePath: string) => {
    try {
      const buffer = await fs.promises.readFile(filePath)
      return buffer.toString('base64')
    } catch (e: any) {
      return null
    }
  })

  // 将剪贴板图片（base64 data URL）保存为临时文件，返回文件路径
  ipcMain.handle('api:save-clipboard-image', async (_, dataUrl: string) => {
    return saveBase64ImageInternal(dataUrl)
  })

  // 获取已生成的文件列表（支持按会话过滤）
  ipcMain.handle('api:get-generated-files', async (_, sessionId?: string) => {
    try {
      const genDir = getGeneratedFilesDir(sessionId)
      const files = await fs.promises.readdir(genDir)
      const list: { name: string; path: string; size: number; time: string }[] = []
      for (const file of files) {
        const filePath = join(genDir, file)
        const stat = await fs.promises.stat(filePath)
        if (stat.isFile()) {
          list.push({
            name: file,
            path: filePath,
            size: stat.size,
            time: stat.mtime.toISOString()
          })
        }
      }
      // 按修改时间倒序
      list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      return list
    } catch (e) {
      console.error('获取生成文件列表失败', e)
      return []
    }
  })

  // 生成文件另存为（弹出系统保存对话框）
  ipcMain.handle('api:save-generated-file-as', async (_, filePath: string) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!win) return false
    const fileName = basename(filePath)
    const ext = fileName.split('.').pop() || ''
    const result = await dialog.showSaveDialog(win, {
      title: '保存文件',
      defaultPath: fileName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return false
    try {
      await fs.promises.copyFile(filePath, result.filePath)
      return true
    } catch (e) {
      console.error('另存为失败', e)
      return false
    }
  })

  // 导出单轮大模型工具调用过程，供失败诊断和提示词/工具策略调优。
  ipcMain.handle('api:export-tool-trace', async (_, payload: { defaultFileName?: string; trace?: any }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!win) return { success: false, error: '没有可用窗口' }
    if (!payload?.trace || typeof payload.trace !== 'object') {
      return { success: false, error: '调用过程数据无效' }
    }

    const safeBaseName = String(payload.defaultFileName || 'agentpet-tool-trace.json')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\.+$/g, '')
      .slice(0, 120)
    const defaultFileName = safeBaseName.toLowerCase().endsWith('.json') ? safeBaseName : `${safeBaseName}.json`
    const result = await dialog.showSaveDialog(win, {
      title: '导出调用过程',
      defaultPath: defaultFileName,
      filters: [{ name: 'JSON 调试文件', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { success: false }

    try {
      await fs.promises.writeFile(result.filePath, JSON.stringify(payload.trace, null, 2), 'utf8')
      return { success: true, filePath: result.filePath }
    } catch (error: any) {
      console.error('导出调用过程失败', error)
      return { success: false, error: error?.message || String(error) }
    }
  })

  // 删除已生成的文件
  ipcMain.handle('api:delete-generated-file', async (_, filePath: string, sessionId?: string) => {
    try {
      const genDir = getGeneratedFilesDir(sessionId)
      if (!filePath.startsWith(genDir)) return false
      await shell.trashItem(filePath)
      return true
    } catch (e) {
      return false
    }
  })

  // toolDefinitions has been replaced by toolRegistry manifests

  function getFormattedTools(_isFrontend: boolean, simplify = false): any[] {

    const list: any[] = []

    // 从 toolRegistry 获取所有内置工具定义
    const allTools = toolRegistry.getAllToolsInfo()
    for (const tool of Object.values(allTools)) {
      list.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      })
    }

    // 添加 MCP 外部工具
    const mcpTools = mcpManager.getTools()
    for (const tool of mcpTools) {
      list.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: simplify ? { type: 'object', properties: {} } : (tool.inputSchema || { type: 'object', properties: {} })
        }
      })
    }

    return list
  }


  // handleLongTaskAutoMemory has been relocated to AgentExecutor

  async function callLlmInternal(
    config: any,
    messages: any[],
    workspacePath?: string,
    event?: Electron.IpcMainInvokeEvent,
    onToolEvent?: (evt: { type: string; name: string; args?: any; result?: string; contextTokens?: number; detail?: string; sources?: any[]; status?: string; beforeTokens?: number; afterTokens?: number; activeToolContextTokens?: number; archivePath?: string; removedMessages?: number }) => void
  ): Promise<string> {
    config = {
      ...config,
      apiKey: config?.apiKey || systemLlmConfig.apiKey
    }
    const executor = new AgentExecutor()
    let thisController: AbortController
    const sessionId = config.sessionId || 'default'

    // 检查此 session 在开始前是否已经被主动终止了
    if (abortedSessionIds.has(sessionId)) {
      abortedSessionIds.delete(sessionId)
      throw new Error('UserAborted')
    }

    if (event && !(config as any).isBackground) {
      const oldController = activeLlmAbortControllers.get(sessionId)
      if (oldController) {
        try { oldController.abort() } catch (_) { /* ignore */ }
      }
      thisController = new AbortController()
      activeLlmAbortControllers.set(sessionId, thisController)
    } else {
      thisController = new AbortController()
    }

    try {
      const stepStream = executor.run(
        {
          ...config,
          sandboxMode: sandboxMode,
          event
        },
        messages,
        workspacePath,
        thisController.signal
      )

      let finalResponse = ''
      for await (const step of stepStream) {
        if (step.type === 'think') {
          if (event) {
            event.sender.send('api:llm-tool-event', {
              type: 'think',
              name: '深度思考过程',
              detail: step.detail,
              timestamp: Date.now(),
              messageId: config.messageId,
              sessionId: config.sessionId
            })
          }
          if (onToolEvent) {
            onToolEvent({ type: 'think', name: '深度思考过程', detail: step.detail })
          }
        } else if (step.type === 'tool_call') {
          if (event) {
            event.sender.send('api:llm-tool-event', {
              type: 'tool_call',
              name: step.name,
              args: step.args,
              timestamp: Date.now(),
              messageId: config.messageId,
              sessionId: config.sessionId
            })
          }
          if (onToolEvent) {
            onToolEvent({ type: 'tool_call', name: step.name, args: step.args })
          }
        } else if (step.type === 'tool_result') {
          if (event) {
            event.sender.send('api:llm-tool-event', {
              type: 'tool_result',
              name: step.name,
              result: step.result,
              contextTokens: step.contextTokens,
              timestamp: Date.now(),
              messageId: config.messageId,
              sessionId: config.sessionId
            })
          }
          if (onToolEvent) {
            onToolEvent({ type: 'tool_result', name: step.name, result: step.result, contextTokens: step.contextTokens })
          }
        } else if (step.type === 'context_compaction') {
          const payload = {
            type: 'context_compaction',
            name: '上下文压缩',
            status: step.status,
            beforeTokens: step.beforeTokens,
            afterTokens: step.afterTokens,
            activeToolContextTokens: step.activeToolContextTokens,
            archivePath: step.archivePath,
            removedMessages: step.removedMessages,
            detail: step.detail,
            timestamp: Date.now(),
            messageId: config.messageId,
            sessionId: config.sessionId
          }
          if (event) event.sender.send('api:llm-tool-event', payload)
          if (onToolEvent) onToolEvent(payload)
        } else if (step.type === 'generated_files') {
          if (event) {
            event.sender.send('api:llm-tool-event', {
              type: 'generated_files',
              files: step.files,
              timestamp: Date.now(),
              messageId: config.messageId,
              sessionId: config.sessionId
            })
          }
        } else if (step.type === 'web_sources') {
          if (event) {
            event.sender.send('api:llm-tool-event', {
              type: 'web_sources',
              sources: step.sources,
              timestamp: Date.now(),
              messageId: config.messageId,
              sessionId: config.sessionId
            })
          }
          if (onToolEvent) {
            onToolEvent({ type: 'web_sources', name: 'web_sources', sources: step.sources })
          }
        } else if (step.type === 'token') {
          const payload = {
            model: config.model,
            provider: config.provider,
            promptTokens: step.promptTokens,
            completionTokens: step.completionTokens,
            timestamp: Date.now(),
            sessionId: config.sessionId,
            messageId: config.messageId
          }
          if (event) {
            event.sender.send('api:llm-token-usage', payload)
          } else {
            if (agentWindow && !agentWindow.isDestroyed()) {
              agentWindow.webContents.send('api:llm-token-usage', payload)
            } else if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('api:llm-token-usage', payload)
            }
          }
        } else if (step.type === 'text') {
          finalResponse = step.content
        } else if (step.type === 'text_delta') {
          if (event) {
            event.sender.send('api:llm-text-delta', {
              content: step.content,
              sessionId: config.sessionId,
              messageId: config.messageId
            })
          }
        } else if (step.type === 'error') {
          throw new Error(step.message)
        }
      }

      if (activeLlmAbortControllers.get(sessionId) === thisController) {
        activeLlmAbortControllers.delete(sessionId)
      }
      abortedSessionIds.delete(sessionId)
      return finalResponse
    } catch (e: any) {
      if (activeLlmAbortControllers.get(sessionId) === thisController) {
        activeLlmAbortControllers.delete(sessionId)
      }
      abortedSessionIds.delete(sessionId)
      if (thisController.signal.aborted) {
        throw new Error('UserAborted')
      }
      throw e
    }
  }

  // 大模型对外代理调用
  ipcMain.handle('api:call-llm', async (event, config, messages, workspacePath) => {
    return callLlmInternal(config, messages, workspacePath, event)
  })

  // 获取当前可用的工具定义（用于明盒化展示）
  ipcMain.handle('api:get-tools-definition', async () => {
    try {
      // 触发懒连接，确保 MCP 工具定义已加载
      await mcpManager.ensureConnected()
      const tools = getFormattedTools(true)
      return tools
    } catch (err) {
      console.error('获取工具定义失败:', err)
      return []
    }
  })

  // 微信智能助手接口通道注册
  ipcMain.handle('api:wechat-start-login', async () => {
    if (wechatBotManager) {
      wechatBotManager.startLogin()
      return true
    }
    return false
  })

  ipcMain.handle('api:wechat-logout', async () => {
    if (wechatBotManager) {
      await wechatBotManager.logout()
      return true
    }
    return false
  })

  ipcMain.handle('api:wechat-get-status', () => {
    if (wechatBotManager) {
      return wechatBotManager.getState()
    }
    return null
  })

  ipcMain.handle('api:wechat-save-settings', async (_, settings) => {
    if (wechatBotManager) {
      return wechatBotManager.saveSettings(settings)
    }
    return false
  })

  ipcMain.handle('api:get-system-llm-config', () => {
    return sanitizeSystemLlmConfig(systemLlmConfig)
  })

  ipcMain.handle('api:sync-llm-config', (_, config) => {
    systemLlmConfig = saveSecureSystemLlmConfig(config)
    return sanitizeSystemLlmConfig(systemLlmConfig)
  })

  ipcMain.handle('api:sync-mcp-config', (_, config) => {
    systemMcpConfig = mcpManager.saveSystemMcpConfig(config)
    return mcpManager.getSanitizedSystemMcpConfig()
  })

  ipcMain.handle('api:test-mcp-server', async (_, config) => {
    try {
      const [
        { Client },
        { StreamableHTTPClientTransport },
        { SSEClientTransport }
      ] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
        import('@modelcontextprotocol/sdk/client/sse.js')
      ])

      const runtimeServer = systemMcpConfig.servers.find((server: any) => server.id === config.id)
      const apiKey = config.apiKey || runtimeServer?.apiKey || ''
      const headers: Record<string, string> = {}
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

      let client = new Client(
        { name: 'AgentPet-Test', version: '1.0.0' },
        { capabilities: {} }
      )
      let usedProtocol = 'Streamable HTTP'
      const mcpType = config.type || 'stream'

      if (mcpType === 'stream') {
        const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
        await client.connect(transport)
        usedProtocol = 'Streamable HTTP'
      } else if (mcpType === 'sse') {
        const transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
        await client.connect(transport)
        usedProtocol = 'SSE'
      } else {
        // auto 模式
        try {
          const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          await client.connect(transport)
          usedProtocol = 'Streamable HTTP'
        } catch (httpErr: any) {
          console.warn(`[MCP Test] Streamable HTTP 失败，回退到 SSE: ${httpErr.message}`)
          client = new Client(
            { name: 'AgentPet-Test', version: '1.0.0' },
            { capabilities: {} }
          )
          usedProtocol = 'SSE'
          const transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } } as any)
          await client.connect(transport)
        }
      }

      const response = await client.listTools()
      await client.close()

      // 计算工具定义的大小
      const tools = response.tools || []
      const toolsJson = JSON.stringify(tools)
      const toolsCharCount = toolsJson.length
      const estimatedTokens = Math.round(toolsCharCount * 0.5)

      return {
        success: true,
        tools,
        protocol: usedProtocol,
        toolsSize: {
          charCount: toolsCharCount,
          estimatedTokens
        }
      }
    } catch (err: any) {
      console.error('MCP Test Error:', err)
      return { success: false, error: err.message || err.toString() }
    }
  })

  ipcMain.handle('api:get-mcp-config', () => {
    return mcpManager.getSanitizedSystemMcpConfig()
  })

  ipcMain.handle('api:get-active-mcp-servers', async () => {
    // 首次查询时触发懒连接，确保大模型能获取到 MCP 工具列表
    await mcpManager.ensureConnected()
    return mcpManager.getActiveServers()
  })

  ipcMain.handle('api:get-paddleocr-token-status', () => ({ configured: hasPaddleOcrToken() }))

  ipcMain.handle('api:set-paddleocr-token', (_, token: string) => {
    setPaddleOcrToken(typeof token === 'string' ? token : '')
    return { configured: true }
  })

  ipcMain.handle('api:clear-paddleocr-token', () => {
    clearPaddleOcrToken()
    return { configured: false }
  })

  // 初始化微信 Bot 服务
  wechatBotManager = new WechatBotManager({
    getDB,
    callLlm: async (config, messages, sessionId, onToolEvent) => {
      const effectiveConfig = config.useSystemConfig
        ? {
          ...config,
          provider: systemLlmConfig.provider,
          apiKey: systemLlmConfig.apiKey,
          baseUrl: systemLlmConfig.baseUrl,
          model: systemLlmConfig.model,
          temperature: config.temperature !== undefined ? config.temperature : systemLlmConfig.temperature
        }
        : config

      if (effectiveConfig.provider !== 'ollama' && !effectiveConfig.apiKey) {
        throw new Error('微信 Bot 未配置大模型密钥 (API Key)')
      }

      return callLlmInternal({ ...effectiveConfig, sessionId }, messages, getActiveStorageDir(), undefined, onToolEvent)
    },
    getMcpToolNames: async () => {
      await mcpManager.ensureConnected()
      return mcpManager.getTools().map((t: any) => t.name)
    },
    onStatusUpdated: () => {
      if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.webContents.send('api:wechat-status-updated', wechatBotManager?.getState())
      }
    },
    notifyRenderSessionUpdate: (sessionId?: string) => {
      if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.webContents.send('api:wechat-session-updated', sessionId)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('api:wechat-session-updated', sessionId)
      }
    },
    getStorageDir: getActiveStorageDir
  })

  // 尝试自动恢复登录会话
  wechatBotManager.autoReconnect()

  // 应用退出前清理所有进行中的请求和连接，防止重启后假死
  app.on('before-quit', () => {
    console.log('[App] 正在清理进行中的请求和连接...')

    // 1. 中止所有正在进行的 LLM 请求
    for (const controller of activeLlmAbortControllers.values()) {
      try { controller.abort() } catch (_) { /* ignore */ }
    }
    activeLlmAbortControllers.clear()

    // 2. 解除所有等待授权的阻塞，避免 loading 挂起
    permissionManager.clearPendingPermissions()
    clarificationManager.cancelPending()
    credentialManager.cancelPending()
    officeRuntimeManager.cancelPending()


    // 3. 断开所有 MCP 服务连接
    mcpManager.disconnectAll().catch(() => { })

    // 4. 断开微信 Bot
    if (wechatBotManager) {
      wechatBotManager.shutdown().catch(() => { })
    }

    // 5. 中止所有运行中的 RPA 任务并释放浏览器资源
    PlaywrightRpaExecutor.cleanAll().catch(() => { })
    activeRpaRunControllers.forEach(controller => controller.close())
    activeRpaRunControllers.clear()
    if (rpaScheduleTimer) {
      clearInterval(rpaScheduleTimer)
      rpaScheduleTimer = null
    }

    // 6. 销毁所有可能遗留的全局快捷键
    try { globalShortcut.unregisterAll() } catch (_) { }
  })












  // ── RPA 可视化流程系统 IPC 接口注册 ──────────────────
  ipcMain.handle('api:get-rpa-manifest', async () => {
    return await rpaStorage.loadManifest()
  })

  ipcMain.handle('api:save-rpa-manifest', async (_, manifest: rpaStorage.RpaTaskManifest[]) => {
    return await rpaStorage.saveManifest(manifest)
  })

  ipcMain.handle('api:get-rpa-task-flow', async (_, taskId: string) => {
    return await rpaStorage.loadTaskFlow(taskId)
  })

  ipcMain.handle('api:save-rpa-task-flow', async (_, taskId: string, flowData: rpaStorage.RpaTaskFlow) => {
    return await rpaStorage.saveTaskFlow(taskId, flowData)
  })

  ipcMain.handle('api:run-rpa-task', async (event, taskId: string, flowData: { nodes: any[], edges: any[] }) => {
    activeRpaRunControllers.get(taskId)?.close()
    const task = (await rpaStorage.loadManifest()).find(item => item.id === taskId)
    let controller: Awaited<ReturnType<typeof createRpaRunController>>
    controller = await createRpaRunController({
      taskName: task?.name || 'RPA 流程',
      totalSteps: flowData.nodes.length,
      onPause: () => PlaywrightRpaExecutor.getActive(taskId)?.pause(),
      onResume: () => PlaywrightRpaExecutor.getActive(taskId)?.resume(),
      onStop: async () => {
        const executor = PlaywrightRpaExecutor.getActive(taskId)
        if (executor) await executor.stop()
        controller.setResult('stopped', '流程已由用户停止')
        event.sender.send('api:rpa-status-event', { taskId, status: 'idle' })
        setTimeout(() => {
          controller.close()
          activeRpaRunControllers.delete(taskId)
        }, 1200)
      }
    })
    activeRpaRunControllers.set(taskId, controller)
    await PlaywrightRpaExecutor.run(taskId, flowData.nodes, flowData.edges, event.sender, {}, {
      onStep: step => {
        controller.updateStep(step)
        if (step.state === 'paused') controller.setPaused(true, !step.requiresConfirmation)
        else if (step.state === 'running') controller.setPaused(false)
      },
      onStatus: (status, errorMsg) => {
        if (status === 'running') return
        controller.setResult(status, status === 'success' ? '流程执行完成' : errorMsg || '流程执行失败')
        setTimeout(() => {
          controller.close()
          activeRpaRunControllers.delete(taskId)
        }, status === 'success' ? 1400 : 2600)
      }
    })
    return true
  })

  ipcMain.handle('api:pause-rpa-task', async (_, taskId: string) => {
    const executor = PlaywrightRpaExecutor.getActive(taskId)
    if (!executor) return false
    executor.pause()
    activeRpaRunControllers.get(taskId)?.setPaused(true)
    return true
  })

  ipcMain.handle('api:resume-rpa-task', async (_, taskId: string) => {
    const executor = PlaywrightRpaExecutor.getActive(taskId)
    if (!executor) return false
    executor.resume()
    activeRpaRunControllers.get(taskId)?.setPaused(false)
    return true
  })

  ipcMain.handle('api:stop-rpa-task', async (_, taskId: string) => {
    const executor = PlaywrightRpaExecutor.getActive(taskId)
    if (executor) {
      await executor.stop()
      const controller = activeRpaRunControllers.get(taskId)
      controller?.setResult('stopped', '流程已停止')
      setTimeout(() => controller?.close(), 900)
      activeRpaRunControllers.delete(taskId)
      return true
    }
    return false
  })

  ipcMain.handle('api:respond-rpa-manual-confirm', async (_, taskId: string, updates?: Record<string, any>) => {
    const executor = PlaywrightRpaExecutor.getActive(taskId)
    if (executor) {
      executor.resume(updates)
      return true
    }
    return false
  })

  ipcMain.handle('api:list-rpa-secrets', () => getRpaSecretService().list())
  ipcMain.handle('api:capture-rpa-desktop-target', (_, delayMs?: number) => captureDesktopTarget(delayMs))

  ipcMain.handle('api:create-rpa-secret', (_, input: {
    ref: RpaSecretRef
    plaintext: string
    label: string
    allowedWorkflowIds: string[]
    allowedSurfaces: RpaSurface[]
  }) => getRpaSecretService().create(input.ref, input.plaintext, input))

  ipcMain.handle('api:rotate-rpa-secret', (_, ref: RpaSecretRef, plaintext: string) =>
    getRpaSecretService().rotate(ref, plaintext)
  )

  ipcMain.handle('api:set-rpa-secret-status', (_, ref: RpaSecretRef, status: 'active' | 'disabled') =>
    getRpaSecretService().setStatus(ref, status)
  )

  ipcMain.handle('api:delete-rpa-secret', async (_, ref: RpaSecretRef) => {
    const referencedBy: string[] = []
    for (const workflow of await rpaStorage.loadManifest()) {
      const flow = await rpaStorage.loadTaskFlow(workflow.id)
      if (flow && JSON.stringify(flow).includes(ref)) referencedBy.push(workflow.id)
    }
    return getRpaSecretService().delete(ref, referencedBy)
  })



  createTray()
  createWindow()
  startRpaScheduleMonitor()

  // 启动后台物理内存和 V8 缓存垃圾清理定时器 (每 60 秒运行一次)
  setInterval(() => {
    try {
      // 1. 主进程 V8 垃圾回收
      if (global.gc) {
        global.gc()
      }
      // 2. 清理全局 session 缓存与 Code Cache，避免 Chromium 网络/代码缓存无限增加
      if (session.defaultSession) {
        session.defaultSession.clearCache().catch(() => { })
        session.defaultSession.clearCodeCaches({}).catch(() => { })
      }
      // 3. 遍历所有活动窗口，在其对应的渲染进程中强行触发 GC
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed() && win.webContents) {
          win.webContents.executeJavaScript('window.gc && window.gc()').catch(() => { })
        }
      })
      // 4. 强制修剪物理工作集内存，将不活跃物理内存压降回虚拟内存
      trimPhysicalMemory()
    } catch (err) {
      console.error('[Memory] 定时内存清理失败:', err)
    }
  }, 60000)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // 保持后台系统托盘常驻，所有窗口关闭时不自动退出整个应用
})


// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

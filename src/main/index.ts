import { app, shell, BrowserWindow, ipcMain, screen, protocol, net, Tray, Menu, dialog, Notification, session, clipboard, nativeImage, desktopCapturer } from 'electron'
import { join, basename } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as fs from 'fs'
import * as os from 'os'
import Database from 'better-sqlite3'
import { EdgeTTS } from 'node-edge-tts'
import { toolRegistry } from './tools/core/tool-registry'
import { registerBuiltinTools } from './tools/builtin'
import { unifiedToolExecutor } from './tools/core/tool-executor'
import { mcpManager } from './tools/mcp/mcp-manager'
import { permissionManager } from './tools/security/permission-manager'
import { sshManager } from './tools/builtin/terminal/ssh-manager'




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
import { WechatBotManager } from './wechatBot'

let wechatBotManager: WechatBotManager | null = null
let systemLlmConfig: any = { provider: 'gemini', apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', temperature: 0.7 }
let systemMcpConfig: any = { servers: [] }

function loadSystemLlmConfig() {
  try {
    const configPath = join(app.getPath('userData'), 'system_llm_config.json')
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8')
      systemLlmConfig = { ...systemLlmConfig, ...JSON.parse(data) }
    }
  } catch (e) {
    console.error('加载全局大模型配置文件失败:', e)
  }
}

function saveSystemLlmConfig(config: any) {
  try {
    const configPath = join(app.getPath('userData'), 'system_llm_config.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch (e) {
    console.error('保存全局大模型配置文件失败:', e)
  }
}

function saveSystemMcpConfig(config: any) {
  try {
    const configPath = join(app.getPath('userData'), 'system_mcp_config.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch (e) {
    console.error('保存全局 MCP 配置文件失败:', e)
  }
}



import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// McpManager and shell session management have been refactored to separate modules.


// 消除 GPU Shader Disk Cache 权限警告（不影响渲染性能）
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

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

// 窗口尺寸
const winWidth = 260
const winHeight = 300

let agentWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let inputWindow: BrowserWindow | null = null
let pendingAgentInput: string = '' // 缓存快捷输入框传递过来的待发送文本
let tray: Tray | null = null
let customModelDir = ''
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
let currentLlmAbortController: AbortController | null = null
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
  if (agentWindow) {
    if (agentWindow.isMinimized()) agentWindow.restore()
    agentWindow.focus()
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
      sandbox: false
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
    agentWindow?.show()
    // 窗口就绪后，如果有待投递的通知则发送（数据在 localStorage 中）
    if (pendingAgentInput && agentWindow && !agentWindow.isDestroyed()) {
      agentWindow.webContents.send('pending-input')
      pendingAgentInput = ''
    }
  })

  agentWindow.on('closed', () => {
    agentWindow = null
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
    agentWindow.close()
  }
})

ipcMain.handle('api:is-agent-window-maximized', () => {
  if (agentWindow && !agentWindow.isDestroyed()) {
    return agentWindow.isMaximized()
  }
  return false
})


function createInputWindow(x?: number, y?: number, initialImage?: { path: string; base64: string; width: number; height: number }): void {
  if (inputWindow) {
    if (inputWindow.isMinimized()) inputWindow.restore()
    if (x !== undefined && y !== undefined) {
      inputWindow.setBounds({ x, y, width: 400, height: 90 })
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
    targetX = Math.round(scrWidth / 2 - 400 / 2)
    targetY = Math.round(scrHeight * 0.22)
  }

  inputWindow = new BrowserWindow({
    width: 400,
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
  })
}

function createTray(mainWindow: BrowserWindow): void {
  tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示虚拟体',
      click: () => {
        mainWindow.show()
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

function createWindow(): void {
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
      sandbox: false
    }
  })

  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
    // 初始开启穿透，直到鼠标移动到宠物元素上
    win.setIgnoreMouseEvents(true, { forward: true })
    createTray(win)
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
    win.setIgnoreMouseEvents(ignore, options)
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
    if (mainWindow) {
      mainWindow.hide()
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

  ipcMain.on('send-chat-to-pet', (_, text: string, isNewSession?: boolean, imagePath?: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat-to-pet', text, isNewSession, imagePath)
    }
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
    const inputWidth = 400
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
    // 同步通知 Agent 窗口刷新会话（回复已写入数据库）
    if (agentWindow && !agentWindow.isDestroyed()) {
      agentWindow.webContents.send('api:wechat-session-updated')
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
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // 恢复物理持久化的大模型配置，保证后台微信 Bot 在前端就绪前能拿到有效密钥
  registerBuiltinTools()
  loadSystemLlmConfig()
  mcpManager.loadSystemMcpConfig()


  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

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
    : join(process.resourcesPath, 'live2d')

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

  protocol.handle('local-file', async (request) => {
    try {
      // local-file 协议注册了 standard:true，Chromium 会将 local-file://C:/path 中的 C: 当 hostname 解析
      // 渲染层统一使用 local-file:///C:/path（三斜杠），此时 pathname=/C:/path
      // 需要去掉 Windows 盘符路径前多余的前导斜杠
      const parsedUrl = new URL(request.url)
      let filePath = decodeURIComponent(parsedUrl.pathname)
      // Windows 绝对路径：/C:/path → C:/path
      if (/^\/[A-Za-z]:\//.test(filePath)) {
        filePath = filePath.slice(1)
      }
      const fileUrl = pathToFileURL(filePath).toString()
      const response = await net.fetch(fileUrl)
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD')
      return new Response(response.body, { status: response.status, headers })
    } catch (e) {
      console.error('[local-file protocol error]', e)
      return new Response('Not Found', { status: 404 })
    }
  })

  ipcMain.on('ping', () => console.log('pong'))

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
      const fs = require('fs')
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
          if (mainWindow) {
            mainWindow.hide()
          }
          if (inputWindow && !inputWindow.isDestroyed()) {
            inputWindow.close()
          }
        }
      }
    ])
    menu.popup()
  })

  ipcMain.handle('api:abort-llm', () => {
    if (currentLlmAbortController) {
      currentLlmAbortController.abort()
      currentLlmAbortController = null
    }
    permissionManager.clearPendingPermissions()

    return true
  })

  ipcMain.handle('api:show-notification', async (_, title: string, body: string) => {
    try {
      const notification = new Notification({
        title,
        body,
        icon: icon
      })
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
      const cronPath = join(getActiveStorageDir(), 'cron_tasks.json')
      if (fs.existsSync(cronPath)) {
        const data = await fs.promises.readFile(cronPath, 'utf-8')
        return JSON.parse(data)
      }
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
        name: defaultConfig.name || 'Mao (默认形象)',
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
  ipcMain.handle('api:get-models', async (_, config: { provider: string; apiKey: string; baseUrl: string }) => {
    const { provider, apiKey, baseUrl } = config
    
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

  let db: Database.Database | null = null

  const getDB = (): Database.Database => {
    const chatDir = getActiveChatDir()
    const dbPath = join(chatDir, 'chat.db')

    if (db) {
      if (db.name !== dbPath) {
        try {
          db.close()
        } catch (ce) {
          console.error('关闭旧数据库连接失败', ce)
        }
        db = null
      }
    }

    if (!db) {
      db = new Database(dbPath)
      // 开启外键支持
      db.pragma('foreign_keys = ON')
      // 创建表（默认包含 user_id 列）
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT,
          time TEXT,
          pinned INTEGER DEFAULT 0,
          user_id TEXT DEFAULT 'system'
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
          embedding TEXT
        );
        CREATE TABLE IF NOT EXISTS memory_entity_links (
          memory_id TEXT,
          entity_name TEXT NOT NULL,
          created_at INTEGER,
          PRIMARY KEY (memory_id, entity_name),
          FOREIGN KEY (memory_id) REFERENCES persona_memories(id) ON DELETE CASCADE
        );
      `)

      // 动态升级旧数据库表结构，为已创建的表添加 user_id 字段
      try {
        db.prepare("SELECT user_id FROM sessions LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT 'system'")
          console.log("成功升级 SQLite sessions 表结构，加入 user_id 列")
        } catch (alterErr) {
          console.error("升级 sessions 表结构添加 user_id 失败", alterErr)
        }
      }
      try {
        db.prepare("SELECT user_id FROM messages LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE messages ADD COLUMN user_id TEXT DEFAULT 'system'")
          console.log("成功升级 SQLite messages 表结构，加入 user_id 列")
        } catch (alterErr) {
          console.error("升级 messages 表结构添加 user_id 失败", alterErr)
        }
      }
      // 动态升级：为老数据库添加 file_infos 列（多附件/上传图片持久化）
      try {
        db.prepare("SELECT file_infos FROM messages LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE messages ADD COLUMN file_infos TEXT")
          console.log("成功升级 SQLite messages 表结构，加入 file_infos 列")
        } catch (alterErr) {
          console.error("升级 messages 表结构添加 file_infos 失败", alterErr)
        }
      }
      // 动态升级：为老数据库添加 pinned 列（会话置顶）
      try {
        db.prepare("SELECT pinned FROM sessions LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0")
          console.log("成功升级 SQLite sessions 表结构，加入 pinned 列")
        } catch (alterErr) {
          console.error("升级 sessions 表结构添加 pinned 失败", alterErr)
        }
      }
      // 动态升级：为老数据库添加 is_summarized 列（用于上下文总结）
      try {
        db.prepare("SELECT is_summarized FROM messages LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE messages ADD COLUMN is_summarized INTEGER DEFAULT 0")
          console.log("成功升级 SQLite messages 表结构，加入 is_summarized 列")
        } catch (alterErr) {
          console.error("升级 messages 表结构添加 is_summarized 失败", alterErr)
        }
      }
      // 动态升级：为 persona_memories 添加 category, keywords, embedding 字段
      try {
        db.prepare("SELECT category FROM persona_memories LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE persona_memories ADD COLUMN category TEXT DEFAULT 'profile'")
          console.log("成功升级 SQLite persona_memories 表结构，加入 category 列")
        } catch (alterErr) {
          console.error("升级 persona_memories 表结构添加 category 失败", alterErr)
        }
      }
      try {
        db.prepare("SELECT keywords FROM persona_memories LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE persona_memories ADD COLUMN keywords TEXT")
          console.log("成功升级 SQLite persona_memories 表结构，加入 keywords 列")
        } catch (alterErr) {
          console.error("升级 persona_memories 表结构添加 keywords 失败", alterErr)
        }
      }
      try {
        db.prepare("SELECT embedding FROM persona_memories LIMIT 1").all()
      } catch (e) {
        try {
          db.exec("ALTER TABLE persona_memories ADD COLUMN embedding TEXT")
          console.log("成功升级 SQLite persona_memories 表结构，加入 embedding 列")
        } catch (alterErr) {
          console.error("升级 persona_memories 表结构添加 embedding 失败", alterErr)
        }
      }
    }

    return db
  }

  const migrateOldSessionsIfExist = (): void => {
    const chatDir = getActiveChatDir()
    const oldJsonPath = join(chatDir, 'sessions.json')

    if (fs.existsSync(oldJsonPath)) {
      console.log('检测到旧的 sessions.json 历史文件，正在迁移到 SQLite...')
      try {
        const dataStr = fs.readFileSync(oldJsonPath, 'utf-8')
        const sessions = JSON.parse(dataStr)
        if (Array.isArray(sessions)) {
          const database = getDB()

          // 使用事务一次性写入
          const insertSession = database.prepare('INSERT OR REPLACE INTO sessions (id, name, time, user_id) VALUES (?, ?, ?, ?)')
          const insertMessage = database.prepare(`
            INSERT OR REPLACE INTO messages 
            (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, file_infos, is_error, user_id, is_summarized) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)

          const transaction = database.transaction((sessList: any[]) => {
            for (const s of sessList) {
              insertSession.run(s.id, s.name || '新会话', s.time || '', s.userId || 'system')
              if (Array.isArray(s.messages)) {
                for (const m of s.messages) {
                  const msgId = String(m.id || `${Date.now()}-${Math.random()}`)
                  const sender = m.sender || 'system'
                  const text = m.text || ''
                  const time = m.time || ''
                  const isThinking = m.isThinking ? 1 : 0
                  const toolSteps = m.toolSteps ? JSON.stringify(m.toolSteps) : null
                  const fileInfo = m.fileInfo ? JSON.stringify(m.fileInfo) : null
                  // fileInfos 保存时剔除 objectUrl（blob URL 重启后失效）
                  const fileInfos = m.fileInfos
                    ? JSON.stringify(m.fileInfos.map((f: any) => { const { objectUrl: _o, ...rest } = f; return rest }))
                    : null
                  const isError = m.isError ? 1 : 0
                  const userId = m.userId || 'system'
                  const isSummarized = m.isSummarized ? 1 : 0

                  insertMessage.run(msgId, s.id, sender, text, time, isThinking, toolSteps, fileInfo, fileInfos, isError, userId, isSummarized)
                }
              }
            }
          })

          transaction(sessions)
          console.log('数据迁移成功！')
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
  ipcMain.handle('api:get-local-sessions', async () => {
    try {
      migrateOldSessionsIfExist()

      const database = getDB()
      const dbSessions = database.prepare('SELECT * FROM sessions ORDER BY time ASC').all()
      const result: any[] = []

      const selectMessages = database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC')

      for (const s of dbSessions as any[]) {
        const dbMessages = selectMessages.all(s.id) as any[]
        const messages = dbMessages.map((m: any) => {
          let toolSteps = undefined
          if (m.tool_steps) {
            try { toolSteps = JSON.parse(m.tool_steps) } catch (e) { console.error(e) }
          }
          let fileInfo = undefined
          if (m.file_info) {
            try {
              const fi = JSON.parse(m.file_info)
              // 剔除失效的 blob objectUrl
              const { objectUrl: _o, ...restFi } = fi
              fileInfo = restFi
            } catch (e) { console.error(e) }
          }
          let fileInfos = undefined
          if (m.file_infos) {
            try {
              const arr = JSON.parse(m.file_infos)
              // 剔除失效的 blob objectUrl，渲染层统一走 local-file:// 协议
              fileInfos = arr.map((f: any) => { const { objectUrl: _o, ...rest } = f; return rest })
            } catch (e) { console.error(e) }
          }

          // 还原 id。如果是纯数字，转回 number
          let restoredId: string | number = m.id
          if (/^\d+$/.test(m.id)) {
            const num = Number(m.id)
            if (String(num) === m.id) {
              restoredId = num
            }
          }

          return {
            id: restoredId,
            sender: m.sender,
            text: m.text,
            time: m.time,
            isThinking: m.is_thinking === 1,
            toolSteps,
            fileInfo,
            fileInfos,
            isError: m.is_error === 1,
            userId: m.user_id || 'system',
            isSummarized: m.is_summarized === 1
          }
        })

        result.push({
          id: s.id,
          name: s.name,
          time: s.time,
          pinned: s.pinned === 1,
          userId: s.user_id || 'system',
          messages
        })
      }
      return result
    } catch (e) {
      console.error('从 SQLite 读取聊天记录失败', e)
    }
    return null
  })

  // 保存聊天记录到本地物理文件
  ipcMain.handle('api:save-local-sessions', async (_, sessions: any[]) => {
    try {
      const database = getDB()

      const insertSession = database.prepare('INSERT OR REPLACE INTO sessions (id, name, time, pinned, user_id) VALUES (?, ?, ?, ?, ?)')
      const insertMessage = database.prepare(`
        INSERT OR REPLACE INTO messages
        (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, file_infos, is_error, user_id, is_summarized)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const sessionIds = sessions.map(s => s.id)

      // 在事务开始前找出将被删除的会话
      let deletedSessions: { id: string }[] = []
      try {
        if (sessionIds.length > 0) {
          const placeholders = sessionIds.map(() => '?').join(',')
          deletedSessions = database.prepare(`SELECT id FROM sessions WHERE id NOT IN (${placeholders})`).all(...sessionIds) as { id: string }[]
        } else {
          deletedSessions = database.prepare('SELECT id FROM sessions').all() as { id: string }[]
        }
      } catch (err) {
        console.error('获取即将删除的会话失败', err)
      }

      const transaction = database.transaction((sessList: any[]) => {
        // 1. 删除已被删除 of sessions
        if (sessionIds.length > 0) {
          const placeholders = sessionIds.map(() => '?').join(',')
          database.prepare(`DELETE FROM sessions WHERE id NOT IN (${placeholders})`).run(...sessionIds)
        } else {
          database.prepare('DELETE FROM sessions').run()
        }

        for (const s of sessList) {
          insertSession.run(s.id, s.name, s.time, s.pinned ? 1 : 0, s.userId || 'system')

          // 收集当前 session 里的所有 message ID，用于删除已经不存在 the message
          const msgList = s.messages || []
          const msgIds = msgList.map((m: any) => String(m.id))

          if (msgIds.length > 0) {
            const placeholders = msgIds.map(() => '?').join(',')
            database.prepare(`DELETE FROM messages WHERE session_id = ? AND id NOT IN (${placeholders})`).run(s.id, ...msgIds)
          } else {
            database.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id)
          }

          for (const m of msgList) {
            const msgId = String(m.id)
            const sender = m.sender || 'system'
            const text = m.text || ''
            const time = m.time || ''
            const isThinking = m.isThinking ? 1 : 0
            const toolSteps = m.toolSteps ? JSON.stringify(m.toolSteps) : null
            const fileInfo = m.fileInfo ? JSON.stringify(m.fileInfo) : null
            // fileInfos 保存时剔除 objectUrl（blob URL 重启后失效）
            const fileInfos = m.fileInfos
              ? JSON.stringify(m.fileInfos.map((f: any) => { const { objectUrl: _o, ...rest } = f; return rest }))
              : null
            const isError = m.isError ? 1 : 0
            const userId = m.userId || 'system'
            const isSummarized = m.isSummarized ? 1 : 0

            insertMessage.run(msgId, s.id, sender, text, time, isThinking, toolSteps, fileInfo, fileInfos, isError, userId, isSummarized)
          }
        }
      })

      transaction(sessions)

      // 事务执行成功后，物理清理关联的本地物理文件目录
      if (deletedSessions.length > 0) {
        const chatDir = getActiveChatDir()
        for (const ds of deletedSessions) {
          // 兼容并清理两种安全命名替换方式的目录
          const safe1 = ds.id.replace(/[^a-zA-Z0-9_-]/g, '_')
          const safe2 = ds.id.replace(/[<>:"/\\|?*]/g, '_')
          
          const path1 = join(chatDir, safe1)
          const path2 = join(chatDir, safe2)
          
          try {
            if (fs.existsSync(path1)) {
              await fs.promises.rm(path1, { recursive: true, force: true })
              console.log(`[SaveLocalSessions] 成功物理清理会话目录: ${path1}`)
            }
            if (safe2 !== safe1 && fs.existsSync(path2)) {
              await fs.promises.rm(path2, { recursive: true, force: true })
              console.log(`[SaveLocalSessions] 成功物理清理会话目录: ${path2}`)
            }
          } catch (err) {
            console.error(`[SaveLocalSessions] 清理被删除会话目录失败 (${ds.id}):`, err)
          }
        }
      }

      return true
    } catch (e) {
      console.error('保存聊天记录到 SQLite 失败', e)
      return false
    }
  })

  // 追加写入每日 Markdown 摘要（用会话文件夹进行隔离）
  ipcMain.handle('api:append-memory-summary', async (_, sessionId: string, text: string) => {
    try {
      if (!sessionId) return false
      const chatDir = getActiveChatDir()
      const safeSessionId = sessionId.replace(/[<>:"/\\|?*]/g, '_')
      const sessionMemoryDir = join(chatDir, safeSessionId, 'memory')
      
      if (!fs.existsSync(sessionMemoryDir)) {
        await fs.promises.mkdir(sessionMemoryDir, { recursive: true })
      }

      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const fileName = `${year}-${month}-${day}.md`
      const filePath = join(sessionMemoryDir, fileName)

      await fs.promises.appendFile(filePath, text + '\n\n', 'utf-8')
      return true
    } catch (e) {
      console.error('追加写入每日摘要失败', e)
      return false
    }
  })

  // 计算两个向量的余弦相似度
  function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0
    let dotProduct = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i]
      normA += vecA[i] * vecA[i]
      normB += vecB[i] * vecB[i]
    }
    if (normA === 0 || normB === 0) return 0
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  // 获取文本的 Embedding 向量，支持优雅降级
  async function getEmbeddingInternal(
    config: { 
      provider: string; 
      apiKey: string; 
      baseUrl: string; 
      model: string; 
    }, 
    text: string
  ): Promise<number[] | null> {
    // 优先尝试 SiliconFlow 的免费高精度向量嵌入
    const sfApiKey = process.env.SILICONFLOW_API_KEY
    if (sfApiKey) {
      try {
        console.log('[Embedding] 正在通过 SiliconFlow (BAAI/bge-m3) 获取向量...')
        const sfResponse = await net.fetch("https://api.siliconflow.cn/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${sfApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            input: text,
            model: "BAAI/bge-m3"
          }),
          signal: AbortSignal.timeout(8000)
        })

        if (sfResponse.ok) {
          const sfData: any = await sfResponse.json()
          if (sfData && sfData.data && sfData.data[0] && sfData.data[0].embedding) {
            console.log('[Embedding] SiliconFlow 向量获取成功')
            return sfData.data[0].embedding
          }
        } else {
          const sfErr = await sfResponse.text().catch(() => '')
          console.warn(`[Embedding] SiliconFlow 响应错误 (HTTP ${sfResponse.status}): ${sfErr}，将尝试回退。`)
        }
      } catch (err) {
        console.warn('[Embedding] SiliconFlow 请求异常，将尝试回退至系统配置大模型向量:', err)
      }
    }

    // 回退逻辑：使用既有大模型提供商的向量接口
    try {
      const { provider, apiKey, baseUrl } = config
      if (!apiKey && provider !== 'ollama') {
        return null
      }
      let url = ''
      const headers: any = {
        'Content-Type': 'application/json'
      }
      const body: any = {
        input: text
      }

      if (provider === 'gemini') {
        const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
        url = `${effectiveBaseUrl}/embeddings`
        headers['Authorization'] = `Bearer ${apiKey}`
        body.model = 'text-embedding-004'
      } else if (provider === 'openai') {
        const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1'
        url = `${effectiveBaseUrl}/embeddings`
        headers['Authorization'] = `Bearer ${apiKey}`
        body.model = 'text-embedding-3-small'
      } else if (provider === 'deepseek') {
        return null
      } else if (provider === 'ollama') {
        const effectiveBaseUrl = baseUrl || 'http://localhost:11434/v1'
        url = `${effectiveBaseUrl}/embeddings`
        body.model = 'nomic-embed-text'
      } else {
        url = `${baseUrl}/embeddings`
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`
        }
        body.model = 'text-embedding-3-small'
      }

      const response = await net.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000)
      })

      if (!response.ok) {
        return null
      }

      const data: any = await response.json()
      if (data && data.data && data.data[0] && data.data[0].embedding) {
        return data.data[0].embedding
      }
      return null
    } catch (err) {
      console.warn('[Embedding] 回退向量接口异常，降级为纯文本模糊搜索', err)
      return null
    }
  }

  // 获取顶级全局画像 profile.md
  ipcMain.handle('api:get-memory-profile', async () => {
    try {
      const filePath = join(getActiveStorageDir(), 'memory', 'profile.md')
      if (fs.existsSync(filePath)) {
        return await fs.promises.readFile(filePath, 'utf-8')
      }
      return ''
    } catch (e) {
      console.error('读取 profile.md 失败', e)
      return ''
    }
  })

  // 覆盖写入顶级全局画像 profile.md
  ipcMain.handle('api:write-memory-profile', async (_, text: string) => {
    try {
      const dirPath = join(getActiveStorageDir(), 'memory')
      if (!fs.existsSync(dirPath)) {
        await fs.promises.mkdir(dirPath, { recursive: true })
      }
      const filePath = join(dirPath, 'profile.md')
      await fs.promises.writeFile(filePath, text, 'utf-8')
      return true
    } catch (e) {
      console.error('写入 profile.md 失败', e)
      return false
    }
  })

  // 第三层：系统内置画像整理与避坑经验沉淀的后台 pipeline
  ipcMain.handle('api:purify-memory-pipeline', async () => {
    try {
      const chatDir = getActiveChatDir()
      const database = getDB()
      const sessions = database.prepare('SELECT id, name FROM sessions').all() as { id: string; name: string }[]
      
      let allSummariesCombined = ''
      const processedFiles: string[] = []
      
      // 搜集所有会话下的 memory 文件夹内的 md 摘要
      for (const sess of sessions) {
        const safeSessionId = sess.id.replace(/[<>:"/\\|?*]/g, '_')
        const sessionMemoryDir = join(chatDir, safeSessionId, 'memory')
        if (fs.existsSync(sessionMemoryDir)) {
          const files = await fs.promises.readdir(sessionMemoryDir)
          const mdFiles = files.filter(f => f.toLowerCase().endsWith('.md') && !f.toLowerCase().endsWith('_已更新.md'))
          for (const file of mdFiles) {
            const filePath = join(sessionMemoryDir, file)
            const content = await fs.promises.readFile(filePath, 'utf-8')
            allSummariesCombined += `\n### 会话: ${sess.name} (日期: ${file.replace(/\.md$/i, '')})\n${content}\n`
            processedFiles.push(filePath)
          }
        }
      }

      // 辅助函数：自动扫描库内向量维度不符的老数据，重新生成向量嵌入并更新，同时一键补建老数据的实体关联图谱
      async function autoMigrateOldEmbeddings(db: any) {
        try {
          const rows = db.prepare("SELECT id, fact, keywords, embedding FROM persona_memories WHERE category = 'experience'").all() as any[]
          if (rows.length === 0) return

          // 1. 增量自动扫描并补建实体多对多关联图谱 (避免新数据库表中实体关系全空的问题)
          let linkRebuiltCount = 0
          for (const row of rows) {
            let keywordsList: string[] = []
            try {
              if (row.keywords) {
                const parsedKw = JSON.parse(row.keywords)
                keywordsList = Array.isArray(parsedKw) ? parsedKw : []
              }
            } catch {}

            if (keywordsList.length > 0) {
              const linkCount = db.prepare("SELECT COUNT(*) as cnt FROM memory_entity_links WHERE memory_id = ?").get(row.id) as { cnt: number }
              if (linkCount && linkCount.cnt === 0) {
                const insertLink = db.prepare("INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_name, created_at) VALUES (?, ?, ?)")
                const now = Date.now()
                for (const kw of keywordsList) {
                  if (kw && typeof kw === 'string' && kw.trim()) {
                    insertLink.run(row.id, kw.trim(), now)
                  }
                }
                linkRebuiltCount++
              }
            }
          }
          if (linkRebuiltCount > 0) {
            console.log(`[Migration] 成功为 ${linkRebuiltCount} 条历史经验自动完成了实体多对多关联图谱的重建补建`)
          }

          // 2. 检测期望的向量维度并做向量重嵌入
          let expectedLen = 1024 
          const sampleEmb = await getEmbeddingInternal(systemLlmConfig, "test")
          if (sampleEmb && sampleEmb.length > 0) {
            expectedLen = sampleEmb.length
          } else {
            console.log('[Migration] 未获取到当前活动的向量生成模型，跳过向量增量更新。')
            return
          }

          const rowsToMigrate = rows.filter(row => {
            if (!row.embedding) return true
            try {
              const parsed = JSON.parse(row.embedding)
              return !Array.isArray(parsed) || parsed.length !== expectedLen
            } catch {
              return true
            }
          })

          if (rowsToMigrate.length === 0) {
            return
          }

          console.log(`[Migration] 检测到有 ${rowsToMigrate.length} 条历史避坑数据没有向量或向量维度不匹配，正在重算并迁移更新...`)

          let updateCount = 0
          for (const row of rowsToMigrate) {
            try {
              const newEmb = await getEmbeddingInternal(systemLlmConfig, row.fact)
              if (newEmb && newEmb.length === expectedLen) {
                db.prepare("UPDATE persona_memories SET embedding = ? WHERE id = ?").run(JSON.stringify(newEmb), row.id)
                updateCount++
              }
            } catch (err) {
              console.error(`[Migration] 更新历史数据向量失败 (ID: ${row.id}):`, err)
            }
          }
          console.log(`[Migration] 历史向量库增量更新迁移完毕，成功更新了 ${updateCount} 条数据。当前使用维度为 ${expectedLen}`)
        } catch (migrationErr) {
          console.error('[Migration] 执行历史老数据向量增量更新抛出异常:', migrationErr)
        }
      }

      if (!allSummariesCombined.trim()) {
        console.log('[Purify] 无摘要历史，跳过大模型合并，只执行数据库状态清理。')
        await autoMigrateOldEmbeddings(database)
        return { success: true, count: 0, insertCount: 0 }
      }

      // 1. 合并更新全局画像 profile.md
      const currentProfilePath = join(getActiveStorageDir(), 'memory', 'profile.md')
      let currentProfile = ''
      if (fs.existsSync(currentProfilePath)) {
        currentProfile = await fs.promises.readFile(currentProfilePath, 'utf-8')
      }

      const profileSystemPrompt = `你是一个高级人物画像整理专家。你的任务是分析主人（用户）最近的对话摘要，提纯、合并并更新主人的全局长期人物画像。
人物画像必须严格按照以下五个维度进行整理：
1. 工作背景
2. 个人背景
3. 当前关注
4. 近期动态
5. 避坑重点与习惯

请合并新摘要中体现的信息，如果与过去的信息有冲突，以新的为准。
请以 Markdown 格式输出最新的全局人物画像（不要包含任何思考过程、JSON、多余的分析或客套话，直接输出画像的 Markdown 文本内容）。`

      const profileMessages = [
        { role: 'system', content: profileSystemPrompt },
        { role: 'user', content: `【当前的全局人物画像】\n${currentProfile || '（暂无）'}\n\n【最近收集的对话摘要历史】\n${allSummariesCombined}\n\n请根据上面的对话摘要，对当前的全局人物画像进行提纯、增量合并和覆盖更新，输出最新版本的画像。` }
      ]

      console.log('[Purify] 正在调用大模型更新人物画像...')
      const updatedProfile = await callLlmInternal(systemLlmConfig, profileMessages, getActiveStorageDir())
      
      const globalMemoryDir = join(getActiveStorageDir(), 'memory')
      if (!fs.existsSync(globalMemoryDir)) {
        await fs.promises.mkdir(globalMemoryDir, { recursive: true })
      }
      await fs.promises.writeFile(join(globalMemoryDir, 'profile.md'), updatedProfile.trim(), 'utf-8')
      console.log('[Purify] 人物画像 profile.md 覆盖更新成功。')

      // 2. 提取报错与避坑经验，写入 persona_memories
      const experienceSystemPrompt = `你是一个任务纠错与避坑经验沉淀专家。请分析主人最近的对话摘要（特别是工具执行失败或报错的部分），提取并总结出结构化的“纠错避坑经验”。
对于每一条经验，你必须输出为 JSON 格式的数组。格式如下：
[
  {
    "fact": "简明扼要的经验/事实描述，例如：在Windows下用read_file读写Excel时，如果Office软件正在占用，应先提示主人手动关闭。",
    "keywords": ["read_file", "excel", "permission", "locked"]
  }
]
如果你没有发现任何有价值的避坑经验或工具报错，请直接输出空数组 []。
请不要输出任何 Markdown 标记或多余的解释，只输出合法的 JSON 数组本身。`

      const experienceMessages = [
        { role: 'system', content: experienceSystemPrompt },
        { role: 'user', content: `【最近收集的对话摘要历史】\n${allSummariesCombined}\n\n请从中提取避坑经验并输出为 JSON 数组。` }
      ]

      console.log('[Purify] 正在调用大模型提炼避坑经验...')
      const experienceRawJson = await callLlmInternal(systemLlmConfig, experienceMessages, getActiveStorageDir())
      
      let jsonText = experienceRawJson.trim()
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(json)?/, '').replace(/```$/, '').trim()
      }
      
      let experiences: any[] = []
      try {
        experiences = JSON.parse(jsonText)
      } catch (je) {
        console.error('[Purify] 解析避坑经验 JSON 失败, raw response:', experienceRawJson, je)
      }

      let insertCount = 0
      if (Array.isArray(experiences) && experiences.length > 0) {
        for (const item of experiences) {
          if (!item.fact) continue
          
          let emb: number[] | null = null
          try {
            emb = await getEmbeddingInternal(systemLlmConfig, item.fact)
          } catch (ee) {
            console.error('[Purify] 获取向量失败', ee)
          }

          // 查询是否有相似的已有经验
          const rows = database.prepare("SELECT id, fact, embedding FROM persona_memories WHERE category = 'experience'").all() as any[]
          
          let matchedId: string | null = null
          if (emb && rows.length > 0) {
            for (const row of rows) {
              if (row.embedding) {
                try {
                  const dbEmb = JSON.parse(row.embedding)
                  if (Array.isArray(dbEmb)) {
                    const sim = cosineSimilarity(emb, dbEmb)
                    if (sim > 0.85) {
                      matchedId = row.id
                      break
                    }
                  }
                } catch {}
              }
            }
          }

          if (!matchedId) {
            const exactMatch = rows.find(r => r.fact.trim() === item.fact.trim())
            if (exactMatch) {
              matchedId = exactMatch.id
            }
          }

          const now = Date.now()
          const targetId = matchedId || `exp_${now}_${Math.random().toString(36).substring(2, 7)}`

          if (matchedId) {
            database.prepare("UPDATE persona_memories SET strength = MIN(1.0, strength + 0.3), last_accessed_at = ? WHERE id = ?")
              .run(now, matchedId)
            console.log(`[Purify] 强化已有避坑经验 (ID: ${matchedId})`)
          } else {
            database.prepare(`
              INSERT INTO persona_memories (id, fact, strength, last_accessed_at, created_at, category, keywords, embedding)
              VALUES (?, ?, 1.0, ?, ?, 'experience', ?, ?)
            `).run(
              targetId,
              item.fact,
              now,
              now,
              JSON.stringify(item.keywords || []),
              emb ? JSON.stringify(emb) : null
            )
            insertCount++
            console.log(`[Purify] 写入新避坑经验 (ID: ${targetId}): ${item.fact}`)
          }

          // 仿 SAG 机制：写入实体多对多关联关系图谱
          try {
            // 先清理旧有的实体绑定，以防大模型更新时实体关键词发生变更
            database.prepare("DELETE FROM memory_entity_links WHERE memory_id = ?").run(targetId)

            const keywordsList = Array.isArray(item.keywords) ? item.keywords : []
            if (keywordsList.length > 0) {
              const insertLink = database.prepare("INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_name, created_at) VALUES (?, ?, ?)")
              for (const kw of keywordsList) {
                if (kw && typeof kw === 'string' && kw.trim()) {
                  insertLink.run(targetId, kw.trim(), now)
                }
              }
            }
          } catch (linkErr) {
            console.error(`[Purify] 写入实体关联图谱失败 (ID: ${targetId})`, linkErr)
          }
        }
      }

      // 全部提纯并抽取完成，标记已处理文件
      for (const filePath of processedFiles) {
        try {
          const newFilePath = filePath.replace(/\.md$/i, '_已更新.md')
          await fs.promises.rename(filePath, newFilePath)
        } catch (renameErr) {
          console.error(`[Purify] 标记文件为已更新失败: ${filePath}`, renameErr)
        }
      }

      await autoMigrateOldEmbeddings(database)
      return { success: true, count: processedFiles.length, insertCount }
    } catch (e: any) {
      console.error('画像整理 pipeline 失败', e)
      throw new Error(`画像整理 Pipeline 失败: ${e.message || e}`)
    }
  })

  // 第四层：多路混合检索召回相关避坑经验 (仿 SAG 本地 SQL 动态图关联 RAG 架构)
  ipcMain.handle('api:recall-experiences', async (_, queryText: string) => {
    try {
      if (!queryText || !queryText.trim()) return []
      const database = getDB()
      
      // 1. 获取库中所有避坑经验记录及实体映射
      const rows = database.prepare("SELECT id, fact, strength, last_accessed_at, created_at, keywords, embedding FROM persona_memories WHERE category = 'experience'").all() as any[]
      if (rows.length === 0) return []

      const linkRows = database.prepare("SELECT memory_id, entity_name FROM memory_entity_links").all() as { memory_id: string, entity_name: string }[]
      
      // 构建每个记忆与其包含的实体的映射 Map<memoryId, Set<entityName>>
      const memoryToEntities = new Map<string, Set<string>>()
      linkRows.forEach(link => {
        const memId = link.memory_id
        if (!memoryToEntities.has(memId)) {
          memoryToEntities.set(memId, new Set())
        }
        memoryToEntities.get(memId)!.add(link.entity_name.toLowerCase().trim())
      })

      // 2. 一阶激活实体提取：寻找出现在用户提问中的实体词
      const uniqueEntities = new Set(linkRows.map(r => r.entity_name.toLowerCase().trim()))
      const lowerQuery = queryText.toLowerCase()
      const firstOrderActive = new Set<string>()
      uniqueEntities.forEach(ent => {
        if (lowerQuery.includes(ent)) {
          firstOrderActive.add(ent)
        }
      })

      // 3. 动态二阶实体联想 (多跳联想)
      const secondOrderActive = new Set<string>()
      if (firstOrderActive.size > 0) {
        // A. 找出包含任意一阶实体词的所有直接相关记忆 (一阶记忆)
        const firstOrderMemories = new Set<string>()
        memoryToEntities.forEach((entitiesSet, memId) => {
          for (const ent of firstOrderActive) {
            if (entitiesSet.has(ent)) {
              firstOrderMemories.add(memId)
              break
            }
          }
        })

        // B. 找出这些一阶记忆关联的、不属于一阶激活实体的其它实体作为二阶实体
        firstOrderMemories.forEach(memId => {
          const entitiesSet = memoryToEntities.get(memId)
          if (entitiesSet) {
            entitiesSet.forEach(ent => {
              if (!firstOrderActive.has(ent)) {
                secondOrderActive.add(ent)
              }
            })
          }
        })
      }

      // 4. 尝试生成提问的 Embedding 向量 (优先 SiliconFlow)
      let queryEmb: number[] | null = null
      try {
        queryEmb = await getEmbeddingInternal(systemLlmConfig, queryText)
      } catch (e) {
        console.error('召回计算提问向量失败', e)
      }

      // 5. 本地轻量级 Jaccard 相似度辅助算法
      const jaccardSimilarity = (strA: string, strB: string): number => {
        const cleanTokens = (str: string) => {
          return new Set(str.toLowerCase().match(/[\w\-]+|[\u4e00-\u9fa5]/g) || [])
        }
        const setA = cleanTokens(strA)
        const setB = cleanTokens(strB)
        if (setA.size === 0 || setB.size === 0) return 0
        const intersection = new Set([...setA].filter(x => setB.has(x)))
        const union = new Set([...setA, ...setB])
        return intersection.size / union.size
      }

      const now = Date.now()
      
      const scoredResults = rows.map(row => {
        // A. 指数时间衰退实际强度 (S_now)
        const lastAccess = row.last_accessed_at || row.created_at || now
        const deltaDays = (now - lastAccess) / (1000 * 60 * 60 * 24)
        const sNow = Math.max(0, row.strength * Math.exp(-0.1 * deltaDays))

        // 过滤深度遗忘的知识 (强度小于 0.2)
        if (sNow < 0.2) {
          return { ...row, sNow, score: 0 }
        }

        // B. 动态实体图谱匹配得分 (Graph Score，仿 SAG 核心逻辑)
        let graphScore = 0
        const rowEntities = memoryToEntities.get(row.id)
        if (rowEntities && firstOrderActive.size > 0) {
          let hasFirstOrder = false
          let hasSecondOrder = false
          
          for (const ent of rowEntities) {
            if (firstOrderActive.has(ent)) {
              hasFirstOrder = true
              break
            }
            if (secondOrderActive.has(ent)) {
              hasSecondOrder = true
            }
          }

          if (hasFirstOrder) {
            graphScore = 1.0 // 直接一阶相关
          } else if (hasSecondOrder) {
            graphScore = 0.5 // 间接二阶关联相关 (实现多跳召回)
          }
        }

        // C. 向量相似度得分 (Vector Score)
        let vectorScore = 0
        if (queryEmb && row.embedding) {
          try {
            const dbEmb = JSON.parse(row.embedding)
            if (Array.isArray(dbEmb)) {
              vectorScore = cosineSimilarity(queryEmb, dbEmb)
              // 归一化 [-1, 1] 到 [0, 1]
              vectorScore = (vectorScore + 1) / 2
            }
          } catch {}
        }

        // D. 纯本地文本 Jaccard 相似度匹配分 (Jaccard Score)
        const jaccardScore = jaccardSimilarity(queryText, row.fact)

        // E. 融合计算综合打分
        let score = 0
        if (queryEmb && row.embedding) {
          // 有向量支持：加权图谱、向量相似度、本地文本分及时间衰减
          score = 0.4 * vectorScore + 0.3 * graphScore + 0.2 * jaccardScore + 0.1 * sNow
        } else {
          // 无向量支持（降级模式）：完全依赖图谱分、本地文本匹配和时间衰减
          score = 0.5 * graphScore + 0.3 * jaccardScore + 0.2 * sNow
        }

        return {
          id: row.id,
          fact: row.fact,
          sNow,
          vectorScore,
          graphScore,
          jaccardScore,
          score
        }
      })

      // 过滤低相关分，并按得分从高到低排序
      const activeResults = scoredResults.filter(r => r.sNow >= 0.2 && r.score > 0.05)
      activeResults.sort((a, b) => b.score - a.score)
      const top3 = activeResults.slice(0, 3)

      console.log(`[Recall] 仿 SAG 多跳召回了 ${top3.length} 条相关经验:`, top3.map(t => `${t.fact.substring(0, 30)}... (score: ${t.score.toFixed(3)})`))
      return {
        results: top3,
        debug: {
          firstOrderActive: Array.from(firstOrderActive),
          secondOrderActive: Array.from(secondOrderActive),
          allScored: scoredResults
            .filter(r => r.score > 0.01)
            .sort((a, b) => b.score - a.score)
            .map(r => ({
              id: r.id,
              fact: r.fact,
              score: r.score,
              vectorScore: r.vectorScore || 0,
              graphScore: r.graphScore || 0,
              jaccardScore: r.jaccardScore || 0,
              sNow: r.sNow || 0
            }))
        }
      }
    } catch (err) {
      console.error('召回经验失败', err)
      return []
    }
  })

  // 强化被大模型复习的经验（重置强度）
  ipcMain.handle('api:strengthen-experiences', async (_, ids: string[]) => {
    try {
      if (!Array.isArray(ids) || ids.length === 0) return true
      const database = getDB()
      const now = Date.now()
      const stmt = database.prepare("UPDATE persona_memories SET strength = 1.0, last_accessed_at = ? WHERE id = ?")
      const transaction = database.transaction((targetIds: string[]) => {
        for (const id of targetIds) {
          stmt.run(now, id)
        }
      })
      transaction(ids)
      console.log(`[Recall] 成功强化复习了记忆: ${ids.join(', ')}`)
      return true
    } catch (err) {
      console.error('强化记忆失败', err)
      return false
    }
  })

  ipcMain.handle('api:get-skills-path', () => {
    return getActiveSkillsDir()
  })

  ipcMain.handle('api:open-skills-folder', async () => {
    await shell.openPath(getActiveSkillsDir())
  })

  const readSkillsFolder = async (): Promise<any[]> => {
    try {
      const skillsPath = getActiveSkillsDir()
      const files = await fs.promises.readdir(skillsPath)
      const list: any[] = []
      for (const file of files) {
        if (file.toLowerCase().endsWith('.zip')) {
          const filePath = join(skillsPath, file)
          const stat = await fs.promises.stat(filePath)
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
        await fs.promises.unlink(filePath)
      }
    } catch (e) {
      console.error(e)
    }
    return await readSkillsFolder()
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
        const { PDFParse } = require('pdf-parse')
        const buffer = await fs.promises.readFile(filePath)
        const parser = new PDFParse()
        const data = await parser.parseBuffer(buffer)
        content = data.text || ''
        if (!content.trim()) {
          content = '[PDF 文件已加载，但未能提取到文本内容（可能是扫描件或纯图片 PDF）]'
        }
      } else if (ext === 'docx') {
        // Word 文档解析
        const mammoth = require('mammoth')
        const buffer = await fs.promises.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        content = result.value || ''
        if (!content.trim()) {
          content = '[Word 文档已加载，但内容为空]'
        }
      } else if (ext === 'xlsx' || ext === 'xls') {
        // Excel 文件解析
        const XLSX = require('xlsx')
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
        const Papa = require('papaparse')
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
  ipcMain.handle('api:parse-file-content', async (_, filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    try {
      if (ext === 'pdf') {
        const { PDFParse } = require('pdf-parse')
        const buffer = await fs.promises.readFile(filePath)
        const parser = new PDFParse()
        const data = await parser.parseBuffer(buffer)
        return data.text || '[PDF 未能提取到文本内容]'
      } else if (ext === 'docx') {
        const mammoth = require('mammoth')
        const buffer = await fs.promises.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        return result.value || '[Word 文档内容为空]'
      } else if (ext === 'xlsx' || ext === 'xls') {
        const XLSX = require('xlsx')
        const workbook = XLSX.readFile(filePath)
        const sheets: string[] = []
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const csv = XLSX.utils.sheet_to_csv(sheet)
          if (csv.trim()) sheets.push(`[工作表: ${sheetName}]\n${csv}`)
        }
        return sheets.join('\n\n') || '[Excel 文件内容为空]'
      } else if (ext === 'csv') {
        const Papa = require('papaparse')
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
        const mammoth = require('mammoth')
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
        const ExcelJS = require('exceljs')
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
        const Papa = require('papaparse')
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

  // 删除已生成的文件
  ipcMain.handle('api:delete-generated-file', async (_, filePath: string, sessionId?: string) => {
    try {
      const genDir = getGeneratedFilesDir(sessionId)
      if (!filePath.startsWith(genDir)) return false
      await fs.promises.unlink(filePath)
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

  function getFullToolDefinitionByName(name: string, isFrontend: boolean): any | null {
    const fullTools = getFormattedTools(isFrontend, false)
    return fullTools.find((t: any) => t.function.name === name) || null
  }

  // 执行本地系统及 MCP 工具的统一分发入口
  async function executeTool(
    name: string,
    args: any,
    workspacePath: string,
    event?: Electron.IpcMainInvokeEvent,
    sessionId?: string
  ): Promise<string> {
    const ctx = {
      workspacePath,
      sessionId,
      isFrontend: !!event,
      event,
      sandboxMode: sandboxMode
    }
    const result = await unifiedToolExecutor.execute(name, args, ctx)
    return result.content
  }


  // 5. 通用大模型内部核心请求处理器 (解决 CORS 跨域问题，支持 Tool Calling 循环)
  async function callLlmInternal(
    config: { 
      provider: string; 
      apiKey: string; 
      baseUrl: string; 
      model: string; 
      temperature: number; 
      maxTokens?: number; 
      sessionId?: string; 
      messageId?: number 
    }, 
    messages: any[], 
    workspacePath?: string,
    event?: Electron.IpcMainInvokeEvent,
    onToolEvent?: (evt: { type: string; name: string; args?: any; result?: string; detail?: string }) => void

  ): Promise<string> {
    const { provider, apiKey, baseUrl, model, temperature, maxTokens, sessionId, messageId } = config
    // 清理上一次可能残留的 abort controller
    if (currentLlmAbortController) {
      try { currentLlmAbortController.abort() } catch (_) { /* ignore */ }
    }
    currentLlmAbortController = new AbortController()
    const thisController = currentLlmAbortController

    let url = ''
    const headers: any = {
      'Content-Type': 'application/json'
    }
    const body: any = {}

    if (provider === 'gemini') {
      const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
      url = `${effectiveBaseUrl}/chat/completions`
      headers['Authorization'] = `Bearer ${apiKey}`
      body.model = model || 'gemini-1.5-flash'
      body.temperature = temperature ?? 0.7
    } else if (provider === 'openai') {
      const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1'
      url = `${effectiveBaseUrl}/chat/completions`
      headers['Authorization'] = `Bearer ${apiKey}`
      body.model = model || 'gpt-4o-mini'
      body.temperature = temperature ?? 0.7
    } else if (provider === 'deepseek') {
      const effectiveBaseUrl = baseUrl || 'https://api.deepseek.com/v1'
      url = `${effectiveBaseUrl}/chat/completions`
      headers['Authorization'] = `Bearer ${apiKey}`
      body.model = model || 'deepseek-chat'
      body.temperature = temperature ?? 0.7
    } else if (provider === 'ollama') {
      const effectiveBaseUrl = baseUrl || 'http://localhost:11434/v1'
      url = `${effectiveBaseUrl}/chat/completions`
      body.model = model || 'llama3'
      body.temperature = temperature ?? 0.7
    } else {
      url = `${baseUrl}/chat/completions`
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
      body.model = model
      body.temperature = temperature ?? 0.7
    }

    if (maxTokens) {
      body.max_tokens = maxTokens
    }

    let chatHistory = JSON.parse(JSON.stringify(messages)) // 深拷贝避免污染

    let totalPromptTokens = 0
    let totalCompletionTokens = 0

    // 直接加载简化版工具列表进行第一阶段路由（本地 + MCP，减少首轮 Token 消耗）
    const effectiveTools = getFormattedTools(!!event, true)

    if (effectiveTools.length > 0) {
      body.tools = effectiveTools
      body.tool_choice = 'auto'
    }

    // 在发送前解析本地图片路径为 base64 多模态格式
    for (const msg of chatHistory) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'image_url' && block.image_url && block.image_url.url && block.image_url.url.startsWith('local-file://')) {
            // 解析 local-file:///C:/path 格式（三斜杠），去掉 Windows 路径前导斜杠
            let localPath = ''
            try {
              const parsedUrl = new URL(block.image_url.url)
              localPath = decodeURIComponent(parsedUrl.pathname)
              if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1)
            } catch {
              localPath = block.image_url.url.replace('local-file://', '')
            }
            try {
              if (fs.existsSync(localPath)) {
                const buffer = fs.readFileSync(localPath)
                let ext = localPath.split('.').pop()?.toLowerCase() || 'jpeg'
                if (ext === 'jpg') ext = 'jpeg'
                const mimeType = `image/${ext}`
                block.image_url.url = `data:${mimeType};base64,${buffer.toString('base64')}`
              }
            } catch (err) {
              console.error('读取本地图片转换 Base64 给大模型时失败:', err)
            }
          }
        }
      }
    }

    const sendTokenEvent = () => {
      try {
        if (totalPromptTokens > 0 || totalCompletionTokens > 0) {
          console.log(`[Token] Total - prompt: ${totalPromptTokens}, completion: ${totalCompletionTokens}, total: ${totalPromptTokens + totalCompletionTokens}`)
          const payload = {
            model: body.model || model,
            provider,
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            timestamp: Date.now(),
            sessionId,
            messageId
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
        }
      } catch (se) {
        console.error('send token usage event failed', se)
      }
    }

    let loopCount = 0
    const maxLoops = 40
    // 工具调用中断阈值：超过此次数后强制暂停工具链，引导用户补全关键信息
    const TOOL_INTERRUPT_THRESHOLD = 10

    while (loopCount < maxLoops) {
      loopCount++
      
      try {
        const response = await net.fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, messages: chatHistory }),
          signal: currentLlmAbortController?.signal
        })

        if (!response.ok) {
          const errorText = await response.text()
          // 优雅降级：如果是第一次带 tools 失败（如接口不支持 tools 参数），自动删除降级
          if (loopCount === 1 && body.tools && (response.status === 400 || errorText.includes('tools') || errorText.includes('tool_choice') || errorText.includes('parameter') || errorText.includes('unsupported'))) {
            console.warn('API 不支持工具参数，已优雅降级为纯对话模式', errorText)
            delete body.tools
            delete body.tool_choice
            loopCount = 0
            continue
          }
          throw new Error(`HTTP ${response.status}: ${errorText}`)
        }

        const data: any = await response.json()

        // 累加 token 消耗
        if (data.usage) {
          const apiPromptTokens = data.usage.prompt_tokens || 0
          const apiCompletionTokens = data.usage.completion_tokens || 0
          totalPromptTokens += apiPromptTokens
          totalCompletionTokens += apiCompletionTokens
          console.log(`[Token] API usage - prompt: ${apiPromptTokens}, completion: ${apiCompletionTokens}`)
        } else if (data.choices?.[0]?.message?.content) {
          const textOut = data.choices[0].message.content || ''
          const textIn = chatHistory.map((m: any) => {
            if (Array.isArray(m.content)) {
              return m.content.map((b: any) => b.text || '').join('')
            }
            return m.content || ''
          }).join('')
          const estimatedPrompt = Math.max(1, Math.round(textIn.length * 0.5))
          const estimatedCompletion = Math.max(1, Math.round(textOut.length * 0.8))
          totalPromptTokens += estimatedPrompt
          totalCompletionTokens += estimatedCompletion
          console.log(`[Token] Estimated - prompt: ${estimatedPrompt} (chars: ${textIn.length}), completion: ${estimatedCompletion} (chars: ${textOut.length})`)
        } else {
          console.log(`[Token] No usage data - hasUsage: ${!!data.usage}, hasContent: ${!!data.choices?.[0]?.message?.content}`)
        }

        const message = data.choices?.[0]?.message
        if (!message) {
          throw new Error('未获取到有效的模型答复结构')
        }

        let thinkContent = message.reasoning_content || ''
        if (!thinkContent && message.content) {
          const thinkMatch = message.content.match(/<think>([\s\S]*?)<\/think>/i)
          if (thinkMatch) {
            thinkContent = thinkMatch[1].trim()
          }
        }

        if (thinkContent) {
          if (event) {
            event.sender.send('api:llm-tool-event', {
              type: 'think',
              name: '深度思考过程',
              detail: thinkContent,
              sessionId
            })
          }
          if (onToolEvent) {
            onToolEvent({ type: 'think', name: '深度思考过程', detail: thinkContent })
          }
        }

        const toolCalls = message.tool_calls
        if (toolCalls && toolCalls.length > 0) {
          // ⭐ 工具调用超阈值：强制中断工具链，引导用户补全关键信息
          if (loopCount >= TOOL_INTERRUPT_THRESHOLD) {
            console.warn(`[callLlm] 工具调用已达 ${loopCount} 次，触发中断阈值，强制生成引导追问...`)

            // 将 assistant 消息（含 tool_calls）加入历史，保持对话连贯性
            chatHistory.push(message)
            // 为每个未执行的 tool_call 补充虚拟占位结果，避免 API 因缺少 tool 结果而报错
            for (const tc of toolCalls) {
              chatHistory.push({
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.function.name,
                content: '[系统中断：工具调用次数已达上限，等待用户补充信息]'
              })
            }

            // 注入引导追问的 system 指令（置于消息末尾以提高优先级）
            chatHistory.push({
              role: 'system',
              content: `【系统强制中断指令】你已进行了 ${loopCount} 次工具调用，仍未找到明确答案。这通常说明用户提供的信息不够具体。请立即停止调用任何工具，改为以友好自然的语气向用户提问，帮助补全以下关键信息（结合任务上下文判断哪些最重要）：具体的文件名或路径、所在项目或目录范围、相关关键词或版本号。请直接输出追问内容，不要解释，不要再调用工具。`
            })

            // 发起最后一轮无工具的纯对话，让模型生成追问内容
            const interruptBodyCopy = { ...body, messages: chatHistory }
            delete interruptBodyCopy.tools
            delete interruptBodyCopy.tool_choice

            try {
              const interruptResponse = await net.fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(interruptBodyCopy),
                signal: currentLlmAbortController?.signal
              })

              sendTokenEvent()
              currentLlmAbortController = null

              if (interruptResponse.ok) {
                const interruptData: any = await interruptResponse.json()
                const interruptMsg = interruptData.choices?.[0]?.message?.content || ''
                return interruptMsg.trim() || '我已搜索多次但未能定位目标，请提供更具体的信息，例如文件名、所在目录或相关关键词，我来帮您精准查找。'
              } else {
                return '我已搜索多次但未能定位目标，请提供更具体的信息，例如文件名、所在目录或相关关键词，我来帮您精准查找。'
              }
            } catch (interruptErr: any) {
              if (thisController.signal.aborted) {
                currentLlmAbortController = null
                throw new Error('UserAborted')
              }
              return '我已搜索多次但未能定位目标，请提供更具体的信息，例如文件名、所在目录或相关关键词，我来帮您精准查找。'
            }
          }

          // 第二阶段参数填充逻辑：对于每个被调用的工具，若其包含非空 properties 参数定义，则按需填充
          for (let i = 0; i < toolCalls.length; i++) {
            const toolCall = toolCalls[i]
            const toolName = toolCall.function.name
            const fullTool = getFullToolDefinitionByName(toolName, !!event)
            
            const isMcpTool = mcpManager.hasTool(toolName)
            if (isMcpTool && fullTool && fullTool.function.parameters && Object.keys(fullTool.function.parameters.properties || {}).length > 0) {
              console.log(`[Two-Stage] 检测到简化工具调用: ${toolName}，正在启动第二阶段参数填充...`)
              try {
                const tempHistory = [
                  ...chatHistory,
                  message,
                  {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolName,
                    content: `【系统提示】此工具需要输入参数。请根据以下 JSON Schema 定义重新生成此工具调用，并提供正确的 arguments 参数字段：\n${JSON.stringify(fullTool.function.parameters)}`
                  }
                ]
                
                const fillBody: any = {
                  model: body.model,
                  temperature: 0.1, // 降低随机性确保参数填充精度
                  messages: tempHistory,
                  tools: [fullTool],
                  tool_choice: { type: 'function', function: { name: toolName } }
                }
                if (body.max_tokens) {
                  fillBody.max_tokens = body.max_tokens
                }

                const fillResponse = await net.fetch(url, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(fillBody),
                  signal: currentLlmAbortController?.signal
                })

                if (!fillResponse.ok) {
                  const errorText = await fillResponse.text()
                  throw new Error(`参数填充请求失败 HTTP ${fillResponse.status}: ${errorText}`)
                }

                const fillData: any = await fillResponse.json()
                
                if (fillData.usage) {
                  const apiPromptTokens = fillData.usage.prompt_tokens || 0
                  const apiCompletionTokens = fillData.usage.completion_tokens || 0
                  totalPromptTokens += apiPromptTokens
                  totalCompletionTokens += apiCompletionTokens
                  console.log(`[Two-Stage Token] API usage - prompt: ${apiPromptTokens}, completion: ${apiCompletionTokens}`)
                }

                const fillMessage = fillData.choices?.[0]?.message
                const fillToolCalls = fillMessage?.tool_calls
                const matchedCall = fillToolCalls?.find((tc: any) => tc.function.name === toolName)
                
                if (matchedCall && matchedCall.function.arguments) {
                  console.log(`[Two-Stage] 成功获取参数:`, matchedCall.function.arguments)
                  toolCall.function.arguments = matchedCall.function.arguments
                } else {
                  console.warn(`[Two-Stage] 未能从模型返回中获取到匹配的参数`)
                }
              } catch (fillErr) {
                console.error(`[Two-Stage] 参数填充出错:`, fillErr)
              }
            }
          }

          chatHistory.push(message)

          for (const toolCall of toolCalls) {
            // 检查是否已中止，如果是则立即停止工具执行
            if (thisController.signal.aborted) {
              currentLlmAbortController = null
              throw new Error('UserAborted')
            }

            const toolName = toolCall.function.name
            let toolArgs: any = {}
            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}')
            } catch (pe) {
              console.error('解析工具参数失败', pe)
            }

            if (event) {
              event.sender.send('api:llm-tool-event', {
                type: 'tool_call',
                name: toolName,
                args: toolArgs,
                sessionId
              })
            }
            if (onToolEvent) {
              onToolEvent({ type: 'tool_call', name: toolName, args: toolArgs })
            }

            const toolResult = await executeTool(toolName, toolArgs, workspacePath || '', event, sessionId)


            // 工具执行完成后再次检查是否已中止
            if (thisController.signal.aborted) {
              currentLlmAbortController = null
              throw new Error('UserAborted')
            }

            if (event) {
              event.sender.send('api:llm-tool-event', {
                type: 'tool_result',
                name: toolName,
                result: toolResult,
                sessionId
              })
            }
            if (onToolEvent) {
              onToolEvent({ type: 'tool_result', name: toolName, result: toolResult })
            }

            chatHistory.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolName,
              content: toolResult
            })
          }
          continue
        } else {
          sendTokenEvent()
          currentLlmAbortController = null
          let finalResponse = message.content || ''
          finalResponse = finalResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
          if (!finalResponse.trim() && loopCount > 1) {
            finalResponse = '⚠️ [系统提示] 大模型在执行完工具链后返回了空回复，可能是因为工具返回的数据量过大超出了大模型的上下文处理上限，或触发了安全过滤机制。'
          }
          return finalResponse
        }

      } catch (e: any) {
        console.error('[call-llm loop error]', e)
        sendTokenEvent()
        // 只有当前请求的 controller 被中止才抛 UserAborted，避免被后续请求误清理
        if (thisController.signal.aborted) {
          currentLlmAbortController = null
          throw new Error('UserAborted')
        }
        // 非中止错误，清理 controller 并抛出原始错误
        currentLlmAbortController = null
        throw new Error(e.message || 'LLM 请求代理失败')
      }
    }

    sendTokenEvent()
    currentLlmAbortController = null
    return '智能代理执行工具链已达到最大轮数上限。'
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

  ipcMain.handle('api:wechat-save-settings', (_, settings) => {
    if (wechatBotManager) {
      wechatBotManager.saveSettings(settings)
      return true
    }
    return false
  })

  ipcMain.handle('api:sync-llm-config', (_, config) => {
    systemLlmConfig = config
    saveSystemLlmConfig(config)
    return true
  })

  ipcMain.handle('api:sync-mcp-config', (_, config) => {
    systemMcpConfig = config
    saveSystemMcpConfig(config)
    // 懒加载模式：只注册配置，不立即连接，等实际需要工具时再按需连接
    mcpManager.setConfigs(config.servers)
    return true
  })

  ipcMain.handle('api:test-mcp-server', async (_, config) => {
    try {
      const headers: Record<string, string> = {}
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

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
    return systemMcpConfig
  })

  ipcMain.handle('api:get-active-mcp-servers', async () => {
    // 首次查询时触发懒连接，确保大模型能获取到 MCP 工具列表
    await mcpManager.ensureConnected()
    return mcpManager.getActiveServers()
  })

  // 初始化微信 Bot 服务
  wechatBotManager = new WechatBotManager({
    getDB,
    callLlm: async (config, messages, sessionId, onToolEvent) => {
      const effectiveConfig = config.useSystemConfig
        ? {
            ...systemLlmConfig,
            ...config,
            apiKey: config.apiKey || systemLlmConfig.apiKey,
            baseUrl: config.baseUrl || systemLlmConfig.baseUrl,
            provider: config.provider || systemLlmConfig.provider,
            model: config.model || systemLlmConfig.model
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

    // 1. 中止正在进行的 LLM 请求
    if (currentLlmAbortController) {
      try { currentLlmAbortController.abort() } catch (_) { /* ignore */ }
      currentLlmAbortController = null
    }

    // 2. 解除所有等待授权的阻塞，避免 loading 挂起
    permissionManager.clearPendingPermissions()


    // 3. 断开所有 MCP 服务连接
    mcpManager.disconnectAll().catch(() => {})

    // 4. 断开微信 Bot
    if (wechatBotManager) {
      wechatBotManager.logout().catch(() => {})
    }
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})


// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

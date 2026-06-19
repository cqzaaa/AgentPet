import { app, shell, BrowserWindow, ipcMain, screen, protocol, net, Tray, Menu, dialog, Notification, session, clipboard, nativeImage } from 'electron'
import { join, basename, dirname } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as fs from 'fs'
import * as os from 'os'
import { exec } from 'child_process'
import * as https from 'https'
import * as http from 'http'
import { promisify } from 'util'
import Database from 'better-sqlite3'
import { WechatBotManager } from './wechatBot'

let wechatBotManager: WechatBotManager | null = null
let systemLlmConfig: any = { provider: 'gemini', apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', temperature: 0.7 }
let systemMcpConfig: { servers: McpServerConfig[] } = { servers: [] }

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface McpServerConfig {
  id: string
  name: string
  url: string
  apiKey: string
  type?: 'sse' | 'stream' | 'auto'
  enabled: boolean
}

class McpManager {
  private connections: Map<string, { client: Client; transport: SSEClientTransport | StreamableHTTPClientTransport; tools: any[]; config: McpServerConfig }> = new Map()

  public async connectAll(configs: McpServerConfig[]) {
    const configsToConnect = configs.filter(c => c.enabled && c.url)
    const activeIds = configsToConnect.map(c => c.id)

    // 1. 关闭不再活动或被禁用的连接
    for (const [id, conn] of this.connections.entries()) {
      if (!activeIds.includes(id)) {
        console.log(`[MCP] 断开并移除服务: ${conn.config.name} (${id})`)
        try {
          await conn.client.close()
        } catch (e) {
          console.error(`[MCP] 关闭客户端 ${id} 失败`, e)
        }
        this.connections.delete(id)
      }
    }

    // 2. 并发连接所有需要启用的服务
    await Promise.all(configsToConnect.map(async (config) => {
      const existing = this.connections.get(config.id)
      
      // 如果已存在连接，且参数没有变化，则无需重连
      if (existing && existing.config.url === config.url && existing.config.apiKey === config.apiKey && existing.config.type === config.type) {
        return
      }

      // 否则，先断开旧连接
      if (existing) {
        console.log(`[MCP] 配置变更，正在重新连接服务: ${config.name}`)
        try {
          await existing.client.close()
        } catch {}
        this.connections.delete(config.id)
      }

      console.log(`[MCP] 正在建立服务连接: ${config.name} -> ${config.url}`)
      try {
        const headers: Record<string, string> = {}
        if (config.apiKey) {
          headers['Authorization'] = `Bearer ${config.apiKey}`
        }

        let transport: StreamableHTTPClientTransport | SSEClientTransport
        let client = new Client(
          { name: 'AgentPet-Client', version: '1.0.0' },
          { capabilities: {} }
        )

        const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
        )

        const mcpType = config.type || 'stream'

        if (mcpType === 'stream') {
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 使用 Streamable HTTP 协议连接成功`)
        } else if (mcpType === 'sse') {
          transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 使用 SSE 协议连接成功`)
        } else {
          // auto 模式
          try {
            transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
            await Promise.race([client.connect(transport), connectTimeout(5000)])
            console.log(`[MCP] 服务 ${config.name} 使用 Streamable HTTP 协议连接成功`)
          } catch (httpErr: any) {
            console.warn(`[MCP] Streamable HTTP 连接失败 (${httpErr.message})，正在回退到 SSE 协议...`)
            // 重新创建 client 避免状态污染
            client = new Client(
              { name: 'AgentPet-Client', version: '1.0.0' },
              { capabilities: {} }
            )
            transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } })
            await Promise.race([client.connect(transport), connectTimeout(5000)])
            console.log(`[MCP] 服务 ${config.name} 使用 SSE 协议连接成功（降级）`)
          }
        }

        const response = await client.listTools()
        const tools = response.tools || []
        
        this.connections.set(config.id, { client, transport, tools, config })
        console.log(`[MCP] 服务 ${config.name} 连接成功！加载了 ${tools.length} 个外部工具`)
      } catch (err) {
        console.error(`[MCP] 服务 ${config.name} 连接失败:`, err)
      }
    }))
  }

  private async reconnectServer(id: string): Promise<boolean> {
    const conn = this.connections.get(id)
    if (!conn) return false
    const config = conn.config

    console.log(`[MCP] 正在尝试重连服务: ${config.name} (${id})`)
    try {
      try {
        await conn.client.close()
      } catch {}
      this.connections.delete(id)

      const headers: Record<string, string> = {}
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`
      }

      let transport: StreamableHTTPClientTransport | SSEClientTransport
      let client = new Client(
        { name: 'AgentPet-Client', version: '1.0.0' },
        { capabilities: {} }
      )

      const connectTimeout = (ms: number) => new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`连接超时 (${ms}ms)`)), ms)
      )

      const mcpType = config.type || 'stream'

      if (mcpType === 'stream') {
        transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
        await Promise.race([client.connect(transport), connectTimeout(5000)])
        console.log(`[MCP] 服务 ${config.name} 重连成功 (Streamable HTTP)`)
      } else if (mcpType === 'sse') {
        transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } })
        await Promise.race([client.connect(transport), connectTimeout(5000)])
        console.log(`[MCP] 服务 ${config.name} 重连成功 (SSE)`)
      } else {
        // auto 模式
        try {
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 重连成功 (Streamable HTTP)`)
        } catch (httpErr: any) {
          console.warn(`[MCP] 服务 ${config.name} 重连 Streamable HTTP 失败，回退到 SSE...`)
          client = new Client(
            { name: 'AgentPet-Client', version: '1.0.0' },
            { capabilities: {} }
          )
          transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } })
          await Promise.race([client.connect(transport), connectTimeout(5000)])
          console.log(`[MCP] 服务 ${config.name} 重连成功 (SSE)`)
        }
      }

      const response = await client.listTools()
      const tools = response.tools || []

      this.connections.set(config.id, { client, transport, tools, config })
      return true
    } catch (err) {
      console.error(`[MCP] 服务 ${config.name} 重连失败:`, err)
      return false
    }
  }

  public async disconnectAll() {
    for (const [id, conn] of this.connections.entries()) {
      try {
        await conn.client.close()
      } catch {}
    }
    this.connections.clear()
  }

  public getTools(): any[] {
    const allTools: any[] = []
    for (const conn of this.connections.values()) {
      allTools.push(...conn.tools)
    }
    return allTools
  }

  public hasTool(name: string): boolean {
    for (const conn of this.connections.values()) {
      if (conn.tools.some(t => t.name === name)) {
        return true
      }
    }
    return false
  }

  public async executeTool(name: string, args: any, isRetry = false): Promise<string> {
    let targetConnId: string | null = null
    let targetConn: any = null
    for (const [id, conn] of this.connections.entries()) {
      if (conn.tools.some(t => t.name === name)) {
        targetConnId = id
        targetConn = conn
        break
      }
    }

    if (!targetConn || !targetConnId) {
      return `错误：未在任何已连接的 MCP 服务中找到工具: ${name}`
    }

    try {
      // 增加超时控制 (10秒限制)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP 工具调用超时 (10秒限制)')), 20000)
      )

      const callPromise = targetConn.client.callTool({ name, arguments: args })
      const response = await Promise.race([callPromise, timeoutPromise])

      if (response && response.content) {
        return response.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
      }
      return 'MCP 工具执行完毕，但未返回可读文本。'
    } catch (err: any) {
      console.error(`[MCP] 调用外部工具 ${name} 失败`, err)

      // 无论何种调用失败错误（如 ECONNRESET、Timeout、Aborted），只要尚未重试过，立即执行重连并重试
      if (!isRetry) {
        console.log(`[MCP] 检测到服务 ${targetConn.config.name} 的连接可能已失效/报错，正在尝试自动重连...`)
        const success = await this.reconnectServer(targetConnId)
        if (success) {
          console.log(`[MCP] 服务 ${targetConn.config.name} 重连成功，正在重新执行工具 ${name}...`)
          return this.executeTool(name, args, true)
        }
      }

      return `错误：调用外部 MCP 工具失败: ${err.message || err}`
    }
  }
}

const mcpManager = new McpManager()

function loadSystemMcpConfig() {
  try {
    const configPath = join(app.getPath('userData'), 'system_mcp_config.json')
    let parsed: any = null
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8')
      try {
        parsed = JSON.parse(data)
      } catch {}
    }

    if (parsed) {
      // 向下兼容：如果以前是单配置格式，转换为列表格式
      if (!Array.isArray(parsed.servers)) {
        const oldConfig = parsed as any
        if (oldConfig.url) {
          systemMcpConfig = {
            servers: [
              {
                id: 'legacy-default',
                name: '高德地图mcp',
                url: 'https://mcpmarket.cn/mcp/de5dc2cd1aa574509a53c4d6',
                apiKey: oldConfig.apiKey || '',
                enabled: oldConfig.enabled ?? false
              }
            ]
          }
        } else {
          systemMcpConfig = { servers: [] }
        }
      } else {
        systemMcpConfig = { servers: parsed.servers || [] }
        systemMcpConfig.servers = systemMcpConfig.servers.map((s: any) => {
          if (s.name === '默认外部服务' || s.name === '高德地图服务') {
            return {
              ...s,
              name: '高德地图mcp',
              url: 'https://mcpmarket.cn/mcp/de5dc2cd1aa574509a53c4d6'
            }
          }
          return s
        })
      }
    }

    // 如果没有配置或列表为空，初始化默认服务
    if (!systemMcpConfig.servers || systemMcpConfig.servers.length === 0) {
      systemMcpConfig = {
        servers: [
          {
            id: 'mcp-default-bing',
            name: 'Bing 网页搜索',
            url: 'https://mcpmarket.cn/mcp/93c3bda00747681006348634',
            apiKey: '',
            enabled: true
          },
          {
            id: 'mcp-default-amap',
            name: '高德地图mcp',
            url: 'https://mcpmarket.cn/mcp/de5dc2cd1aa574509a53c4d6',
            apiKey: '',
            enabled: true
          }
        ]
      }
      saveSystemMcpConfig(systemMcpConfig)
    }

    mcpManager.connectAll(systemMcpConfig.servers).catch(console.error)
  } catch (e) {
    console.error('加载全局 MCP 配置文件失败:', e)
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

const execAsync = promisify(exec)

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
let tray: Tray | null = null
let customModelDir = ''
let customModelFile = ''
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
    frame: true,
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
  })

  agentWindow.on('closed', () => {
    agentWindow = null
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
  tray.setToolTip('agentself')
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
  mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    // 初始开启穿透，直到鼠标移动到宠物元素上
    mainWindow.setIgnoreMouseEvents(true, { forward: true })
    createTray(mainWindow)
  })

  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-blur')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 注册窗口拖动 IPC 监听
  ipcMain.on('start-drag', () => {
    // 拖拽开始，无需特殊处理
  })

  ipcMain.on('move-window', (_, dx: number, dy: number) => {
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x + dx, y + dy)
  })

  ipcMain.on('end-drag', () => {
    // 拖拽结束，无需边缘贴合半隐藏逻辑
  })

  ipcMain.on('set-ignore-mouse-events', (_, ignore: boolean, options?: { forward: boolean }) => {
    mainWindow.setIgnoreMouseEvents(ignore, options)
  })

  ipcMain.on('set-window-size', (event, width: number, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      const [oldW, oldH] = win.getSize()
      const [oldX, oldY] = win.getPosition()
      const newW = Math.round(width)
      const newH = Math.round(height)

      // 保持窗口底部中心点不变
      const newX = Math.round((oldX + oldW / 2) - newW / 2)
      const newY = Math.round((oldY + oldH) - newH)

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

  ipcMain.on('hide-window', () => {
    mainWindow.hide()
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // 恢复物理持久化的大模型配置，保证后台微信 Bot 在前端就绪前能拿到有效密钥
  loadSystemLlmConfig()
  loadSystemMcpConfig()

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
      const wechatFilesDir = join(getActiveStorageDir(), 'wechat_files')
      const fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const filePath = join(wechatFilesDir, fileName)
      
      // 安全检查：防止目录遍历漏洞
      if (!filePath.startsWith(wechatFilesDir)) {
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

  const pendingPermissions = new Map<number, (approved: boolean) => void>()
  let nextPermissionRequestId = 1

  ipcMain.on('api:permission-response', (_, { requestId, approved }) => {
    const resolve = pendingPermissions.get(requestId)
    if (resolve) {
      resolve(!!approved)
      pendingPermissions.delete(requestId)
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
        const wechatFilesDir = join(getActiveStorageDir(), 'wechat_files')
        const fileName = decodeURIComponent(imageUrl.replace('wechat-file://', '').replace(/^\/+/, ''))
        const filePath = join(wechatFilesDir, fileName)
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
              const wechatFilesDir = join(getActiveStorageDir(), 'wechat_files')
              const fileName = decodeURIComponent(imageUrl.replace('wechat-file://', '').replace(/^\/+/, ''))
              img = nativeImage.createFromPath(join(wechatFilesDir, fileName))
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

  ipcMain.handle('api:abort-llm', () => {
    if (currentLlmAbortController) {
      currentLlmAbortController.abort()
      currentLlmAbortController = null
    }
    // 同时清理任何正在等待授权的 promise 避免 loading 挂载不消失
    if (pendingPermissions.size > 0) {
      for (const [reqId, resolve] of pendingPermissions.entries()) {
        resolve(false)
      }
      pendingPermissions.clear()
    }
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
  ipcMain.handle('api:save-avatar-config', async (_, { id, name, languageStyle }) => {
    try {
      if (!avatarConfigs[id]) {
        avatarConfigs[id] = {}
      }
      avatarConfigs[id].name = name
      avatarConfigs[id].languageStyle = languageStyle
      writeConfig({ avatarConfigs })
      return true
    } catch (e) {
      console.error('保存虚拟体配置失败', e)
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

    // 如果数据库连接已经存在，但对应的文件路径发生了变化，说明需要重新打开
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
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
            (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, file_infos, is_error, user_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

                  insertMessage.run(msgId, s.id, sender, text, time, isThinking, toolSteps, fileInfo, fileInfos, isError, userId)
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
            userId: m.user_id || 'system'
          }
        })

        result.push({
          id: s.id,
          name: s.name,
          time: s.time,
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

      const insertSession = database.prepare('INSERT OR REPLACE INTO sessions (id, name, time, user_id) VALUES (?, ?, ?, ?)')
      const insertMessage = database.prepare(`
        INSERT OR REPLACE INTO messages 
        (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, file_infos, is_error, user_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const sessionIds = sessions.map(s => s.id)

      const transaction = database.transaction((sessList: any[]) => {
        // 1. 删除已被删除的 sessions 
        if (sessionIds.length > 0) {
          const placeholders = sessionIds.map(() => '?').join(',')
          database.prepare(`DELETE FROM sessions WHERE id NOT IN (${placeholders})`).run(...sessionIds)
        } else {
          database.prepare('DELETE FROM sessions').run()
        }

        for (const s of sessList) {
          insertSession.run(s.id, s.name, s.time, s.userId || 'system')

          // 收集当前 session 里的所有 message ID，用于删除已经不存在的 message
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

            insertMessage.run(msgId, s.id, sender, text, time, isThinking, toolSteps, fileInfo, fileInfos, isError, userId)
          }
        }
      })

      transaction(sessions)
      return true
    } catch (e) {
      console.error('保存聊天记录到 SQLite 失败', e)
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

  // 本地系统工具定义
  const toolDefinitions = [
    {
      type: 'function',
      function: {
        name: 'run_terminal_command',
        description: '执行一条终端命令并返回输出结果。默认在系统临时工作目录下执行。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的终端命令内容' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_system_status',
        description: '获取当前主机的 CPU、内存占用以及系统负载状态信息。',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'manage_cron_task',
        description: '管理定时任务。可以用于创建新的定时任务（action_type="create"）或者删除某个定时任务（action_type="delete"）。不可以由用户自己手动在页面上创建，必须且只能由大模型在Chat页面通过调用此工具来创建。',
        parameters: {
          type: 'object',
          properties: {
            action_type: { 
              type: 'string', 
              enum: ['create', 'delete'], 
              description: '操作类型：create (创建定时任务), delete (删除定时任务)' 
            },
            name: { 
              type: 'string', 
              description: '【创建任务时必填】定时任务的名称，应体现任务目的，例如："提醒喝水", "检测CPU负载"' 
            },
            interval: { 
              type: 'number', 
              description: '【创建任务时必填】定时任务的触发周期，单位为秒，必须大于或等于 2' 
            },
            action: { 
              type: 'string', 
              description: '【创建任务时必填】定时任务触发时执行的动作指令或提示信息，例如："提醒我：主人，该喝水了", "运行 npm run clean-log", "获取系统状态并提醒我"' 
            },
            taskId: { 
              type: 'string', 
              description: '【删除任务时必填】需要删除的定时任务的ID' 
            }
          },
          required: ['action_type']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_location',
        description: '获取用户当前电脑的地理位置定位信息（经纬度），以便提供当地时间、天气、或基于当前位置的其他针对性建议。不需要参数。',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'generate_file',
        description: '生成一个新文件供用户下载。支持生成：文本/代码文件（txt, md, js, ts, py, html, css, json, xml, yml, csv 等）、Excel（xlsx）、Word 文档（docx）、PDF（pdf）、PowerPoint（pptx）。注意：如果用户上传了 xlsx/docx 文件并要求修改，必须使用 modify_xlsx_file 或 modify_docx_file 而不是此工具，否则会丢失原有格式、下拉选择等。此工具仅用于从零创建新文件。',
        parameters: {
          type: 'object',
          properties: {
            file_name: { type: 'string', description: '文件名（含扩展名），例如 "report.md"、"data.csv"、"analysis.xlsx"、"报告.docx"、"slides.pptx"' },
            content: { type: 'string', description: '文件内容。对于 xlsx 格式，支持两种格式：1) CSV 文本（简单数据）2) JSON 字符串（支持样式/公式/多sheet/下拉选择，格式：{"sheets":[{"name":"Sheet1","data":[["A1值","B1值"]],"styles":{"A1":{"bold":true,"bgColor":"FFFF00"}},"formulas":{"B2":"=SUM(B1)"},"merge":["A1:C1"],"colWidths":{"A":20},"dataValidations":{"B2:B100":{"type":"list","formulae":["选项1,选项2,选项3"]}}}]}）。对于 docx/pdf/pptx 格式，传入纯文本内容。' },
            file_type: { type: 'string', enum: ['text', 'excel', 'docx', 'pdf', 'pptx'], description: '文件类型：text（文本/代码）、excel（Excel 表格）、docx（Word 文档）、pdf（PDF 文档）、pptx（PPT 演示文稿）。默认 text。' }
          },
          required: ['file_name', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'modify_docx_file',
        description: '修改已上传的 docx 文件内容并保留原始排版格式。支持修改文字、设置样式（字体颜色/加粗/字号等）、嵌入图片。当用户上传 docx 文件并要求修改时，必须使用此工具而不是 generate_file。',
        parameters: {
          type: 'object',
          properties: {
            source_path: { type: 'string', description: '原始 docx 文件的绝对路径（从用户上传的文件信息中获取）' },
            output_name: { type: 'string', description: '输出文件名，如 "修改后的报告.docx"' },
            modifications: {
              type: 'array',
              description: '文本修改指令数组。每个元素包含 search（要查找的原文）、replace（替换后的新文）、可选的 style（样式修改）。',
              items: {
                type: 'object',
                properties: {
                  search: { type: 'string', description: '要查找的原始文本（必须与文档中的文字完全一致）' },
                  replace: { type: 'string', description: '替换后的新文本' },
                  paragraphStyle: { type: 'string', description: '可选。限定只在指定段落样式中搜索。常见值："Heading1"（一级标题）、"Heading2"（二级标题）、"Heading3"（三级标题）、"Normal"（正文）、"Title"（文档标题）。不指定则在全文搜索。' },
                  style: {
                    type: 'object',
                    description: '可选。对替换后文字应用的样式。',
                    properties: {
                      bold: { type: 'boolean', description: '是否加粗' },
                      italic: { type: 'boolean', description: '是否斜体' },
                      underline: { type: 'boolean', description: '是否下划线' },
                      color: { type: 'string', description: '字体颜色，十六进制如 "FF0000"（红色）' },
                      fontSize: { type: 'number', description: '字号（半磅为单位，如 24 = 12pt）' },
                      highlight: { type: 'string', description: '高亮背景色，如 "yellow"、"cyan"' }
                    }
                  }
                },
                required: ['search', 'replace']
              }
            },
            images: {
              type: 'array',
              description: '可选。图片嵌入指令数组。在指定文字位置插入图片。',
              items: {
                type: 'object',
                properties: {
                  search_text: { type: 'string', description: '要替换为图片的文字（会从文档中删除这段文字，替换为图片）' },
                  image_path: { type: 'string', description: '图片文件的绝对路径' },
                  width: { type: 'number', description: '图片宽度（厘米），默认 10' },
                  height: { type: 'number', description: '图片高度（厘米），默认 8' }
                },
                required: ['search_text', 'image_path']
              }
            }
          },
          required: ['source_path', 'output_name', 'modifications']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'modify_xlsx_file',
        description: '修改用户上传的 xlsx 文件。保留原有格式、下拉选择（数据验证）、合并单元格等。支持修改单元格值、设置样式、写入公式、合并单元格、添加新工作表、设置新的数据验证（下拉选择）、批量在末尾追加新数据行。重要：1) 当用户上传了 xlsx 文件并要求修改时，必须使用此工具而非 generate_file 以保留格式。2) 如果需要批量在表尾追加/新增整行数据，必须优先使用 append_rows 参数，绝不能将每一行的单元格拆分为 modifications 中的单个 cell 元素，否则会产生海量单元格修改导致生成截断。',
        parameters: {
          type: 'object',
          properties: {
            source_path: { type: 'string', description: '原始 xlsx 文件的绝对路径' },
            output_name: { type: 'string', description: '输出文件名，如 "修改后的报表.xlsx"' },
            modifications: {
              type: 'array',
              description: '单元格修改指令数组。仅用于修改已有单元格的值、公式或应用单元格样式。如果需要追加新数据行，请务必使用 append_rows 参数而非本参数。',
              items: {
                type: 'object',
                properties: {
                  sheet: { type: 'string', description: '工作表名称，默认第一个 sheet' },
                  cell: { type: 'string', description: '单元格地址，如 "A1"、"B3"' },
                  value: { description: '单元格值（字符串/数字/布尔），与 formula 二选一' },
                  formula: { type: 'string', description: '公式，如 "=SUM(A1:A10)"，与 value 二选一' },
                  style: {
                    type: 'object',
                    description: '可选。单元格样式。',
                    properties: {
                      bold: { type: 'boolean' },
                      italic: { type: 'boolean' },
                      fontSize: { type: 'number', description: '字号，如 12' },
                      fontColor: { type: 'string', description: '字体颜色，十六进制如 "FF0000"' },
                      bgColor: { type: 'string', description: '背景填充颜色，十六进制如 "FFFF00"' },
                      borderStyle: { type: 'string', description: '边框样式：thin/medium/thick/dashed/dotted' },
                      borderColor: { type: 'string', description: '边框颜色，十六进制' },
                      align: { type: 'string', description: '水平对齐：left/center/right' },
                      valign: { type: 'string', description: '垂直对齐：top/middle/bottom' },
                      wrapText: { type: 'boolean', description: '自动换行' },
                      numberFormat: { type: 'string', description: '数字格式，如 "#,##0.00"、"$#,##0"、"0%"' }
                    }
                  }
                },
                required: ['cell']
              }
            },
            append_rows: {
              type: 'array',
              description: '可选。在工作表末尾追加的新行数据列表。当需要批量新增行时，必须优先使用此参数而不是 modifications，以避免大量单元格修改导致大模型输出被截断。',
              items: {
                type: 'object',
                properties: {
                  sheet: { type: 'string', description: '工作表名称，默认第一个 sheet' },
                  values: {
                    type: 'array',
                    description: '这一行的单元格值列表，例如 ["电容", "电容-（M30系列）", "=SUM(A1:A2)"]。值会依次填入新行的 A, B, C... 列。如果元素是字符串且以 "=" 开头（如 "=SUM(A1:B1)"），会自动识别并作为 Excel 公式写入该单元格。',
                    items: { type: 'string' }
                  }
                },
                required: ['values']
              }
            },
            merge_cells: {
              type: 'array',
              description: '合并单元格区域数组，如 ["A1:C1", "D2:E2"]',
              items: { type: 'string' }
            },
            add_sheet: {
              type: 'string',
              description: '新增工作表名称'
            },
            column_widths: {
              type: 'object',
              description: '列宽设置，如 {"A": 20, "B": 15}',
              additionalProperties: { type: 'number' }
            },
            data_validations: {
              type: 'object',
              description: '数据验证（下拉选择等），key 为单元格区域如 "B2:B100"，value 为验证规则。示例：{"A2:A100": {"type": "list", "formulae": ["选项1,选项2,选项3"]}}',
              additionalProperties: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['list', 'whole', 'decimal', 'date', 'time', 'textLength', 'custom'], description: '验证类型，list 为下拉选择' },
                  formulae: { type: 'array', items: { type: 'string' }, description: '公式/选项列表，list 类型传逗号分隔的选项如 ["是,否,待定"]' }
                }
              }
            }
          },
          required: ['source_path', 'output_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取指定路径文件的内容。支持 Excel（xlsx/xls）、Word（docx）、PDF、CSV 及常见文本/代码文件（txt, md, js, json, html, css, py 等）。返回文件的文本内容，Excel 文件返回各工作表的 CSV 数据。',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件的绝对路径，如 "C:\\Users\\xx\\Documents\\data.xlsx"' }
          },
          required: ['file_path']
        }
      }
    }
  ]

  function getFormattedTools(isFrontend: boolean): any[] {
    const list: any[] = []
    
    if (isFrontend) {
      list.push(...toolDefinitions)
    } else {
      // 后端（如微信机器人）不注入本地工具，仅使用 MCP 工具
    }

    const mcpTools = mcpManager.getTools()
    for (const tool of mcpTools) {
      list.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.inputSchema || { type: 'object', properties: {} }
        }
      })
    }

    return list
  }

  // 判定是否为只读或无害查询命令，用于免弹窗自动放行
  function isReadOnlyCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    
    // 只读或版本检测命令的正则匹配
    const safePatterns = [
      /^(git\s+(status|diff|log|show|branch|remote|tag|config\s+--list|config\s+-l))\b/,
      /^(ls|dir|pwd|echo|whoami|hostname|uname|date|time)\b/,
      /^(cat|type|head|tail|grep|more|less)\s+/,
      /^(node|npm|npx|yarn|pnpm|git|python|pip|tsc|go|rustc|cargo|docker|java)\s+(-v|--version)\b/
    ];

    // 检查是否完全符合至少一个安全模式
    return safePatterns.some(pattern => pattern.test(trimmed));
  }

  // 检查终端命令安全性 (返回警告文案而非硬性直接拦截)
  function checkCommandSafety(command: string): { safe: boolean; warning?: string } {
    const trimmed = command.trim().toLowerCase();
    
    // 1. 磁盘格式化/低级操作
    if (/\b(format)\b/.test(trimmed) || /\b(mkfs|dd if=)\b/.test(trimmed)) {
      return { safe: false, warning: '检测到磁盘格式化或底层硬盘扇区写入操作，此操作极其危险，可能导致不可逆的数据丢失。' }
    }
    
    // 2. 系统关机/重启
    if (/\b(shutdown|reboot|init 0|init 6)\b/.test(trimmed)) {
      return { safe: false, warning: '检测到关机、重启系统的指令，运行此命令将导致本应用及当前的桌面助理服务中断。' }
    }

    // 3. 用户及权限管理
    if (/\bnet\s+user\b/.test(trimmed) || /\bnet\s+localgroup\b/.test(trimmed) || /\b(useradd|userdel|groupadd|groupdel)\b/.test(trimmed)) {
      return { safe: false, warning: '检测到涉及添加、修改或删除本地系统账户/特权组的安全敏感命令。' }
    }

    // 4. 注册表高危修改
    if (/\breg\s+(add|delete|import)\b/.test(trimmed)) {
      return { safe: false, warning: '检测到修改 Windows 注册表的操作，误删或误改关键注册表项可能导致系统崩溃或功能异常。' }
    }

    // 5. 试图删除整盘或系统关键路径 (Linux/Unix)
    if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|\/\*|\/etc|\/var|\/usr|\/bin|\/boot)\b/.test(trimmed)) {
      return { safe: false, warning: '检测到尝试强制递归删除 Linux 系统根目录或系统关键路径 (rm -rf /) 的毁灭性高危操作！' }
    }

    // 6. 试图删除整盘或关键路径 (Windows)
    if (/\bdel\b.*\b(c:|d:)\\\s*(\*|\/s)/.test(trimmed) || /\bdel\b.*\b\\\s*\/s/.test(trimmed)) {
      return { safe: false, warning: '检测到尝试递归删除系统盘根目录文件或整盘数据 (del /s) 的高危操作！' }
    }

    // 7. 绕过脚本执行策略
    if (/-executionpolicy\s+bypass\b/.test(trimmed) || /-ep\s+bypass\b/.test(trimmed)) {
      return { safe: false, warning: '检测到尝试绕过系统 PowerShell 脚本安全执行策略 (Bypass) 的行为。' }
    }

    return { safe: true }
  }

  // 执行本地系统工具处理器
  async function executeTool(name: string, args: any, workspacePath: string, event?: Electron.IpcMainInvokeEvent, sessionId?: string): Promise<string> {
    if (name === 'get_location') {
      try {
        const activeWin = event?.sender
        if (!activeWin) {
          return '获取定位失败：无法获取当前活动的渲染进程实例。'
        }

        // ── Windows 系统定位（WinRT Geolocator API，Windows 10+ 现代接口）──
        // 使用 Windows.Devices.Geolocation.Geolocator，与系统「设置→隐私→位置」直连，
        // 支持 GPS + Wi-Fi 三角定位 + 基站，精度远高于旧的 System.Device API。
        // 通过 PowerShell Add-Type 内联 C# 调用 WinRT 异步接口。
        const psScript = `
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference  = 'SilentlyContinue'
$WarningPreference  = 'SilentlyContinue'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# 加载 WinRT 类型
$null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType=WindowsRuntime]

# 获取 AsTask 泛型扩展方法（把 WinRT IAsyncOperation 转为 .NET Task）
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod } |
  Select-Object -First 1

$geoposType = [Windows.Devices.Geolocation.Geoposition, Windows.Devices.Geolocation, ContentType=WindowsRuntime]
$asTask = $asTaskMethod.MakeGenericMethod($geoposType)

$geo = [Windows.Devices.Geolocation.Geolocator]::new()
$geo.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High

$asyncOp = $geo.GetGeopositionAsync()
$task = $asTask.Invoke($null, @($asyncOp))

if (-not $task.Wait(15000)) {
  Write-Output 'ERROR:LocationTimeout'
} elseif ($task.IsFaulted) {
  Write-Output "ERROR:LocationFailed:$($task.Exception.InnerException.Message)"
} else {
  $pos = $task.Result
  $acc = if ($pos.Coordinate.Accuracy -ne $null) { $pos.Coordinate.Accuracy } else { 50 }
  Write-Output "$($pos.Coordinate.Latitude),$($pos.Coordinate.Longitude),$acc"
}
`

        let winCoords: { latitude: number; longitude: number; accuracy: number } | null = null
        let winError = ''

        try {
          const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
          const { stdout } = await execAsync(`powershell -EncodedCommand ${encoded}`, { timeout: 22000 })
          const out = stdout.trim()

          // 用正则验证输出格式：真实坐标是 "lat,lon,acc" 数字格式
          // PowerShell 进度流产生的 CLIXML 会混入 stderr，但不影响 stdout
          const coordMatch = out.match(/^(-?\d+\.\d+),(-?\d+\.\d+),?(\d*\.?\d*)$/m)
          if (coordMatch) {
            winCoords = {
              latitude: parseFloat(coordMatch[1]),
              longitude: parseFloat(coordMatch[2]),
              accuracy: coordMatch[3] ? parseFloat(coordMatch[3]) : 50
            }
          } else if (out.startsWith('ERROR:')) {
            winError = out.replace('ERROR:', '')
          } else {
            winError = out || '脚本无输出，请检查 Windows 位置服务权限'
          }
        } catch (psErr: any) {
          winError = psErr?.message || String(psErr)
        }

        if (!winCoords) {
          return [
            `获取 Windows 物理定位失败：${winError}`,
            '',
            '请检查以下设置：',
            '① Windows 设置 → 隐私和安全性 → 位置 → 开启「位置服务」',
            '② 同页面开启「允许桌面应用访问你的位置」',
            '③ 确保 Wi-Fi 已连接（用于 Wi-Fi 三角定位）'
          ].join('\n')
        }

        // 将真实坐标注入 Chromium（此后 navigator.geolocation 返回注入值，不调 Google API）
        try {
          if (!activeWin.debugger.isAttached()) activeWin.debugger.attach('1.3')
          await activeWin.debugger.sendCommand('Emulation.setGeolocationOverride', {
            latitude: winCoords.latitude,
            longitude: winCoords.longitude,
            accuracy: winCoords.accuracy
          })
          console.log(`[Geolocation] WinRT 坐标注入成功: ${winCoords.latitude}, ${winCoords.longitude}`)
        } catch (debugErr: any) {
          console.warn('[Geolocation] debugger 注入失败，直接返回坐标:', debugErr?.message)
          return JSON.stringify({
            status: 'success',
            latitude: winCoords.latitude,
            longitude: winCoords.longitude,
            accuracy: `${winCoords.accuracy.toFixed(1)}m`,
            provider: 'windows_winrt_geolocator'
          }, null, 2)
        }

        // 触发渲染层 navigator.geolocation 弹窗授权（用户看到允许/拒绝弹窗）
        // 允许后 Chromium 直接返回注入坐标，不再调 Google API，无 403
        return await new Promise<string>((resolve) => {
          const reqId = nextPermissionRequestId++
          activeWin.send('api:request-geolocation', { requestId: reqId })

          const onResponse = (_evt: any, resp: { requestId: number; location?: { latitude: number; longitude: number; accuracy: number }; error?: string }) => {
            if (resp && resp.requestId === reqId) {
              ipcMain.removeListener('api:geolocation-response', onResponse)
              const coords = resp.location || winCoords!
              resolve(JSON.stringify({
                status: 'success',
                latitude: coords.latitude,
                longitude: coords.longitude,
                accuracy: `${typeof coords.accuracy === 'number' ? coords.accuracy.toFixed(1) : coords.accuracy}m`,
                provider: 'windows_winrt_geolocator'
              }, null, 2))
            }
          }

          ipcMain.on('api:geolocation-response', onResponse)

          // 15 秒等待用户点击弹窗，超时直接返回坐标
          setTimeout(() => {
            ipcMain.removeListener('api:geolocation-response', onResponse)
            resolve(JSON.stringify({
              status: 'success',
              latitude: winCoords!.latitude,
              longitude: winCoords!.longitude,
              accuracy: `${winCoords!.accuracy.toFixed(1)}m`,
              provider: 'windows_winrt_geolocator'
            }, null, 2))
          }, 15000)
        })

      } catch (err: any) {
        return `执行 get_location 工具失败：${err.message || err}`
      }
    }



    if (name === 'manage_cron_task') {
      try {
        const { action_type, name: taskName, interval, action, taskId } = args
        const cronPath = join(getActiveStorageDir(), 'cron_tasks.json')
        let tasks: any[] = []
        if (fs.existsSync(cronPath)) {
          const data = await fs.promises.readFile(cronPath, 'utf-8')
          tasks = JSON.parse(data)
        }

        if (action_type === 'create') {
          if (!taskName || !interval || !action) {
            return '创建失败：缺少必要参数（name, interval, action）'
          }
          const newTask = {
            id: Date.now().toString(),
            name: taskName,
            interval: Math.max(2, interval),
            action: action,
            isActive: true,
            triggerCount: 0,
            lastTriggered: '未触发',
            logs: []
          }
          tasks.push(newTask)
          await fs.promises.writeFile(cronPath, JSON.stringify(tasks, null, 2), 'utf-8')

          // 通知渲染层定时任务已更新
          event?.sender?.send('api:cron-updated')
          return JSON.stringify({
            status: 'success',
            message: `成功创建定时任务："${taskName}"`,
            details: `执行周期为每 ${interval} 秒一次，操作指令: "${action}"`
          })
        } else if (action_type === 'delete') {
          if (!taskId) {
            return '删除失败：缺少 taskId 参数'
          }
          const filtered = tasks.filter((t: any) => t.id !== taskId)
          if (filtered.length === tasks.length) {
            return `未找到 ID 为 ${taskId} 的定时任务`
          }
          await fs.promises.writeFile(cronPath, JSON.stringify(filtered, null, 2), 'utf-8')

          event?.sender?.send('api:cron-updated')
          return `已成功删除 ID 为 ${taskId} 的定时任务`
        }
        return `未知的操作类型: ${action_type}`
      } catch (err: any) {
        return `执行 manage_cron_task 工具失败: ${err.message || err}`
      }
    }

    if (name === 'get_system_status') {
      try {
        const cpus = os.cpus()
        const freeMem = os.freemem()
        const totalMem = os.totalmem()
        return JSON.stringify({
          cpuModel: cpus[0]?.model || 'Unknown CPU',
          cpuCount: cpus.length,
          freeMemory: `${(freeMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
          totalMemory: `${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
          platform: os.platform(),
          release: os.release(),
          uptime: `${Math.round(os.uptime() / 3600)} 小时`
        }, null, 2)
      } catch (err: any) {
        return `获取系统状态失败: ${err.message}`
      }
    }

    if (name === 'run_terminal_command') {
      try {
        const { command } = args
        // 优先在当前会话的文件目录下执行，其次用工作空间，最后用主目录
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

        if (sandboxMode) {
          // 1. 只读免密自动放行
          if (isReadOnlyCommand(command)) {
            // 只读指令，放行执行，不弹出授权确认框
          } else {
            // 2. 检查是否有高危操作
            const safety = checkCommandSafety(command)
            
            // 3. 向前端发送 IPC 授权确认请求 (高危命令附带 warning 文本)
            const activeWin = agentWindow || mainWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
            if (activeWin) {
              const reqId = nextPermissionRequestId++
              activeWin.webContents.send('api:request-permission', {
                requestId: reqId,
                command,
                execCwd,
                warning: safety.warning // 携带安全警示信息
              })

              // 异步等待前端回传
              const approved = await new Promise<boolean>((resolve) => {
                pendingPermissions.set(reqId, resolve)
                // 5分钟超时保护，避免阻塞
                setTimeout(() => {
                  if (pendingPermissions.has(reqId)) {
                    resolve(false)
                    pendingPermissions.delete(reqId)
                  }
                }, 300000)
              })

              if (!approved) {
                return `[安全提示] 用户拒绝了此终端命令的执行。指令内容: "${command}"`
              }
            } else {
              return '[安全拦截] 找不到活动窗口以发送授权确认，拒绝执行命令。'
            }
          }
        }

        const { stdout, stderr } = await execAsync(command, { cwd: execCwd, timeout: 30000 })
        return `[命令执行输出]\n${stdout || ''}\n${stderr ? '[错误输出]\n' + stderr : ''}`
      } catch (err: any) {
        return `终端命令执行失败：${err.message || err}`
      }
    }

    // 生成文件不需要工作空间
    if (name === 'generate_file') {
      try {
        const { file_name, content, file_type } = args
        if (!file_name || !content) {
          return '错误：缺少必要参数 file_name 或 content'
        }

        const genDir = getGeneratedFilesDir(sessionId)
        const safeName = file_name.replace(/[<>:”/\\|?*]/g, '_')
        const filePath = join(genDir, safeName)

        if (file_type === 'excel') {
          const ExcelJS = require('exceljs')
          const workbook = new ExcelJS.Workbook()

          // 尝试解析为 JSON（支持样式/公式/多sheet）
          let jsonData: any = null
          try { jsonData = JSON.parse(content) } catch (e) { /* not JSON, treat as CSV */ }

          if (jsonData && jsonData.sheets && Array.isArray(jsonData.sheets)) {
            // JSON 模式：支持样式、公式、合并、列宽
            for (const sheetDef of jsonData.sheets) {
              const ws = workbook.addWorksheet(sheetDef.name || 'Sheet1')
              // 写入数据
              if (sheetDef.data && Array.isArray(sheetDef.data)) {
                for (let r = 0; r < sheetDef.data.length; r++) {
                  const row = sheetDef.data[r]
                  for (let c = 0; c < row.length; c++) {
                    const cell = ws.getCell(r + 1, c + 1)
                    cell.value = row[c]
                  }
                }
              }
              // 应用样式
              if (sheetDef.styles) {
                for (const [cellRef, style] of Object.entries(sheetDef.styles as Record<string, any>)) {
                  const cell = ws.getCell(cellRef)
                  const font: any = {}
                  if (style.bold) font.bold = true
                  if (style.italic) font.italic = true
                  if (style.fontSize) font.size = style.fontSize
                  if (style.fontColor) font.color = { argb: 'FF' + String(style.fontColor).replace(/^#/, '') }
                  if (Object.keys(font).length > 0) cell.font = font
                  if (style.bgColor) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + String(style.bgColor).replace(/^#/, '') } }
                  }
                  if (style.borderStyle) {
                    const side = { style: style.borderStyle, color: style.borderColor ? { argb: 'FF' + String(style.borderColor).replace(/^#/, '') } : undefined }
                    cell.border = { top: side, bottom: side, left: side, right: side }
                  }
                  const alignment: any = {}
                  if (style.align) alignment.horizontal = style.align
                  if (style.valign) alignment.vertical = style.valign
                  if (style.wrapText) alignment.wrapText = true
                  if (Object.keys(alignment).length > 0) cell.alignment = alignment
                  if (style.numberFormat) cell.numFmt = style.numberFormat
                }
              }
              // 写入公式
              if (sheetDef.formulas) {
                for (const [cellRef, formula] of Object.entries(sheetDef.formulas as Record<string, string>)) {
                  ws.getCell(cellRef).value = { formula: String(formula).replace(/^=/, '') }
                }
              }
              // 合并单元格
              if (sheetDef.merge && Array.isArray(sheetDef.merge)) {
                for (const range of sheetDef.merge) {
                  ws.mergeCells(range)
                }
              }
              // 列宽
              if (sheetDef.colWidths) {
                for (const [col, width] of Object.entries(sheetDef.colWidths as Record<string, number>)) {
                  ws.getColumn(col).width = width
                }
              }
              // 数据验证（下拉选择等）
              if (sheetDef.dataValidations) {
                for (const [range, dv] of Object.entries(sheetDef.dataValidations as Record<string, any>)) {
                  ws.dataValidations.add(range, {
                    type: dv.type || 'list',
                    formulae: dv.formulae || [],
                    showErrorMessage: dv.showErrorMessage !== false,
                    errorTitle: dv.errorTitle || '输入错误',
                    error: dv.error || '请从下拉列表中选择',
                    showInputMessage: dv.showInputMessage || false,
                    promptTitle: dv.promptTitle || '',
                    prompt: dv.prompt || ''
                  })
                }
              }
            }
          } else {
            // CSV 模式（向后兼容）
            const ws = workbook.addWorksheet('Sheet1')
            const lines = content.split('\n')
            for (const line of lines) {
              ws.addRow(line.split(','))
            }
          }

          // 自动从源 xlsx 文件复制数据验证（下拉选择等）
          // 使用 ExcelJS 读取源文件（SheetJS 社区版不支持读取数据验证）
          const sourceXlsx = sessionId ? sessionLastXlsxMap.get(sessionId) : null
          if (sourceXlsx && fs.existsSync(sourceXlsx)) {
            try {
              const ExcelJSReader = require('exceljs')
              const srcReaderWb = new ExcelJSReader.Workbook()
              await srcReaderWb.xlsx.readFile(sourceXlsx)
              for (const srcWs of srcReaderWb.worksheets) {
                const dstWs = workbook.getWorksheet(srcWs.name) || workbook.worksheets[0]
                if (!dstWs) continue
                // ExcelJS 的 dataValidations 是一个 DataValidations 对象
                const dvModel = (srcWs.dataValidations as any).model || srcWs.dataValidations
                if (!dvModel) continue
                for (const [addr, dv] of Object.entries(dvModel as Record<string, any>)) {
                  try {
                    dstWs.dataValidations.add(addr, {
                      type: dv.type || 'list',
                      formulae: dv.formulae || [],
                      showErrorMessage: dv.showErrorMessage !== false,
                      errorTitle: dv.errorTitle || '输入错误',
                      error: dv.error || '请从下拉列表中选择',
                      showInputMessage: dv.showInputMessage || false,
                      promptTitle: dv.promptTitle || '',
                      prompt: dv.prompt || ''
                    })
                  } catch (_) { /* skip invalid entries */ }
                }
              }
            } catch (e) {
              console.warn('复制源文件数据验证失败（不影响文件生成）:', (e as Error).message)
            }
          }

          await workbook.xlsx.writeFile(filePath)
        } else if (file_type === 'docx') {
          const docx = require('docx')
          const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx
          // 将内容按换行拆分为段落
          const lines = content.split('\n')
          const children = lines.map((line: string) => {
            // 简单识别标题行（以 # 开头或全大写短行）
            if (line.startsWith('# ')) {
              return new Paragraph({
                heading: HeadingLevel.HEADING_1,
                children: [new TextRun({ text: line.replace(/^#+\s*/, ''), bold: true, size: 32 })]
              })
            } else if (line.startsWith('## ')) {
              return new Paragraph({
                heading: HeadingLevel.HEADING_2,
                children: [new TextRun({ text: line.replace(/^#+\s*/, ''), bold: true, size: 28 })]
              })
            } else if (line.startsWith('### ')) {
              return new Paragraph({
                heading: HeadingLevel.HEADING_3,
                children: [new TextRun({ text: line.replace(/^#+\s*/, ''), bold: true, size: 24 })]
              })
            } else if (line.trim() === '') {
              return new Paragraph({ children: [] })
            } else {
              return new Paragraph({
                children: [new TextRun({ text: line, size: 24 })]
              })
            }
          })
          const doc = new Document({ sections: [{ children }] })
          const buffer = await Packer.toBuffer(doc)
          await fs.promises.writeFile(filePath, buffer)
        } else if (file_type === 'pdf') {
          const PDFDocument = require('pdfkit')
          await new Promise<void>((resolve, reject) => {
            const pdf = new PDFDocument({ size: 'A4', margin: 50 })
            const stream = fs.createWriteStream(filePath)
            pdf.pipe(stream)
            // 注册中文字体支持（尝试系统字体）
            try {
              const fontPath = process.platform === 'win32'
                ? 'C:/Windows/Fonts/msyh.ttc'
                : process.platform === 'darwin'
                  ? '/System/Library/Fonts/PingFang.ttc'
                  : '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'
              if (fs.existsSync(fontPath)) {
                pdf.registerFont('CJK', fontPath)
                pdf.font('CJK')
              }
            } catch (e) { /* fallback to default font */ }
            const lines = content.split('\n')
            for (const line of lines) {
              if (line.startsWith('# ')) {
                pdf.fontSize(20).text(line.replace(/^#+\s*/, ''), { continued: false })
                pdf.moveDown(0.3)
              } else if (line.startsWith('## ')) {
                pdf.fontSize(16).text(line.replace(/^#+\s*/, ''), { continued: false })
                pdf.moveDown(0.2)
              } else if (line.startsWith('### ')) {
                pdf.fontSize(14).text(line.replace(/^#+\s*/, ''), { continued: false })
                pdf.moveDown(0.1)
              } else {
                pdf.fontSize(11).text(line || ' ', { continued: false })
              }
            }
            pdf.end()
            stream.on('finish', resolve)
            stream.on('error', reject)
          })
        } else if (file_type === 'pptx') {
          const PptxGenJS = require('pptxgenjs')
          const pptx = new PptxGenJS()
          pptx.layout = 'LAYOUT_16x9'
          const lines = content.split('\n')
          let currentSlide = pptx.addSlide()
          let lineCount = 0
          const maxLinesPerSlide = 12
          for (const line of lines) {
            if (line.startsWith('# ')) {
              // 一级标题 → 新幻灯片
              currentSlide = pptx.addSlide()
              currentSlide.addText(line.replace(/^#+\s*/, ''), {
                x: 0.5, y: 0.3, w: '90%', h: 0.8,
                fontSize: 28, bold: true, color: '1a1a2e'
              })
              lineCount = 0
            } else if (line.startsWith('## ')) {
              // 二级标题 → 新幻灯片
              currentSlide = pptx.addSlide()
              currentSlide.addText(line.replace(/^#+\s*/, ''), {
                x: 0.5, y: 0.3, w: '90%', h: 0.6,
                fontSize: 22, bold: true, color: '2d3436'
              })
              lineCount = 0
            } else if (line.trim() === '') {
              continue
            } else {
              if (lineCount >= maxLinesPerSlide) {
                currentSlide = pptx.addSlide()
                lineCount = 0
              }
              currentSlide.addText(line, {
                x: 0.5, y: 1.0 + lineCount * 0.45, w: '90%', h: 0.4,
                fontSize: 14, color: '333333'
              })
              lineCount++
            }
          }
          const buffer = await pptx.write({ outputType: 'nodebuffer' })
          await fs.promises.writeFile(filePath, buffer)
        } else {
          await fs.promises.writeFile(filePath, content, 'utf-8')
        }

        const activeWin = agentWindow || mainWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (activeWin) {
          activeWin.webContents.send('api:generated-file-updated')
        }

        return JSON.stringify({
          status: 'success',
          message: `文件 “${safeName}” 已生成`,
          file_path: filePath,
          file_name: safeName
        }, null, 2)
      } catch (err: any) {
        return `生成文件失败：${err.message || err}`
      }
    }

    // 修改 docx 文件（保留原始排版）
    if (name === 'modify_docx_file') {
      try {
        const { source_path, output_name, modifications, images } = args
        if (!source_path || !output_name) {
          return '错误：缺少必要参数 source_path 或 output_name'
        }
        if (!modifications && !images) {
          return '错误：至少需要提供 modifications 或 images 参数'
        }
        if (!fs.existsSync(source_path)) {
          return `错误：源文件不存在：${source_path}`
        }

        const JSZip = require('jszip')
        const path = require('path')
        const buffer = await fs.promises.readFile(source_path)
        const zip = await JSZip.loadAsync(buffer)

        const docXmlFile = zip.file('word/document.xml')
        if (!docXmlFile) {
          return '错误：该 docx 文件结构异常，未找到 word/document.xml'
        }

        let xml = await docXmlFile.async('string')
        console.log(`[modify_docx] xml length: ${xml.length}, first 500 chars: ${xml.substring(0, 500)}`)
        let replaceCount = 0
        let imageCount = 0

        // ── 1. 文本替换 + 样式修改 ──
        // 合并样式：在已有 rPr 基础上增/改指定属性，保留其余属性
        const mergeRPr = (existingRPr: string, style: any): string => {
          let rPr = existingRPr || '<w:rPr></w:rPr>'
          // 确保有 <w:rPr> 包裹
          if (!rPr.includes('<w:rPr>')) rPr = '<w:rPr></w:rPr>'

          const upsert = (tag: string, value: string) => {
            const tagBase = tag.replace(/\/.*$/, '') // '<w:b/>' -> '<w:b'
            const re = new RegExp(`${tagBase}[^/]*?\\/>`, 'g')
            if (rPr.match(re)) {
              rPr = rPr.replace(re, value)
            } else {
              rPr = rPr.replace('</w:rPr>', value + '</w:rPr>')
            }
          }

          if (style.bold !== undefined) {
            if (style.bold) upsert('<w:b', '<w:b/><w:bCs/>')
            else { rPr = rPr.replace(/<w:b\/>/g, '').replace(/<w:bCs\/>/g, '') }
          }
          if (style.italic !== undefined) {
            if (style.italic) upsert('<w:i', '<w:i/><w:iCs/>')
            else { rPr = rPr.replace(/<w:i\/>/g, '').replace(/<w:iCs\/>/g, '') }
          }
          if (style.underline !== undefined) {
            upsert('<w:u', `<w:u w:val="${style.underline ? 'single' : 'none'}"/>`)
          }
          if (style.color) upsert('<w:color', `<w:color w:val="${style.color}"/>`)
          if (style.fontSize) upsert('<w:sz', `<w:sz w:val="${style.fontSize}"/><w:szCs w:val="${style.fontSize}"/>`)
          if (style.highlight) upsert('<w:highlight', `<w:highlight w:val="${style.highlight}"/>`)
          return rPr
        }

        // 辅助函数：在 XML 中替换文字，支持跨 <w:r> 节点匹配
        // 只在 <w:body> 内操作，排除元数据（dc:title 等）
        // style: 要合并的样式对象（可选），合并到现有 rPr 上，不覆盖原有属性
        const replaceInXml = (xmlStr: string, search: string, replaceText: string, style?: any): string => {
          const bodyMatch = xmlStr.match(/([\s\S]*?<w:body[^>]*>)([\s\S]*?)(<\/w:body>[\s\S]*)/)
          if (!bodyMatch) {
            return replaceInXmlCore(xmlStr, search, replaceText, style)
          }
          const bodyPrefix = bodyMatch[1]
          const bodyContent = bodyMatch[2]
          const bodySuffix = bodyMatch[3]
          const newBody = replaceInXmlCore(bodyContent, search, replaceText, style)
          if (newBody !== bodyContent) return bodyPrefix + newBody + bodySuffix
          return xmlStr
        }

        // 核心替换函数：在给定 XML 片段中搜索替换文字，支持跨 <w:r> 节点
        // style: 要合并的样式对象（可选），会与 run 块的现有样式合并，不覆盖
        const replaceInXmlCore = (xmlStr: string, search: string, replaceText: string, style?: any): string => {
          // 快速路径：文字在同一个节点内
          if (xmlStr.includes(search)) {
            if (style) {
              const runStart = '<w:r '
              const runStartAlt = '<w:r>'
              const runEnd = '</w:r>'
              let pos = 0
              while (pos < xmlStr.length) {
                let rStart = xmlStr.indexOf(runStart, pos)
                const rStartAlt = xmlStr.indexOf(runStartAlt, pos)
                if (rStart === -1) rStart = rStartAlt
                else if (rStartAlt !== -1 && rStartAlt < rStart) rStart = rStartAlt
                if (rStart === -1) break

                const rEnd = xmlStr.indexOf(runEnd, rStart)
                if (rEnd === -1) break
                const block = xmlStr.substring(rStart, rEnd + runEnd.length)

                if (block.includes(search)) {
                  let newBlock = block.replace(search, replaceText)
                  // 提取现有 rPr，与新样式合并（保留原有字体、字号等）
                  const existingRPrM = newBlock.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)
                  const existingRPr = existingRPrM ? existingRPrM[0] : ''
                  const mergedRPr = mergeRPr(existingRPr, style)
                  if (existingRPr) {
                    newBlock = newBlock.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, mergedRPr)
                  } else {
                    const rTagEnd = newBlock.indexOf('>')
                    newBlock = newBlock.substring(0, rTagEnd + 1) + mergedRPr + newBlock.substring(rTagEnd + 1)
                  }
                  return xmlStr.substring(0, rStart) + newBlock + xmlStr.substring(rEnd + runEnd.length)
                }
                pos = rEnd + runEnd.length
              }
            }
            return xmlStr.split(search).join(replaceText)
          }

          // 跨节点路径
          const runStart = '<w:r '
          const runStartAlt = '<w:r>'
          const runEnd = '</w:r>'
          const nodes: { type: 'run' | 'other'; content: string; text: string }[] = []
          let scanPos = 0

          while (scanPos < xmlStr.length) {
            let rStart = xmlStr.indexOf(runStart, scanPos)
            const rStartAlt = xmlStr.indexOf(runStartAlt, scanPos)
            if (rStart === -1) rStart = rStartAlt
            else if (rStartAlt !== -1 && rStartAlt < rStart) rStart = rStartAlt
            if (rStart === -1) {
              nodes.push({ type: 'other', content: xmlStr.substring(scanPos), text: '' })
              break
            }
            if (rStart > scanPos) {
              nodes.push({ type: 'other', content: xmlStr.substring(scanPos, rStart), text: '' })
            }
            const rEnd = xmlStr.indexOf(runEnd, rStart)
            if (rEnd === -1) {
              nodes.push({ type: 'other', content: xmlStr.substring(rStart), text: '' })
              break
            }
            const block = xmlStr.substring(rStart, rEnd + runEnd.length)
            const textM = block.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/)
            nodes.push({ type: 'run', content: block, text: textM ? textM[1] : '' })
            scanPos = rEnd + runEnd.length
          }

          const runNodes = nodes.filter(n => n.type === 'run')
          let concat = ''
          const charOffsets: number[] = []
          for (const rn of runNodes) {
            charOffsets.push(concat.length)
            concat += rn.text
          }

          const idx = concat.indexOf(search)
          if (idx === -1) return xmlStr

          const endIdx = idx + search.length
          const involved: number[] = []
          for (let i = 0; i < runNodes.length; i++) {
            const start = charOffsets[i]
            const end = start + (runNodes[i].text?.length || 0)
            if (start < endIdx && end > idx) involved.push(i)
          }
          if (involved.length === 0) return xmlStr

          const first = involved[0]
          const last = involved[involved.length - 1]
          const prefix = (runNodes[first].text || '').slice(0, idx - charOffsets[first])
          const suffix = (runNodes[last].text || '').slice(endIdx - charOffsets[last])

          for (let i = 0; i <= last; i++) {
            if (!involved.includes(i)) continue
            const rn = runNodes[i]
            if (i === first) {
              let newContent = rn.content
              newContent = newContent.replace(/(<w:t[^>]*>)[\s\S]*?(<\/w:t>)/, `$1${prefix}${replaceText}${suffix}$2`)
              if (style) {
                const existingRPrM = newContent.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)
                const existingRPr = existingRPrM ? existingRPrM[0] : ''
                const mergedRPr = mergeRPr(existingRPr, style)
                if (existingRPr) {
                  newContent = newContent.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, mergedRPr)
                } else {
                  const rTagEnd = newContent.indexOf('>')
                  newContent = newContent.substring(0, rTagEnd + 1) + mergedRPr + newContent.substring(rTagEnd + 1)
                }
              }
              rn.content = newContent
              rn.text = prefix + replaceText + suffix
            } else {
              rn.content = rn.content.replace(/(<w:t[^>]*>)[\s\S]*?(<\/w:t>)/, '$1$2')
              rn.text = ''
            }
          }

          let result = ''
          let runIdx = 0
          for (const node of nodes) {
            if (node.type === 'other') {
              result += node.content
            } else {
              result += runNodes[runIdx].content
              runIdx++
            }
          }
          return result
        }

        if (modifications && Array.isArray(modifications)) {
          for (const mod of modifications) {
            if (!mod.search || typeof mod.search !== 'string') continue
            const before = xml
            const replacement = mod.replace ?? mod.search

            if (mod.paragraphStyle) {
              // 按段落样式过滤：只在匹配 <w:pStyle w:val="..."> 的段落中替换
              const pStyleVal = mod.paragraphStyle
              const paraRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
              let pm: RegExpExecArray | null
              let newXml = ''
              let lastPEnd = 0
              while ((pm = paraRegex.exec(xml)) !== null) {
                const paraBlock = pm[0]
                const paraStart = pm.index
                // 检查段落是否包含指定的 pStyle
                const styleMatch = paraBlock.match(/<w:pStyle\s+w:val="([^"]+)"/)
                const paraStyle = styleMatch ? styleMatch[1] : 'Normal'
                // 保留段落前的非段落内容
                newXml += xml.slice(lastPEnd, paraStart)
                if (paraStyle === pStyleVal || paraStyle.toLowerCase() === pStyleVal.toLowerCase()) {
                  // 在这个段落内执行替换
                  newXml += replaceInXml(paraBlock, mod.search, replacement, rPr)
                } else {
                  newXml += paraBlock
                }
                lastPEnd = paraStart + paraBlock.length
              }
              newXml += xml.slice(lastPEnd)
              xml = newXml
            } else {
              // 全文搜索替换
              xml = replaceInXml(xml, mod.search, replacement, mod.style)
            }

            const changed = xml !== before
            if (changed) replaceCount++
            console.log(`[modify_docx] search="${mod.search}", pStyle=${mod.paragraphStyle || 'any'}, changed=${changed}`)
          }
        }

        // ── 2. 图片嵌入 ──
        if (images && Array.isArray(images)) {
          // 读取或创建 rels 文件
          let relsXml = ''
          const relsFile = zip.file('word/_rels/document.xml.rels')
          if (relsFile) {
            relsXml = await relsFile.async('string')
          } else {
            relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
          }

          // 读取或创建 [Content_Types].xml
          let contentTypes = ''
          const ctFile = zip.file('[Content_Types].xml')
          if (ctFile) {
            contentTypes = await ctFile.async('string')
          }

          for (const img of images) {
            if (!img.search_text || !img.image_path) continue
            if (!fs.existsSync(img.image_path)) continue

            const imgBuffer = await fs.promises.readFile(img.image_path)
            const imgExt = path.extname(img.image_path).toLowerCase().replace('.', '') || 'png'
            const contentTypeMap: Record<string, string> = {
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp'
            }
            const contentType = contentTypeMap[imgExt] || 'image/png'

            // 计算图片序号
            const existingMedia = Object.keys(zip.files).filter(f => f.startsWith('word/media/image'))
            const imgIndex = existingMedia.length + 1
            const imgFileName = `image${imgIndex}.${imgExt}`
            const relId = `rIdImg${imgIndex}`

            // 写入图片到 zip
            zip.file(`word/media/${imgFileName}`, imgBuffer)

            // 更新 rels
            relsXml = relsXml.replace('</Relationships>',
              `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imgFileName}"/></Relationships>`)

            // 更新 Content_Types（如果没有对应类型）
            if (!contentTypes.includes(`Extension="${imgExt}"`)) {
              contentTypes = contentTypes.replace('</Types>',
                `<Default Extension="${imgExt}" ContentType="${contentType}"/></Types>`)
            }

            // 构建图片 XML 节点
            const widthEmu = Math.round((img.width || 10) * 360000)
            const heightEmu = Math.round((img.height || 8) * 360000)
            const drawingXml = `<w:drawing>` +
              `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
              `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
              `<wp:docPr id="${imgIndex}" name="Picture ${imgIndex}"/>` +
              `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
              `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
              `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
              `<pic:nvPicPr><pic:cNvPr id="${imgIndex}" name="${imgFileName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
              `<pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
              `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
              `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`

            // 替换搜索文字为图片（支持跨节点匹配）
            const beforeImg = xml
            xml = replaceInXml(xml, img.search_text, drawingXml)
            if (xml === beforeImg) {
              // 最后尝试简单替换
              xml = xml.replace(img.search_text, drawingXml)
            }
            imageCount++
          }

          zip.file('word/_rels/document.xml.rels', relsXml)
          zip.file('[Content_Types].xml', contentTypes)
        }

        zip.file('word/document.xml', xml)
        const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' })

        const genDir = getGeneratedFilesDir(sessionId)
        const safeName = output_name.replace(/[<>:"/\\|?*]/g, '_')
        const filePath = join(genDir, safeName)
        await fs.promises.writeFile(filePath, outputBuffer)

        const activeWin = agentWindow || mainWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (activeWin) {
          activeWin.webContents.send('api:generated-file-updated')
        }

        const parts = []
        if (replaceCount > 0) parts.push(`${replaceCount} 处文本`)
        if (imageCount > 0) parts.push(`${imageCount} 张图片`)
        return JSON.stringify({
          status: 'success',
          message: `文件 "${safeName}" 已生成，修改了 ${parts.join('、')}`,
          file_path: filePath,
          file_name: safeName,
          replaced: replaceCount,
          images: imageCount
        }, null, 2)
      } catch (err: any) {
        return `修改 docx 文件失败：${err.message || err}`
      }
    }

    // 修改 xlsx 文件（支持样式、公式、合并单元格、批量追加新行）
    // ⚠️ exceljs 在 Main Process 中读取大型文件时会瞬间占用大量内存，触发 Crashpad 退出。
    // 解决方案：用 worker_threads 将 exceljs 操作完全隔离到子线程，子线程崩溃不影响主进程。
    if (name === 'modify_xlsx_file') {
      try {
        const { source_path, output_name, modifications, append_rows, merge_cells, add_sheet, column_widths, data_validations } = args
        console.log('[modify_xlsx_file] 开始执行 Excel 修改, 路径:', source_path, '输出文件名:', output_name)
        if (!source_path || !output_name) {
          console.warn('[modify_xlsx_file] 缺少必要参数 source_path 或 output_name')
          return '错误：缺少必要参数 source_path 或 output_name'
        }
        if (!modifications && !append_rows && !merge_cells && !add_sheet && !column_widths && !data_validations) {
          console.warn('[modify_xlsx_file] 未提供任何修改操作')
          return '错误：未提供任何修改操作（modifications, append_rows, merge_cells 等至少需要提供一个）'
        }
        if (!fs.existsSync(source_path)) {
          console.warn('[modify_xlsx_file] 源文件不存在:', source_path)
          return `错误：源文件不存在：${source_path}`
        }

        const genDir = getGeneratedFilesDir(sessionId)
        const safeName = output_name.replace(/[<>:"/\\|?*]/g, '_')
        const filePath = join(genDir, safeName)

        // ✅ 使用 Electron 官方的 utilityProcess.fork() 运行后台 Node.js 任务。
        // utilityProcess 是 Electron 专为此设计的 API（Electron 20+）：
        //   - 独立 OS 进程，与 Main Process 完全内存隔离
        //   - 不带 GUI / Crashpad，不会触发应用退出
        //   - 通信使用 child.postMessage / child.on('message')
        //   - 子进程内使用 process.parentPort 收发消息
        const { utilityProcess } = require('electron')
        let workerPath = join(__dirname, 'xlsx-worker.js')
        if (!fs.existsSync(workerPath)) {
          workerPath = join(app.getAppPath(), 'src', 'main', 'xlsx-worker.js')
        }
        console.log('[modify_xlsx_file] utilityProcess.fork 启动, path:', workerPath)

        const { modCount, appendCount } = await new Promise<{ modCount: number; appendCount: number }>((resolve, reject) => {
          const child = utilityProcess.fork(workerPath, [], {
            serviceName: 'xlsx-worker',
            stdio: 'pipe',
            execArgv: ['--max-old-space-size=8192']
          })

          // 转发子进程 stdout/stderr
          child.stdout?.on('data', (d: Buffer) => console.log('[xlsx-worker]', d.toString().trim()))
          child.stderr?.on('data', (d: Buffer) => console.error('[xlsx-worker err]', d.toString().trim()))

          let settled = false
          const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }

          const timeout = setTimeout(() => {
            child.kill()
            done(() => reject(new Error('xlsx 处理超时（>120s）')))
          }, 120000)

          child.on('message', (msg: any) => {
            clearTimeout(timeout)
            if (msg.success) {
              done(() => resolve({ modCount: msg.modCount, appendCount: msg.appendCount }))
            } else {
              done(() => reject(new Error(msg.error || 'xlsx 子进程处理失败')))
            }
            child.kill()
          })
          child.on('exit', (code: number) => {
            clearTimeout(timeout)
            if (code !== 0) {
              done(() => reject(new Error(`xlsx 子进程异常退出，code=${code}`)))
            }
          })

          // 发送数据给子进程
          child.postMessage({
            source_path,
            output_path: filePath,
            modifications,
            append_rows,
            merge_cells,
            add_sheet,
            column_widths,
            data_validations
          })
        })

        console.log('[modify_xlsx_file] Excel 文件成功保存。modCount:', modCount, 'appendCount:', appendCount)

        const activeWin = agentWindow || mainWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (activeWin) {
          activeWin.webContents.send('api:generated-file-updated')
        }

        const parts = []
        if (modCount > 0) parts.push(`修改了 ${modCount} 个单元格`)
        if (appendCount > 0) parts.push(`追加了 ${appendCount} 行数据`)
        const messageStr = parts.length > 0 ? parts.join('，') : '无数据改动'

        return JSON.stringify({
          status: 'success',
          message: `文件 "${safeName}" 已生成，${messageStr}`,
          file_path: filePath,
          file_name: safeName,
          modified: modCount,
          appended: appendCount
        }, null, 2)
      } catch (err: any) {
        console.error('[modify_xlsx_file] 捕获到内部错误:', err)
        return `修改 xlsx 文件失败：${err.message || err}`
      }
    }

    // 通用读取文件工具（支持 xlsx/xls/docx/pdf/csv 及文本文件）
    if (name === 'read_file') {
      try {
        const { file_path } = args
        if (!file_path) return '错误：缺少必要参数 file_path'
        if (!fs.existsSync(file_path)) return `错误：文件不存在：${file_path}`
        const ext = file_path.split('.').pop()?.toLowerCase() || ''
        let content = ''

        if (ext === 'pdf') {
          const pdf = require('pdf-parse')
          const buffer = await fs.promises.readFile(file_path)
          const data = await pdf(buffer)
          content = data.text || ''
          if (!content.trim()) content = '[PDF 文件已加载，但未能提取到文本内容（可能是扫描件或纯图片 PDF）]'
        } else if (ext === 'docx') {
          const mammoth = require('mammoth')
          const buffer = await fs.promises.readFile(file_path)
          const result = await mammoth.extractRawText({ buffer })
          content = result.value || ''
          if (!content.trim()) content = '[Word 文档已加载，但内容为空]'
        } else if (ext === 'xlsx' || ext === 'xls') {
          const XLSX = require('xlsx')
          const workbook = XLSX.readFile(file_path)
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
          const Papa = require('papaparse')
          const csvContent = await fs.promises.readFile(file_path, 'utf-8')
          const parsed = Papa.parse(csvContent, { header: true })
          if (parsed.data && parsed.data.length > 0) {
            const headers = parsed.meta.fields || []
            const rows = parsed.data.slice(0, 500) as any[]
            content = `列名: ${headers.join(', ')}\n\n`
            content += rows.map((row, i) => `第${i + 1}行: ${headers.map(h => `${h}=${row[h] ?? ''}`).join(', ')}`).join('\n')
            if ((parsed.data as any[]).length > 500) content += `\n\n... 共 ${parsed.data.length} 行，已截取前 500 行`
          } else {
            content = '[CSV 文件已加载，但内容为空]'
          }
        } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
          content = `[图片文件: ${basename(file_path)}，路径: ${file_path}]`
        } else {
          // 文本/代码文件
          content = await fs.promises.readFile(file_path, 'utf-8')
        }

        const MAX_READ_LEN = 30000
        if (content.length > MAX_READ_LEN) {
          content = content.slice(0, MAX_READ_LEN) + `\n\n... [警告：内容过长已自动截断，仅展示前 ${MAX_READ_LEN} 个字符。如需阅读后续部分，请通过命令拆分读取或使用其他方式。]`
        }
        return content
      } catch (err: any) {
        return `读取文件失败：${err.message || err}`
      }
    }

    // 未指定工作空间时，自动使用存储目录下的 workspace 子目录
    if (!workspacePath) {
      workspacePath = join(getActiveStorageDir(), 'workspace')
      if (!fs.existsSync(workspacePath)) {
        try { fs.mkdirSync(workspacePath, { recursive: true }) } catch (e) { /* ignore */ }
      }
    }

    if (!fs.existsSync(workspacePath)) {
      return `错误：工作空间路径不存在：${workspacePath}`
    }

    try {
      if (name === 'list_workspace_files') {
        const files = await fs.promises.readdir(workspacePath)
        const listInfo: any[] = []
        for (const file of files) {
          const fullPath = join(workspacePath, file)
          const stat = await fs.promises.stat(fullPath)
          listInfo.push({
            name: file,
            isDirectory: stat.isDirectory(),
            size: stat.isFile() ? stat.size : undefined
          })
        }
        return JSON.stringify(listInfo, null, 2)
      }

      if (name === 'read_workspace_file') {
        const { relative_path } = args
        const fullPath = join(workspacePath, relative_path)
        if (!fullPath.startsWith(workspacePath)) {
          return '错误：安全限制，无法读取工作空间外部的文件。'
        }
        if (!fs.existsSync(fullPath)) {
          return `错误：文件不存在：${relative_path}`
        }
        const stat = await fs.promises.stat(fullPath)
        if (stat.isDirectory()) {
          return `错误：${relative_path} 是一个目录，不能读取为文本文件。`
        }
        let content = await fs.promises.readFile(fullPath, 'utf-8')
        const MAX_READ_LEN = 30000
        if (content.length > MAX_READ_LEN) {
          content = content.slice(0, MAX_READ_LEN) + `\n\n... [警告：内容过长已自动截断，仅展示前 ${MAX_READ_LEN} 个字符。如需阅读后续部分，请通过命令拆分读取或使用其他方式。]`
        }
        return content
      }

      if (name === 'write_workspace_file') {
        const { relative_path, content } = args
        const fullPath = join(workspacePath, relative_path)
        if (!fullPath.startsWith(workspacePath)) {
          return '错误：安全限制，无法写入到工作空间外部。'
        }
        const parentDir = dirname(fullPath)
        if (!fs.existsSync(parentDir)) {
          await fs.promises.mkdir(parentDir, { recursive: true })
        }
        await fs.promises.writeFile(fullPath, content, 'utf-8')
        return `成功：文件已写入到相对路径 ${relative_path}`
      }

      return `未知工具：${name}`
    } catch (err: any) {
      return `工具执行失败：${err.message || err}`
    }
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
    event?: Electron.IpcMainInvokeEvent
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

    const effectiveTools = getFormattedTools(!!event)
    if (effectiveTools.length > 0) {
      body.tools = effectiveTools
      body.tool_choice = 'auto'
    }

    let chatHistory = JSON.parse(JSON.stringify(messages)) // 深拷贝避免污染

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

    let loopCount = 0
    const maxLoops = 40

    let totalPromptTokens = 0
    let totalCompletionTokens = 0

    const sendTokenEvent = () => {
      try {
        if (event && (totalPromptTokens > 0 || totalCompletionTokens > 0)) {
          event.sender.send('api:llm-token-usage', {
            model: body.model || model,
            provider,
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            timestamp: Date.now(),
            sessionId,
            messageId
          })
        }
      } catch (se) {
        console.error('发送 token usage 事件失败', se)
      }
    }

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
          totalPromptTokens += data.usage.prompt_tokens || 0
          totalCompletionTokens += data.usage.completion_tokens || 0
        } else if (data.choices?.[0]?.message?.content) {
          const textOut = data.choices[0].message.content || ''
          const textIn = chatHistory.map((m: any) => {
            if (Array.isArray(m.content)) {
              return m.content.map((b: any) => b.text || '').join('')
            }
            return m.content || ''
          }).join('')
          totalPromptTokens += Math.max(1, Math.round(textIn.length * 0.5))
          totalCompletionTokens += Math.max(1, Math.round(textOut.length * 0.8))
        }

        const message = data.choices?.[0]?.message
        if (!message) {
          throw new Error('未获取到有效的模型答复结构')
        }

        const toolCalls = message.tool_calls
        if (toolCalls && toolCalls.length > 0) {
          chatHistory.push(message)

          for (const toolCall of toolCalls) {
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

            let toolResult = ''
            if (mcpManager.hasTool(toolName)) {
              toolResult = await mcpManager.executeTool(toolName, toolArgs)
            } else {
              toolResult = await executeTool(toolName, toolArgs, workspacePath || '', event, sessionId)
            }

            if (event) {
              event.sender.send('api:llm-tool-event', {
                type: 'tool_result',
                name: toolName,
                result: toolResult,
                sessionId
              })
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
    mcpManager.connectAll(config.servers).catch(console.error)
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
        const transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } })
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
          const transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } })
          await client.connect(transport)
        }
      }

      const response = await client.listTools()
      await client.close()

      return { success: true, tools: response.tools || [], protocol: usedProtocol }
    } catch (err: any) {
      console.error('MCP Test Error:', err)
      return { success: false, error: err.message || err.toString() }
    }
  })

  ipcMain.handle('api:get-mcp-config', () => {
    return systemMcpConfig
  })

  // 初始化微信 Bot 服务
  wechatBotManager = new WechatBotManager({
    getDB,
    callLlm: async (config, messages) => {
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

      return callLlmInternal(effectiveConfig, messages, getActiveStorageDir())
    },
    onStatusUpdated: () => {
      if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.webContents.send('api:wechat-status-updated', wechatBotManager?.getState())
      }
    },
    notifyRenderSessionUpdate: () => {
      if (agentWindow && !agentWindow.isDestroyed()) {
        agentWindow.webContents.send('api:wechat-session-updated')
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('api:wechat-session-updated')
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
    if (pendingPermissions.size > 0) {
      for (const [, resolve] of pendingPermissions.entries()) {
        resolve(false)
      }
      pendingPermissions.clear()
    }

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

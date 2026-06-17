import { app, shell, BrowserWindow, ipcMain, screen, protocol, net, Tray, Menu, dialog, Notification } from 'electron'
import { join, basename, dirname } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as fs from 'fs'
import * as os from 'os'
import { exec } from 'child_process'
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
      if (existing && existing.config.url === config.url && existing.config.apiKey === config.apiKey) {
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

        // 优先尝试 Streamable HTTP（MCP 2025-03-26 新协议），失败则回退到旧 SSE 协议
        let transport: StreamableHTTPClientTransport | SSEClientTransport
        let client = new Client(
          { name: 'AgentPet-Client', version: '1.0.0' },
          { capabilities: {} }
        )

        try {
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          await client.connect(transport)
          console.log(`[MCP] 服务 ${config.name} 使用 Streamable HTTP 协议连接成功`)
        } catch (httpErr: any) {
          console.warn(`[MCP] Streamable HTTP 连接失败 (${httpErr.message})，正在回退到 SSE 协议...`)
          // 重新创建 client 避免状态污染
          client = new Client(
            { name: 'AgentPet-Client', version: '1.0.0' },
            { capabilities: {} }
          )
          transport = new SSEClientTransport(new URL(config.url), { eventSourceInitDict: { headers } })
          await client.connect(transport)
          console.log(`[MCP] 服务 ${config.name} 使用 SSE 协议连接成功（降级）`)
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

  public async executeTool(name: string, args: any): Promise<string> {
    let targetConn: any = null
    for (const conn of this.connections.values()) {
      if (conn.tools.some(t => t.name === name)) {
        targetConn = conn
        break
      }
    }

    if (!targetConn) {
      return `错误：未在任何已连接的 MCP 服务中找到工具: ${name}`
    }

    try {
      const response = await targetConn.client.callTool({ name, arguments: args })
      if (response && response.content) {
        return response.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
      }
      return 'MCP 工具执行完毕，但未返回可读文本。'
    } catch (err: any) {
      console.error(`[MCP] 调用外部工具 ${name} 失败`, err)
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

  const pendingPermissions = new Map<number, (approved: boolean) => void>()
  let nextPermissionRequestId = 1

  ipcMain.on('api:permission-response', (_, { requestId, approved }) => {
    const resolve = pendingPermissions.get(requestId)
    if (resolve) {
      resolve(!!approved)
      pendingPermissions.delete(requestId)
    }
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
            (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, is_error, user_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                  const isError = m.isError ? 1 : 0
                  const userId = m.userId || 'system'

                  insertMessage.run(msgId, s.id, sender, text, time, isThinking, toolSteps, fileInfo, isError, userId)
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
            try { fileInfo = JSON.parse(m.file_info) } catch (e) { console.error(e) }
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
        (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, is_error, user_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            const isError = m.isError ? 1 : 0
            const userId = m.userId || 'system'

            insertMessage.run(msgId, s.id, sender, text, time, isThinking, toolSteps, fileInfo, isError, userId)
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

  // 4.5. 文本文件选择与加载接口
  ipcMain.handle('api:select-file', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: '选择上传的文本文件',
      properties: ['openFile'],
      filters: [
        { name: '文本与代码文件', extensions: ['txt', 'md', 'js', 'jsx', 'ts', 'tsx', 'json', 'html', 'css', 'py', 'java', 'c', 'cpp', 'sh', 'bat', 'yml', 'yaml', 'ini', 'xml'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const filePath = result.filePaths[0]
    const name = basename(filePath)
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      return { name, path: filePath, content }
    } catch (e: any) {
      throw new Error(`读取文件失败: ${e.message}`)
    }
  })

  // 本地系统工具定义
  const toolDefinitions = [
    {
      type: 'function',
      function: {
        name: 'run_terminal_command',
        description: '在当前选定的工作空间目录下执行一条终端命令，并返回输出结果。只能在工作空间已选择时使用。',
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
        name: 'read_workspace_file',
        description: '读取当前工作空间目录下指定文件的文本内容。',
        parameters: {
          type: 'object',
          properties: {
            relative_path: { type: 'string', description: '文件相对于工作空间根目录的相对路径' }
          },
          required: ['relative_path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_workspace_file',
        description: '在当前工作空间目录下创建或覆写指定文件，并写入文本内容。',
        parameters: {
          type: 'object',
          properties: {
            relative_path: { type: 'string', description: '文件相对于工作空间根目录的相对路径' },
            content: { type: 'string', description: '要写入的文本内容' }
          },
          required: ['relative_path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_workspace_files',
        description: '列出当前工作空间目录下的所有文件和文件夹列表。',
        parameters: {
          type: 'object',
          properties: {}
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
        name: 'get_weather',
        description: '获取指定城市/地区的天气预报信息。如果不指定城市，默认查询深圳。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市或地区名称，例如 "深圳"、"北京"' }
          },
          required: ['city']
        }
      }
    }
  ]

  function getFormattedTools(isFrontend: boolean): any[] {
    const list: any[] = []
    
    if (isFrontend) {
      list.push(...toolDefinitions)
    } else {
      const weatherTool = toolDefinitions.find(t => t.function.name === 'get_weather')
      if (weatherTool) {
        list.push(weatherTool)
      }
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
  async function executeTool(name: string, args: any, workspacePath: string, event?: Electron.IpcMainInvokeEvent): Promise<string> {
    if (name === 'get_weather') {
      try {
        const { city } = args
        const targetCity = city || '深圳'
        try {
          const resp = await net.fetch(`https://autodev.openspeech.cn/api/v1/open/weather?city=${encodeURIComponent(targetCity)}`)
          if (resp.ok) {
            const data: any = await resp.json()
            if (data && data.code === 1 && data.data && data.data.length > 0) {
              const forecasts = data.data.slice(0, 3).map((item: any) => {
                return `${item.date} (${item.dayOfWeek}): ${item.weather}, 温度: ${item.low}℃ ~ ${item.high}℃, 风向: ${item.wind}, 空气质量: ${item.airQuality || '未知'}`
              }).join('\n')
              return `[天气查询结果 - ${targetCity}]\n当前及近期天气预报:\n${forecasts}`
            }
          }
        } catch (err) {
          console.error('autodev 天气接口异常，尝试 wttr.in 备用', err)
        }

        try {
          const resp = await net.fetch(`https://wttr.in/${encodeURIComponent(targetCity)}?format=3`)
          if (resp.ok) {
            const text = await resp.text()
            return `[天气查询结果 - ${targetCity}]\n${text.trim()}`
          }
        } catch (err) {
          console.error('wttr.in 天气接口异常', err)
        }

        return `暂未查询到 ${targetCity} 的天气信息，请稍后再试。`
      } catch (err: any) {
        return `执行 get_weather 工具失败: ${err.message || err}`
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
        // 智能降级：如果没有配置工作空间，则默认在用户主目录下执行全局命令
        const execCwd = workspacePath && fs.existsSync(workspacePath)
          ? workspacePath
          : os.homedir()

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

    if (!workspacePath) {
      return '错误：用户尚未选择工作空间目录。请指示用户点击输入框底部的“选择工作空间”按钮配置工作目录。'
    }

    if (!fs.existsSync(workspacePath)) {
      return `错误：选定的工作空间路径不存在：${workspacePath}`
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
        const content = await fs.promises.readFile(fullPath, 'utf-8')
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
    currentLlmAbortController = new AbortController()
    
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

    let chatHistory = [...messages]
    let loopCount = 0
    const maxLoops = 6

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
          const textIn = chatHistory.map(m => m.content || '').join('')
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
              toolResult = await executeTool(toolName, toolArgs, workspacePath || '', event)
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
          return message.content || ''
        }

      } catch (e: any) {
        console.error('[call-llm loop error]', e)
        sendTokenEvent()
        currentLlmAbortController = null
        if (e.name === 'AbortError' || e.message?.includes('aborted') || e.message?.includes('Cancel') || e.message?.includes('abort')) {
          throw new Error('UserAborted')
        }
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

      // 优先尝试 Streamable HTTP（MCP 2025-03-26 新协议），失败则回退到旧 SSE 协议
      let client = new Client(
        { name: 'AgentPet-Test', version: '1.0.0' },
        { capabilities: {} }
      )
      let usedProtocol = 'Streamable HTTP'

      try {
        const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
        await client.connect(transport)
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

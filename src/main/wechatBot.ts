import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { randomBytes } from 'node:crypto'
import * as crypto from 'crypto'
import * as https from 'https'
import * as http from 'http'

export interface WechatLlmConfig {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  useSystemConfig: boolean
}

export interface WechatBotState {
  status: 'disconnected' | 'qrcode_ready' | 'scanned' | 'connected'
  qrcodeUrl: string
  botId: string
  messagesReceived: number
  messagesSent: number
  logs: Array<{ time: string; type: 'info' | 'in' | 'out'; text: string }>
  llmConfig: WechatLlmConfig
  autoReplyText: string
  enableAutoReply: boolean
  activeChats: Array<{ userId: string; nickname: string; lastMessageTime: string }>
}

interface WechatBotManagerOptions {
  getDB: () => any
  callLlm: (
    config: any,
    messages: any[],
    sessionId?: string,
    onToolEvent?: (evt: { type: string; name: string; args?: any; result?: string }) => void
  ) => Promise<string>
  getMcpToolNames: () => string[] | Promise<string[]>
  onStatusUpdated: () => void
  notifyRenderSessionUpdate: (sessionId?: string) => void
  getStorageDir: () => string
}

// ── 自研极简微信 iLink 客户端 ────────────────────────────────────────────
class WechatIlinkClient {
  public token = ''
  public baseUrl = 'https://ilinkai.weixin.qq.com'
  
  constructor(token = '', baseUrl = 'https://ilinkai.weixin.qq.com') {
    this.token = token
    this.baseUrl = baseUrl
  }

  // 随机UIN生成
  private randomWechatUin() {
    const value = randomBytes(4).readUInt32BE(0).toString(10)
    return Buffer.from(value).toString('base64')
  }

  // 构建通用 Headers
  private buildHeaders(bodyLength: number) {
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '131334',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.randomWechatUin(),
      'Content-Type': 'application/json',
      'Content-Length': String(bodyLength)
    }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }
    return headers
  }

  // POST 请求通用方法（使用 Node.js 原生 https 模块，避免 Chromium fetch 的 ERR_INVALID_ARGUMENT）
  private async doPost(path: string, payload: any, timeoutMs = 15000): Promise<any> {
    const fullUrl = `${this.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
    const bodyStr = JSON.stringify(payload)
    const headers = this.buildHeaders(Buffer.byteLength(bodyStr))

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(fullUrl)
      const transport = parsedUrl.protocol === 'https:' ? https : http

      const req = transport.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers,
        timeout: timeoutMs
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error(`JSON 解析失败: ${data.substring(0, 200)}`))
          }
        })
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      req.on('error', (err) => {
        reject(err)
      })

      req.write(bodyStr)
      req.end()
    })
  }

  // GET 请求通用方法
  private async doGet(path: string, searchParams?: Record<string, string>, timeoutMs = 15000): Promise<any> {
    let url = `${this.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
    if (searchParams) {
      const sp = new URLSearchParams(searchParams)
      url += `?${sp.toString()}`
    }
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '131334',
      'X-WECHAT-UIN': this.randomWechatUin()
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      clearTimeout(timer)

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
      }

      return await resp.json()
    } catch (err: any) {
      clearTimeout(timer)
      throw err
    }
  }

  // 1. 获取登录二维码
  public async fetchQRCode(): Promise<{ qrcode: string, qrcode_img_content: string }> {
    const resp = await this.doGet('ilink/bot/get_bot_qrcode', { bot_type: '3' })
    let qrcodeImgContent = resp.qrcode_img_content || ''

    if (qrcodeImgContent && qrcodeImgContent.startsWith('http')) {
      try {
        const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=10&data=${encodeURIComponent(qrcodeImgContent)}`
        const imgResp = await fetch(qrApiUrl)
        if (imgResp.ok) {
          const buffer = await imgResp.arrayBuffer()
          const base64 = Buffer.from(buffer).toString('base64')
          qrcodeImgContent = `data:image/png;base64,${base64}`
        }
      } catch (err) {
        console.error('主进程下载微信二维码图片转 Base64 失败', err)
      }
    }

    return {
      qrcode: resp.qrcode || '',
      qrcode_img_content: qrcodeImgContent
    }
  }

  // 2. 轮询二维码扫码状态
  public async pollQRStatus(qrcode: string, customBaseUrl?: string): Promise<any> {
    const originalBase = this.baseUrl
    if (customBaseUrl) {
      this.baseUrl = customBaseUrl
    }
    try {
      return await this.doGet('ilink/bot/get_qrcode_status', { qrcode }, 35000)
    } finally {
      this.baseUrl = originalBase
    }
  }

  // 3. 长轮询获取微信消息
  public async getUpdates(getUpdatesBuf = '', timeoutMs = 35000): Promise<any> {
    return this.doPost('ilink/bot/getupdates', {
      get_updates_buf: getUpdatesBuf,
      base_info: { channel_version: '2.1.6' }
    }, timeoutMs)
  }

  // 4. 发送文本消息
  public async sendText(toUserId: string, text: string, contextToken: string): Promise<any> {
    const clientId = `openclaw-weixin:${Date.now()}-${randomBytes(4).toString('hex')}`
    return this.doPost('ilink/bot/sendmessage', {
      base_info: { channel_version: '2.1.6' },
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // MESSAGE_TYPE_BOT
        message_state: 2, // MESSAGE_STATE_FINISH
        context_token: contextToken,
        item_list: [
          {
            type: 1, // ITEM_TYPE_TEXT
            text_item: { text }
          }
        ]
      }
    })
  }

  // 5. 上传媒体文件到微信 CDN
  public async uploadMedia(fileBuffer: Buffer, mediaType: number, toUserId: string): Promise<any> {
    const aeskeyBuffer = crypto.randomBytes(16)
    const aeskeyHex = aeskeyBuffer.toString('hex')
    const rawfilemd5 = crypto.createHash('md5').update(fileBuffer).digest('hex')
    const rawsize = fileBuffer.length
    const filesize = Math.ceil((rawsize + 1) / 16) * 16
    const filekey = crypto.randomBytes(16).toString('hex') // 文档要求：32位随机 hex

    const getUrlResp = await this.doPost('ilink/bot/getuploadurl', {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskeyHex,
      no_need_thumb: true,
      base_info: { channel_version: '2.1.6' }
    })

    console.log('[uploadMedia] getuploadurl 完整响应:', JSON.stringify(getUrlResp, null, 2))

    if (!getUrlResp || (!getUrlResp.upload_full_url && !getUrlResp.upload_url && !getUrlResp.url)) {
      throw new Error(`获取上传链接失败: ${JSON.stringify(getUrlResp)}`)
    }

    const uploadUrl = getUrlResp.upload_full_url || getUrlResp.upload_url || getUrlResp.url
    const cdnUrl = getUrlResp.cdn_url || getUrlResp.download_url || getUrlResp.full_url || uploadUrl
    const uploadParam = getUrlResp.upload_param || ''

    // 按文档构造 CDN 上传 URL：base_url?encrypted_query_param={upload_param}&filekey={filekey}
    let fullUrl = uploadUrl
    if (uploadParam) {
      const sep = fullUrl.includes('?') ? '&' : '?'
      fullUrl += `${sep}encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
    }

    const cipher = crypto.createCipheriv('aes-128-ecb', aeskeyBuffer, null)
    cipher.setAutoPadding(true)
    const encryptedBuffer = Buffer.concat([cipher.update(fileBuffer), cipher.final()])

    const uploadResp = await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encryptedBuffer
    })

    if (!uploadResp.ok) {
      throw new Error(`上传 CDN 失败 HTTP ${uploadResp.status}`)
    }

    // 下载参数（encrypt_query_param）必须来自 CDN 上传响应，不能用上传 URL 里的参数
    let encryptParam = uploadResp.headers.get('x-encrypted-param') || ''
    let uploadRespBody: any = null
    try {
      uploadRespBody = await uploadResp.json()
      if (!encryptParam) {
        encryptParam = uploadRespBody.encrypt_param || uploadRespBody.encrypted_param || ''
      }
    } catch (e) { /* 响应可能不是 JSON，忽略 */ }

    const finalCdnUrl = (uploadRespBody && (uploadRespBody.cdn_url || uploadRespBody.download_url || uploadRespBody.full_url)) || cdnUrl

    const result = {
      aeskey: aeskeyHex,
      encrypt_param: encryptParam,
      filekey,
      cdn_url: finalCdnUrl,
      url: finalCdnUrl,
      rawsize,
      filesize,
      rawfilemd5
    }
    console.log('[uploadMedia] 上传结果:', JSON.stringify(result, null, 2))
    return result
  }

  // 6. 发送多类型消息
  public async sendMessageItems(toUserId: string, contextToken: string, itemList: any[]): Promise<any> {
    const clientId = `openclaw-weixin:${Date.now()}-${randomBytes(4).toString('hex')}`
    const resp = await this.doPost('ilink/bot/sendmessage', {
      base_info: { channel_version: '2.1.6' },
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: itemList
      }
    })
    console.log('[sendMessage] 服务器响应:', JSON.stringify(resp, null, 2))
    const ret = Number(resp?.ret ?? resp?.errcode ?? 0)
    if (ret !== 0) {
      throw new Error(`发送失败 (ret=${ret}): ${JSON.stringify(resp)}`)
    }
    return resp
  }

  // 获取输入中的 typing_ticket
  public async getTypingTicket(fromUserId: string, contextToken: string): Promise<string> {
    try {
      const resp = await this.doPost('ilink/bot/getconfig', {
        ilink_user_id: fromUserId,
        context_token: contextToken,
        base_info: { channel_version: '2.1.6' }
      })
      return resp.typing_ticket || ''
    } catch (e) {
      console.error('获取 typing_ticket 失败', e)
      return ''
    }
  }

  // 发送输入状态 (status 1=输入中, 2=取消)
  public async sendTyping(toUserId: string, typingTicket: string, isTyping: boolean): Promise<any> {
    try {
      return await this.doPost('ilink/bot/sendtyping', {
        to_user_id: toUserId,
        typing_ticket: typingTicket,
        status: isTyping ? 1 : 2
      })
    } catch (e) {
      console.error('发送 typing 状态失败', e)
    }
  }
}

// ── 微信消息文字提取器 ──────────────────────────────────────────────────
export function extractText(message: any): string {
  if (!message || !message.item_list) return ''
  for (const item of message.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      let text = item.text_item.text
      const ref = item.ref_msg
      if (ref?.message_item) {
        const isMedia = [2, 3, 4, 5].includes(ref.message_item.type)
        if (!isMedia) {
          const refBody = ref.message_item.text_item?.text || ''
          const title = ref.title || ''
          if (title !== '' || refBody !== '') {
            text = `[引用: ${title} | ${refBody}]\n${text}`
          }
        }
      }
      return text
    }
  }
  // 微信语音消息翻译转文字
  for (const item of message.item_list) {
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

// ── 微信智能托管服务管理类 ──────────────────────────────────────────────
export class WechatBotManager {
  private client: WechatIlinkClient | null = null
  private options: WechatBotManagerOptions
  private configPath: string
  private tokenPath: string
  private syncBufPath: string
  private activeChatsPath: string

  // 内存状态
  private state: WechatBotState = {
    status: 'disconnected',
    qrcodeUrl: '',
    botId: '',
    messagesReceived: 0,
    messagesSent: 0,
    logs: [],
    llmConfig: {
      provider: 'gemini',
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: '',
      temperature: 0.7,
      useSystemConfig: true
    },
    autoReplyText: '你好，我是 Mao 的微信集成助手。',
    enableAutoReply: true,
    activeChats: []
  }

  // 微信好友上下文缓存 (from_user_id -> Array of messages)
  private chatContexts: Map<string, any[]> = new Map()
  
  // 是否正在进行长轮询
  private isMonitoring = false

  // 微信消息去重集合，缓存最近处理过的消息指纹以防重复消费
  private processedMsgKeys: Set<string> = new Set()

  constructor(options: WechatBotManagerOptions) {
    this.options = options
    const userData = app.getPath('userData')
    this.configPath = join(userData, 'wechat_config.json')
    this.tokenPath = join(userData, 'wechat_token.json')
    this.syncBufPath = join(userData, 'wechat_sync_buf.dat')
    this.activeChatsPath = join(userData, 'wechat_active_chats.json')

    this.loadConfig()
    this.loadActiveChats()
    this.addLog('info', '微信 Bot 管理服务已初始化')
  }

  // 日志记录辅助函数
  private addLog(type: 'info' | 'in' | 'out', text: string) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    this.state.logs.unshift({ time, type, text })
    if (this.state.logs.length > 150) {
      this.state.logs.pop()
    }
    this.options.onStatusUpdated()
  }

  // 生成安全的会话目录名（与普通 chat 目录规则一致）
  private safeSessionId(userId: string): string {
    return `wechat_${userId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  // 获取某个微信好友的专属文件目录：base/chat/wechat_<userId>/wechat_files
  private getWechatFilesDir(fromUserId: string): string {
    const safeSessionId = this.safeSessionId(fromUserId)
    const dir = join(this.options.getStorageDir(), 'chat', safeSessionId, 'wechat_files')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  // 解析 wechat-file 协议 URL，兼容旧格式 wechat-file://local/<fileName>
  // 和新格式 wechat-file://local/<safeSessionId>/<fileName>
  private resolveWechatFilePath(fileUrl: string): { filePath: string; fileName: string } | null {
    const relativePath = fileUrl.replace('wechat-file://', '').replace(/^\/+/, '')
    const segments = relativePath.split('/')
    if (segments.length >= 2 && segments[0] === 'local') {
      if (segments.length >= 3) {
        // 新格式：local/<safeSessionId>/<fileName>
        const safeSessionId = segments[1]
        const fileName = segments.slice(2).join('/')
        const filePath = join(this.options.getStorageDir(), 'chat', safeSessionId, 'wechat_files', fileName)
        return { filePath, fileName }
      }
      // 旧格式：local/<fileName>
      const fileName = segments.slice(1).join('/')
      const filePath = join(this.options.getStorageDir(), 'wechat_files', fileName)
      return { filePath, fileName }
    }
    return null
  }

  // 维护最近活跃的微信聊天窗口列表
  private updateActiveChat(userId: string, nickname: string) {
    const idx = this.state.activeChats.findIndex(c => c.userId === userId)
    const chat = {
      userId,
      nickname,
      lastMessageTime: new Date().toISOString()
    }
    if (idx >= 0) {
      this.state.activeChats.splice(idx, 1)
    }
    this.state.activeChats.unshift(chat)
    if (this.state.activeChats.length > 20) {
      this.state.activeChats.pop()
    }
    this.saveActiveChats()
  }

  // 持久化活跃聊天窗口列表
  private saveActiveChats() {
    try {
      fs.writeFileSync(this.activeChatsPath, JSON.stringify(this.state.activeChats, null, 2), 'utf8')
    } catch (e) {
      console.error('保存微信活跃聊天窗口失败:', e)
    }
  }

  // 恢复活跃聊天窗口列表
  private loadActiveChats() {
    try {
      if (fs.existsSync(this.activeChatsPath)) {
        const data = fs.readFileSync(this.activeChatsPath, 'utf8')
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed)) {
          this.state.activeChats = parsed
        }
      }
    } catch (e) {
      console.error('加载微信活跃聊天窗口失败:', e)
    }
  }

  // 加载局部配置文件
  private loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8')
        const parsed = JSON.parse(data)
        this.state.llmConfig = { ...this.state.llmConfig, ...parsed.llmConfig }
        if (parsed.autoReplyText !== undefined) this.state.autoReplyText = parsed.autoReplyText
        if (parsed.enableAutoReply !== undefined) this.state.enableAutoReply = parsed.enableAutoReply
      }
    } catch (e) {
      this.addLog('info', `加载配置文件 wechat_config.json 失败: ${e}`)
    }
  }

  // 保存局部配置到物理文件
  public saveSettings(settings: { llmConfig: WechatLlmConfig; autoReplyText: string; enableAutoReply: boolean }) {
    const prevEnable = this.state.enableAutoReply
    this.state.llmConfig = settings.llmConfig
    this.state.autoReplyText = settings.autoReplyText
    this.state.enableAutoReply = settings.enableAutoReply
    
    try {
      fs.writeFileSync(this.configPath, JSON.stringify({
        llmConfig: this.state.llmConfig,
        autoReplyText: this.state.autoReplyText,
        enableAutoReply: this.state.enableAutoReply
      }, null, 2), 'utf8')
      this.addLog('info', '微信 Bot 独立大模型及自动回复配置已成功保存！')

      // 联动重连：如果 enableAutoReply 变为了 true，并且当前连接断开，自动在后台重连
      if (this.state.enableAutoReply && !prevEnable && this.state.status === 'disconnected') {
        this.autoReconnect()
      }
    } catch (e) {
      this.addLog('info', `保存配置文件 wechat_config.json 失败: ${e}`)
    }
  }

  // 获取当前的内存状态（发送给渲染层）
  public getState(): WechatBotState {
    return this.state
  }

  // 微信登录：扫码授权
  public async startLogin() {
    if (this.state.status === 'connected') {
      this.addLog('info', '正在断开当前连接以重新绑定...')
      await this.logout()
    } else if (this.state.status === 'scanned' || this.state.status === 'qrcode_ready') {
      this.addLog('info', '当前正在等待扫码，请勿重复点击。')
      return
    }

    this.addLog('info', '正在请求微信 iLink 官方接口以获取登录二维码...')
    this.state.status = 'qrcode_ready'
    this.options.onStatusUpdated()

    this.client = new WechatIlinkClient()
    
    try {
      const qr = await this.client.fetchQRCode()
      if (!qr.qrcode) {
        throw new Error('未获取到有效的登录二维码参数 URN')
      }

      this.state.status = 'qrcode_ready'
      this.state.qrcodeUrl = qr.qrcode_img_content
      this.addLog('info', '成功获取登录二维码，请使用手机微信扫码授权')
      this.options.onStatusUpdated()

      // 开始轮询状态，直到确认或超时 (设置 8 分钟超时)
      const deadline = Date.now() + 480000
      let scannedNotified = false
      let pollBaseUrl = this.client.baseUrl

      while (Date.now() <= deadline && (this.state.status as string) !== 'disconnected') {
        if (!this.client) break

        let statusResp: any
        try {
          statusResp = await this.client.pollQRStatus(qr.qrcode, pollBaseUrl)
        } catch (e) {
          console.error('轮询扫码状态异常', e)
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        }

        const status = statusResp.status || 'wait'
        if (status === 'scaned' && !scannedNotified) {
          scannedNotified = true
          this.state.status = 'scanned'
          this.addLog('info', '已成功扫码，请在您的手机微信上点击确认登录')
          this.options.onStatusUpdated()
        } else if (status === 'scaned_but_redirect' && statusResp.redirect_host) {
          pollBaseUrl = `https://${statusResp.redirect_host}`
        } else if (status === 'expired') {
          this.state.status = 'disconnected'
          this.state.qrcodeUrl = ''
          this.addLog('info', '登录二维码已过期，请重新点击扫码登录。')
          this.options.onStatusUpdated()
          break
        } else if (status === 'confirmed') {
          const botId = statusResp.ilink_bot_id || ''
          if (!botId) {
            throw new Error('服务器未返回 Bot ID')
          }

          this.client.token = statusResp.bot_token || ''
          if (statusResp.baseurl) {
            this.client.baseUrl = statusResp.baseurl
          } else if (pollBaseUrl !== this.client.baseUrl) {
            // 如果服务器发生了重定向但 confirmed 响应没有返回 baseurl，使用重定向后的地址
            this.client.baseUrl = pollBaseUrl
          }

          this.state.status = 'connected'
          this.state.botId = botId
          this.state.qrcodeUrl = ''
          this.addLog('info', `微信登录成功！Bot ID: ${this.state.botId}`)
          this.options.onStatusUpdated()

          // 清除旧的同步缓冲区，确保新会话从最新位置开始轮询
          if (fs.existsSync(this.syncBufPath)) {
            try { fs.unlinkSync(this.syncBufPath) } catch {}
          }

          // 保存 Token，用于重启自动连线
          this.saveToken(this.client.token, this.client.baseUrl)

          // 启动消息循环
          this.startMessageLoop()
          break
        }

        await new Promise(resolve => setTimeout(resolve, 1500))
      }

      if (this.state.status !== 'connected' && this.state.status !== 'scanned') {
        this.state.status = 'disconnected'
        this.state.qrcodeUrl = ''
        this.options.onStatusUpdated()
      }

    } catch (e: any) {
      this.state.status = 'disconnected'
      this.state.qrcodeUrl = ''
      this.addLog('info', `获取微信二维码登录连接异常: ${e.message || e}`)
      this.options.onStatusUpdated()
    }
  }

  // 微信注销：断开连接并清理缓存
  public async logout() {
    this.addLog('info', '正在断开微信 Bot 托管连接并清理会话令牌...')
    
    // 终止轮询
    this.stopMessageLoop()

    this.client = null
    this.state.status = 'disconnected'
    this.state.botId = ''
    this.state.qrcodeUrl = ''
    this.chatContexts.clear()

    // 清理本地 Token 保存
    if (fs.existsSync(this.tokenPath)) {
      try { fs.unlinkSync(this.tokenPath) } catch {}
    }

    this.addLog('info', '微信 Bot 连接已完全断开！已恢复未登录状态。')
    this.options.onStatusUpdated()
  }

  // 重启时自动恢复会话连接
  public async autoReconnect() {
    if (!fs.existsSync(this.tokenPath)) {
      return
    }

    try {
      const data = fs.readFileSync(this.tokenPath, 'utf8')
      const { token, baseUrl } = JSON.parse(data)

      if (token) {
        this.addLog('info', '检测到已保存的微信令牌，正在尝试自动恢复微信 Bot 会话连接...')
        this.client = new WechatIlinkClient(token, baseUrl)
        this.state.status = 'connected'
        this.state.botId = '已恢复的会话'
        this.options.onStatusUpdated()

        // 清除旧的同步缓冲区，避免使用过期的游标导致服务器返回错误
        if (fs.existsSync(this.syncBufPath)) {
          try { fs.unlinkSync(this.syncBufPath) } catch {}
        }

        this.startMessageLoop()
      }
    } catch (e) {
      this.addLog('info', `恢复自动登录失败: ${e}`)
      this.state.status = 'disconnected'
      this.options.onStatusUpdated()
    }
  }

  // 保存 token
  private saveToken(token: string, baseUrl: string) {
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify({ token, baseUrl }), 'utf8')
    } catch (e) {
      this.addLog('info', `保存微信 token 失败: ${e}`)
    }
  }

  // 开始消息长轮询监听
  private async startMessageLoop() {
    if (this.isMonitoring) return
    this.isMonitoring = true

    let savedBuf = ''
    try {
      if (fs.existsSync(this.syncBufPath)) {
        savedBuf = fs.readFileSync(this.syncBufPath, 'utf8')
      }
    } catch {}

    this.addLog('info', '已启动微信消息长轮询机制，正在实时监听好友新消息...')

    // 微信好友在内存中维护 context_token
    const contextTokens = new Map<string, string>()

    // 连续错误计数器，用于检测是否需要重新认证
    let consecutiveErrors = 0
    // 连续超时计数器
    let consecutiveTimeouts = 0

    while (this.isMonitoring && this.client) {
      try {
        const resp = await this.client.getUpdates(savedBuf, 35000)

        // 处理服务器状态码
        const ret = Number(resp.ret || 0)
        const errCode = Number(resp.errcode || 0)

        if (ret !== 0 || errCode !== 0) {
          consecutiveErrors++

          if (ret === -14 || errCode === -14) {
            this.addLog('info', '检测到微信登录会话已过期 (errcode: -14)，需重新进行扫码登录！')
            this.logout()
            break
          }

          // 连续错误超过 5 次，可能是 token 失效，强制断开并提示用户
          if (consecutiveErrors >= 5) {
            this.addLog('info', `消息接口连续返回错误 ${consecutiveErrors} 次 (ret: ${ret}, errcode: ${errCode})，可能登录已失效，正在断开连接...`)
            this.logout()
            break
          }

          this.addLog('info', `获取消息接口返回错误 ret: ${ret}, errcode: ${errCode}，2 秒后重试...`)
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        }

        // 成功响应，重置错误计数和超时计数
        consecutiveErrors = 0
        consecutiveTimeouts = 0

        // 保存下一次请求的游标位置
        if (resp.get_updates_buf) {
          savedBuf = resp.get_updates_buf
          try {
            fs.writeFileSync(this.syncBufPath, savedBuf, 'utf8')
          } catch {}
        }

        // 循环处理消息
        if (!this.isMonitoring) {
          break
        }
        const msgs = resp.msgs || []
        for (const message of msgs) {
          if (!this.isMonitoring) {
            break
          }
          const fromUserId = String(message.from_user_id)
          if (message.context_token) {
            contextTokens.set(fromUserId, message.context_token)
          }

          const nickname = message.from_user_nickname || `微信好友 (${fromUserId})`
          const { text } = await this.processMessageContent(message, fromUserId)
          if (!text) continue

          // 构建唯一去重 Key，防止微信服务器重试或长轮询引发的重复处理
          const textContent = message.item_list?.map((it: any) => it.text_item?.text || '').join('_') || ''
          const msgKey = message.msg_id || message.msgid || message.client_id || 
                         `${fromUserId}_${message.create_time || message.time || ''}_${textContent}`
          
          if (this.processedMsgKeys.has(msgKey)) {
            continue
          }

          this.processedMsgKeys.add(msgKey)
          if (this.processedMsgKeys.size > 200) {
            const firstKey = this.processedMsgKeys.values().next().value
            if (firstKey !== undefined) {
              this.processedMsgKeys.delete(firstKey)
            }
          }

          this.state.messagesReceived++
          const logText = text.replace(/!\[图片\]\(wechat-file:\/\/local\/.*?\)/g, '[图片]')

          // 更新活跃聊天窗口记录，再记录日志（日志会触发 UI 刷新）
          this.updateActiveChat(fromUserId, nickname)
          this.addLog('in', `[${nickname}]: ${logText}`)

          // 1. 在 SQLite 中保存用户的消息
          this.saveMessageToDB({
            sessionId: `wechat:${fromUserId}`,
            sessionName: nickname,
            messageId: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            sender: 'user',
            text: text,
            userId: fromUserId
          })

          // 2. 自动回复
          if (this.state.enableAutoReply) {
            const agentMsgId = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`

            // 写入思考占位符
            this.saveMessageToDB({
              sessionId: `wechat:${fromUserId}`,
              sessionName: nickname,
              messageId: agentMsgId,
              sender: 'agent',
              text: '',
              userId: fromUserId,
              isThinking: true
            })

            // 工具调用步骤收集器
            const toolSteps: any[] = []
            let toolStepCounter = 0
            const onToolEvent = (evt: { type: string; name: string; args?: any; result?: string }) => {
              toolStepCounter++
              toolSteps.push({
                id: `wxtool-${toolStepCounter}`,
                type: evt.type === 'tool_call' ? 'call' : 'result',
                name: evt.name,
                detail: evt.type === 'tool_call' ? (evt.args || {}) : (evt.result || '')
              })
              // 实时更新 DB 中的 tool_steps，让渲染进程可以刷新
              this.saveMessageToDB({
                sessionId: `wechat:${fromUserId}`,
                sessionName: nickname,
                messageId: agentMsgId,
                sender: 'agent',
                text: '',
                userId: fromUserId,
                isThinking: true,
                toolSteps
              })
            }

            let replyText = ''
            let isError = false
            let typingInterval: any = null
            const token = contextTokens.get(fromUserId)

            if (token) {
              try {
                this.client.getTypingTicket(fromUserId, token).then((ticket) => {
                  if (ticket && this.isMonitoring && this.client) {
                    this.client.sendTyping(fromUserId, ticket, true).catch(() => {})
                    typingInterval = setInterval(() => {
                      if (this.client && this.isMonitoring) {
                        this.client.sendTyping(fromUserId, ticket, true).catch(() => {})
                      }
                    }, 5000)
                  }
                }).catch(() => {})
              } catch (err) {
                console.error('[wechatBot] 开启打字状态失败:', err)
              }
            }

            try {
              // 1.5 分钟 (90 秒) 强制超时保护机制
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('TIMEOUT')), 90000)
              )
              replyText = await Promise.race([
                this.generateAiReply(fromUserId, text, onToolEvent),
                timeoutPromise
              ])
            } catch (err: any) {
              if (err.message === 'TIMEOUT') {
                replyText = '⚠️ 请求超时，请重新发送'
              } else {
                replyText = `⚠️ 自动回复生成失败: ${err.message || err}`
              }
              isError = true
            } finally {
              if (typingInterval) {
                clearInterval(typingInterval)
              }
              if (token) {
                try {
                  this.client.getTypingTicket(fromUserId, token).then((ticket) => {
                    if (ticket && this.client) {
                      this.client.sendTyping(fromUserId, ticket, false).catch(() => {})
                    }
                  }).catch(() => {})
                } catch {}
              }
            }
            
            if (!token) {
              this.addLog('info', `回复失败：未找到好友 [${nickname}] 的会话 context_token`)
              this.saveMessageToDB({
                sessionId: `wechat:${fromUserId}`,
                sessionName: nickname,
                messageId: agentMsgId,
                sender: 'agent',
                text: '⚠️ 发送失败：未找到微信会话 token',
                userId: fromUserId,
                isThinking: false,
                isError: true
              })
              continue
            }

            // 发送消息到微信
            try {
              if (isError) {
                this.saveMessageToDB({
                  sessionId: `wechat:${fromUserId}`,
                  sessionName: nickname,
                  messageId: agentMsgId,
                  sender: 'agent',
                  text: replyText,
                  userId: fromUserId,
                  isThinking: false,
                  isError: true
                })
                // 超时或错误时，强制将提示信息也回发给微信好友
                await this.client.sendMessageItems(fromUserId, token, [
                  { type: 1, text_item: { text: replyText } }
                ])
              } else {
                const mediaItems: any[] = []
                const mediaRegex = /(!?)\[(.*?)\]\((.*?)\)/g
                let match: RegExpExecArray | null

                // 1. 扫描并上传所有的媒体附件
                mediaRegex.lastIndex = 0
                while ((match = mediaRegex.exec(replyText)) !== null) {
                  const isImage = match[1] === '!'
                  const label = match[2]
                  const url = match[3]

                  try {
                    let buffer: Buffer | null = null
                    let localPath = url
                    if (localPath.startsWith('local-file:///')) {
                      localPath = localPath.replace('local-file:///', '')
                      if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1)
                      localPath = decodeURIComponent(localPath)
                    } else if (localPath.startsWith('local-file://')) {
                      localPath = localPath.replace('local-file://', '')
                      if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1)
                      localPath = decodeURIComponent(localPath)
                    } else if (localPath.startsWith('wechat-file://')) {
                      const resolved = this.resolveWechatFilePath(localPath)
                      if (resolved) {
                        localPath = resolved.filePath
                      } else {
                        localPath = ''
                      }
                    }

                    const isLocalFile = url.startsWith('local-file://') ||
                                       url.startsWith('wechat-file://') ||
                                       (localPath && fs.existsSync(localPath))

                    if (isLocalFile) {
                      if (localPath && fs.existsSync(localPath)) {
                        buffer = fs.readFileSync(localPath)
                      }
                    } else if (url.startsWith('data:')) {
                      const b64 = url.split(',')[1]
                      if (b64) buffer = Buffer.from(b64, 'base64')
                    } else if (url.startsWith('http')) {
                      const resp = await fetch(url)
                      if (resp.ok) buffer = Buffer.from(await resp.arrayBuffer())
                    }

                    if (buffer) {
                      const mediaType = isImage ? 1 : 3 // 1=IMAGE, 3=FILE
                      this.addLog('info', `正在上传${isImage ? '图片' : '文件'}到微信 CDN: ${label || '未命名'}`)
                      const uploadRes = await this.client!.uploadMedia(buffer, mediaType, fromUserId)

                      // 文档要求：hex string → UTF-8 bytes → base64
                      const aesKeyBase64 = Buffer.from(uploadRes.aeskey, 'utf8').toString('base64')

                      if (isImage) {
                        mediaItems.push({
                          type: 2,
                          image_item: {
                            media: {
                              encrypt_query_param: uploadRes.encrypt_param,
                              aes_key: aesKeyBase64,
                              encrypt_type: 1
                            }
                          }
                        })
                      } else {
                        mediaItems.push({
                          type: 4,
                          file_item: {
                            media: {
                              encrypt_query_param: uploadRes.encrypt_param,
                              aes_key: aesKeyBase64,
                              encrypt_type: 1
                            },
                            file_name: label || 'file.dat',
                            len: String(uploadRes.rawsize)
                          }
                        })
                      }
                      this.addLog('info', `${isImage ? '图片' : '文件'}已上传成功并加入发送队列`)
                    }
                  } catch (err: any) {
                    this.addLog('info', `上传发送媒体失败: ${err.message}`)
                  }
                }

                // 2. 清洗回复文本：去除 Markdown 超链接格式，只保留显示名称，保证发送的文字清爽好读
                let cleanText = replyText
                  .replace(/!\[(.*?)\]\(.*?\)/g, '[图片]')
                  .replace(/\[(.*?)\]\(.*?\)/g, '$1')

                // 3. 构建发送队列并依次发送
                const sendQueue: any[] = []
                if (cleanText.trim()) {
                  sendQueue.push({ type: 1, text_item: { text: cleanText } })
                }
                sendQueue.push(...mediaItems)

                if (sendQueue.length === 0) {
                  sendQueue.push({ type: 1, text_item: { text: replyText || ' ' } })
                }

                // 逐条依次发送，避免在一包消息里混合文本与文件/图片导致微信官方接口报 ret: -2 错误
                for (const item of sendQueue) {
                  await this.client.sendMessageItems(fromUserId, token, [item])
                  // 稍微延时 800ms 防止发送过快触发官方限制
                  await new Promise(resolve => setTimeout(resolve, 800))
                }

                this.state.messagesSent++
                this.addLog('out', `[回复 ${nickname}]: ${replyText}`)

                // 3. 在 SQLite 中保存机器人的回复（将思考占位符更新为真实回复）
                this.saveMessageToDB({
                  sessionId: `wechat:${fromUserId}`,
                  sessionName: nickname,
                  messageId: agentMsgId,
                  sender: 'agent',
                  text: replyText,
                  userId: fromUserId,
                  isThinking: false,
                  toolSteps: toolSteps.length > 0 ? toolSteps : undefined
                })
              }
            } catch (pushErr: any) {
              this.addLog('info', `向微信好友 [${nickname}] 发送回复失败: ${pushErr.message || pushErr}`)
              this.saveMessageToDB({
                sessionId: `wechat:${fromUserId}`,
                sessionName: nickname,
                messageId: agentMsgId,
                sender: 'agent',
                text: `⚠️ 发送失败: ${pushErr.message || pushErr}`,
                userId: fromUserId,
                isThinking: false,
                isError: true
              })
            }
          }
        }
        
      } catch (err: any) {
        if (!this.isMonitoring) break
        
        if (err.name === 'AbortError') {
          consecutiveTimeouts++
          if (consecutiveTimeouts % 3 === 0) {
            this.addLog('info', `消息轮询已连续超时 ${consecutiveTimeouts} 次，服务器可能未正常响应...`)
          }
          continue
        }

        // 非超时错误，重置超时计数
        consecutiveTimeouts = 0
        
        this.addLog('info', `消息长轮询监听异常: ${err.message || err}，正在等待 5 秒后重试...`)
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
  }

  // 终止消息监听循环
  private stopMessageLoop() {
    this.isMonitoring = false
  }

  // 大模型自动回复生成
  private async generateAiReply(
    fromUserId: string,
    userText: string,
    onToolEvent?: (evt: { type: string; name: string; args?: any; result?: string }) => void
  ): Promise<string> {
    const llm = this.state.llmConfig
    
    // 多轮对话上下文构造 (限制最多 15 轮历史)
    if (!this.chatContexts.has(fromUserId)) {
      this.chatContexts.set(fromUserId, [])
    }
    const history = this.chatContexts.get(fromUserId)!

    history.push({ role: 'user', content: userText })

    try {
      const mcpToolNames = await this.options.getMcpToolNames()
      const mcpContext = mcpToolNames.length > 0
        ? `\n你可以使用以下外部工具来帮助回答问题：${mcpToolNames.join('、')}。当用户的问题需要实时信息（如搜索、天气、地图等）时，请主动调用这些工具获取最新数据。`
        : ''
      const skillsContext = '你无法直接操作本地电脑的文件系统或运行命令，但可以通过外部工具获取实时信息。'
      const filePrompt = `\n【核心要求】当且仅当你调用工具成功修改或生成了本地文件后，你必须在回复中提供该文件的 Markdown 超链接链接，以便微信助手把该物理文件发送给好友：
- 格式：[展示的文件名](文件的真实绝对物理路径)
- 示例：我已经帮您把文件修改好了：[会议记录_修改版.docx](D:/Electron/AgentPet/chat/wechat_xxx/generated_files/会议记录_修改版.docx)
注意：绝对物理路径必须完全使用工具返回的实际路径（如 file_path），不得自行伪造或忽略 Markdown 括号！`
      const systemPrompt = `你是一只名为 Mao 的微信个人助理。
你需要使用非常温柔、自然、友好的语气与主人的好友对话。
你绝对不能泄露你是大语言模型（如 Gemini、OpenAI、DeepSeek 等）的真实身份，要坚持自己是主人专属助理 Mao 的分身。
${skillsContext}${mcpContext}${filePrompt}
回答要尽量简短，适合微信聊天的快节奏。`

      const messagesForLlm = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-30).map(h => {
          if (h.role === 'user') {
            return {
              role: h.role,
              content: this.convertWechatFileToBase64(h.content)
            }
          }
          return h
        })
      ]

      const response = await this.options.callLlm(llm, messagesForLlm, `wechat:${fromUserId}`, onToolEvent)
      
      if (response && response !== '智能代理执行工具链已达到最大轮数上限。') {
        history.push({ role: 'assistant', content: response })
        if (history.length > 30) {
          history.shift()
          history.shift()
        }
        return response
      }
    } catch (e: any) {
      this.addLog('info', `调用 AI 接口异常: ${e.message || e}`)
    }

    // 默认兜底自动回复
    return this.state.autoReplyText || '你好~ 我现在有些忙，稍后会回复您！'
  }

  // 将会话与消息物理持久化到 SQLite 数据库中
  private saveMessageToDB(params: {
    sessionId: string
    sessionName: string
    messageId: string
    sender: 'user' | 'agent'
    text: string
    userId: string
    isThinking?: boolean
    isError?: boolean
    toolSteps?: any[]
  }) {
    try {
      const database = this.options.getDB()
      if (!database) return

      const timeStr = new Date().toLocaleString('zh-CN', { hour12: false })

      // 1. 确保 Session 存在
      database.prepare('INSERT OR IGNORE INTO sessions (id, name, time, user_id) VALUES (?, ?, ?, ?)')
        .run(params.sessionId, params.sessionName, timeStr, params.userId)

      const isThinkingVal = params.isThinking ? 1 : 0
      const isErrorVal = params.isError ? 1 : 0
      const toolStepsJson = params.toolSteps ? JSON.stringify(params.toolSteps) : null

      // 2. 插入或更新消息
      database.prepare(`
        INSERT OR REPLACE INTO messages 
        (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, is_error, user_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        params.messageId,
        params.sessionId,
        params.sender,
        params.text,
        timeStr,
        isThinkingVal,
        toolStepsJson,
        isErrorVal,
        params.userId
      )

      // 3. 通知渲染进程会话已更新，让聊天页可以刷新
      this.options.notifyRenderSessionUpdate(params.sessionId)
    } catch (dbErr) {
      this.addLog('info', `保存微信聊天记录到 SQLite 失败: ${dbErr}`)
    }
  }

  // ── 微信媒体解密与下载服务 ────────────────────────────────────────────

  // 下载并解密微信媒体文件
  private async downloadAndDecryptMedia(cdnUrl: string, aesKeyStr: string, ext = 'png', fromUserId: string): Promise<string> {
    try {
      const wechatFilesDir = this.getWechatFilesDir(fromUserId)

      // 1. 下载加密的 CDN 文件
      const resp = await fetch(cdnUrl)
      if (!resp.ok) {
        throw new Error(`下载媒体文件失败: HTTP ${resp.status}`)
      }
      const encryptedBuffer = Buffer.from(await resp.arrayBuffer())

      // 2. 解析 AES Key
      const keyBuffer = this.parseAesKey(aesKeyStr)

      // 3. AES-128-ECB 解密
      const decryptedBuffer = this.decryptAesEcb(encryptedBuffer, keyBuffer)

      // 4. 保存为本地文件
      const fileName = `${Date.now()}_${randomBytes(4).toString('hex')}.${ext}`
      const filePath = join(wechatFilesDir, fileName)
      fs.writeFileSync(filePath, decryptedBuffer)

      // 5. 返回携带会话隔离信息的 wechat-file URL
      const safeSessionId = this.safeSessionId(fromUserId)
      this.addLog('info', `微信媒体文件已下载解密并保存成功: ${fileName}`)
      return `wechat-file://local/${safeSessionId}/${fileName}`
    } catch (e: any) {
      this.addLog('info', `处理微信多媒体文件下载解密失败: ${e.message || e}`)
      return ''
    }
  }

  // 辅助函数：解析密钥
  private parseAesKey(key: string): Buffer {
    if (key.length === 32 && /^[0-9a-fA-F]{32}$/.test(key)) {
      return Buffer.from(key, 'hex')
    }
    const decoded = Buffer.from(key, 'base64')
    if (decoded.length === 16) {
      return decoded
    }
    if (decoded.length === 32) {
      return Buffer.from(decoded.toString('ascii'), 'hex')
    }
    return decoded
  }

  // 辅助函数：AES-128-ECB 解密
  private decryptAesEcb(encryptedBuffer: Buffer, keyBuffer: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuffer, null)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()])
  }

  // 处理微信消息的完整内容（包括多模态文件下载与解密）
  private async processMessageContent(message: any, fromUserId: string): Promise<{ text: string; mediaUrls: string[] }> {
    let textParts: string[] = []
    const mediaUrls: string[] = []

    if (!message || !message.item_list) {
      return { text: '', mediaUrls: [] }
    }

    for (const item of message.item_list) {
      if (item.type === 1 && item.text_item?.text) {
        // 文本项
        let txt = item.text_item.text
        const ref = item.ref_msg
        if (ref?.message_item) {
          const isMedia = [2, 3, 4, 5].includes(ref.message_item.type)
          if (!isMedia) {
            const refBody = ref.message_item.text_item?.text || ''
            const title = ref.title || ''
            if (title !== '' || refBody !== '') {
              txt = `[引用: ${title} | ${refBody}]\n${txt}`
            }
          }
        }
        textParts.push(txt)
      } else if (item.type === 2) {
        // 图片项 (ITEM_TYPE_IMAGE)
        const imageItem = item.image_item
        if (imageItem) {
          const aesKey = imageItem.aeskey || imageItem.media?.aes_key || ''
          const cdnUrl = imageItem.url || imageItem.cdn_url || imageItem.media?.full_url || ''
          if (cdnUrl && aesKey) {
            this.addLog('info', '检测到微信图片消息，开始下载解密...')
            const localUrl = await this.downloadAndDecryptMedia(cdnUrl, aesKey, 'png', fromUserId)
            if (localUrl) {
              mediaUrls.push(localUrl)
              textParts.push(`![图片](${localUrl})`)
            } else {
              textParts.push('[图片加载失败]')
            }
          } else {
            textParts.push('[图片数据不完整]')
          }
        }
      } else if (item.type === 3 && item.voice_item?.text) {
        // 语音项 (如果有识别出来的文本)
        textParts.push(item.voice_item.text)
      } else if (item.type === 4) {
        // 文件项 (ITEM_TYPE_FILE)
        const fileItem = item.file_item
        if (fileItem) {
          console.log('[processMessage] file_item 完整结构:', JSON.stringify(fileItem, null, 2))
          const aesKey = fileItem.aeskey || fileItem.media?.aes_key || ''
          const cdnUrl = fileItem.url || fileItem.cdn_url || fileItem.media?.full_url || ''
          const fileName = fileItem.name || fileItem.file_name || fileItem.filename || fileItem.title || 'file.dat'
          const ext = fileName.split('.').pop() || 'dat'
          if (cdnUrl && aesKey) {
            this.addLog('info', `检测到微信文件消息 [${fileName}]，开始下载解密...`)
            const localUrl = await this.downloadAndDecryptMedia(cdnUrl, aesKey, ext, fromUserId)
            if (localUrl) {
              mediaUrls.push(localUrl)
              textParts.push(`[文件: ${fileName}](${localUrl})`)
            } else {
              textParts.push(`[文件下载失败: ${fileName}]`)
            }
          } else {
            textParts.push(`[文件数据不完整: ${fileName}]`)
          }
        }
      }
    }

    return {
      text: textParts.join('\n'),
      mediaUrls
    }
  }

  // 将 wechat-file:// 协议链接转换为大模型需要的 Base64 URL (若有)
  private convertWechatFileToBase64(text: string): string | any[] {
    const imgRegex = /!\[.*?\]\((wechat-file:\/\/local\/.*?)\)/g
    const parts: any[] = []
    let lastIndex = 0

    // 检测是否包含图片
    const hasImage = imgRegex.test(text)
    if (!hasImage) {
      return text // 纯文本
    }

    // 重置正则的 lastIndex
    imgRegex.lastIndex = 0

    let match
    while ((match = imgRegex.exec(text)) !== null) {
      const textBefore = text.substring(lastIndex, match.index)
      if (textBefore.trim()) {
        parts.push({ type: 'text', text: textBefore })
      }

      const fileUrl = match[1]
      const resolved = this.resolveWechatFilePath(fileUrl)

      try {
        if (resolved && fs.existsSync(resolved.filePath)) {
          const imageBuffer = fs.readFileSync(resolved.filePath)
          const base64 = imageBuffer.toString('base64')
          const ext = resolved.fileName.split('.').pop() || 'png'
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64}`
            }
          })
        }
      } catch (err) {
        console.error('转换图片为 base64 失败', err)
      }

      lastIndex = imgRegex.lastIndex
    }

    const textAfter = text.substring(lastIndex)
    if (textAfter.trim()) {
      parts.push({ type: 'text', text: textAfter })
    }

    return parts
  }
}

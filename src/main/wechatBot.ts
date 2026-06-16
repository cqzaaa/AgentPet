import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { randomBytes } from 'node:crypto'

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
}

interface WechatBotManagerOptions {
  getDB: () => any
  callLlm: (config: any, messages: any[]) => Promise<string>
  onStatusUpdated: () => void
  notifyRenderSessionUpdate: () => void
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

  // POST 请求通用方法
  private async doPost(path: string, payload: any, timeoutMs = 15000): Promise<any> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
    const bodyStr = JSON.stringify(payload)
    const headers = this.buildHeaders(Buffer.byteLength(bodyStr))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyStr,
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
    enableAutoReply: true
  }

  // 微信好友上下文缓存 (from_user_id -> Array of messages)
  private chatContexts: Map<string, any[]> = new Map()
  
  // 是否正在进行长轮询
  private isMonitoring = false

  constructor(options: WechatBotManagerOptions) {
    this.options = options
    const userData = app.getPath('userData')
    this.configPath = join(userData, 'wechat_config.json')
    this.tokenPath = join(userData, 'wechat_token.json')
    this.syncBufPath = join(userData, 'wechat_sync_buf.dat')

    this.loadConfig()
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
    if (this.state.status === 'connected' || this.state.status === 'scanned' || this.state.status === 'qrcode_ready') {
      this.addLog('info', '当前正在连接或已连接，请先断开连接。')
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

      while (Date.now() <= deadline && this.state.status !== 'disconnected') {
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
          }

          this.state.status = 'connected'
          this.state.botId = botId
          this.state.qrcodeUrl = ''
          this.addLog('info', `微信登录成功！Bot ID: ${this.state.botId}`)
          this.options.onStatusUpdated()

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

    while (this.isMonitoring && this.client) {
      try {
        const resp = await this.client.getUpdates(savedBuf, 35000)
        
        // 处理服务器状态码
        const ret = Number(resp.ret || 0)
        const errCode = Number(resp.errcode || 0)
        
        if (ret !== 0 || errCode !== 0) {
          if (ret === -14 || errCode === -14) {
            this.addLog('info', '检测到微信登录会话已过期 (errcode: -14)，需重新进行扫码登录！')
            this.logout()
            break
          }
          this.addLog('info', `获取消息接口返回错误 ret: ${ret}, errcode: ${errCode}，2 秒后重试...`)
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        }

        // 保存下一次请求的游标位置
        if (resp.get_updates_buf) {
          savedBuf = resp.get_updates_buf
          try {
            fs.writeFileSync(this.syncBufPath, savedBuf, 'utf8')
          } catch {}
        }

        // 循环处理消息
        const msgs = resp.msgs || []
        for (const message of msgs) {
          const fromUserId = String(message.from_user_id)
          if (message.context_token) {
            contextTokens.set(fromUserId, message.context_token)
          }

          const text = extractText(message)
          if (!text) continue

          const nickname = message.from_user_nickname || `微信好友 (${fromUserId})`
          this.state.messagesReceived++
          this.addLog('in', `[${nickname}]: ${text}`)

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

            let replyText = ''
            let isError = false
            try {
              replyText = await this.generateAiReply(fromUserId, text)
            } catch (err: any) {
              replyText = `⚠️ 自动回复生成失败: ${err.message || err}`
              isError = true
            }

            const token = contextTokens.get(fromUserId)
            
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
              } else {
                await this.client.sendText(fromUserId, replyText, token)
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
                  isThinking: false
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
          continue
        }
        
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
  private async generateAiReply(fromUserId: string, userText: string): Promise<string> {
    const llm = this.state.llmConfig
    
    // 多轮对话上下文构造 (限制最多 15 轮历史)
    if (!this.chatContexts.has(fromUserId)) {
      this.chatContexts.set(fromUserId, [])
    }
    const history = this.chatContexts.get(fromUserId)!

    history.push({ role: 'user', content: userText })

    try {
      const skillsContext = '微信助手端已被限制直接调用本地系统文件修改或运行命令工具，你只需以可爱的态度回答问题。'
      const systemPrompt = `你是一只名为 Mao 的微信个人助理猫咪。
你需要使用非常温柔、可爱、忠诚的语气与主人的好友对话，回答中要适当带有『喵~』、『喵呜~』等猫咪口癖。
你绝对不能泄露你是大语言模型（如 Gemini、OpenAI、DeepSeek 等）的真实身份，要坚持自己是主人专属宠物猫咪 Mao 的分身。
${skillsContext}
回答要尽量简短，适合微信聊天的快节奏。`

      const messagesForLlm = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-30) // 最多取近 15 轮对话
      ]

      const response = await this.options.callLlm(llm, messagesForLlm)
      
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
    return this.state.autoReplyText || '你好喵~ 我现在有些忙，稍后会回复您喵！'
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

      // 2. 插入或更新消息
      database.prepare(`
        INSERT OR REPLACE INTO messages 
        (id, session_id, sender, text, time, is_thinking, tool_steps, file_info, is_error, user_id) 
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        params.messageId,
        params.sessionId,
        params.sender,
        params.text,
        timeStr,
        isThinkingVal,
        isErrorVal,
        params.userId
      )

      // 3. 通知渲染进程会话已更新，让聊天页可以刷新
      this.options.notifyRenderSessionUpdate()
    } catch (dbErr) {
      this.addLog('info', `保存微信聊天记录到 SQLite 失败: ${dbErr}`)
    }
  }
}

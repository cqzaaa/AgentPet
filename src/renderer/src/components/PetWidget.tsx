import React, { useEffect, useState, useRef } from 'react'
import * as PIXI from 'pixi.js'
import { MessageSquare } from 'lucide-react'

type Live2DModelClass = typeof import('pixi-live2d-display/cubism4')['Live2DModel']
type Live2DModelInstance = InstanceType<Live2DModelClass>

// Keep Pixi/Live2D initialization inside the pet-only renderer chunk.
;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI

// 尺寸自适应配置
const SIZE_CONFIG = {
  targetHeight: 320,   // 期望挂件的高度 (px)
  defaultWidth: 250    // 默认兜底宽度 (px)
}

// 过滤 Markdown 等标记以便 TTS 自然朗读的净化函数
function cleanTextForTts(text: string): string {
  if (!text) return ''
  return text
    // 移除 markdown 标题 (e.g. ### 标题 -> 标题)
    .replace(/^(#+)\s+/gm, '')
    // 移除加粗与斜体标记 (e.g. **加粗** -> 加粗)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // 移除列表标记 (e.g. - 列表 -> 列表, 1. 列表 -> 列表)
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // 移除链接 (e.g. [链接](url) -> 链接)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 移除行内代码 (e.g. `code` -> code)
    .replace(/`([^`]+)`/g, '$1')
    // 移除代码块
    .replace(/```[\s\S]*?```/g, '')
    // 移除 HTML 标签
    .replace(/<[^>]*>/g, '')
    .trim()
}

// Cubism Core 加载状态检测
function isCubismReady(): boolean {
  return typeof (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore !== 'undefined'
}

let cubismCoreLoadPromise: Promise<void> | null = null

function ensureCubismCore(): Promise<void> {
  if (isCubismReady()) return Promise.resolve()
  if (cubismCoreLoadPromise) return cubismCoreLoadPromise

  const loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-agentpet-cubism-core]')
    const script = existing || document.createElement('script')

    const handleLoad = (): void => {
      if (isCubismReady()) resolve()
      else reject(new Error('Cubism Core 加载完成但未能初始化'))
    }
    const handleError = (): void => reject(new Error('Cubism Core 加载失败'))

    script.addEventListener('load', handleLoad, { once: true })
    script.addEventListener('error', handleError, { once: true })

    if (!existing) {
      script.src = 'live2d://live2d/core/live2dcubismcore.min.js'
      script.dataset.agentpetCubismCore = 'true'
      document.head.appendChild(script)
    }
  }).catch(error => {
    cubismCoreLoadPromise = null
    throw error
  })

  cubismCoreLoadPromise = loadPromise
  return loadPromise
}

function findWeightedPercentile(counts: Uint32Array, percentile: number): number {
  let total = 0
  for (const count of counts) total += count
  if (total === 0) return 0
  const target = total * percentile
  let accumulated = 0
  for (let index = 0; index < counts.length; index++) {
    accumulated += counts[index]
    if (accumulated >= target) return index
  }
  return counts.length - 1
}

function captureModelVisibleRight(
  app: PIXI.Application,
  logicalWidth: number,
  logicalHeight: number
): number | null {
  try {
    // Keep the later quick-chat positioning fix: this snapshot is used only to
    // anchor the button near the model's visible right edge.
    const canvas = app.renderer.plugins.extract.canvas(
      app.stage,
      new PIXI.Rectangle(0, 0, logicalWidth, logicalHeight)
    )
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context || canvas.width === 0 || canvas.height === 0) return null
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const columnCounts = new Uint32Array(canvas.width)
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const alpha = image.data[(y * canvas.width + x) * 4 + 3]
        if (alpha < 24) continue
        columnCounts[x]++
      }
    }
    const scaleX = canvas.width / logicalWidth
    // Percentiles ignore isolated particles or decorative pixels that would
    // otherwise push the chat button to the window edge.
    return findWeightedPercentile(columnCounts, 0.97) / scaleX
  } catch (error) {
    console.warn('[Live2D] Failed to locate the visible model edge:', error)
    return null
  }
}

export function PetWidget(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [modelReady, setModelReady] = useState(false)
  const [widgetHeight, setWidgetHeight] = useState(SIZE_CONFIG.targetHeight)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [isModelHovered, setIsModelHovered] = useState(false)
  const [chatButtonPosition, setChatButtonPosition] = useState<{ bottom: number; left: number } | null>(null)


  const isDraggingRef = useRef(false)
  const lastXRef = useRef(0)
  const lastYRef = useRef(0)
  const modelRef = useRef<Live2DModelInstance | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)

  // ── 快捷聊天与大模型/TTS 相关状态 ──────────────────────────
  const [isLlmThinking, setIsLlmThinking] = useState(false)
  const [avatarList, setAvatarList] = useState<any[]>([])
  const [customModelDir, setCustomModelDir] = useState('')
  const [customModelFile, setCustomModelFile] = useState('')

  const activeAvatar = avatarList.find(a => (customModelDir ? a.dir === customModelDir : a.isDefault))
  const currentAvatarName = activeAvatar ? activeAvatar.name : (customModelFile ? customModelFile.replace(/\.model3\.json$/i, '') : 'Mao')
  const currentAvatarStyle = activeAvatar?.languageStyle || 'normal'
  const currentAvatarVoice = activeAvatar?.voice || 'zh-CN-XiaoxiaoNeural'

  const isLlmThinkingRef = useRef(false)
  isLlmThinkingRef.current = isLlmThinking

  // 记录挂件窗口的自适应宽高 Ref，用于动态气泡拉伸高度使用
  const computedWidthRef = useRef(SIZE_CONFIG.defaultWidth)
  const targetHeightRef = useRef(SIZE_CONFIG.targetHeight)

  const formatDateTime = (): string => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }

  // 气泡文本格式化渲染器 (将大段原始的 Markdown 天气预报渲染成高级精致、紧凑自适应的排版)
  const renderBubbleContent = (text: string | null) => {
    if (!text) return null
    const lines = text.split('\n')
    return lines.map((line, idx) => {
      let cleanLine = line
      const boldRegexStrict = /\*\*(.*?)\*\*/g
      const parts: React.ReactNode[] = []
      let lastIndex = 0
      let match

      while ((match = boldRegexStrict.exec(cleanLine)) !== null) {
        if (match.index > lastIndex) {
          parts.push(cleanLine.substring(lastIndex, match.index))
        }
        parts.push(<strong key={match.index} style={{ color: '#ffb638', fontWeight: 'bold' }}>{match[1]}</strong>)
        lastIndex = boldRegexStrict.lastIndex
      }

      if (lastIndex < cleanLine.length) {
        parts.push(cleanLine.substring(lastIndex))
      }

      return (
        <div key={idx} style={{ margin: '4px 0', minHeight: '1.2em', wordBreak: 'break-word', fontSize: '11px', letterSpacing: '0.2px' }}>
          {parts.length > 0 ? parts : line}
        </div>
      )
    })
  }

  // 加载 avatar 配置
  const refreshAvatarsInfo = async () => {
    try {
      const info = await window.api.getCustomModel()
      if (info) {
        setCustomModelDir(info.customModelDir || '')
        setCustomModelFile(info.customModelFile || '')
      }
      const list = await window.api.getAvatarsList()
      setAvatarList(list)
    } catch (e) {
      console.error('[PetWidget] 加载模型配置失败:', e)
    }
  }

  useEffect(() => {
    refreshAvatarsInfo()
  }, [reloadKey])

  // Listen for model-updated IPC event
  useEffect(() => {
    const handleModelUpdated = (): void => { setReloadKey(prev => prev + 1) }
    window.electron.ipcRenderer.on('model-updated', handleModelUpdated)
    return () => { window.electron.ipcRenderer.removeListener('model-updated', handleModelUpdated) }
  }, [])

  const [bubbleText, setBubbleText] = useState<string | null>(null)
  const [bubbleDetails, setBubbleDetails] = useState<string | null>(null)
  const [bubbleTaskId, setBubbleTaskId] = useState<string | null>(null)
  const [bubbleLogId, setBubbleLogId] = useState<string | null>(null)
  const bubbleTimerRef = useRef<any>(null)

  useEffect(() => {
    if (!window.api.onShowBubble) return
    const unsubscribe = window.api.onShowBubble((text: string, details?: string, taskId?: string, logId?: string) => {
      setBubbleText(text)
      setBubbleDetails(details || null)
      setBubbleTaskId(taskId || null)
      setBubbleLogId(logId || null)
      if (modelRef.current) {
        modelRef.current.motion('TapBody').catch((err) => console.log('Live2D motion failed', err))
      }
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
      const duration = details ? 10000 : 5000
      bubbleTimerRef.current = setTimeout(() => {
        setBubbleText(null)
        setBubbleDetails(null)
        setBubbleTaskId(null)
        setBubbleLogId(null)
      }, duration)
    })
    return () => {
      unsubscribe()
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
    }
  }, [])

  // 动态根据气泡是否显示调整 Electron 窗口尺寸，给气泡腾空间以防遮挡 Live2D 模型
  useEffect(() => {
    if (!modelReady) return
    const currentW = computedWidthRef.current
    const targetH = targetHeightRef.current
    if (bubbleText) {
      // 弹出气泡时，调高 140px 以免挡住 Live2D
      window.api.setWindowSize(currentW, targetH + 140)
    } else {
      // 气泡消失，还原原高
      window.api.setWindowSize(currentW, targetH)
    }
  }, [bubbleText, modelReady])

  // TTS 音频播放 + Lip-Sync
  useEffect(() => {
    if (!window.api.onPlayTtsAudio) return
    const unsubscribe = window.api.onPlayTtsAudio((audioBuffer: ArrayBuffer) => {
      try {
        const blob = new Blob([audioBuffer], { type: 'audio/mp3' })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)

        const audioCtx = new AudioContext()
        const source = audioCtx.createMediaElementSource(audio)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        analyser.connect(audioCtx.destination)

        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        let lipSyncRaf = 0

        const updateLipSync = (): void => {
          analyser.getByteFrequencyData(dataArray)
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255
          if (modelRef.current) {
            try {
              const coreModel = (modelRef.current as any).internalModel?.coreModel
              if (coreModel && coreModel.setParameterValueById) {
                coreModel.setParameterValueById('ParamMouthOpenY', avg * 1.5)
              }
            } catch { /* ignore */ }
          }
          lipSyncRaf = requestAnimationFrame(updateLipSync)
        }

        audio.onplay = () => { updateLipSync() }
        audio.onended = () => {
          cancelAnimationFrame(lipSyncRaf)
          // 闭嘴
          if (modelRef.current) {
            try {
              const coreModel = (modelRef.current as any).internalModel?.coreModel
              if (coreModel && coreModel.setParameterValueById) {
                coreModel.setParameterValueById('ParamMouthOpenY', 0)
              }
            } catch { /* ignore */ }
          }
          audioCtx.close().catch(() => { })
          URL.revokeObjectURL(url)
        }

        audio.play().catch(err => console.error('TTS 音频播放失败', err))
      } catch (err) {
        console.error('TTS 播放初始化失败', err)
      }
    })
    return () => { unsubscribe() }
  }, [])

  // ── 快捷聊天核心响应大模型逻辑 ─────────────────────────────
  const handleChatToPet = async (text: string, isNewSession?: boolean, imagePath?: string) => {
    if (isLlmThinkingRef.current) return
    setIsLlmThinking(true)
    localStorage.setItem('agentpet_llm_thinking_at', String(Date.now()))

    if (modelRef.current) {
      modelRef.current.motion('TapBody').catch(() => { })
    }

    await new Promise(resolve => setTimeout(resolve, 1200))

    let activeSessionId = localStorage.getItem('agentself_active_session_id') || localStorage.getItem('agentpet_active_session_id') || 'agent:main:dashboard:default'
    let replyId = Date.now() + 1

    try {
      const savedLlmConfig = localStorage.getItem('agentpet_llm_config') || localStorage.getItem('agentself_llm_config')
      let llmConfig = { provider: 'gemini', apiKey: '', hasApiKey: false, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', temperature: 0.7 }
      if (savedLlmConfig) {
        try { llmConfig = JSON.parse(savedLlmConfig) } catch (e) { }
      }

      const isOllama = llmConfig.provider === 'ollama'
      const hasKey = isOllama || !!llmConfig.apiKey || !!llmConfig.hasApiKey

      if (!hasKey) {
        const reply = '主人，您还没有配置大模型 API Key 呢，我已经为您打开配置页面，请先配置一下密钥哦~'
        await new Promise(resolve => setTimeout(resolve, 1000))
        setIsLlmThinking(false)

        // 将兜底答复同步传回给快捷输入框显示
        if (window.api.sendPetReplyToInput) {
          window.api.sendPetReplyToInput(reply)
        }

        // 自动打开大窗口
        if (window.api.openAgentWindow) {
          window.api.openAgentWindow()
        }

        // 默认开启 TTS 朗读发声（除非用户明确关闭）
        const ttsEnabled = localStorage.getItem('agentpet_tts_enabled') !== 'false'
        if (ttsEnabled && currentAvatarVoice) {
          const cleanReply = cleanTextForTts(reply)
          const audioBuffer = await window.api.synthesizeTts(cleanReply, currentAvatarVoice)
          if (audioBuffer) window.api.playTtsAudio(audioBuffer)
        }
        return
      }

      if (isNewSession) {
        activeSessionId = 'agent:session:' + Date.now()
        localStorage.setItem('agentself_active_session_id', activeSessionId)
        localStorage.setItem('agentpet_active_session_id', activeSessionId)
        // 广播通知主界面等更新当前的会话选中状态
        if (window.electron && window.electron.ipcRenderer) {
          window.electron.ipcRenderer.send('api:wechat-session-updated', activeSessionId)
        }
      }

      const savedSessions = localStorage.getItem('agentself_sessions') || localStorage.getItem('agentpet_sessions')
      let sessions: any[] = []
      if (savedSessions) {
        try { sessions = JSON.parse(savedSessions) } catch (e) { }
      }

      let activeSession = sessions.find(s => s.id === activeSessionId)
      let isNew = false
      if (!activeSession) {
        activeSession = {
          id: activeSessionId,
          name: '(未命名)',
          time: formatDateTime(),
          messages: []
        }
        sessions.push(activeSession)
        isNew = true
      }

      const contextRoundsStr = localStorage.getItem('agentself_context_rounds') || localStorage.getItem('agentpet_context_rounds') || '10'
      const contextRounds = Number(contextRoundsStr)
      const currentMessages = activeSession.messages || []
      const filtered = currentMessages.filter((m: any) => (m.sender === 'user' || m.sender === 'agent') && !m.isThinking && !m.isError)

      const parseMessageToBlocks = (msgText: string) => {
        const imageRegex = /!\[([^\]]*)\]\((local-file:\/\/[^)]+)\)/g
        imageRegex.lastIndex = 0
        const match = imageRegex.exec(msgText)
        if (match) {
          const textPart = msgText.replace(imageRegex, '').trim()
          const imageUrl = match[2]
          return [
            { type: 'text', text: textPart || '分析这张图片' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
        return msgText
      }

      const chatMessages = filtered.slice(-contextRounds * 2).map((m: any) => {
        return {
          role: m.sender === 'user' ? 'user' : 'assistant',
          content: parseMessageToBlocks(m.text || '')
        }
      })

      if (imagePath) {
        chatMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: text || '分析这张图片' },
            { type: 'image_url', image_url: { url: `local-file://${imagePath}` } }
          ]
        })
      } else {
        chatMessages.push({ role: 'user', content: text })
      }

      let profileContent = ''
      try {
        profileContent = await window.api.getMemoryProfile()
      } catch (err) { }

      let relevantExperiences: any[] = []
      try {
        const recallRes: any = await window.api.recallExperiences(text)
        if (recallRes) {
          relevantExperiences = Array.isArray(recallRes) ? recallRes : (recallRes.results || [])
        }
      } catch (err) { }

      const memoryContext = `\n\n🧠 【长期人物画像与背景设定】\n${profileContent || '暂无详细人物画像。'}` +
        (relevantExperiences.length > 0
          ? `\n\n💡 【相关历史经验与避坑指南】\n${relevantExperiences.map((e, i) => `${i + 1}. ${e.fact}${e.absolutePath ? `\n   [对应原始归档文件路径，若需了解详情你可以使用 read_file 访问该路径]: ${e.absolutePath}` : ''}`).join('\n')}`
          : '')

      const stylePrompt = currentAvatarStyle === 'cute'
        ? '你需要使用可爱、萌系、活泼的语气与主人（用户）对话。'
        : '你需要使用专业、友好、自然的语气与主人（用户）对话。'

      const systemPrompt = `你是一只名为 ${currentAvatarName} 的桌面智能助理宠物（智能体）。
${stylePrompt}
当主人问起你是谁或者是什么大模型时，你必须坚持自己是专属桌面助手 ${currentAvatarName}，绝对不要泄露你是大语言模型（如 Gemini、OpenAI、DeepSeek 等）的真实身份，以免让人设割裂。
${memoryContext}
⚠️ 极重要约束：普通的打招呼（例如 hi, 你好）、日常闲聊、常识问答等，请直接以自然的文字进行回复，严禁滥用并调用任何系统工具。由于这是桌面悬浮聊天，绝对不要返回包含代码、文件写入等本地系统工具的指令，以文本交流为主。

🔍 主动澄清与消歧准则（Disambiguation Rules）：
1. 识别模糊与多义性：当用户的提问存在多种合理的解释，或者你无法确定具体指向（例如“记忆api”可能指代码文件，也可能指持久化数据，或外部项目）时，禁止擅自做假设或发散脑补。
2. 停止并提问：此时你必须立刻暂停长篇大论的回答，转而向用户提出一个简明、有针对性的澄清问题。
3. 提问模板：明确罗列出你怀疑的几种可能性，友好地请用户进行选择或补充。`

      chatMessages.unshift({ role: 'system', content: systemPrompt })

      const timeStr = formatDateTime()
      const displayFormatText = imagePath
        ? `${text}\n\n![Screenshot](local-file://${imagePath})`
        : text

      const userMsg = {
        id: Date.now(),
        sender: 'user',
        text: displayFormatText,
        time: timeStr
      }
      const agentPlaceholderMsg = {
        id: replyId,
        sender: 'agent',
        text: '',
        isThinking: true,
        toolSteps: [],
        time: timeStr
      }

      // 先清理上一次可能残留的 isThinking 状态（异常退出或工具调用失败时可能遗留）
      const cleanedMessages = (activeSession.messages || []).map(m =>
        m.isThinking
          ? { ...m, isThinking: false, text: m.text || '对话生成被中断。' }
          : m
      )
      const updatedMessages = [...cleanedMessages, userMsg, agentPlaceholderMsg]

      let name = activeSession.name
      const isFirstUserMsg = (activeSession.messages || []).filter((m: any) => m.sender === 'user').length === 0
      if (isFirstUserMsg || activeSession.name === '(未命名)' || activeSession.name === '新会话') {
        name = text.length > 15 ? text.substring(0, 15) + '...' : text
      }

      const updatedSessions = sessions.map(s => {
        if (s.id === activeSessionId) {
          return { ...s, name, messages: updatedMessages }
        }
        return s
      })

      localStorage.setItem('agentpet_sessions', JSON.stringify(updatedSessions))
      // 增量持久化到数据库，避免全量重写
      if (isNew) {
        await window.api.createSession({ id: activeSessionId, name, time: activeSession.time })
      } else {
        await window.api.updateSession(activeSessionId, { name })
      }
      await window.api.saveMessage({ ...userMsg, sessionId: activeSessionId })
      await window.api.saveMessage({ ...agentPlaceholderMsg, sessionId: activeSessionId })

      const workspacePath = localStorage.getItem('agentpet_workspace_path') || ''
      const response = await window.api.callLLM(
        {
          ...llmConfig,
          sessionId: activeSessionId,
          messageId: replyId
        },
        chatMessages,
        workspacePath
      )

      const finalSessions = updatedSessions.map(s => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: s.messages.map(m => m.id === replyId ? { ...m, text: response, isThinking: false } : m)
          }
        }
        return s
      })

      localStorage.setItem('agentpet_sessions', JSON.stringify(finalSessions))
      // 增量写入最终生成的助理回复到数据库
      await window.api.saveMessage({
        id: replyId,
        sessionId: activeSessionId,
        sender: 'agent',
        text: response,
        time: formatDateTime(),
        isThinking: false
      })



      // 将大模型答复同步传回给快捷输入框显示
      if (window.api.sendPetReplyToInput) {
        window.api.sendPetReplyToInput(response)
      }

      // 默认开启 TTS 朗读发音（除非用户明确关闭）
      const ttsEnabled = localStorage.getItem('agentpet_tts_enabled') !== 'false'
      if (ttsEnabled && response && currentAvatarVoice) {
        try {
          const cleanResponse = cleanTextForTts(response)
          const audioBuffer = await window.api.synthesizeTts(cleanResponse, currentAvatarVoice)
          if (audioBuffer) {
            window.api.playTtsAudio(audioBuffer)
          }
        } catch (ttsErr) {
          console.error('TTS 播放失败', ttsErr)
        }
      }

    } catch (e: any) {
      console.error('[PetWidget] 对话生成失败:', e)
      const isAbort = e.message?.includes('UserAborted') || e.message?.includes('aborted')
      const errMsg = isAbort
        ? '对话生成已被中断。'
        : `哎呀，出错了（${e.message || e}）。请检查你的模型 API Key 是否正确配置。`
      if (window.api.sendPetReplyToInput) {
        window.api.sendPetReplyToInput(errMsg)
      }
      // 同步报错状态到本地状态和数据库，去除假死的 loading 状态
      try {
        const savedSessions = localStorage.getItem('agentpet_sessions')
        if (savedSessions) {
          const sessions = JSON.parse(savedSessions)
          const updatedSessions = sessions.map((s: any) => {
            if (s.id === activeSessionId) {
              return {
                ...s,
                messages: (s.messages || []).map((m: any) => m.id === replyId ? { ...m, text: errMsg, isThinking: false, isError: !isAbort } : m)
              }
            }
            return s
          })
          localStorage.setItem('agentpet_sessions', JSON.stringify(updatedSessions))
        }
        await window.api.saveMessage({
          id: replyId,
          sessionId: activeSessionId,
          sender: 'agent',
          text: errMsg,
          time: formatDateTime(),
          isThinking: false,
          isError: !isAbort
        })
      } catch (err) {
        console.error('保存错误状态失败', err)
      }
    } finally {
      setIsLlmThinking(false)
      localStorage.removeItem('agentpet_llm_thinking_at')
    }
  }

  // 监听广播消息
  useEffect(() => {
    if (!window.electron || !window.electron.ipcRenderer) return
    const handleChat = (_event: any, text: string, isNewSession?: boolean, imagePath?: string) => {
      handleChatToPet(text, isNewSession, imagePath)
    }
    window.electron.ipcRenderer.on('chat-to-pet', handleChat)
    return () => {
      window.electron.ipcRenderer.removeListener('chat-to-pet', handleChat)
    }
  }, [currentAvatarVoice, currentAvatarStyle, currentAvatarName, reloadKey])

  const handleViewDetails = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const tId = bubbleTaskId
    const lId = bubbleLogId
    setBubbleText(null)
    setBubbleDetails(null)
    setBubbleTaskId(null)
    setBubbleLogId(null)
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)

    if (tId && lId) {
      window.api.openCronLogDetails(tId, lId)
    } else {
      window.api.openAgentWindow()
    }
  }

  // Global mouse events
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDraggingRef.current) return
      const dx = e.screenX - lastXRef.current
      const dy = e.screenY - lastYRef.current
      lastXRef.current = e.screenX
      lastYRef.current = e.screenY
      window.api.moveWindow(dx, dy)
    }
    const handleMouseUp = (): void => {
      if (isDraggingRef.current) { isDraggingRef.current = false; window.api.endDrag() }
    }
    const handleGlobalClick = (): void => {
    }
    const handleBlur = (): void => {
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('click', handleGlobalClick)
    window.addEventListener('blur', handleBlur)

    const hasIpc = window.electron && window.electron.ipcRenderer
    if (hasIpc) {
      window.electron.ipcRenderer.on('window-blur', handleBlur)
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('click', handleGlobalClick)
      window.removeEventListener('blur', handleBlur)
      if (hasIpc) {
        window.electron.ipcRenderer.removeListener('window-blur', handleBlur)
      }
    }
  }, [])

  // Initialize PixiJS + Live2D
  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false

    const init = async (): Promise<void> => {
      await ensureCubismCore()
      const { Live2DModel } = await import('pixi-live2d-display/cubism4')
      if (destroyed) return

      // 直接从主进程获取最新的配置信息，避免 React 状态更新延迟
      let customScale = 1.0
      let customXOffset = 0
      let customYOffset = 0
      try {
        const info = await window.api.getCustomModel()
        const customDir = info?.customModelDir || ''
        const list = await window.api.getAvatarsList()
        const active = list.find(a => (customDir ? a.dir === customDir : a.isDefault))
        if (active) {
          customScale = active.scale ?? 1.0
          customXOffset = active.xOffset ?? 0
          customYOffset = active.yOffset ?? 0
        }
      } catch (err) {
        console.error('[Live2D] 获取模型微调配置失败:', err)
      }

      const app = new PIXI.Application({
        width: SIZE_CONFIG.defaultWidth,
        height: SIZE_CONFIG.targetHeight,
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(window.devicePixelRatio || 1, 1.5),
        autoDensity: true,
        powerPreference: 'low-power',
        preserveDrawingBuffer: true // Keep the framebuffer available for per-pointer pixel hit testing.
      })
      app.ticker.maxFPS = 30
      appRef.current = app

      const canvas = app.view as HTMLCanvasElement
      canvas.style.cssText = 'width:100%;height:100%;display:block;'
      containerRef.current!.appendChild(canvas)

      let model: Live2DModelInstance
      try {
        const modelUrl = await window.api.getModelUrl()
        model = await Live2DModel.from(modelUrl, { autoInteract: false })
      } catch (e) {
        console.error('[Live2D] 模型加载失败:', e)
        setLoadError(`模型加载失败: ${e}`)
        return
      }

      if (destroyed) { model.destroy(); return }

      modelRef.current = model
      app.stage.addChild(model as unknown as PIXI.DisplayObject)

      // 先把缩放设为 1，然后高精度获取可见物体的物理包围盒，摆脱巨大的透明外框限制
      model.scale.set(1)
      const localBounds = model.getLocalBounds()
      const boundsW = localBounds.width || model.width || 2048
      const boundsH = localBounds.height || model.height || 2048
      const boundsX = localBounds.x || 0
      const boundsY = localBounds.y || 0

      console.log('[Live2D] 物理可见包围盒:', boundsW, 'x', boundsH, 'offset:', boundsX, ',', boundsY)

      // 目标人物身体显示高度设为 250px 
      const desiredBodyHeight = 250
      const autoScale = desiredBodyHeight / boundsH
      const finalScale = autoScale * customScale

      const bodyW = boundsW * finalScale
      const bodyH = boundsH * finalScale

      // 动态推导最包裹身体的窗口宽度和高度（给动作摆动留出空间）
      // Reserve enough transparent, click-through space on the right for the
      // quick-chat button so it does not overlap the avatar.
      const computedWidth = Math.max(190, Math.min(480, Math.round(bodyW + 100)))
      const targetHeight = Math.max(220, Math.min(500, Math.round(bodyH + 60)))

      console.log(`[Live2D] 窗口自适应尺寸设置: 宽=${computedWidth}, 高=${targetHeight}, 缩放=${finalScale}`)

      // 记录最新长宽状态
      computedWidthRef.current = computedWidth
      targetHeightRef.current = targetHeight
      setWidgetHeight(targetHeight)

      window.api.setWindowSize(computedWidth, targetHeight)
      app.renderer.resize(computedWidth, targetHeight)

      // 应用最终缩放
      model.scale.set(finalScale)

      // 完美的坐标定位算法：水平居中对齐，垂直底部对齐（向上留 10px 缝隙）
      model.x = (computedWidth - bodyW) / 2 - boundsX * finalScale + (customXOffset * finalScale)
      model.y = targetHeight - 10 - (boundsY + boundsH) * finalScale + (customYOffset * finalScale)

      await model.motion('Idle')
      app.render()
      const visibleRight = captureModelVisibleRight(app, computedWidth, targetHeight)
      if (visibleRight !== null) {
        setChatButtonPosition({
          left: Math.max(8, Math.min(computedWidth - 36, Math.round(visibleRight + 68))),
          bottom: 10
        })
      } else {
        setChatButtonPosition(null)
      }
      setModelReady(true)
      console.log('[Live2D] 模型就绪！')
    }

    init().catch((e) => { console.error('[Live2D] 初始化异常:', e); setLoadError(String(e)) })

    return () => {
      destroyed = true
      if (modelRef.current) {
        try {
          modelRef.current.destroy({ children: true, texture: true, baseTexture: true })
        } catch (e) {
          console.error('[Live2D] 销毁模型异常:', e)
        }
        modelRef.current = null
      }
      if (appRef.current) {
        try {
          appRef.current.destroy(true, { children: true, texture: true, baseTexture: true })
        } catch (e) {
          console.error('[PixiJS] 销毁 app 异常:', e)
        }
        appRef.current = null
      }
    }
  }, [reloadKey])

  const checkHoveringModel = (clientX: number, clientY: number): boolean => {
    if (!modelRef.current || !containerRef.current || !appRef.current) return false
    const rect = containerRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    if (x < 0 || x > rect.width || y < 0 || y > rect.height) return false

    // Restore the original high-precision WebGL pixel hit test.
    try {
      const renderer = appRef.current.renderer
      const resolution = renderer.resolution || 1
      const canvasX = Math.round(x * resolution)
      const canvasY = Math.round((rect.height - y) * resolution)
      const gl = (renderer as any).gl
      if (gl) {
        const pixels = new Uint8Array(4)
        ;(renderer as any).framebuffer.bind()
        gl.readPixels(canvasX, canvasY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        return pixels[3] > 10
      }
    } catch (error) {
      console.warn('[Live2D] WebGL readPixels failed, falling back to model bounds:', error)
    }

    const hitAreas = modelRef.current.hitTest(x, y)
    if (hitAreas && hitAreas.length > 0) return true

    try {
      const localBounds = modelRef.current.getLocalBounds()
      const finalScale = modelRef.current.scale.x
      const modelX = modelRef.current.x + localBounds.x * finalScale
      const modelY = modelRef.current.y + localBounds.y * finalScale
      const modelW = localBounds.width * finalScale
      const modelH = localBounds.height * finalScale

      if (x >= modelX && x <= modelX + modelW && y >= modelY && y <= modelY + modelH) return true
    } catch { /* Fall through. */ }

    return false
  }

  const updatePointerInteraction = (clientX: number, clientY: number): void => {
    const element = document.elementFromPoint(clientX, clientY)
    const isChatButton = Boolean(element?.closest('.pet-chat-icon-btn'))
    const isBubble = Boolean(element?.closest('.pet-toast-bubble'))
    const isOnModel = checkHoveringModel(clientX, clientY)
    setIsModelHovered(isOnModel || isChatButton)

    if (isOnModel || isChatButton || isBubble) {
      window.api.setIgnoreMouseEvents(false)
    } else {
      window.api.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    isDraggingRef.current = true
    lastXRef.current = e.screenX
    lastYRef.current = e.screenY
    window.api.startDrag()
  }

  const handleMouseEnter = (e: React.MouseEvent): void => {
    if (!modelRef.current) return
    updatePointerInteraction(e.clientX, e.clientY)
  }

  const handleMouseLeave = (): void => {
    setIsModelHovered(false)
    window.api.setIgnoreMouseEvents(true, { forward: true })
  }

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (isDraggingRef.current || !containerRef.current || !modelRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    modelRef.current.focus(e.clientX - rect.left, e.clientY - rect.top)
    updatePointerInteraction(e.clientX, e.clientY)
  }

  const handleClick = (e: React.MouseEvent): void => {
    if (!modelRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (modelRef.current.hitTest(x, y).length > 0) modelRef.current.motion('TapBody')
  }

  const handleDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.api.openAgentWindow()
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    window.api.showPetContextMenu()
  }

  const handleOpenInput = (e: React.MouseEvent): void => {
    e.stopPropagation()
    window.api.openInputWindow()
  }

  return (
    <div
      className="widget-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseMove={handleMouseMove}
      onContextMenu={handleContextMenu}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        overflow: 'visible'
      }}
    >
      <style>{`
        .pet-chat-icon-btn {
          position: absolute;
          bottom: 12px;
          right: 12px;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid rgba(0, 0, 0, 0.1);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #4f8cff;
          cursor: pointer;
          z-index: 999;
          opacity: 0;
          transform: scale(0.9);
          transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
        }

        .pet-chat-icon-btn.visible {
          opacity: 1;
          transform: scale(1);
        }

        .pet-chat-icon-btn:hover {
          background: #4f8cff;
          color: #ffffff;
          transform: scale(1.08) !important;
          box-shadow: 0 4px 12px rgba(79, 140, 255, 0.35);
        }

        .pet-chat-icon-btn:active {
          transform: scale(0.95) !important;
        }

        /* 气泡样式重构：亮丽半透明黑胶玻璃效果，加宽排版，支持滚动 */
        .pet-toast-bubble {
          position: absolute;
          top: 10px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(20, 20, 22, 0.88);
          backdrop-filter: blur(14px) saturate(180%);
          -webkit-backdrop-filter: blur(14px) saturate(180%);
          border: 1.2px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
          border-radius: 16px;
          padding: 10px 14px;
          width: 250px;
          max-width: 280px;
          max-height: 120px;
          overflow-y: auto;
          box-sizing: border-box;
          z-index: 1000;
          cursor: pointer;
          animation: bubbleFadeIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .pet-toast-bubble:focus-visible {
          outline: 2px solid rgba(79, 140, 255, 0.85);
          outline-offset: 3px;
        }

        .pet-toast-bubble::-webkit-scrollbar {
          width: 3px;
        }
        .pet-toast-bubble::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.15);
          border-radius: 2px;
        }

        .pet-toast-bubble-content {
          font-size: 11px;
          color: #f1f5f9;
          line-height: 1.45;
          text-align: left;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-weight: normal;
        }

        .pet-toast-bubble-arrow {
          position: absolute;
          bottom: -5px;
          left: 50%;
          transform: translateX(-50%) rotate(45deg);
          width: 10px;
          height: 10px;
          background: rgba(20, 20, 22, 0.88);
          border-right: 1.2px solid rgba(255, 255, 255, 0.08);
          border-bottom: 1.2px solid rgba(255, 255, 255, 0.08);
        }
      `}</style>

      {/* 定时提醒气泡 */}
      {bubbleText && (
        <div
          className="pet-toast-bubble"
          role="button"
          tabIndex={0}
          title="点击回到 AgentPet"
          onClick={handleViewDetails}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              handleViewDetails(event as unknown as React.MouseEvent)
            }
          }}
        >
          <div className="pet-toast-bubble-content">
            <div>{renderBubbleContent(bubbleText)}</div>
            {bubbleDetails && (
              <div className="pet-bubble-link" onClick={handleViewDetails}>
                查看详情
              </div>
            )}
          </div>
          <div className="pet-toast-bubble-arrow" />
        </div>
      )}

      {/* Live2D 渲染容器，高度固定并绝对定位靠底 */}
      <div
        ref={containerRef}
        className="pet-avatar-wrapper"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        style={{
          width: '100%',
          height: `${widgetHeight}px`,
          position: 'absolute',
          bottom: 0,
          left: 0,
          borderRadius: 0,
          opacity: modelReady ? 1 : 0,
          transition: 'opacity 0.5s ease',
          zIndex: 5
        }}
      />

      {/* 快捷输入聊天悬浮按钮 */}
      {modelReady && (
        <div
          className={`pet-chat-icon-btn ${isModelHovered ? 'visible' : ''}`}
          onClick={handleOpenInput}
          style={chatButtonPosition ? {
            bottom: `${chatButtonPosition.bottom}px`,
            left: `${chatButtonPosition.left}px`,
            right: 'auto'
          } : undefined}
          title="快捷聊天"
        >
          <MessageSquare size={15} strokeWidth={2} aria-hidden="true" />
        </div>
      )}



      {/* 调试错误提示 */}
      {loadError && (
        <div style={{ position: 'absolute', bottom: 40, left: 0, right: 0, background: 'rgba(255,0,0,0.8)', color: '#fff', fontSize: 9, padding: '4px 6px', borderRadius: 6, wordBreak: 'break-all', zIndex: 99 }}>
          {loadError}
        </div>
      )}
    </div>
  )
}

import React, { useEffect, useState, useRef } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'

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

export function PetWidget(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [modelReady, setModelReady] = useState(false)
  const [_isHoveringBody, setIsHoveringBody] = useState(false)
  const [widgetHeight, setWidgetHeight] = useState(SIZE_CONFIG.targetHeight)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)


  const isDraggingRef = useRef(false)
  const lastXRef = useRef(0)
  const lastYRef = useRef(0)
  const modelRef = useRef<InstanceType<typeof Live2DModel> | null>(null)
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

    try {
      const savedLlmConfig = localStorage.getItem('agentpet_llm_config') || localStorage.getItem('agentself_llm_config')
      let llmConfig = { provider: 'gemini', apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', temperature: 0.7 }
      if (savedLlmConfig) {
        try { llmConfig = JSON.parse(savedLlmConfig) } catch (e) { }
      }

      const isOllama = llmConfig.provider === 'ollama'
      const hasKey = isOllama || !!llmConfig.apiKey

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

      let activeSessionId = localStorage.getItem('agentself_active_session_id') || localStorage.getItem('agentpet_active_session_id') || 'agent:main:dashboard:default'

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
          ? `\n\n💡 【相关历史经验与避坑指南】\n${relevantExperiences.map((e, i) => `${i + 1}. ${e.fact}`).join('\n')}`
          : '')

      const stylePrompt = currentAvatarStyle === 'cute'
        ? '你需要使用可爱、萌系、活泼的语气与主人（用户）对话。'
        : '你需要使用专业、友好、自然的语气与主人（用户）对话。'

      const systemPrompt = `你是一只名为 ${currentAvatarName} 的桌面智能助理宠物（智能体）。
${stylePrompt}
当主人问起你是谁或者是什么大模型时，你必须坚持自己是专属桌面助手 ${currentAvatarName}，绝对不要泄露你是大语言模型（如 Gemini、OpenAI、DeepSeek 等）的真实身份，以免让人设割裂。
${memoryContext}
⚠️ 极重要约束：普通的打招呼（例如 hi, 你好）、日常闲聊、常识问答等，请直接以自然的文字进行回复，严禁滥用并调用任何系统工具。由于这是桌面悬浮聊天，绝对不要返回包含代码、文件写入等本地系统工具的指令，以文本交流为主。`

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
      const replyId = Date.now() + 1
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
          ? { ...m, isThinking: false, text: m.text || '⚠️ 对话生成被中断。' }
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
      const errMsg = `⚠️ 哎呀，出错了（${e.message || e}）。请检查你的模型 API Key 是否正确配置。`
      if (window.api.sendPetReplyToInput) {
        window.api.sendPetReplyToInput(errMsg)
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

    const waitForCubism = (retries = 20, interval = 100): Promise<void> =>
      new Promise((resolve, reject) => {
        const check = (n: number): void => {
          if (isCubismReady()) { resolve(); return }
          if (n <= 0) { reject(new Error('Cubism Core 未加载，请检查 live2dcubismcore.min.js 路径')); return }
          setTimeout(() => check(n - 1), interval)
        }
        check(retries)
      })

    const init = async (): Promise<void> => {
      await waitForCubism()
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
        preserveDrawingBuffer: true // 开启绘图缓冲保留，用于 readPixels 检测不规则碰撞
      })
      app.ticker.maxFPS = 30
      appRef.current = app

      const canvas = app.view as HTMLCanvasElement
      canvas.style.cssText = 'width:100%;height:100%;display:block;'
      containerRef.current!.appendChild(canvas)

      let model: InstanceType<typeof Live2DModel>
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
      const computedWidth = Math.max(160, Math.min(480, Math.round(bodyW + 50)))
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

    if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
      return false
    }

    // 1. 高精度的 WebGL 像素级碰撞检测 (Alpha 过滤)
    try {
      const renderer = appRef.current.renderer
      const resolution = renderer.resolution || 1
      const canvasX = Math.round(x * resolution)
      const canvasY = Math.round((rect.height - y) * resolution)
      const gl = (renderer as any).gl
      if (gl) {
        const pixels = new Uint8Array(4)
          ; (renderer as any).framebuffer.bind()
        gl.readPixels(canvasX, canvasY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        const alpha = pixels[3]
        return alpha > 10 // 大于 10 则判定鼠标触及有颜色的身体部分
      }
    } catch (err) {
      console.warn('[Live2D] WebGL readPixels 失败，降级至包围盒检测:', err)
    }

    // 2. 降级方案 A: 角色内置 hitTest
    const hitAreas = modelRef.current.hitTest(x, y)
    if (hitAreas && hitAreas.length > 0) {
      return true
    }

    // 3. 降级方案 B: 精确的物理可见部分 AABB 盒子检测
    try {
      const localBounds = modelRef.current.getLocalBounds()
      const finalScale = modelRef.current.scale.x

      const modelX = modelRef.current.x + localBounds.x * finalScale
      const modelY = modelRef.current.y + localBounds.y * finalScale
      const modelW = localBounds.width * finalScale
      const modelH = localBounds.height * finalScale

      if (x >= modelX && x <= modelX + modelW && y >= modelY && y <= modelY + modelH) {
        return true
      }
    } catch (e) { }

    return false
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

    // 检查鼠标下方是不是交互式 HTML 元素（气泡或快捷聊天按钮）
    const element = document.elementFromPoint(e.clientX, e.clientY)
    const isInteractive = element && (element.closest('.pet-chat-icon-btn') || element.closest('.pet-toast-bubble'))

    const isHovering = isInteractive ? true : checkHoveringModel(e.clientX, e.clientY)
    setIsHoveringBody(isHovering)
    if (isHovering) {
      window.api.setIgnoreMouseEvents(false)
    } else {
      window.api.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  const handleMouseLeave = (): void => {
    setIsHoveringBody(false)
    window.api.setIgnoreMouseEvents(true, { forward: true })
  }

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (isDraggingRef.current || !containerRef.current || !modelRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    modelRef.current.focus(x, y)

    // 检查鼠标下方是不是交互式 HTML 元素（气泡或快捷聊天按钮）
    const element = document.elementFromPoint(e.clientX, e.clientY)
    const isInteractive = element && (element.closest('.pet-chat-icon-btn') || element.closest('.pet-toast-bubble'))

    const isHovering = isInteractive ? true : checkHoveringModel(e.clientX, e.clientY)
    setIsHoveringBody(isHovering)
    if (isHovering) {
      window.api.setIgnoreMouseEvents(false)
    } else {
      window.api.setIgnoreMouseEvents(true, { forward: true })
    }
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

        .widget-container:hover .pet-chat-icon-btn {
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
          animation: bubbleFadeIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
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
        <div className="pet-toast-bubble">
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
          className="pet-chat-icon-btn"
          onClick={handleOpenInput}
          title="快捷聊天"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
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

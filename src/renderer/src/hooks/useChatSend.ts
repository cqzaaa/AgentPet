/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import { formatDateTime } from '../utils/helpers'

interface ChatSendState {
  sessions: any[]
  activeSessionId: string
  inputValue: string
  attachedFiles: any[]
  sendingSessionIds: Record<string, boolean>
  llmConfig: any
  contextRounds: number
  skillsList: any[]
  disabledSkillNames: string[]
  avatarList: any[]
  customModelDir: string
  customModelFile: string
  ttsEnabled: boolean
}

interface ChatSendOptions {
  getState: () => ChatSendState
  workspacePath: string
  setShowApiKeyModal: (show: boolean) => void
  setSessions: (updater: any[] | ((sessions: any[]) => any[])) => void
  setInputValue: (value: string) => void
  setAttachedFiles: (files: any[]) => void
  setSendingSessionIds: (updater: (sending: Record<string, boolean>) => Record<string, boolean>) => void
  abortedReplyIdsRef: MutableRefObject<Set<number>>
  finalizeReply: (replyId: number, text: string, sessionId: string, onComplete: () => void) => void
  failReply: (replyId: number, sessionId: string, error: unknown) => void
  triggerSessionSummary: (sessionId: string, sessions: any[]) => Promise<void>
}

function getAvatar(state: ChatSendState): { name: string; style: string; voice: string } {
  const avatar = state.avatarList.find(item => state.customModelDir ? item.dir === state.customModelDir : item.isDefault)
  return {
    name: avatar?.name || (state.customModelFile ? state.customModelFile.replace(/\.model3\.json$/i, '') : 'Mao'),
    style: avatar?.languageStyle || 'normal',
    voice: avatar?.voice || 'zh-CN-XiaoxiaoNeural'
  }
}

function toLlmMessage(message: any): { role: string; content: any } {
  let textContent = message.text || ''
  const imageBlocks: any[] = []

  if (message.fileInfo) {
    const needsPath = /\.(docx|xlsx|xls|csv|pdf)$/i.test(message.fileInfo.name || '')
    const pathNote = needsPath && message.fileInfo.path ? `\n[源文件路径: ${message.fileInfo.path}]` : ''
    textContent = `${message.text}\n\n--- [附带文件: ${message.fileInfo.name}]${pathNote}\n${message.fileInfo.content}`
  } else if (message.fileInfos?.length) {
    const attachmentsText = message.fileInfos
      .filter((file: any) => file.content)
      .map((file: any) => {
        const needsPath = /\.(docx|xlsx|xls|csv|pdf)$/i.test(file.name || '')
        const pathNote = needsPath && file.path ? `\n[源文件路径: ${file.path}]` : ''
        return `--- [附带文件: ${file.name}]${pathNote}\n${file.content}`
      })
      .join('\n\n')
    if (attachmentsText) textContent = `${message.text}\n\n${attachmentsText}`

    for (const file of message.fileInfos) {
      if (!file.content && file.path && (/\.(jpg|jpeg|png|gif|webp)$/i.test(file.name) || file.objectUrl)) {
        imageBlocks.push({
          type: 'image_url',
          image_url: { url: `local-file:///${file.path.replace(/\\/g, '/')}` }
        })
      }
    }
  }

  const role = message.sender === 'user' ? 'user' : 'assistant'
  if (imageBlocks.length === 0) return { role, content: textContent }
  return {
    role,
    content: [
      ...(textContent ? [{ type: 'text', text: textContent }] : []),
      ...imageBlocks
    ]
  }
}

/** Owns the complete "create messages -> call LLM -> settle reply" pipeline. */
export function useChatSend({
  getState,
  workspacePath,
  setShowApiKeyModal,
  setSessions,
  setInputValue,
  setAttachedFiles,
  setSendingSessionIds,
  abortedReplyIdsRef,
  finalizeReply,
  failReply,
  triggerSessionSummary
}: ChatSendOptions): { handleSendChat: () => Promise<void> } {
  const handleSendChat = useCallback(async (): Promise<void> => {
    const state = getState()
    const sessionId = state.activeSessionId
    const attachedFiles = [...state.attachedFiles]
    const text = state.inputValue.trim()
    if ((!text && attachedFiles.length === 0) || state.sendingSessionIds[sessionId]) return

    const llmConfig = { ...state.llmConfig }
    if (llmConfig.provider !== 'ollama' && !llmConfig.apiKey) {
      setShowApiKeyModal(true)
      return
    }

    const time = formatDateTime()
    const fileNames = attachedFiles.map(file => file.name).join(', ')
    const userMessage: any = {
      id: Date.now(),
      sender: 'user',
      text: text || (fileNames ? `📄 上传了附件: ${fileNames}` : ''),
      time
    }
    if (attachedFiles.length > 0) {
      userMessage.fileInfos = attachedFiles.map(file => ({
        name: file.name,
        path: file.path,
        content: file.content,
        safeName: file.safeName
      }))
    }

    const replyId = Date.now() + 1
    const placeholder: any = {
      id: replyId,
      sender: 'agent',
      text: '',
      isThinking: true,
      toolSteps: [],
      time
    }

    let updatedSessions: any[] = []
    setSessions((previous: any[]) => {
      updatedSessions = previous.map(session => {
        if (session.id !== sessionId) return session
        let name = session.name
        const isFirstUserMessage = !session.messages.some((message: any) => message.sender === 'user')
        if (isFirstUserMessage || name === '(未命名)' || name === '新会话' || name.startsWith('agent:main:dashboard:')) {
          const title = text || attachedFiles[0]?.name || '新会话'
          name = title.length > 15 ? `${title.substring(0, 15)}...` : title
        }
        const messages = session.messages.map((message: any) => {
          if (!message.isThinking) return message
          const cleaned = { ...message, isThinking: false, text: message.text || '⚠️ 对话生成被中断。' }
          window.api.saveMessage({ ...cleaned, sessionId }).catch(console.error)
          return cleaned
        })
        return { ...session, name, messages: [...messages, userMessage, placeholder] }
      })
      return updatedSessions
    })

    setInputValue('')
    setAttachedFiles([])
    setSendingSessionIds(previous => ({ ...previous, [sessionId]: true }))

    const activeSession = updatedSessions.find(session => session.id === sessionId)
    ;(async () => {
      await window.api.saveMessage({ ...userMessage, sessionId })
      await window.api.saveMessage({ ...placeholder, sessionId })
      if (activeSession) await window.api.updateSession(sessionId, { name: activeSession.name })
    })().catch(console.error)

    try {
      if (!activeSession) throw new Error(`SessionNotFound: ${sessionId}`)
      const chatMessages = activeSession.messages
        .filter((message: any) => (message.sender === 'user' || message.sender === 'agent') && !message.isThinking)
        .slice(-state.contextRounds * 2)
        .map(toLlmMessage)

      const enabledSkillNames = state.skillsList
        .filter(skill => !state.disabledSkillNames.includes(skill.name))
        .map(skill => skill.name)
      const [profileContent, recallResponse, skillsPromptText, activeMcpServers] = await Promise.all([
        window.api.getMemoryProfile().catch((error: any) => { console.error('获取人物画像失败:', error); return '' }),
        window.api.recallExperiences(text).catch((error: any) => { console.error('获取避坑经验失败:', error); return [] }),
        window.api.getActiveSkillsPrompt(enabledSkillNames).catch((error: any) => { console.error('获取已启用技能提示词失败:', error); return '' }),
        window.api.getActiveMcpServers().catch((error: any) => { console.error('获取可用 MCP 服务列表失败:', error); return [] })
      ])

      let relevantExperiences: any[] = []
      let recallDebug: any = null
      const recallResult: any = recallResponse
      if (recallResult && !Array.isArray(recallResult)) {
        relevantExperiences = recallResult.results || []
        recallDebug = recallResult.debug || null
      } else {
        relevantExperiences = Array.isArray(recallResult) ? recallResult : []
      }

      const memoryContext = `\n\n🧠 【长期人物画像与背景设定】\n${profileContent || '暂无详细人物画像。'}` +
        (relevantExperiences.length > 0
          ? `\n\n💡 【相关历史经验与避坑指南】\n${relevantExperiences.map((experience: any, index: number) => {
              let item = `${index + 1}. ${experience.fact}`
              if (experience.relatedContent) {
                item += `\n   [关联的原始总结上下文]:\n   """\n   ${experience.relatedContent.replace(/\n/g, '\n   ')}\n   """`
              } else if (experience.absolutePath) {
                item += `\n   [对应原始归档文件路径，若需了解详情你可以使用 read_file 访问该路径]: ${experience.absolutePath}`
              }
              return item
            }).join('\n')}`
          : '')
      const skillsContext = String(skillsPromptText).trim()
        ? `你当前已配备、激活并载入了以下专属技能扩展规约，请严格遵守这些技能定义的规约与最佳实践：\n\n${skillsPromptText}`
        : '你当前尚未启用任何第三方扩展skill技能。'
      const avatar = getAvatar(state)
      const stylePrompt = avatar.style === 'cute'
        ? '你需要使用可爱、萌系、活泼的语气与主人（用户）对话。'
        : '你需要使用专业、友好、自然的语气与主人（用户）对话。'
      const mcpContext = activeMcpServers.length > 0
        ? `\n\n🔗 此外，你已成功接入 MCP（Model Context Protocol）扩展服务：
${activeMcpServers.map((server: any, index: number) => `${index + 1}. ${server.name} — ${server.description || '外部 MCP 服务'} (包含 ${server.toolsCount} 个工具)`).join('\n')}
当主人的问题涉及上述 MCP 服务领域时，请务必主动调用对应的扩展工具来完成任务。`
        : ''

      const systemPrompt = `# [角色设定]
你是一只名为 ${avatar.name} 的桌面智能助理宠物（智能体）。
你的性格与语气：${stylePrompt}

<avatar_profile>
- 核心人设：你是专属的桌面萌宠助理，永远坚称自己是 ${avatar.name}。
- 🚫 绝对约束：严禁泄露你是大语言模型（如 Gemini、OpenAI、DeepSeek 等）的真实身份，以免破坏人设。
</avatar_profile>
${memoryContext}
${skillsContext}

<tool_use_rules>
- 工具授权：主进程已为你绑定了本地系统操作工具（文件读写、终端命令执行、系统状态获取）与外部 MCP 扩展工具。
- ⚠️ 调用原则：普通的打招呼（例如 hi、你好）、日常闲聊、常识问答等，请直接以文字回复，【严禁】无意义地调用系统工具。
- 🚫 调用约束：你只能使用已提供给你的工具，绝对不允许编造任何不存在的工具名称。
- 💡 变通调用：如果遇到未提供专用工具的需求（例如获取当前时间），请通过 'run_terminal_command' 执行相应的系统指令；本机 Windows 请指定 shell='powershell'，例如 \`Get-Date -Format 'yyyy-MM-dd HH:mm:ss K'\`。${mcpContext}

</tool_use_rules>

<output_rules>
- 对话风格：语气需保持人设风格（${avatar.style === 'cute' ? '可爱、萌系、活泼' : '专业、友好、自然'}）。
- 错误处理：遇到工具执行报错或空结果时，请以萌宠的语气告知主人，并尝试提供替代的解决方法。
- 主动澄清与消歧准则（Disambiguation Rules）：
  1. 识别模糊与多义性：当用户的提问存在多种合理的解释，或者你无法确定具体指向（例如“记忆api”可能指代码文件，也可能指持久化数据，或外部项目）时，禁止擅自做假设或发散脑补。
  2. 停止并提问：此时你必须立刻暂停长篇大论的回答，转而向用户提出一个简明、有针对性的澄清问题。
  3. 提问模板：明确罗列出你怀疑的几种可能性，友好地请用户进行选择或补充。
- 隐式 Wiki 知识溯源：在回答具体内容时，如果你参考了本地工作空间文件（或抓取的网页缓存文档）中的信息，请务必**直接在该句话或该段落的末尾**以 HTML 注释的形式精准标注出你引用的具体文件绝对或相对路径（例如 \`...相关内容。<!-- 关联文件: /path/to/file.md -->\`）。此标注对前端用户不可见，专用于后台精确到句的 Wiki 知识溯源，请确保标注的位置与参考内容紧密对应。
</output_rules>`

      chatMessages.unshift({ role: 'system', content: systemPrompt })
      const rawSummary = activeSession.contextSummary || ''
      if (rawSummary.trim()) {
        const trimmedSummary = rawSummary.length > 8000 ? `...(旧摘要已裁剪)...\n${rawSummary.slice(-8000)}` : rawSummary
        chatMessages.splice(1, 0, {
          role: 'user',
          content: `📝 [历史对话摘要]（以下是当前会话中超出上下文窗口的旧对话的精炼总结，请以此为参考背景）：\n${trimmedSummary}`
        })
      }

      window.api.getToolsDefinition().then((toolsDefinition: any[]) => {
        const promptInfo = {
          systemPrompt,
          chatMessages: [...chatMessages],
          toolsDefinition,
          model: llmConfig.model,
          provider: llmConfig.provider,
          temperature: llmConfig.temperature,
          maxTokens: llmConfig.maxTokens,
          recallDebug
        }
        setSessions((previous: any[]) => previous.map(session => session.id === sessionId
          ? { ...session, messages: session.messages.map((message: any) => message.id === userMessage.id ? { ...message, promptInfo } : message) }
          : session))
        window.api.saveMessage({ ...userMessage, promptInfo, sessionId }).catch(console.error)
      }).catch((error: any) => console.error('获取工具定义失败:', error))

      if (abortedReplyIdsRef.current.has(replyId)) throw new Error('UserAborted')
      const response = await window.api.callLLM(
        { ...llmConfig, sessionId, messageId: replyId },
        chatMessages,
        workspacePath
      )

      if (response !== undefined) {
        finalizeReply(replyId, response, sessionId, () => {
          const latestSessions = getState().sessions
          void triggerSessionSummary(sessionId, latestSessions)
        })
        if (relevantExperiences.length > 0) {
          window.api.strengthenExperiences(relevantExperiences.map(experience => experience.id)).catch((error: any) => {
            console.error('[Memory] 强化复习记忆失败:', error)
          })
        }
      } else {
        throw new Error('LLM returned no response')
      }

      if (state.ttsEnabled && response && avatar.voice) {
        try {
          const audioBuffer = await window.api.synthesizeTts(response, avatar.voice)
          if (audioBuffer) window.api.playTtsAudio(audioBuffer)
        } catch (error) {
          console.error('TTS 播放失败', error)
        }
      }
    } catch (error) {
      console.error(error)
      failReply(replyId, sessionId, error)
    }
  }, [
    abortedReplyIdsRef,
    failReply,
    finalizeReply,
    getState,
    setAttachedFiles,
    setInputValue,
    setSendingSessionIds,
    setSessions,
    setShowApiKeyModal,
    triggerSessionSummary,
    workspacePath
  ])

  return { handleSendChat }
}

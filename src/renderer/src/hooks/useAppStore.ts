import { useState, useRef, useEffect, type FormEvent } from 'react'
import { DEFAULT_MODELS, formatDateTime } from '../utils/helpers'

// ── 类型定义 ─────────────────────────────────────────────────
export interface CronLog {
  id: string
  time: string
  status: 'success' | 'failed' | 'running'
  message: string
  messages?: any[]
}

export interface CronTask {
  id: string
  name: string
  interval: number
  lastTriggered: string
  triggerCount: number
  isActive: boolean
  action?: string
  logs?: CronLog[]
}

export interface Session {
  id: string
  name: string
  time: string
  messages: any[]
}

export interface TokenLog {
  id: string
  model: string
  provider: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  timestamp: number
  sessionId?: string
  messageId?: number
}

export type TabType = 'chat' | 'control' | 'agent' | 'settings' | 'logs'
export type AgentSubTab = 'skills' | 'memory' | 'cron'
export type SettingsSubTab = 'keys' | 'storage' | 'avatar' | 'mcp'

export interface AttachedFile {
  name: string
  path: string
  content?: string
  safeName?: string
  objectUrl?: string
}

// ── 内部剪贴板（用于消息间复制文件） ─────────────────────────
let internalClipboard: { files: { name: string; path: string; content?: string }[]; text: string } | null = null

export function setInternalClipboard(files: { name: string; path: string; content?: string }[] | null, text?: string) {
  if (files && files.length > 0) {
    internalClipboard = { files, text: text || '' }
  } else {
    internalClipboard = null
  }
}

export function getInternalClipboard() {
  return internalClipboard
}

// ── useAppStore hook ─────────────────────────────────────────
export function useAppStore() {
  // ── Navigation ──────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabType>('chat')
  const [agentSubTab, setAgentSubTab] = useState<AgentSubTab>('skills')
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>('keys')

  // ── UI State ─────────────────────────────────────────────────
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)
  const cronRunningLogsRef = useRef<Record<string, CronLog>>({})

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null)

  // ── Cron Location Details ────────────────────────────────────
  const [selectedTaskForLog, setSelectedTaskForLog] = useState<any>(null)
  const [selectedCronLogDetails, setSelectedCronLogDetails] = useState<any>(null)
  const [pendingOpenTaskId, setPendingOpenTaskId] = useState<string | null>(null)
  const [pendingOpenLogId, setPendingOpenLogId] = useState<string | null>(null)

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type })
  }

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000)
      return () => clearTimeout(timer)
    }
    return () => {}
  }, [toast])

  // ── Theme ────────────────────────────────────────────────────
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('agentself_theme') as 'dark' | 'light') ||
      (localStorage.getItem('agentpet_theme') as 'dark' | 'light') || 'light'
  })

  const handleThemeToggle = (): void => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(nextTheme)
    localStorage.setItem('agentself_theme', nextTheme)
  }

  const [isSending, setIsSending] = useState(false)

  // ── LLM Config ───────────────────────────────────────────────
  const [llmConfig, setLlmConfig] = useState(() => {
    const saved = localStorage.getItem('agentself_llm_config') || localStorage.getItem('agentpet_llm_config')
    if (saved) {
      try { return JSON.parse(saved) } catch (e) { console.error(e) }
    }
    return { provider: 'gemini', apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', temperature: 0.7, maxTokens: 2048 }
  })

  const saveLlmConfig = (newConfig: any) => {
    if (isSending) {
      showToast('大模型正在思考中，无法修改配置', 'error')
      return
    }
    const prevModel = llmConfig.model
    const newModel = newConfig.model
    setLlmConfig(newConfig)
    localStorage.setItem('agentpet_llm_config', JSON.stringify(newConfig))

    // 同步配置到主进程
    window.api.syncLlmConfig(newConfig).catch(console.error)

    if (prevModel && newModel && prevModel !== newModel) {
      const timeStr = formatDateTime()
      setSessions(prev => prev.map(s => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: [...s.messages, {
              id: `sys-${Date.now()}-${Math.random()}`,
              sender: 'system',
              text: `⚙️ 已将大模型切换为：**${newModel}**`,
              time: timeStr
            }]
          }
        }
        return s
      }))
    }
  }

  // ── MCP Config ───────────────────────────────────────────────
  const [mcpConfig, setMcpConfig] = useState(() => {
    const saved = localStorage.getItem('agentpet_mcp_config')
    let currentConfig: any = null
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed && Array.isArray(parsed.servers)) {
          currentConfig = parsed
          currentConfig.servers = currentConfig.servers.map((s: any) => {
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
        // 向下兼容：如果以前是单个配置格式
        else if (parsed && parsed.url) {
          currentConfig = {
            servers: [
              {
                id: 'legacy-default',
                name: '高德地图mcp',
                url: 'https://mcpmarket.cn/mcp/de5dc2cd1aa574509a53c4d6',
                apiKey: parsed.apiKey || '',
                enabled: parsed.enabled ?? false
              }
            ]
          }
        }
      } catch (e) { console.error(e) }
    }

    if (!currentConfig || !currentConfig.servers || currentConfig.servers.length === 0) {
      const defaultServers = [
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
      currentConfig = { servers: defaultServers }
      localStorage.setItem('agentpet_mcp_config', JSON.stringify(currentConfig))
    }
    return currentConfig
  })

  const saveMcpConfig = (newConfig: any) => {
    setMcpConfig(newConfig)
    localStorage.setItem('agentpet_mcp_config', JSON.stringify(newConfig))
    window.api.syncMcpConfig(newConfig).catch(console.error)
  }

  // ── Cron Tasks ───────────────────────────────────────────────
  const [cronTasks, setCronTasks] = useState<CronTask[]>(() => {
    const saved = localStorage.getItem('agentself_cron_tasks') || localStorage.getItem('agentpet_cron_tasks')
    if (saved) {
      try { return JSON.parse(saved) } catch (e) { console.error(e) }
    }
    return [] // 默认无预设任务，由用户自行添加
  })


  // ── Sessions ─────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>(() => {
    const saved = localStorage.getItem('agentself_sessions') || localStorage.getItem('agentpet_sessions')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed && parsed.length > 0) {
          // 清除残留的 is_thinking 状态（应用异常退出时可能遗留在缓存中）
          return parsed.map((s: any) => ({
            ...s,
            messages: (s.messages || []).map((m: any) =>
              m.isThinking
                ? { ...m, isThinking: false, text: m.text || '⚠️ 应用异常退出，对话生成被中断。' }
                : m
            )
          }))
        }
      } catch (e) { console.error(e) }
    }
    return [{
      id: 'agent:main:dashboard:default',
      name: '(未命名)',
      time: formatDateTime(),
      messages: []
    }]
  })

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return localStorage.getItem('agentself_active_session_id') ||
      localStorage.getItem('agentpet_active_session_id') ||
      'agent:main:dashboard:default'
  })

  const [inputValue, setInputValue] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  // ── System Info ──────────────────────────────────────────────
  const [systemInfo, setSystemInfo] = useState<any>(null)

  // ── Token Logs ───────────────────────────────────────────────
  const [tokenLogs, setTokenLogs] = useState<TokenLog[]>(() => {
    const saved = localStorage.getItem('agentself_token_logs') || localStorage.getItem('agentpet_token_logs')
    if (saved) {
      try { return JSON.parse(saved) } catch (e) { console.error(e) }
    }
    return []
  })

  // ── Highlighted Message ──────────────────────────────────────
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null)

  // ── Skills ───────────────────────────────────────────────────
  const [skillsList, setSkillsList] = useState<any[]>([])
  const [skillsPath, setSkillsPath] = useState<string>('')
  const [storageInputPath, setStorageInputPath] = useState('')
  const [actualStoragePath, setActualStoragePath] = useState('')
  const [storageSaveStatus, setStorageSaveStatus] = useState<{ type: 'success' | 'failed' | 'idle'; message: string }>({ type: 'idle', message: '' })
  const [sandboxMode, setSandboxMode] = useState<boolean>(true)
  const [activePermissionRequest, setActivePermissionRequest] = useState<{
    requestId: number
    command: string
    execCwd: string
  } | null>(null)

  // ── Avatar ───────────────────────────────────────────────────
  const [customModelDir, setCustomModelDir] = useState('')
  const [customModelFile, setCustomModelFile] = useState('')
  const [avatarList, setAvatarList] = useState<any[]>([])
  const activeAvatar = avatarList.find(a => (customModelDir ? a.dir === customModelDir : a.isDefault))
  const currentAvatarName = activeAvatar ? activeAvatar.name : (customModelFile ? customModelFile.replace(/\.model3\.json$/i, '') : 'Mao')
  const currentAvatarStyle = activeAvatar?.languageStyle || 'normal'

  // ── Memory Settings ──────────────────────────────────────────
  const [autoSaveHistory, setAutoSaveHistory] = useState(() => {
    const val = localStorage.getItem('agentself_autosave') || localStorage.getItem('agentpet_autosave')
    return val === null ? true : val === 'true'
  })
  const [contextRounds, setContextRounds] = useState(() => {
    return Number(localStorage.getItem('agentself_context_rounds') || localStorage.getItem('agentpet_context_rounds') || '10')
  })

  // ── Connection Test ──────────────────────────────────────────
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | string>('idle')

  // ── Effects ──────────────────────────────────────────────────

  // 应用启动或配置更改时自动获取最新可用模型列表
  useEffect(() => {
    const isOllama = llmConfig.provider === 'ollama'
    const hasKey = isOllama || !!llmConfig.apiKey
    if (hasKey) {
      const autoFetch = async () => {
        setIsLoadingModels(true)
        try {
          const list = await window.api.getModels({ 
            provider: llmConfig.provider, 
            apiKey: llmConfig.apiKey, 
            baseUrl: llmConfig.baseUrl 
          })
          if (list && list.length > 0) {
            setAvailableModels(list)
            // 如果拉取到的列表中不包含当前设置的 model，我们自适应选择第一个
            if (!list.includes(llmConfig.model)) {
              saveLlmConfig({ ...llmConfig, model: list[0] })
            }
          }
        } catch (e) {
          console.error('自动加载模型列表失败', e)
        } finally {
          setIsLoadingModels(false)
        }
      }
      autoFetch()
    } else {
      setAvailableModels([])
    }
  }, [llmConfig.provider, llmConfig.apiKey, llmConfig.baseUrl])

  // Click outside to close model dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Poll system info
  useEffect(() => {
    const fetchInfo = async (): Promise<void> => {
      try {
        const info = await window.api.getSystemInfo()
        setSystemInfo(info)
      } catch (e) { console.error('获取系统资源失败', e) }
    }
    fetchInfo()
    const interval = setInterval(fetchInfo, 2000)
    return () => clearInterval(interval)
  }, [])

  // Load skills & storage path
  const refreshSkillsAndStorage = async (): Promise<void> => {
    try {
      const list = await window.api.getSkillsList()
      setSkillsList(list)
      const path = await window.api.getSkillsPath()
      setSkillsPath(path)
      const customPath = await window.api.getStoragePath()
      setActualStoragePath(customPath || path)
      setStorageInputPath(customPath)
    } catch (e) { console.error(e) }
  }

  const refreshAvatarsList = async (): Promise<void> => {
    try {
      const list = await window.api.getAvatarsList()
      setAvatarList(list)
    } catch (e) { console.error(e) }
  }

  useEffect(() => {
    refreshSkillsAndStorage()
    const loadCustomModelInfo = async (): Promise<void> => {
      try {
        const info = await window.api.getCustomModel()
        if (info) {
          setCustomModelDir(info.customModelDir || '')
          setCustomModelFile(info.customModelFile || '')
        }
      } catch (e) { console.error(e) }
    }
    const loadSandboxMode = async (): Promise<void> => {
      try {
        const enabled = await window.api.getSandboxMode()
        setSandboxMode(enabled)
      } catch (e) { console.error(e) }
    }
    loadSandboxMode()
    loadCustomModelInfo()
    refreshAvatarsList()
  }, [])

  // 加载本地及主进程定时任务
  useEffect(() => {
    const loadCronTasks = async () => {
      try {
        const tasks = await window.api.getCronTasks()
        if (tasks && tasks.length > 0) {
          setCronTasks(tasks)
        } else {
          // 兼容并迁移旧版 localStorage 里的定时任务
          const saved = localStorage.getItem('agentpet_cron_tasks') || localStorage.getItem('agentself_cron_tasks')
          if (saved) {
            try {
              const parsed = JSON.parse(saved)
              setCronTasks(parsed)
              await window.api.saveCronTasks(parsed)
            } catch (e) {
              console.error(e)
            }
          }
        }
      } catch (e) {
        console.error('加载定时任务失败', e)
      }
    }
    loadCronTasks()
  }, [])

  // 监听并执行详情自动定位弹窗
  useEffect(() => {
    if (!pendingOpenTaskId || cronTasks.length === 0) return
    const task = cronTasks.find(t => t.id === pendingOpenTaskId)
    if (task) {
      setSelectedTaskForLog(task)
      if (pendingOpenLogId && task.logs) {
        const log = task.logs.find(l => l.id === pendingOpenLogId)
        if (log) {
          setSelectedCronLogDetails(log)
        }
      }
    }
    setPendingOpenTaskId(null)
    setPendingOpenLogId(null)
  }, [pendingOpenTaskId, pendingOpenLogId, cronTasks])

  // 监听主窗口 IPC 定位指令
  useEffect(() => {
    if (!window.api.onOpenCronLogDetails) return
    const unsubscribe = window.api.onOpenCronLogDetails((taskId: string, logId: string) => {
      setActiveTab('agent')
      setAgentSubTab('cron')
      setPendingOpenTaskId(taskId)
      setPendingOpenLogId(logId)
    })
    return () => unsubscribe()
  }, [])

  // 挂载时解析 URL 传入的定位参数
  useEffect(() => {
    try {
      const href = window.location.href
      const taskMatch = href.match(/[?&]openTaskId=([^&?#]+)/)
      const logMatch = href.match(/[?&]openLogId=([^&?#]+)/)
      if (taskMatch && taskMatch[1]) {
        setActiveTab('agent')
        setAgentSubTab('cron')
        setPendingOpenTaskId(decodeURIComponent(taskMatch[1]))
      }
      if (logMatch && logMatch[1]) {
        setPendingOpenLogId(decodeURIComponent(logMatch[1]))
      }
    } catch (e) {
      console.error('解析 URL 定位参数失败', e)
    }
  }, [])

  // 监听主进程的大模型定时任务更新通知
  useEffect(() => {
    if (!window.api.onCronUpdated) return
    const unsubscribe = window.api.onCronUpdated(async () => {
      try {
        const tasks = await window.api.getCronTasks()
        if (tasks) {
          setCronTasks(tasks)
          showToast('🤖 桌面助理已为您创建或更新了定时任务！', 'success')
        }
      } catch (e) {
        console.error('刷新定时任务失败', e)
      }
    })
    return () => unsubscribe()
  }, [])

  // 监听本地命令的安全沙盒授权请求
  useEffect(() => {
    if (!window.api.onRequestPermission) return
    const unsubscribe = window.api.onRequestPermission((data: any) => {
      setActivePermissionRequest(data)
    })
    return () => unsubscribe()
  }, [])

  // Listen for Token Usage
  useEffect(() => {
    if (!window.api.onTokenUsage) return
    const unsubscribe = window.api.onTokenUsage((data: any) => {
      const newLog: TokenLog = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        model: data.model || 'unknown',
        provider: data.provider || 'unknown',
        promptTokens: data.promptTokens || 0,
        completionTokens: data.completionTokens || 0,
        totalTokens: (data.promptTokens || 0) + (data.completionTokens || 0),
        timestamp: data.timestamp || Date.now(),
        sessionId: data.sessionId,
        messageId: data.messageId
      }
      setTokenLogs(prev => {
        const next = [...prev, newLog]
        localStorage.setItem('agentpet_token_logs', JSON.stringify(next))
        return next
      })
    })
    return () => unsubscribe()
  }, [])

  const refreshSessions = async (): Promise<void> => {
    try {
      const localSess = await window.api.getLocalSessions()
      if (localSess && localSess.length > 0) {
        // 清除残留的 is_thinking 状态（应用异常退出时可能遗留在数据库中）
        const cleaned = localSess.map((s: any) => ({
          ...s,
          messages: (s.messages || []).map((m: any) =>
            m.isThinking
              ? { ...m, isThinking: false, text: m.text || '⚠️ 应用异常退出，对话生成被中断。' }
              : m
          )
        }))
        setSessions(cleaned)
      }
    } catch (e) { console.error('从本地文件载入会话记录失败', e) }
  }

  // 同步初始化大模型与 MCP 配置
  useEffect(() => {
    window.api.syncLlmConfig(llmConfig).catch(console.error)
    window.api.syncMcpConfig(mcpConfig).catch(console.error)
  }, [])

  // 监听微信聊天会话更新通知
  useEffect(() => {
    if (!window.api.onWechatSessionUpdated) return
    const unsubscribe = window.api.onWechatSessionUpdated(() => {
      refreshSessions()
    })
    return () => unsubscribe()
  }, [])

  // Load sessions from local file
  useEffect(() => {
    refreshSessions()
  }, [])

  const [isSessionSwitching, setIsSessionSwitching] = useState(false)
  const prevSessionIdRef = useRef<string | null>(null)
  const justSwitchedRef = useRef(false)

  // 1. 处理会话切换时的骨架屏和定位
  useEffect(() => {
    if (prevSessionIdRef.current !== activeSessionId) {
      setIsSessionSwitching(true)
      prevSessionIdRef.current = activeSessionId

      // 切换会话时清空输入框和附件
      setInputValue('')
      setAttachedFiles([])

      const skeletonTimer = setTimeout(() => {
        setIsSessionSwitching(false)
        justSwitchedRef.current = true

        // 让 React 有时间把骨架屏替换为真实聊天 DOM 后再滚动定位
        setTimeout(() => {
          chatEndRef.current?.scrollIntoView({ behavior: 'auto' })
          justSwitchedRef.current = false
        }, 50)
      }, 400) // 显示 400ms 骨架屏

      return () => clearTimeout(skeletonTimer)
    }
  }, [activeSessionId])

  // 2. 处理正常收到或发送新消息时的平滑滚动
  useEffect(() => {
    // 只有在非切换状态下才执行平滑滚动
    if (!isSessionSwitching && !justSwitchedRef.current) {
      const timer = setTimeout(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [sessions, activeTab])

  // Auto-save sessions
  useEffect(() => {
    if (autoSaveHistory) {
      localStorage.setItem('agentself_sessions', JSON.stringify(sessions))
      window.api.saveLocalSessions(sessions)
    } else {
      localStorage.removeItem('agentself_sessions')
    }
  }, [sessions, autoSaveHistory])

  useEffect(() => {
    localStorage.setItem('agentself_active_session_id', activeSessionId)
  }, [activeSessionId])

  // Cron timer loop variables moved below to avoid TDZ

  // ── Handlers ─────────────────────────────────────────────────

  const handleFetchModels = async (): Promise<void> => {
    setIsLoadingModels(true)
    setShowModelDropdown(true)
    try {
      const list = await window.api.getModels({ provider: llmConfig.provider, apiKey: llmConfig.apiKey, baseUrl: llmConfig.baseUrl })
      if (list && list.length > 0) {
        setAvailableModels(list)
        showToast('获取模型列表成功！', 'success')
      } else {
        setAvailableModels([])
        showToast('未获取到可用模型列表', 'info')
      }
    } catch (e: any) {
      setAvailableModels([])
      showToast(e.message || '获取模型列表失败，请检查网络或配置', 'error')
    } finally {
      setIsLoadingModels(false)
    }
  }

  const handleDeleteSession = (id: string): void => {
    const filtered = sessions.filter(s => s.id !== id)
    let nextSessions = filtered
    if (filtered.length === 0) {
      const timeStr = formatDateTime()
      nextSessions = [{
        id: 'agent:main:dashboard:default',
        name: '(未命名)',
        time: timeStr,
        messages: []
      }]
    }
    setSessions(nextSessions)
    if (activeSessionId === id) setActiveSessionId(nextSessions[0].id)
  }

  const handleCreateNewSession = (): void => {
    if (sessions.length > 0 && sessions[sessions.length - 1].name === '(未命名)') {
      setActiveSessionId(sessions[sessions.length - 1].id)
      setAttachedFiles([])
      setInputValue('')
      setActiveTab('chat')
      return
    }
    const randNum = Math.floor(1000 + Math.random() * 9000)
    const newId = `agent:main:dashboard:${randNum}`
    const newSess: Session = {
      id: newId,
      name: '(未命名)',
      time: formatDateTime(),
      messages: []
    }
    setSessions([...sessions, newSess])
    setActiveSessionId(newId)
    setAttachedFiles([])
    setInputValue('')
    setActiveTab('chat')
  }

  // ── 工作空间与文件上传管理 ────────────────────────────────────
  const [workspacePath, setWorkspacePath] = useState<string>(() => {
    return localStorage.getItem('agentpet_workspace_path') || ''
  })
  
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])

  const handleSelectWorkspace = async (): Promise<void> => {
    try {
      const path = await window.api.selectDirectory({ title: '选择工作空间/项目目录' })
      if (path) {
        setWorkspacePath(path)
        localStorage.setItem('agentpet_workspace_path', path)
        showToast(`工作空间已设置为：${path}`, 'success')
      }
    } catch (e: any) {
      showToast(`选择工作空间失败: ${e.message}`, 'error')
    }
  }

  const handleClearWorkspace = (e: any): void => {
    e.stopPropagation()
    setWorkspacePath('')
    localStorage.removeItem('agentpet_workspace_path')
    showToast('工作空间已清除', 'info')
  }

  const handleUploadFile = async (): Promise<void> => {
    try {
      const file = await window.api.selectFile()
      if (file) {
        setAttachedFiles(prev => [...prev, file])
        showToast(`成功导入文本文件: ${file.name}`, 'success')
      }
    } catch (e: any) {
      showToast(`读取文件失败: ${e.message}`, 'error')
    }
  }

  const handlePasteFiles = async (files: FileList): Promise<void> => {
    if (!files || files.length === 0) return
    const newAttachments: AttachedFile[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const arrayBuffer = await file.arrayBuffer()
        const result = await window.api.saveChatFile(activeSessionId, file.name || 'image.png', arrayBuffer)

        let objectUrl
        if (file.type.startsWith('image/')) {
          objectUrl = URL.createObjectURL(file)
        }

        // 对非图片文件，解析文档内容
        let content: string | undefined
        const ext = file.name.split('.').pop()?.toLowerCase() || ''
        const docExts = ['pdf', 'docx', 'xlsx', 'xls', 'csv']
        const textExts = ['txt', 'md', 'js', 'jsx', 'ts', 'tsx', 'json', 'html', 'css', 'py', 'java', 'c', 'cpp', 'sh', 'bat', 'yml', 'yaml', 'ini', 'xml']
        if (docExts.includes(ext)) {
          content = await window.api.parseFileContent(result.path)
        } else if (textExts.includes(ext)) {
          content = await file.text()
        }

        newAttachments.push({
          name: result.name,
          path: result.path,
          safeName: result.safeName,
          objectUrl,
          content
        })
      } catch (e: any) {
        console.error('粘贴保存文件失败', e)
        showToast(`保存粘贴文件失败: ${e.message}`, 'error')
      }
    }
    if (newAttachments.length > 0) {
      setAttachedFiles(prev => [...prev, ...newAttachments])
      showToast(`成功粘贴 ${newAttachments.length} 个文件`, 'success')
    }
  }

  // 监听大模型在后台的系统工具调用日志事件并插入最新的一条机器人消息中
  useEffect(() => {
    if (!window.api.onToolEvent) return
    const unsubscribe = window.api.onToolEvent((data: any) => {
      const { type, name, args, result, sessionId } = data

      // 1. 如果是定时任务后台执行产生的工具调用事件
      if (sessionId && sessionId.startsWith('cron:')) {
        const runningLog = cronRunningLogsRef.current[sessionId]
        if (runningLog && runningLog.messages) {
          const messages = [...runningLog.messages]
          const agentMsgIdx = messages.findIndex(m => m.sender === 'agent')
          if (agentMsgIdx !== -1) {
            const agentMsg = { ...messages[agentMsgIdx] }
            const toolSteps = agentMsg.toolSteps ? [...agentMsg.toolSteps] : []
            
            if (type === 'tool_call') {
              toolSteps.push({
                id: `step-${Date.now()}-${Math.random()}`,
                type: 'call',
                name,
                detail: args
              })
            } else if (type === 'tool_result') {
              toolSteps.push({
                id: `step-${Date.now()}-${Math.random()}`,
                type: 'result',
                name,
                detail: result
              })
            }
            
            agentMsg.toolSteps = toolSteps
            messages[agentMsgIdx] = agentMsg
            runningLog.messages = messages

            const parts = sessionId.split(':')
            const taskId = parts[1]

            // 实时刷新渲染状态，让前台展示中展现最新的 tool 调用链
            setCronTasks(prevTasks => {
              return prevTasks.map(t => {
                if (t.id === taskId) {
                  const updatedLogs = (t.logs || []).map(l => l.id === runningLog.id ? { ...runningLog } : l)
                  return { ...t, logs: updatedLogs }
                }
                return t
              })
            })
          }
        }
        return
      }

      // 2. 正常前台会话消息更新
      setSessions(prev => prev.map(s => {
        if (s.id === activeSessionId) {
          const messages = [...s.messages]
          const latestAgentIdx = messages.map(m => m.sender).lastIndexOf('agent')
          if (latestAgentIdx !== -1) {
            const agentMsg = { ...messages[latestAgentIdx] }
            const toolSteps = agentMsg.toolSteps ? [...agentMsg.toolSteps] : []
            
            if (type === 'tool_call') {
              toolSteps.push({
                id: `step-${Date.now()}-${Math.random()}`,
                type: 'call',
                name,
                detail: args
              })
            } else if (type === 'tool_result') {
              toolSteps.push({
                id: `step-${Date.now()}-${Math.random()}`,
                type: 'result',
                name,
                detail: result
              })
            }
            
            agentMsg.toolSteps = toolSteps
            messages[latestAgentIdx] = agentMsg
          }
          return { ...s, messages }
        }
        return s
      }))
    })
    return () => unsubscribe()
  }, [activeSessionId])

  const handleSendChat = async (): Promise<void> => {
    if ((!inputValue.trim() && attachedFiles.length === 0) || isSending) return
    const text = inputValue.trim()
    const timeStr = formatDateTime()
    
    const fileNames = attachedFiles.map(f => f.name).join(', ')
    // 1. 构建用户发送的消息
    const userMsg: any = { 
      id: Date.now(), 
      sender: 'user', 
      text: text || (fileNames ? `📄 上传了附件: ${fileNames}` : ''), 
      time: timeStr 
    }
    if (attachedFiles.length > 0) {
      userMsg.fileInfos = attachedFiles.map(f => ({
        name: f.name,
        path: f.path,
        content: f.content,
        safeName: f.safeName
        // ⚠️ 不保存 objectUrl（blob URL 仅在当前进程生命周期内有效，重启后失效）
        // 渲染层会通过 local-file:// 协议直接从磁盘读取 path 来展示图片
      }))
    }

    // 2. 构建机器人的思考占位消息
    const replyId = Date.now() + 1
    const agentPlaceholderMsg: any = {
      id: replyId,
      sender: 'agent',
      text: '',
      isThinking: true,
      toolSteps: [],
      time: timeStr
    }

    let updatedSessions = sessions.map(s => {
      if (s.id === activeSessionId) {
        let name = s.name
        const isFirstUserMsg = s.messages.filter(m => m.sender === 'user').length === 0
        if (isFirstUserMsg || s.name === '(未命名)' || s.name === '新会话' || s.name.startsWith('agent:main:dashboard:')) {
          const displayTitle = text || (attachedFiles.length > 0 ? attachedFiles[0].name : '新会话')
          name = displayTitle.length > 15 ? displayTitle.substring(0, 15) + '...' : displayTitle
        }
        // 同步塞入用户消息和机器人的空白占位消息
        return { ...s, name, messages: [...s.messages, userMsg, agentPlaceholderMsg] }
      }
      return s
    })
    
    setSessions(updatedSessions)
    setInputValue('')
    setAttachedFiles([]) // 发送后清空附件
    setIsSending(true)

    const isOllama = llmConfig.provider === 'ollama'
    const hasKey = isOllama || !!llmConfig.apiKey

    if (!hasKey) {
      setTimeout(() => {
        const agentReplies = [
          '您的指令我已经收到并加入核心记忆库中！',
          '好的，我正在为您分析这部分数据，请稍等。',
          '主人，今天的天气很适合写代码，但也要多注意休息哦！',
          '正在为您检索网络资源...',
          '这件事情听起来很有趣，我很乐意陪您一起探讨呢~'
        ]
        const randomReply = agentReplies[Math.floor(Math.random() * agentReplies.length)]
        setSessions(prev => prev.map(s => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              messages: s.messages.map(m => m.id === replyId ? { ...m, text: randomReply, isThinking: false } : m)
            }
          }
          return s
        }))
        setIsSending(false)
      }, 1000)
      return
    }

    try {
      const activeSessObj = updatedSessions.find(s => s.id === activeSessionId)
      const currentMessages = activeSessObj ? activeSessObj.messages : []
      const filtered = currentMessages.filter(m => (m.sender === 'user' || m.sender === 'agent') && !m.isThinking)
      const chatMessages = filtered.slice(-contextRounds * 2).map(m => {
        // 如果此条消息带有附件，则把文件内容拼装进去送给大模型
        let textContent = m.text || ''
        let hasImage = false
        const imageBlocks: any[] = []

        if (m.fileInfo) {
          const isDocx = m.fileInfo.name?.toLowerCase().endsWith('.docx')
          const pathNote = isDocx && m.fileInfo.path ? `\n[源文件路径: ${m.fileInfo.path}]` : ''
          textContent = `${m.text}\n\n--- [附带文件: ${m.fileInfo.name}]${pathNote}\n${m.fileInfo.content}`
        } else if (m.fileInfos && m.fileInfos.length > 0) {
          const attachmentsText = m.fileInfos.filter((f: any) => f.content).map((f: any) => {
            const isDocx = f.name?.toLowerCase().endsWith('.docx')
            const pathNote = isDocx && f.path ? `\n[源文件路径: ${f.path}]` : ''
            return `--- [附带文件: ${f.name}]${pathNote}\n${f.content}`
          }).join('\n\n')
          if (attachmentsText) {
             textContent = `${m.text}\n\n${attachmentsText}`
          }

          // 提取图片（依据扩展名或者包含 objectUrl 判断）
          const imageFiles = m.fileInfos.filter((f: any) => !f.content && f.path && (f.name.match(/\.(jpg|jpeg|png|gif|webp)$/i) || f.objectUrl))
          if (imageFiles.length > 0) {
            hasImage = true
            imageFiles.forEach((f: any) => {
              imageBlocks.push({
                type: 'image_url',
                image_url: { url: `local-file:///${f.path.replace(/\\/g, '/')}` }
              })
            })
          }
        }

        if (hasImage) {
          const finalContent: any[] = []
          if (textContent) {
            finalContent.push({ type: 'text', text: textContent })
          }
          finalContent.push(...imageBlocks)
          return { role: m.sender === 'user' ? 'user' : 'assistant', content: finalContent }
        } else {
          return { role: m.sender === 'user' ? 'user' : 'assistant', content: textContent }
        }
      })

      // 动态拼装系统人设与技能感知上下文
      const skillsContext = skillsList.length > 0
        ? `你当前已配备并激活的专属技能扩展模块有：[${skillsList.map(s => s.name).join(', ')}]。`
        : '你当前尚未安装配备任何第三方扩展技能。'
      const stylePrompt = currentAvatarStyle === 'cute' 
        ? '你需要使用可爱、萌系、活泼的语气与主人（用户）对话。'
        : '你需要使用专业、友好、自然的语气与主人（用户）对话。'

      const systemPrompt = `你是一只名为 ${currentAvatarName} 的桌面智能助理宠物（智能体）。
${stylePrompt}
当主人问起你是谁或者是什么大模型时，你必须坚持自己是专属桌面助手 ${currentAvatarName}，绝对不要泄露你是大语言模型（如 Gemini、OpenAI、DeepSeek 等）的真实身份，以免让人设割裂。
${skillsContext}
在开发任务中，你可以通过调用本地系统工具来读写主人工作空间下的文件，以及执行终端控制台命令（通过 run_terminal_command）以直接操控本地电脑来协助主人。请明智、安全地使用它们。
⚠️ 极重要约束：只有当主人的指令或问题明确指示进行”查看/操作文件、列出目录、获取系统状态、运行命令”等开发运维任务时，你才被允许调用本地系统工具。普通的打招呼（例如 hi, 你好）、日常闲聊、常识问答等，请直接以自然的文字进行回复，严禁滥用并调用任何系统工具。

🚫 工具调用严格约束：你只能使用以下列出的工具，绝对不允许调用或编造任何不在列表中的工具名称（如 get_current_date、search_web、calculate 等均不存在）。如果你需要获取当前日期时间等信息，请通过 run_terminal_command 执行系统命令（如 date /T）来获取。
你当前可用的工具列表如下：
1. run_terminal_command — 执行终端命令（如运行脚本、查看文件、获取日期时间等）
2. get_system_status — 获取 CPU/内存/系统负载状态
3. manage_cron_task — 创建或删除定时任务
4. get_location — 获取当前地理位置（经纬度）
5. generate_file — 从零创建新文件（txt/xlsx/docx/pdf/pptx 等）
6. modify_docx_file — 修改已上传的 docx 文件（保留原格式）
7. modify_xlsx_file — 修改已上传的 xlsx 文件（保留原格式）
8. read_file — 读取文件内容（xlsx/docx/pdf/csv/文本等）
以上是全部可用工具，不存在其他工具。如需获取日期、时间、网络信息等，请使用 run_terminal_command 执行相应系统命令。`

      // 将 system prompt 注入为上下文的首条消息
      chatMessages.unshift({ role: 'system', content: systemPrompt })

      // 调用大模型接口，传入 workspacePath 参数，同时把 sessionId 和 messageId 传进去
      const response = await window.api.callLLM(
        {
          ...llmConfig,
          sessionId: activeSessionId,
          messageId: replyId
        },
        chatMessages,
        workspacePath
      )
      
      // 更新该 replyId 占位消息的 text 并结束思考状态
      setSessions(prev => prev.map(s => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: s.messages.map(m => m.id === replyId ? { ...m, text: response, isThinking: false } : m)
          }
        }
        return s
      }))
    } catch (e: any) {
      console.error(e)
      const isAbort = e.message?.includes('UserAborted') || e.message?.includes('aborted')
      const errMsg = isAbort 
        ? '⚠️ 对话生成已被用户手动中断。'
        : `系统错误：调用智能代理接口失败（${e.message || e}）。请检查『设置 -> 模型配置』中的代理路径或 API Key。`
      setSessions(prev => prev.map(s => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: s.messages.map(m => m.id === replyId ? { ...m, text: errMsg, isThinking: false, isError: !isAbort } : m)
          }
        }
        return s
      }))
    } finally {
      setIsSending(false)
    }
  }

  const handleTestConnection = async (): Promise<void> => {
    setTestStatus('testing')
    try {
      const result = await window.api.callLLM(llmConfig, [{ role: 'user', content: 'Say "Success" in exactly one word.' }])
      setTestStatus(`连接成功! 答复: "${result.trim()}"`)
    } catch (e: any) {
      setTestStatus(`连接失败: ${e.message || e}`)
    }
  }

  const handleSkillsPathClick = async (): Promise<void> => {
    try {
      const path = await window.api.selectDirectory({ title: '选择技能存放目录' })
      if (path) {
        const savedPath = await window.api.setStoragePath(path)
        showToast(`技能存放路径已成功更改为：${savedPath || '默认UserData'}`, 'success')
        await refreshSkillsAndStorage()
      }
    } catch (e: any) {
      showToast(`更改技能路径失败：${e.message || e}`, 'error')
    }
  }

  const handleImportSkill = async (): Promise<void> => {
    try {
      const list = await window.api.uploadSkillPack()
      if (list && list.length > 0) setSkillsList(list)
    } catch (e) { console.error(e) }
  }

  const handleDeleteSkill = async (name: string): Promise<void> => {
    try {
      const list = await window.api.deleteSkill(name)
      setSkillsList(list)
    } catch (e) { console.error(e) }
  }

  const handleSaveStoragePath = async (): Promise<void> => {
    setStorageSaveStatus({ type: 'idle', message: '' })
    try {
      const savedPath = await window.api.setStoragePath(storageInputPath)
      setStorageSaveStatus({ type: 'success', message: `存储路径保存成功！已创建目录：${savedPath || '默认UserData'}` })
      showToast('存储路径保存成功！已自动迁移文件。', 'success')
      await refreshSkillsAndStorage()
    } catch (e: any) {
      setStorageSaveStatus({ type: 'failed', message: `存储路径修改失败：${e.message || e}` })
      showToast(`存储路径修改失败：${e.message || e}`, 'error')
    }
  }

  const handleToggleSandboxMode = async (enabled: boolean): Promise<void> => {
    try {
      const actual = await window.api.setSandboxMode(enabled)
      setSandboxMode(actual)
      showToast(`安全沙盒模式已${actual ? '开启' : '关闭'}`, 'success')
    } catch (e: any) {
      showToast(`保存沙盒配置失败: ${e.message || e}`, 'error')
    }
  }

  const handleRespondPermission = (approved: boolean): void => {
    if (activePermissionRequest) {
      window.api.respondPermission(activePermissionRequest.requestId, approved)
      setActivePermissionRequest(null)
    }
  }

  const handleAbortLlm = async (): Promise<void> => {
    try {
      await window.api.abortLlm()
      setIsSending(false)
      // 在中断时，立刻将当前处于正在思考（loading）的消息的状态更新为“已终止任务”并隐藏 loading 动画
      setSessions(prev => prev.map(s => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: s.messages.map(m => m.isThinking ? { ...m, text: '⚠️ 对话生成已被手动终止。', isThinking: false } : m)
          }
        }
        return s
      }))
      showToast('已中断大模型生成', 'info')
    } catch (e: any) {
      console.error(e)
      showToast(`中断失败: ${e.message || e}`, 'error')
    }
  }

  const handleToggleCronTask = async (id: string): Promise<void> => {
    const updated = cronTasks.map(t => t.id === id ? { ...t, isActive: !t.isActive } : t)
    setCronTasks(updated)
    localStorage.setItem('agentpet_cron_tasks', JSON.stringify(updated))
    await window.api.saveCronTasks(updated)
  }

  const handleDeleteCronTask = async (id: string): Promise<void> => {
    const updated = cronTasks.filter(t => t.id !== id)
    setCronTasks(updated)
    localStorage.setItem('agentpet_cron_tasks', JSON.stringify(updated))
    await window.api.saveCronTasks(updated)
  }

  const handleClearCronLogs = async (id: string): Promise<void> => {
    const updated = cronTasks.map(t => t.id === id ? { ...t, logs: [] } : t)
    setCronTasks(updated)
    localStorage.setItem('agentpet_cron_tasks', JSON.stringify(updated))
    await window.api.saveCronTasks(updated)
    showToast('定时任务日志已清空', 'success')
  }

  const handleClearTokenLogs = (): void => {
    setTokenLogs([])
    localStorage.removeItem('agentpet_token_logs')
    showToast('已清空 Token 消耗日志', 'success')
  }

  // ── Derived State ─────────────────────────────────────────────
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0] || {
    id: 'agent:main:dashboard:default',
    name: 'agent:main:dashboard:default',
    time: '',
    messages: []
  }
  const activeSessMessages = activeSession.messages || []

  // ── Cron Timer Loop & Backend Executor (Moved here to avoid TDZ) ──
  // Cron timer loop
  const elapsedTimesRef = useRef<Record<string, number>>({})
  
  const runTaskBackend = async (taskToRun: CronTask, tempSessionId: string, logId: string) => {
    try {
      const skillsContext = skillsList.length > 0
        ? `你当前已配备并激活的专属技能扩展模块有：[${skillsList.map(s => s.name).join(', ')}]。`
        : '你当前尚未安装配备任何第三方扩展技能。'
      const stylePrompt = currentAvatarStyle === 'cute' 
        ? '你需要使用可爱、萌系、活泼的语气与主人（用户）对话。'
        : '你需要使用专业、友好、自然的语气与主人（用户）对话。'

      const systemPrompt = `你是一只名为 ${currentAvatarName} 的桌面智能助理宠物（智能体）。
你正在后台为主人自动执行定时任务。为了保证安全和速度，请直接进行动作的执行（不需要过多客套、寒暄语），回答中要保留与设定相符的语气（${stylePrompt}），并在执行完后给出简明扼要的执行结果。
${skillsContext}
在开发任务中，你可以通过调用本地系统工具来读写主人工作空间下的文件，以及执行终端控制台命令（通过 run_terminal_command）以直接操控本地电脑来协助主人。请明智、安全地使用它们。`
      
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `执行定时任务指令: ${taskToRun.action || '无'}` }
      ]

      const response = await window.api.callLLM(
        {
          ...llmConfig,
          sessionId: tempSessionId,
          messageId: Date.now()
        },
        chatMessages,
        workspacePath
      )

      const runningLog = cronRunningLogsRef.current[tempSessionId]
      if (runningLog) {
        runningLog.status = 'success'
        runningLog.message = `定时任务 [${taskToRun.name}] 执行完成。`
        if (runningLog.messages) {
          runningLog.messages = runningLog.messages.map(m => 
            m.sender === 'agent' ? { ...m, text: response, isThinking: false } : m
          )
        }
        delete cronRunningLogsRef.current[tempSessionId]

        setCronTasks(prevTasks => {
          const nextTasks = prevTasks.map(t => {
            if (t.id === taskToRun.id) {
              const updatedLogs = (t.logs || []).map(l => l.id === logId ? { ...runningLog } : l)
              return { ...t, logs: updatedLogs }
            }
            return t
          })
          localStorage.setItem('agentpet_cron_tasks', JSON.stringify(nextTasks))
          window.api.saveCronTasks(nextTasks)
          return nextTasks
        })

        // 触发系统托盘通知与桌面挂件气泡
        window.api.showBubble(`任务 [${taskToRun.name}] 执行成功！`, response, taskToRun.id, logId)

        // 在 Chat 会话中添加简化的完成提醒
        const successTimeStr = formatDateTime()
        const successTimeOnly = successTimeStr.split(' ')[1] || successTimeStr
        setSessions(prevSessions => {
          const updated = prevSessions.map(session => {
            if (session.id === activeSessionId) {
              return {
                ...session,
                messages: [...session.messages, {
                  id: Date.now() + Math.random(),
                  sender: 'system',
                  text: `${successTimeOnly} - 完成【${taskToRun.name}】任务`,
                  time: successTimeStr
                }]
              }
            }
            return session
          })
          if (autoSaveHistory) localStorage.setItem('agentpet_sessions', JSON.stringify(updated))
          return updated
        })
      }
    } catch (err: any) {
      console.error('后台执行定时任务出错', err)
      const runningLog = cronRunningLogsRef.current[tempSessionId]
      if (runningLog) {
        runningLog.status = 'failed'
        runningLog.message = `定时任务 [${taskToRun.name}] 执行失败：${err.message || err}`
        if (runningLog.messages) {
          runningLog.messages = runningLog.messages.map(m => 
            m.sender === 'agent' ? { ...m, text: `⚠️ 执行过程中出现错误：${err.message || err}`, isThinking: false, isError: true } : m
          )
        }
        delete cronRunningLogsRef.current[tempSessionId]

        setCronTasks(prevTasks => {
          const nextTasks = prevTasks.map(t => {
            if (t.id === taskToRun.id) {
              const updatedLogs = (t.logs || []).map(l => l.id === logId ? { ...runningLog } : l)
              return { ...t, logs: updatedLogs }
            }
            return t
          })
          localStorage.setItem('agentpet_cron_tasks', JSON.stringify(nextTasks))
          window.api.saveCronTasks(nextTasks)
          return nextTasks
        })

        window.api.showBubble(`任务 [${taskToRun.name}] 执行失败。`, err.message || err, taskToRun.id, logId)

        // 在 Chat 会话中添加简化的失败提醒
        const failTimeStr = formatDateTime()
        const failTimeOnly = failTimeStr.split(' ')[1] || failTimeStr
        setSessions(prevSessions => {
          const updated = prevSessions.map(session => {
            if (session.id === activeSessionId) {
              return {
                ...session,
                messages: [...session.messages, {
                  id: Date.now() + Math.random(),
                  sender: 'system',
                  text: `${failTimeOnly} - 【${taskToRun.name}】任务执行失败`,
                  time: failTimeStr
                }]
              }
            }
            return session
          })
          if (autoSaveHistory) localStorage.setItem('agentpet_sessions', JSON.stringify(updated))
          return updated
        })
      }
    }
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setCronTasks(prevTasks => {
        let changed = false
        const nextTasks = prevTasks.map(task => {
          if (!task.isActive) return task
          const currentElapsed = (elapsedTimesRef.current[task.id] || 0) + 1
          if (currentElapsed >= task.interval) {
            changed = true
            elapsedTimesRef.current[task.id] = 0
            const timeStr = formatDateTime()
            const tempSessionId = `cron:${task.id}:${Date.now()}`
            
            // 写入日志
            const newLog: CronLog = {
              id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              time: timeStr,
              status: 'running',
              message: `定时任务 [${task.name}] 触发。正在后台执行...`,
              messages: [
                {
                  id: `user-${Date.now()}`,
                  sender: 'user',
                  text: `执行定时任务指令: ${task.action || '无'}`,
                  time: timeStr
                },
                {
                  id: `agent-${Date.now()}`,
                  sender: 'agent',
                  text: '',
                  isThinking: true,
                  toolSteps: [],
                  time: timeStr
                }
              ]
            }
            cronRunningLogsRef.current[tempSessionId] = newLog
            const logs = [newLog, ...(task.logs || [])].slice(0, 100)

            // 异步触发后台大模型执行
            runTaskBackend(task, tempSessionId, newLog.id)

            return { ...task, triggerCount: task.triggerCount + 1, lastTriggered: timeStr, logs }
          } else {
            elapsedTimesRef.current[task.id] = currentElapsed
            return task
          }
        })
        if (changed) {
          localStorage.setItem('agentpet_cron_tasks', JSON.stringify(nextTasks))
          window.api.saveCronTasks(nextTasks)
        }
        return nextTasks
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [activeSessionId, autoSaveHistory, skillsList, currentAvatarName, llmConfig, workspacePath])

  return {
    // navigation
    activeTab, setActiveTab,
    agentSubTab, setAgentSubTab,
    settingsSubTab, setSettingsSubTab,
    // ui
    isCollapsed, setIsCollapsed,
    showApiKey, setShowApiKey,
    showModelDropdown, setShowModelDropdown,
    isLoadingModels,
    availableModels,
    dropdownRef,
    // toast
    toast, showToast,
    // theme
    theme, handleThemeToggle,
    // llm
    llmConfig, saveLlmConfig,
    handleFetchModels, handleTestConnection,
    testStatus,
    // cron
    cronTasks,
    handleToggleCronTask, handleDeleteCronTask, handleClearCronLogs,
    selectedTaskForLog, setSelectedTaskForLog,
    selectedCronLogDetails, setSelectedCronLogDetails,
    // sessions
    sessions, setSessions,
    activeSessionId, setActiveSessionId,
    activeSession, activeSessMessages,
    inputValue, setInputValue,
    isSending,
    chatEndRef,
    handleCreateNewSession, handleDeleteSession, handleSendChat,
    // workspace & attached file
    workspacePath, setWorkspacePath, handleSelectWorkspace, handleClearWorkspace,
    attachedFiles, setAttachedFiles, handlePasteFiles, handleUploadFile,
    // system
    systemInfo,
    // skills
    skillsList,
    skillsPath,
    handleSkillsPathClick, handleImportSkill, handleDeleteSkill,
    // storage
    storageInputPath, setStorageInputPath,
    actualStoragePath,
    storageSaveStatus,
    handleSaveStoragePath,
    // avatar
    customModelDir, setCustomModelDir,
    customModelFile, setCustomModelFile,
    avatarList,
    currentAvatarName,
    refreshAvatarsList,
    // memory
    autoSaveHistory, setAutoSaveHistory,
    contextRounds, setContextRounds,
    // models default
    DEFAULT_MODELS,
    // token logs
    tokenLogs, setTokenLogs,
    handleClearTokenLogs,
    // highlighted message
    highlightedMessageId, setHighlightedMessageId,
    // sandbox
    sandboxMode,
    handleToggleSandboxMode,
    activePermissionRequest,
    handleRespondPermission,
    handleAbortLlm,
    // mcp
    mcpConfig,
    saveMcpConfig,
    // session switch
    isSessionSwitching
  }
}

export type AppStore = ReturnType<typeof useAppStore>

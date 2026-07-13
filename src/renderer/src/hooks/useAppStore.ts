import { useState, useRef, useEffect, useCallback } from 'react'
import { create } from 'zustand'
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
  isSystem?: boolean
}

export interface Session {
  id: string
  name: string
  time: string
  messages: any[]
  pinned?: boolean
  contextSummary?: string
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

export type TabType = 'chat' | 'control' | 'agent' | 'settings' | 'logs' | 'rpa'
export type AgentSubTab = 'skills' | 'memory' | 'cron' | 'mcp'
export type SettingsSubTab = 'keys' | 'storage' | 'avatar'

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

// ── Zustand Global Store ─────────────────────────────────────
export const useAppStoreRaw = create<any>((set) => ({
  activeTab: 'chat',
  agentSubTab: 'skills',
  settingsSubTab: 'keys',
  isCollapsed: false,
  showApiKey: false,
  showApiKeyModal: false,
  showModelDropdown: false,
  isLoadingModels: false,
  availableModels: [],
  toast: null,
  selectedTaskForLog: null,
  selectedCronLogDetails: null,
  pendingOpenTaskId: null,
  pendingOpenLogId: null,
  theme: localStorage.getItem('agentself_theme') || localStorage.getItem('agentpet_theme') || 'light',
  sendingSessionIds: {},
  llmConfig: (() => {
    const saved = localStorage.getItem('agentself_llm_config') || localStorage.getItem('agentpet_llm_config')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed && parsed.maxTokens === 2048) {
          delete parsed.maxTokens
        }
        return parsed
      } catch (e) { console.error(e) }
    }
    return { provider: 'gemini', apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', temperature: 0.7, maxTokens: undefined }
  })(),
  mcpConfig: (() => {
    const saved = localStorage.getItem('agentpet_mcp_config')
    let currentConfig: any = null
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (parsed && Array.isArray(parsed.servers)) {
          currentConfig = parsed
        } else if (parsed && parsed.url) {
          currentConfig = {
            servers: [
              {
                id: 'legacy-default',
                name: parsed.name || '默认外部服务',
                url: parsed.url,
                apiKey: parsed.apiKey || '',
                enabled: parsed.enabled ?? false
              }
            ]
          }
        }
      } catch (e) { console.error(e) }
    }
    if (!currentConfig || !currentConfig.servers) {
      currentConfig = { servers: [] }
    }
    return currentConfig
  })(),
  cronTasks: [],
  sessions: [],
  activeSessionId: localStorage.getItem('agentself_active_session_id') || localStorage.getItem('agentpet_active_session_id') || 'agent:main:dashboard:default',
  inputValue: '',
  systemInfo: null,
  tokenLogs: (() => {
    const saved = localStorage.getItem('agentself_token_logs') || localStorage.getItem('agentpet_token_logs')
    if (saved) {
      try { return JSON.parse(saved) } catch (e) { console.error(e) }
    }
    return []
  })(),
  highlightedMessageId: null,
  generatedFiles: [],
  showFilePanel: false,
  openTabs: [],
  previewFile: null,
  previewLoading: false,
  skillsList: [],
  skillsPath: '',
  disabledSkillNames: (() => {
    try {
      const saved = localStorage.getItem('agentpet_disabled_skills')
      return saved ? JSON.parse(saved) : []
    } catch (e) { return [] }
  })(),
  activeMcpServers: [],
  storageInputPath: '',
  actualStoragePath: '',
  storageSaveStatus: { type: 'idle', message: '' },
  sandboxMode: true,
  activePermissionRequest: null,
  executionDevice: 'local',
  sshConnected: false,
  sshHost: '',
  sshUsername: '',
  customModelDir: '',
  customModelFile: '',
  avatarList: [],
  ttsEnabled: localStorage.getItem('agentpet_tts_enabled') === 'true',
  autoSaveHistory: (() => {
    const val = localStorage.getItem('agentself_autosave') || localStorage.getItem('agentpet_autosave')
    return val === null ? true : val === 'true'
  })(),
  contextRounds: Number(localStorage.getItem('agentself_context_rounds') || localStorage.getItem('agentpet_context_rounds') || '10'),
  testStatus: 'idle',
  isSessionSwitching: false,
  isSessionsInitialized: false,

  // Setters
  setActiveTab: (val: any) => set({ activeTab: val }),
  setAgentSubTab: (val: any) => set({ agentSubTab: val }),
  setSettingsSubTab: (val: any) => set({ settingsSubTab: val }),
  setIsCollapsed: (val: any) => set({ isCollapsed: val }),
  setShowApiKey: (val: any) => set({ showApiKey: val }),
  setShowApiKeyModal: (val: any) => set({ showApiKeyModal: val }),
  setShowModelDropdown: (val: any) => set({ showModelDropdown: val }),
  setIsLoadingModels: (val: any) => set({ isLoadingModels: val }),
  setAvailableModels: (val: any) => set({ availableModels: val }),
  setToast: (val: any) => set({ toast: val }),
  setSelectedTaskForLog: (val: any) => set({ selectedTaskForLog: val }),
  setSelectedCronLogDetails: (val: any) => set({ selectedCronLogDetails: val }),
  setPendingOpenTaskId: (val: any) => set({ pendingOpenTaskId: val }),
  setPendingOpenLogId: (val: any) => set({ pendingOpenLogId: val }),
  setTheme: (val: any) => set({ theme: val }),
  setSendingSessionIds: (val: any) => set((state: any) => ({
    sendingSessionIds: typeof val === 'function' ? val(state.sendingSessionIds) : val
  })),
  setLlmConfig: (val: any) => set({ llmConfig: val }),
  setMcpConfig: (val: any) => set({ mcpConfig: val }),
  setCronTasks: (val: any) => set((state: any) => ({
    cronTasks: typeof val === 'function' ? val(state.cronTasks) : val
  })),
  setSessions: (val: any) => set((state: any) => ({
    sessions: typeof val === 'function' ? val(state.sessions) : val
  })),
  setActiveSessionId: (val: any) => set({ activeSessionId: val }),
  setInputValue: (val: any) => set((state: any) => ({
    inputValue: typeof val === 'function' ? val(state.inputValue) : val
  })),
  setSystemInfo: (val: any) => set({ systemInfo: val }),
  setTokenLogs: (val: any) => set((state: any) => ({
    tokenLogs: typeof val === 'function' ? val(state.tokenLogs) : val
  })),
  setHighlightedMessageId: (val: any) => set({ highlightedMessageId: val }),
  setGeneratedFiles: (val: any) => set((state: any) => ({
    generatedFiles: typeof val === 'function' ? val(state.generatedFiles) : val
  })),
  setShowFilePanel: (val: any) => set({ showFilePanel: val }),
  setOpenTabs: (val: any) => set((state: any) => ({
    openTabs: typeof val === 'function' ? val(state.openTabs) : val
  })),
  setPreviewFile: (val: any) => set({ previewFile: val }),
  setPreviewLoading: (val: any) => set({ previewLoading: val }),
  setSkillsList: (val: any) => set({ skillsList: val }),
  setSkillsPath: (val: any) => set({ skillsPath: val }),
  setDisabledSkillNames: (val: any) => set((state: any) => ({
    disabledSkillNames: typeof val === 'function' ? val(state.disabledSkillNames) : val
  })),
  setActiveMcpServers: (val: any) => set({ activeMcpServers: val }),
  setStorageInputPath: (val: any) => set({ storageInputPath: val }),
  setActualStoragePath: (val: any) => set({ actualStoragePath: val }),
  setStorageSaveStatus: (val: any) => set({ storageSaveStatus: val }),
  setSandboxMode: (val: any) => set({ sandboxMode: val }),
  setActivePermissionRequest: (val: any) => set({ activePermissionRequest: val }),
  setExecutionDeviceState: (val: any) => set({ executionDevice: val }),
  setSshConnected: (val: any) => set({ sshConnected: val }),
  setSshHost: (val: any) => set({ sshHost: val }),
  setSshUsername: (val: any) => set({ sshUsername: val }),
  setCustomModelDir: (val: any) => set({ customModelDir: val }),
  setCustomModelFile: (val: any) => set({ customModelFile: val }),
  setAvatarList: (val: any) => set({ avatarList: val }),
  setTtsEnabled: (val: any) => set({ ttsEnabled: val }),
  setAutoSaveHistory: (val: any) => set({ autoSaveHistory: val }),
  setContextRounds: (val: any) => set({ contextRounds: val }),
  setTestStatus: (val: any) => set({ testStatus: val }),
  setIsSessionSwitching: (val: any) => set({ isSessionSwitching: val }),
  setIsSessionsInitialized: (val: any) => set({ isSessionsInitialized: val }),
}))

// ── useAppStore hook ─────────────────────────────────────────
export function useAppStore() {
  const store = useAppStoreRaw()

  const {
    activeTab, setActiveTab,
    agentSubTab, setAgentSubTab,
    settingsSubTab, setSettingsSubTab,
    isCollapsed, setIsCollapsed,
    showApiKey, setShowApiKey,
    showApiKeyModal, setShowApiKeyModal,
    showModelDropdown, setShowModelDropdown,
    isLoadingModels, setIsLoadingModels,
    availableModels, setAvailableModels,
    toast, setToast,
    selectedTaskForLog, setSelectedTaskForLog,
    selectedCronLogDetails, setSelectedCronLogDetails,
    pendingOpenTaskId, setPendingOpenTaskId,
    pendingOpenLogId, setPendingOpenLogId,
    theme, setTheme,
    sendingSessionIds, setSendingSessionIds,
    llmConfig, setLlmConfig,
    mcpConfig, setMcpConfig,
    cronTasks, setCronTasks,
    sessions, setSessions,
    activeSessionId, setActiveSessionId,
    inputValue, setInputValue,
    systemInfo, setSystemInfo,
    tokenLogs, setTokenLogs,
    highlightedMessageId, setHighlightedMessageId,
    generatedFiles, setGeneratedFiles,
    showFilePanel, setShowFilePanel,
    openTabs, setOpenTabs,
    previewFile, setPreviewFile,
    previewLoading, setPreviewLoading,
    skillsList, setSkillsList,
    skillsPath, setSkillsPath,
    disabledSkillNames, setDisabledSkillNames,
    activeMcpServers, setActiveMcpServers,
    storageInputPath, setStorageInputPath,
    actualStoragePath, setActualStoragePath,
    storageSaveStatus, setStorageSaveStatus,
    sandboxMode, setSandboxMode,
    activePermissionRequest, setActivePermissionRequest,
    executionDevice, setExecutionDeviceState,
    sshConnected, setSshConnected,
    sshHost, setSshHost,
    sshUsername, setSshUsername,
    customModelDir, setCustomModelDir,
    customModelFile, setCustomModelFile,
    avatarList, setAvatarList,
    ttsEnabled, setTtsEnabled,
    autoSaveHistory, setAutoSaveHistory,
    contextRounds, setContextRounds,
    testStatus, setTestStatus,
    isSessionSwitching, setIsSessionSwitching,
    isSessionsInitialized, setIsSessionsInitialized
  } = store

  const dropdownRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const cronRunningLogsRef = useRef<Record<string, CronLog>>({})

  const activeAvatar = avatarList.find(a => (customModelDir ? a.dir === customModelDir : a.isDefault))
  const currentAvatarName = activeAvatar ? activeAvatar.name : (customModelFile ? customModelFile.replace(/\.model3\.json$/i, '') : 'Mao')
  const currentAvatarStyle = activeAvatar?.languageStyle || 'normal'
  const currentAvatarVoice = activeAvatar?.voice || 'zh-CN-XiaoxiaoNeural'

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

  const saveMcpConfig = (newConfig: any) => {
    setMcpConfig(newConfig)
    localStorage.setItem('agentpet_mcp_config', JSON.stringify(newConfig))
    window.api.syncMcpConfig(newConfig)
      .then(() => {
        refreshMcpServers()
      })
      .catch(console.error)
  }

  const loadGeneratedFiles = useCallback(async () => {
    if (window.api?.getGeneratedFiles) {
      const files = await window.api.getGeneratedFiles(activeSessionId)
      setGeneratedFiles(files)
    }
  }, [activeSessionId])

  const handlePreviewFile = useCallback(async (f: { name: string; path: string; size: number }) => {
    setPreviewFile(f)
    setOpenTabs(prev => {
      if (prev.some(t => t.path === f.path)) return prev
      const fullFile = generatedFiles.find(g => g.path === f.path)
      return [...prev, fullFile || { ...f, time: '' }]
    })
  }, [generatedFiles])

  const handleDeleteFile = useCallback(async (f: { path: string }) => {
    await window.api.deleteGeneratedFile(f.path, activeSessionId)
    loadGeneratedFiles()
    const remaining = openTabs.filter(t => t.path !== f.path)
    setOpenTabs(remaining)
    if (previewFile?.path === f.path) {
      if (remaining.length === 0) {
        setPreviewFile(null)
      } else {
        const next = remaining[remaining.length - 1]
        handlePreviewFile(next)
      }
    }
  }, [activeSessionId, openTabs, previewFile, loadGeneratedFiles, handlePreviewFile])

  // ── 打字机流式效果控制 ──────────────────────────────────────────
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isTypingRef = useRef<boolean>(false)
  const abortedReplyIdsRef = useRef<Set<number>>(new Set())

  // 卸载时清理定时器，防止内存泄漏
  useEffect(() => {
    return () => {
      isTypingRef.current = false
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current)
      }
    }
  }, [])

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

  const handleThemeToggle = (): void => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(nextTheme)
    localStorage.setItem('agentself_theme', nextTheme)
    localStorage.setItem('agentpet_theme', nextTheme)
  }

  const isSending = !!sendingSessionIds[activeSessionId]

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

  // 校验 API Key 初始化，如果没有有效的 key，就弹出需要配置 key
  useEffect(() => {
    const isOllama = llmConfig.provider === 'ollama'
    const hasKey = isOllama || !!llmConfig.apiKey
    if (!hasKey) {
      setShowApiKeyModal(true)
    }
  }, [llmConfig.provider, llmConfig.apiKey])

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
      setActualStoragePath(customPath || path.replace(/[\\/]skills$/, ''))
      setStorageInputPath(customPath)
    } catch (e) { console.error(e) }
  }

  const refreshMcpServers = async (): Promise<void> => {
    try {
      const servers = await window.api.getActiveMcpServers()
      setActiveMcpServers(servers)
    } catch (e) {
      console.error('获取可用 MCP 服务列表失败:', e)
    }
  }

  const toggleSkillEnable = (name: string): void => {
    setDisabledSkillNames(prev => {
      const next = prev.includes(name)
        ? prev.filter(n => n !== name)
        : [...prev, name]
      localStorage.setItem('agentpet_disabled_skills', JSON.stringify(next))
      return next
    })
  }

  const refreshAvatarsList = async (): Promise<void> => {
    try {
      const list = await window.api.getAvatarsList()
      setAvatarList(list)
    } catch (e) { console.error(e) }
  }

  useEffect(() => {
    refreshSkillsAndStorage()
    refreshMcpServers()
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

  const refreshSessions = async (clearThinking = false): Promise<void> => {
    try {
      const localSess = await window.api.getLocalSessions()
      if (localSess && localSess.length > 0) {
        if (clearThinking) {
          // 检查 PetWidget 的 LLM 是否正在工作（30 秒内有活动则不清除）
          const llmThinkingAt = localStorage.getItem('agentpet_llm_thinking_at')
          const isLlmActive = llmThinkingAt && (Date.now() - Number(llmThinkingAt) < 30000)

          let cleanedMessagesToSave: { msg: any, sessionId: string }[] = []
          const cleaned = localSess.map((s: any) => ({
            ...s,
            messages: (s.messages || []).map((m: any) => {
              if (m.isThinking && !isLlmActive) {
                const cleanedMsg = { ...m, isThinking: false, text: m.text || '⚠️ 应用异常退出，对话生成被中断。' }
                cleanedMessagesToSave.push({ msg: cleanedMsg, sessionId: s.id })
                return cleanedMsg
              }
              return m
            })
          }))
          setSessions(cleaned)
          cleanedMessagesToSave.forEach(item => {
            window.api.saveMessage({ ...item.msg, sessionId: item.sessionId }).catch(console.error)
          })

          // 重新打开应用时，默认选择最近活跃的非置顶会话（若无非置顶会话，则选择最新的置顶会话）
          if (cleaned.length > 0) {
            const unpinned = cleaned.filter((s: any) => !s.pinned && !s.id.startsWith('wechat:'))
            let latestSess: any = null
            if (unpinned.length > 0) {
              latestSess = unpinned[0]
              for (let i = 1; i < unpinned.length; i++) {
                if (unpinned[i].time && (!latestSess.time || unpinned[i].time > latestSess.time)) {
                  latestSess = unpinned[i]
                }
              }
            } else {
              latestSess = cleaned[0]
              for (let i = 1; i < cleaned.length; i++) {
                if (cleaned[i].time && (!latestSess.time || cleaned[i].time > latestSess.time)) {
                  latestSess = cleaned[i]
                }
              }
            }
            if (latestSess) {
              setActiveSessionId(latestSess.id)
            }
          }
        } else {
          setSessions(localSess)
        }
      }
    } catch (e) {
      console.error('从本地文件载入会话记录失败', e)
    } finally {
      setIsSessionsInitialized(true)
    }
  }

  // 同步初始化大模型与 MCP 配置
  useEffect(() => {
    window.api.syncLlmConfig(llmConfig).catch(console.error)
    window.api.syncMcpConfig(mcpConfig).catch(console.error)
  }, [])

  // 监听微信聊天会话更新通知
  useEffect(() => {
    if (!window.api.onWechatSessionUpdated) return
    const unsubscribe = window.api.onWechatSessionUpdated((sessionId?: string) => {
      refreshSessions().then(() => {
        if (sessionId) {
          setActiveTab('chat')
          setActiveSessionId(sessionId)
          setTimeout(() => {
            chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
          }, 100)
        }
      })
    })
    return () => unsubscribe()
  }, [])

  // 处理从快捷输入框传递过来的待发送内容（文件路径或文本）
  const handlePendingInput = useCallback(async (raw: string) => {
    if (!raw) return
    setActiveTab('chat')

    // 尝试解析 JSON 格式（带文件附件）
    try {
      const payload = JSON.parse(raw)
      // 单个文件（剪贴板图片）
      if (payload.type === 'file' && payload.path && payload.name) {
        if (window.api.attachFileFromPath) {
          const result = await window.api.attachFileFromPath(payload.path, activeSessionId)
          if (result) {
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']
            const ext = result.name.split('.').pop()?.toLowerCase() || ''
            const objectUrl = imageExts.includes(ext) ? `local-file:///${result.path.replace(/\\/g, '/')}` : undefined
            setAttachedFiles(prev => [...prev, {
              name: result.name,
              path: result.path,
              safeName: result.safeName,
              objectUrl,
              content: result.content
            }])
          }
        }
        return
      }
      // 多个文件 + 文本
      if (payload.files || payload.text) {
        if (payload.files && Array.isArray(payload.files) && window.api.attachFileFromPath) {
          for (const f of payload.files) {
            const result = await window.api.attachFileFromPath(f.path, activeSessionId)
            if (result) {
              const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']
              const ext = result.name.split('.').pop()?.toLowerCase() || ''
              const objectUrl = imageExts.includes(ext) ? `local-file:///${result.path.replace(/\\/g, '/')}` : undefined
              setAttachedFiles(prev => [...prev, {
                name: result.name,
                path: result.path,
                safeName: result.safeName,
                objectUrl,
                content: result.content
              }])
            }
          }
        }
        if (payload.text) {
          setInputValue(prev => prev ? prev + payload.text : payload.text)
        }
        return
      }
    } catch {
      // 非 JSON，按纯文本处理
    }

    // 纯文本
    setInputValue(raw)
  }, [activeSessionId])

  // 监听快捷输入框粘贴文件后传递过来的待发送内容
  useEffect(() => {
    if (!window.api.onPendingInput) return
    const unsubscribe = window.api.onPendingInput((text: string) => {
      handlePendingInput(text)
    })
    return () => unsubscribe()
  }, [handlePendingInput])

  // 初始化时主动拉取一次缓存的待发送内容（处理窗口刚创建、IPC 监听尚未就绪的时序问题）
  useEffect(() => {
    if (!window.api.getPendingInput) return
    window.api.getPendingInput().then((text: string) => {
      if (text) handlePendingInput(text)
    }).catch(() => {})
  }, [handlePendingInput])

  const prevWechatStatusRef = useRef<string | null>(null)

  // 微信 Bot 链接成功时，把当前会话置顶，方便在最近会话列表顶部快速找到
  useEffect(() => {
    if (!window.api.onWechatStatusUpdated) return
    const unsubscribe = window.api.onWechatStatusUpdated((data: any) => {
      const status = data?.status || 'disconnected'
      const prevStatus = prevWechatStatusRef.current
      prevWechatStatusRef.current = status

      // 仅当微信连接状态从非 connected 变更为 connected，且当前会话是微信会话时，才把当前会话置顶
      if (status === 'connected' && prevStatus !== null && prevStatus !== 'connected' && activeSessionId.startsWith('wechat:')) {
        setSessions(prev => {
          const target = prev.find(s => s.id === activeSessionId)
          if (!target || target.pinned) return prev
          const toggled = { ...target, pinned: true }
          const rest = prev.filter(s => s.id !== activeSessionId)
          const pinnedRest = rest.filter(s => s.pinned)
          const unpinnedRest = rest.filter(s => !s.pinned)
          return [...pinnedRest, toggled, ...unpinnedRest]
        })
      }
    })
    return () => unsubscribe()
  }, [activeSessionId])

  // Load sessions from local file
  useEffect(() => {
    refreshSessions(true)
  }, [])

  const prevSessionIdRef = useRef<string | null>(null)
  const prevActiveTabRef = useRef<string | null>(null)
  const justSwitchedRef = useRef(false)

  // 统一的骨架屏触发函数
  const triggerChatSkeleton = useCallback(() => {
    setIsSessionSwitching(true)

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

    return skeletonTimer
  }, [chatEndRef])

  // 1. 处理会话切换时的骨架屏和定位
  useEffect(() => {
    if (prevSessionIdRef.current !== activeSessionId) {
      prevSessionIdRef.current = activeSessionId
      // 仅在已经位于 chat 页面时由 session 变化触发骨架屏，
      // 避免与 tab 切换的骨架屏重复。
      if (activeTab === 'chat') {
        const timer = triggerChatSkeleton()
        return () => clearTimeout(timer)
      }
    }
    return undefined
  }, [activeSessionId, activeTab, triggerChatSkeleton])

  // 2. 处理从其他 tab 切换到 chat 页面时的骨架屏
  useEffect(() => {
    if (activeTab === 'chat' && prevActiveTabRef.current !== 'chat' && prevActiveTabRef.current !== null) {
      const timer = triggerChatSkeleton()
      prevActiveTabRef.current = activeTab
      return () => clearTimeout(timer)
    }
    prevActiveTabRef.current = activeTab
    return undefined
  }, [activeTab, triggerChatSkeleton])

  // 注：新消息到来时的外层滚动由 ChatPage.tsx 中监听 activeSessMessages.length 的 effect 负责，
  // 此处不再重复监听 sessions 整体变化（否则流式输出每帧都会触发 scrollIntoView 打断用户翻看历史）

  // 监听原子接口引发的数据修改通知（跨窗口或其它事件）
  useEffect(() => {
    if (!window.api.onSessionsUpdated) return
    const unsubscribe = window.api.onSessionsUpdated(() => {
      // 保持静默数据重新拉取以同步状态
      refreshSessions()
    })
    return () => unsubscribe()
  }, [])

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

  const handleDeleteSession = async (id: string): Promise<void> => {
    const filtered = sessions.filter(s => s.id !== id)
    let nextSessions = filtered
    if (filtered.length === 0) {
      const timeStr = formatDateTime()
      const defaultSess = {
        id: 'agent:main:dashboard:default',
        name: '(未命名)',
        time: timeStr,
        messages: []
      }
      nextSessions = [defaultSess]
      await window.api.createSession(defaultSess)
    }
    setSessions(nextSessions)
    if (activeSessionId === id) setActiveSessionId(nextSessions[0].id)
    await window.api.deleteSession(id)
  }

  // 切换会话置顶状态
  const handleTogglePinSession = async (id: string): Promise<void> => {
    let newPinned = false
    setSessions(prev => {
      const target = prev.find(s => s.id === id)
      if (!target) return prev
      newPinned = !target.pinned
      const toggled = { ...target, pinned: newPinned }
      const rest = prev.filter(s => s.id !== id)
      if (toggled.pinned) {
        const pinnedRest = rest.filter(s => s.pinned)
        const unpinnedRest = rest.filter(s => !s.pinned)
        return [...pinnedRest, toggled, ...unpinnedRest]
      }
      return [...rest, toggled]
    })
    await window.api.updateSession(id, { pinned: newPinned })
  }

  // 重命名会话
  const handleRenameSession = async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, name: trimmed } : s)))
    await window.api.updateSession(id, { name: trimmed })
  }

  const handleCreateNewSession = async (): Promise<void> => {
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
      messages: [],
      pinned: false
    }
    setSessions([...sessions, newSess])
    setActiveSessionId(newId)
    setAttachedFiles([])
    setInputValue('')
    setActiveTab('chat')
    await window.api.createSession(newSess)
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

    let pendingEvents: any[] = []
    let throttleTimeout: NodeJS.Timeout | null = null
    let saveTimeout: NodeJS.Timeout | null = null
    let latestMsgToSave: { msg: any; sessionId: string } | null = null

    const flushEvents = () => {
      if (pendingEvents.length === 0) return

      const eventsToProcess = [...pendingEvents]
      pendingEvents = []
      throttleTimeout = null

      const normalEvents = eventsToProcess.filter(e => !e.sessionId || !e.sessionId.startsWith('cron:'))
      const cronEvents = eventsToProcess.filter(e => e.sessionId && e.sessionId.startsWith('cron:'))

      // 1. 处理普通前台会话消息事件的合并更新
      if (normalEvents.length > 0) {
        setSessions(prev => {
          let updatedMsg: any = null
          const next = prev.map(s => {
            const sessEvents = normalEvents.filter(e => {
              const targetId = e.sessionId || activeSessionId
              return s.id === targetId
            })

            if (sessEvents.length === 0) return s

            const messages = [...s.messages]
            const latestAgentIdx = messages.map(m => m.sender).lastIndexOf('agent')
            if (latestAgentIdx !== -1) {
              const agentMsg = { ...messages[latestAgentIdx] }
              const toolSteps = agentMsg.toolSteps ? [...agentMsg.toolSteps] : []

              sessEvents.forEach(evt => {
                const { type, name, args, result, detail } = evt
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
                } else if (type === 'think') {
                  toolSteps.push({
                    id: `step-${Date.now()}-${Math.random()}`,
                    type: 'think',
                    name,
                    detail: detail
                  })
                }
              })

              agentMsg.toolSteps = toolSteps
              messages[latestAgentIdx] = agentMsg
              updatedMsg = { ...agentMsg, sessionId: s.id }
            }
            return { ...s, messages }
          })

          if (updatedMsg) {
            latestMsgToSave = updatedMsg
            if (saveTimeout) clearTimeout(saveTimeout)
            saveTimeout = setTimeout(() => {
              if (latestMsgToSave) {
                window.api.saveMessage(latestMsgToSave).catch(console.error)
              }
            }, 500)
          }

          return next
        })
      }

      // 2. 处理 Cron 定时后台任务的消息事件的合并更新
      if (cronEvents.length > 0) {
        const cronEventsBySession: Record<string, any[]> = {}
        cronEvents.forEach(e => {
          const sid = e.sessionId
          if (!cronEventsBySession[sid]) {
            cronEventsBySession[sid] = []
          }
          cronEventsBySession[sid].push(e)
        })

        const updatedTaskIds = new Set<string>()

        Object.entries(cronEventsBySession).forEach(([sid, evts]) => {
          const runningLog = cronRunningLogsRef.current[sid]
          if (runningLog && runningLog.messages) {
            const messages = [...runningLog.messages]
            const agentMsgIdx = messages.findIndex(m => m.sender === 'agent')
            if (agentMsgIdx !== -1) {
              const agentMsg = { ...messages[agentMsgIdx] }
              const toolSteps = agentMsg.toolSteps ? [...agentMsg.toolSteps] : []

              evts.forEach(evt => {
                const { type, name, args, result, detail } = evt
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
                } else if (type === 'think') {
                  toolSteps.push({
                    id: `step-${Date.now()}-${Math.random()}`,
                    type: 'think',
                    name,
                    detail: detail
                  })
                }
              })

              agentMsg.toolSteps = toolSteps
              messages[agentMsgIdx] = agentMsg
              runningLog.messages = messages

              const parts = sid.split(':')
              const taskId = parts[1]
              updatedTaskIds.add(taskId)
            }
          }
        })

        if (updatedTaskIds.size > 0) {
          setCronTasks(prevTasks => {
            return prevTasks.map(t => {
              if (updatedTaskIds.has(t.id)) {
                const updatedLogs = (t.logs || []).map(l => {
                  const matchedRunningLog = Object.values(cronRunningLogsRef.current).find(
                    rl => rl.id === l.id
                  )
                  return matchedRunningLog ? { ...matchedRunningLog } : l
                })
                return { ...t, logs: updatedLogs }
              }
              return t
            })
          })
        }
      }
    }

    const unsubscribe = window.api.onToolEvent((data: any) => {
      pendingEvents.push(data)
      if (!throttleTimeout) {
        throttleTimeout = setTimeout(flushEvents, 50)
      }
    })

    return () => {
      unsubscribe()
      if (throttleTimeout) clearTimeout(throttleTimeout)
      if (saveTimeout) clearTimeout(saveTimeout)
      if (pendingEvents.length > 0) {
        flushEvents()
      }
      if (latestMsgToSave) {
        window.api.saveMessage(latestMsgToSave).catch(console.error)
      }
    }
  }, [activeSessionId])

  // 打字机流式打印辅助函数
  // 打字机流式打印辅助函数 (已优化为瞬间渲染以保证桌宠 Live2D 60FPS 帧率并消除卡顿)
  const startTypingEffect = (replyId: number, fullText: string, sessionId: string) => {
    let savedMsg: any = null
    let wasAborted = false

    setSessions(prev => {
      const next = prev.map(s => {
        if (s.id === sessionId) {
          const messages = s.messages.map(m => {
            if (m.id === replyId) {
              // 检查该消息在此前是否已被手动终止
              if (abortedReplyIdsRef.current.has(replyId) || !m.isThinking || (m.text && (m.text.includes('手动终止') || m.text.includes('手动中断')))) {
                wasAborted = true
                return m
              }
              return { ...m, text: fullText, isThinking: false }
            }
            return m
          })
          const target = messages.find(m => m.id === replyId)
          if (target && !wasAborted) savedMsg = target
          return { ...s, messages }
        }
        return s
      })

      if (savedMsg) {
        window.api.saveMessage({ ...savedMsg, sessionId })
      }
      return next
    })

    isTypingRef.current = false
    setSendingSessionIds(prev => ({ ...prev, [sessionId]: false }))

    if (!wasAborted) {
      setTimeout(() => {
        setSessions(prev => {
          triggerSessionSummary(sessionId, prev)
          return prev
        })
      }, 500)
    }
    abortedReplyIdsRef.current.delete(replyId)
  }

  const handleSendChat = async (): Promise<void> => {
    if ((!inputValue.trim() && attachedFiles.length === 0) || isSending) return

    const isOllama = llmConfig.provider === 'ollama'
    const hasKey = isOllama || !!llmConfig.apiKey
    if (!hasKey) {
      setShowApiKeyModal(true)
      return
    }

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
        // 先清理上一次可能残留的 isThinking 状态（异常退出或工具调用失败时可能遗留）
        const cleanedMessages = s.messages.map(m => {
          if (m.isThinking) {
            const cleanedMsg = { ...m, isThinking: false, text: m.text || '⚠️ 对话生成被中断。' }
            window.api.saveMessage({ ...cleanedMsg, sessionId: activeSessionId }).catch(console.error)
            return cleanedMsg
          }
          return m
        })
        // 同步塞入用户消息和机器人的空白占位消息
        return { ...s, name, messages: [...cleanedMessages, userMsg, agentPlaceholderMsg] }
      }
      return s
    })
    
    setSessions(updatedSessions)
    setInputValue('')
    setAttachedFiles([]) // 发送后清空附件
    setSendingSessionIds(prev => ({ ...prev, [activeSessionId]: true }))

    // 增量落库会话标题变更和消息
    // ⚠️ 必须串行写入（先 userMsg → 再 agentPlaceholder），否则并行插入时
    // agentPlaceholder 可能先写入 DB，refreshSessions 读取后消息顺序颠倒
    // fire-and-forget：不 await，不阻塞 UI 响应
    const activeSess = updatedSessions.find(s => s.id === activeSessionId)
    ;(async () => {
      await window.api.saveMessage({ ...userMsg, sessionId: activeSessionId })
      await window.api.saveMessage({ ...agentPlaceholderMsg, sessionId: activeSessionId })
      if (activeSess) {
        await window.api.updateSession(activeSessionId, { name: activeSess.name })
      }
    })().catch(console.error)

    let typingStarted = false
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
          const needsPath = /\.(docx|xlsx|xls|csv|pdf)$/i.test(m.fileInfo.name || '')
          const pathNote = needsPath && m.fileInfo.path ? `\n[源文件路径: ${m.fileInfo.path}]` : ''
          textContent = `${m.text}\n\n--- [附带文件: ${m.fileInfo.name}]${pathNote}\n${m.fileInfo.content}`
        } else if (m.fileInfos && m.fileInfos.length > 0) {
          const attachmentsText = m.fileInfos.filter((f: any) => f.content).map((f: any) => {
            const needsPath = /\.(docx|xlsx|xls|csv|pdf)$/i.test(f.name || '')
            const pathNote = needsPath && f.path ? `\n[源文件路径: ${f.path}]` : ''
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

      // ── 并行获取所有上下文数据（替代原来的 5 个串行 await，节省数百ms）──
      const enabledSkillNamesList = skillsList
        .filter(s => !disabledSkillNames.includes(s.name))
        .map(s => s.name)

      const [
        profileContent,
        recallRes,
        skillsPromptText,
        activeMcpServers,
      ] = await Promise.all([
        window.api.getMemoryProfile().catch((err: any) => { console.error('获取人物画像失败:', err); return '' }),
        window.api.recallExperiences(text).catch((err: any) => { console.error('获取避坑经验失败:', err); return [] }),
        window.api.getActiveSkillsPrompt(enabledSkillNamesList).catch((err: any) => { console.error('获取已启用技能提示词失败:', err); return '' }),
        window.api.getActiveMcpServers().catch((err: any) => { console.error('获取可用 MCP 服务列表失败:', err); return [] }),
      ])

      let relevantExperiences: any[] = []
      let recallDebug: any = null
      if (recallRes && !Array.isArray(recallRes)) {
        relevantExperiences = (recallRes as any).results || []
        recallDebug = (recallRes as any).debug || null
      } else {
        relevantExperiences = Array.isArray(recallRes) ? recallRes : []
      }

      const memoryContext = `\n\n🧠 【长期人物画像与背景设定】\n${profileContent || '暂无详细人物画像。'}` +
        (relevantExperiences.length > 0
          ? `\n\n💡 【相关历史经验与避坑指南】\n${relevantExperiences.map((e: any, i: number) => {
              let itemText = `${i + 1}. ${e.fact}`
              if (e.relatedContent) {
                itemText += `\n   [关联的原始总结上下文]:\n   """\n   ${e.relatedContent.replace(/\n/g, '\n   ')}\n   """`
              } else if (e.absolutePath) {
                itemText += `\n   [对应原始归档文件路径，若需了解详情你可以使用 read_file 访问该路径]: ${e.absolutePath}`
              }
              return itemText
            }).join('\n')}`
          : '')

      const skillsContext = (skillsPromptText as string).trim()
        ? `你当前已配备、激活并载入了以下专属技能扩展规约，请严格遵守这些技能定义的规约与最佳实践：\n\n${skillsPromptText}`
        : '你当前尚未启用任何第三方扩展skill技能。'
      const stylePrompt = currentAvatarStyle === 'cute'
        ? '你需要使用可爱、萌系、活泼的语气与主人（用户）对话。'
        : '你需要使用专业、友好、自然的语气与主人（用户）对话。'

      const mcpContext = activeMcpServers.length > 0
        ? `\n\n🔗 此外，你已成功接入 MCP（Model Context Protocol）扩展服务：
${activeMcpServers.map((s: any, i: number) => `${i + 1}. ${s.name} — ${s.description || '外部 MCP 服务'} (包含 ${s.toolsCount} 个工具)`).join('\n')}
当主人的问题涉及上述 MCP 服务领域时，请务必主动调用对应的扩展工具来完成任务。`
        : ''

      const systemPrompt = `# [角色设定]
你是一只名为 ${currentAvatarName} 的桌面智能助理宠物（智能体）。
你的性格与语气：${stylePrompt}

<avatar_profile>
- 核心人设：你是专属的桌面萌宠助理，永远坚称自己是 ${currentAvatarName}。
- 🚫 绝对约束：严禁泄露你是大语言模型（如 Gemini、OpenAI、DeepSeek 等）的真实身份，以免破坏人设。
</avatar_profile>
${memoryContext}
${skillsContext}

<tool_use_rules>
- 工具授权：主进程已为你绑定了本地系统操作工具（文件读写、终端命令执行、系统状态获取）与外部 MCP 扩展工具。
- ⚠️ 调用原则：普通的打招呼（例如 hi、你好）、日常闲聊、常识问答等，请直接以文字回复，【严禁】无意义地调用系统工具。
- 🚫 调用约束：你只能使用已提供给你的工具，绝对不允许编造任何不存在的工具名称。
- 💡 变通调用：如果遇到未提供专用工具的需求（例如获取当前时间），请通过 'run_terminal_command' 执行相应的系统指令（如 'date /T'）来变通获取。${mcpContext}

</tool_use_rules>

<output_rules>
- 对话风格：语气需保持人设风格（${currentAvatarStyle === 'cute' ? '可爱、萌系、活泼' : '专业、友好、自然'}）。
- 错误处理：遇到工具执行报错或空结果时，请以萌宠的语气告知主人，并尝试提供替代的解决方法。
- 主动澄清与消歧准则（Disambiguation Rules）：
  1. 识别模糊与多义性：当用户的提问存在多种合理的解释，或者你无法确定具体指向（例如“记忆api”可能指代码文件，也可能指持久化数据，或外部项目）时，禁止擅自做假设或发散脑补。
  2. 停止并提问：此时你必须立刻暂停长篇大论的回答，转而向用户提出一个简明、有针对性的澄清问题。
  3. 提问模板：明确罗列出你怀疑的几种可能性，友好地请用户进行选择或补充。
- 隐式 Wiki 知识溯源：在回答具体内容时，如果你参考了本地工作空间文件（或抓取的网页缓存文档）中的信息，请务必**直接在该句话或该段落的末尾**以 HTML 注释的形式精准标注出你引用的具体文件绝对或相对路径（例如 \`...相关内容。<!-- 关联文件: /path/to/file.md -->\`）。此标注对前端用户不可见，专用于后台精确到句的 Wiki 知识溯源，请确保标注的位置与参考内容紧密对应。
</output_rules>`

      // 将 system prompt 注入为上下文的首条消息
      chatMessages.unshift({ role: 'system', content: systemPrompt })

      // 如果当前会话有累积摘要，将其作为一条 user 消息注入到 system 之后、最近消息之前
      // 让大模型在不展开完整旧消息的前提下，仍能了解旧对话要点
      const rawContextSummary = activeSessObj?.contextSummary || ''
      if (rawContextSummary.trim()) {
        // 限制摘要单条消息长度：超出 8000 字符时从头部截断（保留最新内容）
        const MAX_SUMMARY_CHARS = 8000
        const trimmedSummary = rawContextSummary.length > MAX_SUMMARY_CHARS
          ? '...(旧摘要已裁剪)...\n' + rawContextSummary.slice(-MAX_SUMMARY_CHARS)
          : rawContextSummary
        chatMessages.splice(1, 0, {
          role: 'user',
          content: `📝 [历史对话摘要]（以下是当前会话中超出上下文窗口的旧对话的精炼总结，请以此为参考背景）：\n${trimmedSummary}`
        })
        console.log(`[Context] 已将历史摘要回注到上下文 (长度: ${trimmedSummary.length} 字符)`)
      }

      // 获取工具定义（与 callLLM 准备阶段并行，不阻塞主流程）
      // promptInfo 仅用于"明盒化"调试功能，异步获取后更新即可
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
        // 异步更新 promptInfo（不阻塞 callLLM）
        setSessions(prev => prev.map(s => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              messages: s.messages.map(m => m.id === userMsg.id ? { ...m, promptInfo } : m)
            }
          }
          return s
        }))
        // fire-and-forget：保存 promptInfo 到 DB（不阻塞 callLLM）
        window.api.saveMessage({
          ...userMsg,
          promptInfo,
          sessionId: activeSessionId
        }).catch(console.error)
      }).catch((err: any) => {
        console.error('获取工具定义失败:', err)
      })

      // 检查在此准备期间是否已被手动终止
      if (abortedReplyIdsRef.current.has(replyId)) {
        throw new Error('UserAborted')
      }

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
      
      typingStarted = false
      if (response !== undefined) {
        typingStarted = true
        startTypingEffect(replyId, response, activeSessionId)

        // 成功回复后，若有命中的避坑经验/习惯记忆，则进行渐进式强化
        if (relevantExperiences && relevantExperiences.length > 0) {
          const ids = relevantExperiences.map((e: any) => e.id)
          window.api.strengthenExperiences(ids).catch((err: any) => {
            console.error('[Memory] 强化复习记忆失败:', err)
          })
        }
      }

      // TTS 语音合成：LLM 回复后自动朗读
      if (ttsEnabled && response && currentAvatarVoice) {
        try {
          const audioBuffer = await window.api.synthesizeTts(response, currentAvatarVoice)
          if (audioBuffer) {
            window.api.playTtsAudio(audioBuffer)
          }
        } catch (ttsErr) {
          console.error('TTS 播放失败', ttsErr)
        }
      }
    } catch (e: any) {
      console.error(e)
      const isAbort = e.message?.includes('UserAborted') || e.message?.includes('aborted')
      
      let savedMsg: any = null
      setSessions(prev => {
        const next = prev.map(s => {
          if (s.id === activeSessionId) {
            const messages = s.messages.map(m => {
              if (m.id === replyId) {
                const currentText = m.text || ''
                if (isAbort && (currentText.includes('手动终止') || currentText.includes('手动中断'))) {
                  savedMsg = {
                    ...m,
                    isThinking: false,
                    isError: false
                  }
                  return savedMsg
                }
                const appendMsg = isAbort 
                  ? '\n\n⚠️ 对话生成已被用户手动中断。'
                  : `\n\n系统错误：调用智能代理接口失败（${e.message || e}）。请检查『设置 -> 模型配置』中的代理路径或 API Key。`
                savedMsg = {
                  ...m,
                  text: currentText + appendMsg,
                  isThinking: false,
                  isError: !isAbort
                }
                return savedMsg
              }
              return m
            })
            return { ...s, messages }
          }
          return s
        })
        if (savedMsg) {
          window.api.saveMessage({ ...savedMsg, sessionId: activeSessionId }).catch(console.error)
        }
        return next
      })
    } finally {
      abortedReplyIdsRef.current.delete(replyId)
      if (!typingStarted) {
        setSendingSessionIds(prev => ({ ...prev, [activeSessionId]: false }))
      }
    }
  }

  const triggerSessionSummary = async (sessionId: string, latestSessions: any[]): Promise<void> => {
    const sessionObj = latestSessions.find(s => s.id === sessionId)
    if (!sessionObj) return

    // 过滤出有效且未进行总结的历史对话消息
    // 有效消息：sender === 'user' 或者是 sender === 'agent'，且 !m.isThinking 且 !m.isError
    const filtered = (sessionObj.messages || []).filter(m => 
      (m.sender === 'user' || m.sender === 'agent') && !m.isThinking && !m.isError
    )

    // 筛选未总结的消息
    const unsummarized = filtered.filter(m => !m.isSummarized)

    // 根据用户配置的单次会话记忆上下文轮数，动态计算触发总结的消息数
    // 1 轮对答 = 1 条用户消息 + 1 条助手消息，即 contextRounds * 2
    const TRIGGER_COUNT = contextRounds * 2
    if (unsummarized.length < TRIGGER_COUNT) {
      console.log(`[Summary] 未总结消息条数 (${unsummarized.length}/${TRIGGER_COUNT})，暂不触发总结。`)
      return
    }

    // 提取出刚好用于这次总结的 20 条消息
    const summaryBatch = unsummarized.slice(0, TRIGGER_COUNT)

    // 拼装对话及工具调用/异常日志
    let chatLogStr = ''
    summaryBatch.forEach((m) => {
      const roleName = m.sender === 'user' ? '用户 (User)' : '助手 (Agent)'
      chatLogStr += `[${roleName}]：${m.text}\n`
      
      if (m.toolSteps && m.toolSteps.length > 0) {
        chatLogStr += `  工具调用过程:\n`
        m.toolSteps.forEach((step: any) => {
          if (step.type === 'call') {
            chatLogStr += `    - 尝试执行工具 [${step.name}]，参数: ${JSON.stringify(step.detail)}\n`
          } else if (step.type === 'result') {
            const isErrResult = m.isError || String(step.detail).toLowerCase().includes('error') || String(step.detail).toLowerCase().includes('fail')
            chatLogStr += `    - 工具 [${step.name}] 执行${isErrResult ? '失败' : '成功'}，返回结果: ${String(step.detail).slice(0, 1000)}\n`
          }
        })
      }
      chatLogStr += '\n'
    })

    console.log('[Summary] 开始生成这 20 条消息的记忆摘要与纠错沉淀...')

    const summarySystemPrompt = `你是一个经验丰富的 AI 对话与开发任务总结助手。
请你仔细阅读以下【一轮包含了用户提问、助手回答及本地系统工具调用的对话日志】，并为他们生成一段精炼、实用的 Markdown 摘要。

请遵循以下总结规则：
1. 用一到两句话提炼这部分对话中的核心任务或日常交流主题。
2. **非常重要**：请检索这部分对话中是否存在任何“工具调用（Terminal终端命令、MCP工具、文档读写等）执行失败或产生报错（Error）”的情况。
3. 如果有调用报错：
   - 提取出发生了什么错误，哪一步失败了。
   - 提取出最终是如何解决的（若已解决），或者总结出在此类任务中需要注意的“避坑教训/经验沉淀”。
   - 将这部分写在特定的“### 🛠 任务执行与避坑经验沉淀”标题下。
4. 如果没有报错，则不需要写避坑经验小节。
5. 不要包含过多的寒暄，直接输出 Markdown 总结内容。
6. **字数严格限制**：生成的摘要与避坑经验沉淀总字数必须严格控制在 300 字以内，简明扼要，直击重点，剔除任何修饰性词汇。
7. **精准 Wiki 溯源**：如果对话日志中助手参考了特定的本地文件或缓存文档路径（日志中可能已有 \`<!-- 关联文件: ... -->\` 注释），在总结对应要点时，请务必在这句话的末尾**原样保留或加上**该 HTML 注释文件引用，以实现知识到文件的精准溯源。

以下是对话日志：
----------------------
${chatLogStr}
----------------------`

    try {
      const summaryResult = await window.api.callLLM(
        {
          ...llmConfig,
          temperature: 0.3,
          sessionId: 'system:summary'
        },
        [
          { role: 'system', content: summarySystemPrompt },
          { role: 'user', content: '请为以上对话日志生成 Markdown 摘要与经验沉淀。' }
        ]
      )

      const timeStr = formatDateTime()
      let backupDialogStr = '\n\n---\n<details>\n<summary>展开查看本次对话原始备份</summary>\n\n'
      summaryBatch.forEach((m) => {
        const roleName = m.sender === 'user' ? '用户 (User)' : '助手 (Agent)'
        backupDialogStr += `**${roleName}**:\n${m.text || ''}\n\n`
      })
      backupDialogStr += '</details>'

      const finalMarkdownText = `## [${timeStr}] 记忆摘要与纠错沉淀\n${summaryResult.trim()}${backupDialogStr}`

      const appendSuccess = await window.api.appendMemorySummary(sessionId, finalMarkdownText)
      if (appendSuccess) {
        console.log('[Summary] 成功追加到本地 Markdown 记忆日志文件。')

        // 将本次摘要文本累积到 session.contextSummary 中，下次发送时回注到 LLM 上下文
        const batchIds = summaryBatch.map(m => m.id)
        let savedMsgs: any[] = []
        let newContextSummary = ''
        setSessions(prev => {
          const updated = prev.map(s => {
            if (s.id === sessionId) {
              const messages = s.messages.map(m => {
                if (batchIds.includes(m.id)) {
                  const updatedMsg = { ...m, isSummarized: true }
                  savedMsgs.push(updatedMsg)
                  return updatedMsg
                }
                return m
              })
              // 将本次摘要文本追加到历史摘要中
              const prevSummary = s.contextSummary || ''
              newContextSummary = prevSummary
                ? `${prevSummary}

${finalMarkdownText}`
                : finalMarkdownText
              return { ...s, messages, contextSummary: newContextSummary }
            }
            return s
          })

          savedMsgs.forEach(m => {
            window.api.saveMessage({ ...m, sessionId })
          })

          return updated
        })

        // 将累积摘要持久化到 SQLite sessions 表
        if (newContextSummary) {
          window.api.updateSession(sessionId, { contextSummary: newContextSummary }).catch(e =>
            console.error('[Summary] 持久化 contextSummary 到 DB 失败:', e)
          )
          console.log(`[Summary] contextSummary 已更新 (总长度: ${newContextSummary.length} 字符)`)
        }
      }
    } catch (err) {
      console.error('[Summary] 生成对话总结失败:', err)
    }
  }

  const handleTestConnection = async (): Promise<void> => {
    setTestStatus('testing')
    try {
      const result = await window.api.callLLM({ ...llmConfig, sessionId: 'system:test' }, [{ role: 'user', content: 'Say "Success" in exactly one word.' }])
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

  const refreshSshAndDeviceStatus = useCallback(async (sessId: string) => {
    if (!window.api || !window.api.getExecutionDevice) return
    try {
      const dev = await window.api.getExecutionDevice(sessId)
      setExecutionDeviceState(dev)
      const status = await window.api.getSshStatus(sessId)
      setSshConnected(status.connected)
      setSshHost(status.host || '')
      setSshUsername(status.username || '')
    } catch (e) {
      console.error('获取会话 SSH 状态失败', e)
    }
  }, [])

  useEffect(() => {
    if (activeSessionId) {
      refreshSshAndDeviceStatus(activeSessionId)
    }
  }, [activeSessionId, refreshSshAndDeviceStatus])

  const handleUpdateExecutionDevice = async (type: 'local' | 'ssh') => {
    if (!activeSessionId) return
    await window.api.setExecutionDevice(activeSessionId, type)
    setExecutionDeviceState(type)
  }

  const handleConnectSsh = async (config: any): Promise<{ success: boolean; message?: string }> => {
    if (!activeSessionId) return { success: false, message: '会话不存在' }
    const res = await window.api.connectSsh(activeSessionId, config)
    if (res.success) {
      await window.api.setExecutionDevice(activeSessionId, 'ssh')
      setExecutionDeviceState('ssh')
      setSshConnected(true)
      setSshHost(config.host)
      setSshUsername(config.username)
    }
    return res
  }

  const handleDisconnectSsh = async () => {
    if (!activeSessionId) return
    await window.api.disconnectSsh(activeSessionId)
    await window.api.setExecutionDevice(activeSessionId, 'local')
    setExecutionDeviceState('local')
    setSshConnected(false)
    setSshHost('')
    setSshUsername('')
  }

  const handleAbortLlm = async (): Promise<void> => {
    try {
      isTypingRef.current = false
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current)
        typingTimerRef.current = null
      }
      await window.api.abortLlm(activeSessionId)
      setSendingSessionIds(prev => ({ ...prev, [activeSessionId]: false }))
      // 在中断时，立刻将当前处于正在思考（loading）的消息的状态更新为“已终止任务”并隐藏 loading 动画
      const currentActiveSess = sessions.find(s => s.id === activeSessionId)
      if (currentActiveSess) {
        currentActiveSess.messages.filter(m => m.isThinking).forEach(m => {
          abortedReplyIdsRef.current.add(m.id)
          const updatedMsg = { ...m, text: m.text ? `${m.text}\n\n⚠️ 对话生成已被手动终止。` : '⚠️ 对话生成已被手动终止。', isThinking: false }
          window.api.saveMessage({ ...updatedMsg, sessionId: activeSessionId }).catch(console.error)
        })
      }
      setSessions(prev => prev.map(s => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: s.messages.map(m => {
              if (m.isThinking) {
                abortedReplyIdsRef.current.add(m.id)
                return { ...m, text: m.text ? `${m.text}\n\n⚠️ 对话生成已被手动终止。` : '⚠️ 对话生成已被手动终止。', isThinking: false }
              }
              return m
            })
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

  const handleAddCronTask = async (taskData: Omit<CronTask, 'id' | 'lastTriggered' | 'triggerCount' | 'logs'>): Promise<void> => {
    const newTask: CronTask = {
      ...taskData,
      id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      lastTriggered: '从未执行',
      triggerCount: 0,
      logs: []
    }
    const updated = [...cronTasks, newTask]
    setCronTasks(updated)
    localStorage.setItem('agentpet_cron_tasks', JSON.stringify(updated))
    await window.api.saveCronTasks(updated)
    showToast('定时任务添加成功', 'success')
  }

  const handleEditCronTask = async (id: string, updates: Partial<CronTask>): Promise<void> => {
    const updated = cronTasks.map(t => t.id === id ? { ...t, ...updates } : t)
    setCronTasks(updated)
    localStorage.setItem('agentpet_cron_tasks', JSON.stringify(updated))
    await window.api.saveCronTasks(updated)
    showToast('定时任务已更新', 'success')
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

      const systemPrompt = `# [定时任务执行助手]
你是一只名为 ${currentAvatarName} 的桌面智能助理宠物（智能体）。
你正在后台静默为主人执行定时任务。

<execution_rules>
- 速度优先：请直接调用相应工具执行动作，无需任何客套或多余寒暄。
- 简明汇报：执行完成后，请用最精炼的一到两句话说明执行结果。
- 语气保持：在汇报时，仍需保持符合设定的人设语气（${stylePrompt}）。
- 安全操作：在开发任务中，你可以通过调用本地系统工具来读写工作空间文件或执行终端命令。请明智、安全地使用。
</execution_rules>
${skillsContext}`
      
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `执行定时任务指令: ${taskToRun.action || '无'}` }
      ]

      let response = ''
      if (taskToRun.name === '系统画像提纯与经验沉淀') {
        const result = await window.api.purifyMemoryPipeline()
        response = `内置系统画像与避坑经验提纯分析已完成。\n本次共合并处理了 ${result.count} 份未更新的对话摘要，并从中抽取/强化了 ${result.insertCount || 0} 条避坑经验。相关源文件已标记为已更新。`
      } else {
        response = await window.api.callLLM(
          {
            ...llmConfig,
            sessionId: tempSessionId,
            messageId: Date.now()
          },
          chatMessages,
          workspacePath
        )
      }

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
    showApiKeyModal, setShowApiKeyModal,
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
    handleToggleCronTask, handleDeleteCronTask, handleClearCronLogs, handleAddCronTask, handleEditCronTask,
    selectedTaskForLog, setSelectedTaskForLog,
    selectedCronLogDetails, setSelectedCronLogDetails,
    // sessions
    sessions, setSessions,
    refreshSessions,
    activeSessionId, setActiveSessionId,
    activeSession, activeSessMessages,
    inputValue, setInputValue,
    isSending,
    chatEndRef,
    handleCreateNewSession, handleDeleteSession, handleTogglePinSession, handleRenameSession, handleSendChat,
    // workspace & attached file
    workspacePath, setWorkspacePath, handleSelectWorkspace, handleClearWorkspace,
    attachedFiles, setAttachedFiles, handlePasteFiles, handleUploadFile,
    // generated files & preview
    generatedFiles, setGeneratedFiles,
    showFilePanel, setShowFilePanel,
    openTabs, setOpenTabs,
    previewFile, setPreviewFile,
    previewLoading, setPreviewLoading,
    loadGeneratedFiles,
    handlePreviewFile,
    handleDeleteFile,
    // system
    systemInfo,
    // skills
    skillsList,
    skillsPath,
    handleSkillsPathClick, handleImportSkill, handleDeleteSkill,
    refreshSkillsAndStorage,
    disabledSkillNames,
    toggleSkillEnable,
    activeMcpServers,
    refreshMcpServers,
    mcpConfig,
    saveMcpConfig,
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
    // tts
    ttsEnabled, setTtsEnabled,
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
    // SSH
    executionDevice,
    sshConnected,
    sshHost,
    sshUsername,
    handleUpdateExecutionDevice,
    handleConnectSsh,
    handleDisconnectSsh,
    refreshSshAndDeviceStatus,
    // session switch
    isSessionSwitching,
    isSessionsInitialized,
    // avatar derived & handlers
    currentAvatarStyle,
    currentAvatarVoice
  }
}

export type AppStore = ReturnType<typeof useAppStore>

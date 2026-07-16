import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  moveWindow: (dx: number, dy: number): void => {
    ipcRenderer.send('move-window', dx, dy)
  },
  setWindowSize: (width: number, height: number, anchor?: 'bottom' | 'top'): void => {
    ipcRenderer.send('set-window-size', width, height, anchor)
  },
  endDrag: (): void => {
    ipcRenderer.send('end-drag')
  },
  startDrag: (): void => {
    ipcRenderer.send('start-drag')
  },
  hoverEnter: (): void => {
    ipcRenderer.send('hover-enter')
  },
  hoverLeave: (): void => {
    ipcRenderer.send('hover-leave')
  },
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }): void => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, options)
  },
  openAgentWindow: (): void => {
    ipcRenderer.send('open-agent-window')
  },
  hideWindow: (): void => {
    ipcRenderer.send('hide-window')
  },
  openInputWindow: (): void => {
    ipcRenderer.send('open-input-window')
  },
  closeInputWindow: (): void => {
    ipcRenderer.send('close-input-window')
  },
  sendChatToPet: (text: string, isNewSession?: boolean, imagePath?: string): void => {
    ipcRenderer.send('send-chat-to-pet', text, isNewSession, imagePath)
  },
  getSystemInfo: (): Promise<any> => ipcRenderer.invoke('api:get-system-info'),
  getSkillsPath: (): Promise<string> => ipcRenderer.invoke('api:get-skills-path'),
  openSkillsFolder: (): Promise<void> => ipcRenderer.invoke('api:open-skills-folder'),
  uploadSkillPack: (): Promise<any[]> => ipcRenderer.invoke('api:upload-skill-pack'),
  getSkillsList: (): Promise<any[]> => ipcRenderer.invoke('api:get-skills-list'),
  deleteSkill: (name: string): Promise<any[]> => ipcRenderer.invoke('api:delete-skill', name),
  getActiveSkillsPrompt: (enabledSkillNames: string[]): Promise<string> =>
    ipcRenderer.invoke('api:get-active-skills-prompt', enabledSkillNames),
  callLLM: (config: any, messages: any[], workspacePath?: string): Promise<string> =>
    ipcRenderer.invoke('api:call-llm', config, messages, workspacePath),
  selectFile: (): Promise<{ name: string; path: string; content: string } | null> =>
    ipcRenderer.invoke('api:select-file'),
  parseFileContent: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('api:parse-file-content', filePath),
  parseFileHtml: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('api:parse-file-html', filePath),
  readFileBase64: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('api:read-file-base64', filePath),
  saveClipboardImage: (dataUrl: string): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke('api:save-clipboard-image', dataUrl),
  getGeneratedFiles: (sessionId?: string): Promise<{ name: string; path: string; size: number; time: string }[]> =>
    ipcRenderer.invoke('api:get-generated-files', sessionId),
  saveGeneratedFileAs: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('api:save-generated-file-as', filePath),
  deleteGeneratedFile: (filePath: string, sessionId?: string): Promise<boolean> =>
    ipcRenderer.invoke('api:delete-generated-file', filePath, sessionId),
  onGeneratedFileUpdated: (callback: () => void): (() => void) => {
    const subscription = () => callback()
    ipcRenderer.on('api:generated-file-updated', subscription)
    return () => {
      ipcRenderer.removeListener('api:generated-file-updated', subscription)
    }
  },
  saveChatFile: (sessionId: string, fileName: string, arrayBuffer: ArrayBuffer): Promise<{ name: string; path: string; safeName: string }> =>
    ipcRenderer.invoke('api:save-chat-file', sessionId, fileName, arrayBuffer),
  copyToChatFile: (sessionId: string, sourcePath: string): Promise<{ path: string; exists: boolean }> =>
    ipcRenderer.invoke('api:copy-to-chat-file', sessionId, sourcePath),
  attachFileFromPath: (filePath: string, sessionId: string): Promise<{ name: string; path: string; safeName: string; isImage: boolean; content?: string } | null> =>
    ipcRenderer.invoke('api:attach-file-from-path', filePath, sessionId),
  onToolEvent: (callback: (data: any) => void): (() => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:llm-tool-event', subscription)
    return () => {
      ipcRenderer.removeListener('api:llm-tool-event', subscription)
    }
  },
  onLlmTextDelta: (callback: (data: { content: string; sessionId?: string; messageId?: number }) => void): (() => void) => {
    const subscription = (_event: any, data: { content: string; sessionId?: string; messageId?: number }) => callback(data)
    ipcRenderer.on('api:llm-text-delta', subscription)
    return () => ipcRenderer.removeListener('api:llm-text-delta', subscription)
  },
  onTokenUsage: (callback: (data: any) => void): (() => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:llm-token-usage', subscription)
    return () => {
      ipcRenderer.removeListener('api:llm-token-usage', subscription)
    }
  },
  setStoragePath: (pathStr: string): Promise<string> => ipcRenderer.invoke('api:set-storage-path', pathStr),
  getStoragePath: (): Promise<string> => ipcRenderer.invoke('api:get-storage-path'),
  selectDirectory: (options?: { title?: string }): Promise<string | null> =>
    ipcRenderer.invoke('api:select-directory', options),
  getCustomModel: (): Promise<{ customModelDir: string; customModelFile: string } | null> =>
    ipcRenderer.invoke('api:get-custom-model'),
  selectModelDir: (): Promise<{ customModelDir: string; customModelFile: string } | null> =>
    ipcRenderer.invoke('api:select-model-dir'),
  clearCustomModel: (): Promise<void> =>
    ipcRenderer.invoke('api:clear-custom-model'),
  getModelUrl: (): Promise<string> =>
    ipcRenderer.invoke('api:get-model-url'),
  getOllamaModels: (baseUrl: string): Promise<string[]> =>
    ipcRenderer.invoke('api:get-ollama-models', baseUrl),
  getModels: (config: any): Promise<string[]> =>
    ipcRenderer.invoke('api:get-models', config),
  getLocalSessions: (options?: { loadAll?: boolean; activeSessionId?: string }): Promise<any[] | null> =>
    ipcRenderer.invoke('api:get-local-sessions', options),
  createSession: (session: any): Promise<boolean> =>
    ipcRenderer.invoke('api:create-session', session),
  updateSession: (sessionId: string, updates: any): Promise<boolean> =>
    ipcRenderer.invoke('api:update-session', sessionId, updates),
  deleteSession: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('api:delete-session', sessionId),
  saveMessage: (message: any): Promise<boolean> =>
    ipcRenderer.invoke('api:save-message', message),
  saveMessages: (messages: any[]): Promise<boolean> =>
    ipcRenderer.invoke('api:save-messages', messages),
  deleteMessage: (messageId: string): Promise<boolean> =>
    ipcRenderer.invoke('api:delete-message', messageId),
  onSessionsUpdated: (callback: () => void): (() => void) => {
    const subscription = () => callback()
    ipcRenderer.on('api:sessions-updated', subscription)
    return () => {
      ipcRenderer.removeListener('api:sessions-updated', subscription)
    }
  },
  appendMemorySummary: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('api:append-memory-summary', sessionId, text),
  getMemoryProfile: (): Promise<string> =>
    ipcRenderer.invoke('api:get-memory-profile'),
  writeMemoryProfile: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('api:write-memory-profile', text),
  purifyMemoryPipeline: (): Promise<{ success: boolean; count: number; insertCount?: number }> =>
    ipcRenderer.invoke('api:purify-memory-pipeline'),
  recallExperiences: (queryText: string): Promise<any[]> =>
    ipcRenderer.invoke('api:recall-experiences', queryText),
  strengthenExperiences: (ids: string[]): Promise<boolean> =>
    ipcRenderer.invoke('api:strengthen-experiences', ids),
  getActiveMcpServers: (): Promise<any[]> =>
    ipcRenderer.invoke('api:get-active-mcp-servers'),
  getAvatarsList: (): Promise<any[]> =>
    ipcRenderer.invoke('api:get-avatars-list'),
  saveAvatarConfig: (params: { id: string; name: string; languageStyle: string; voice?: string; scale?: number; xOffset?: number; yOffset?: number }): Promise<boolean> =>
    ipcRenderer.invoke('api:save-avatar-config', params),
  synthesizeTts: (text: string, voice: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('api:synthesize-tts', { text, voice }),
  playTtsAudio: (audioBuffer: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke('api:play-tts-audio', audioBuffer),
  onPlayTtsAudio: (callback: (audioBuffer: ArrayBuffer) => void): (() => void) => {
    const subscription = (_event: any, audioBuffer: ArrayBuffer) => callback(audioBuffer)
    ipcRenderer.on('play-tts-audio', subscription)
    return () => {
      ipcRenderer.removeListener('play-tts-audio', subscription)
    }
  },
  switchAvatar: (params: { dir: string; configFile: string }): Promise<any> =>
    ipcRenderer.invoke('api:switch-avatar', params),
  deleteAvatar: (dirPath: string): Promise<boolean> =>
    ipcRenderer.invoke('api:delete-avatar', dirPath),
  getSandboxMode: (): Promise<boolean> =>
    ipcRenderer.invoke('api:get-sandbox-mode'),
  setSandboxMode: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('api:set-sandbox-mode', enabled),
  onRequestPermission: (callback: (data: any) => void): (() => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:request-permission', subscription)
    return () => {
      ipcRenderer.removeListener('api:request-permission', subscription)
    }
  },
  respondPermission: (requestId: number, approved: boolean): void => {
    ipcRenderer.send('api:permission-response', { requestId, approved })
  },
  respondClarification: (requestId: number, answers: Record<string, string>, cancelled = false): void => {
    ipcRenderer.send('api:clarification-response', { requestId, answers, cancelled })
  },
  abortLlm: (sessionId?: string): Promise<boolean> =>
    ipcRenderer.invoke('api:abort-llm', sessionId),
  getCronTasks: (): Promise<any[] | null> =>
    ipcRenderer.invoke('api:get-cron-tasks'),
  saveCronTasks: (tasks: any[]): Promise<boolean> =>
    ipcRenderer.invoke('api:save-cron-tasks', tasks),
  onCronUpdated: (callback: () => void): (() => void) => {
    const subscription = () => callback()
    ipcRenderer.on('api:cron-updated', subscription)
    return () => {
      ipcRenderer.removeListener('api:cron-updated', subscription)
    }
  },
  showNotification: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke('api:show-notification', title, body),
  onShowBubble: (callback: (text: string, details?: string, taskId?: string, logId?: string) => void): (() => void) => {
    const subscription = (_event: any, text: string, details?: string, taskId?: string, logId?: string) =>
      callback(text, details, taskId, logId)
    ipcRenderer.on('api:show-bubble', subscription)
    return () => {
      ipcRenderer.removeListener('api:show-bubble', subscription)
    }
  },
  showBubble: (text: string, details?: string, taskId?: string, logId?: string): void => {
    ipcRenderer.send('api:trigger-bubble', text, details, taskId, logId)
  },
  openCronLogDetails: (taskId: string, logId: string): void => {
    ipcRenderer.send('api:request-open-cron-log-details', taskId, logId)
  },
  onOpenCronLogDetails: (callback: (taskId: string, logId: string) => void): (() => void) => {
    const subscription = (_event: any, taskId: string, logId: string) => callback(taskId, logId)
    ipcRenderer.on('api:open-cron-log-details', subscription)
    return () => {
      ipcRenderer.removeListener('api:open-cron-log-details', subscription)
    }
  },
  wechatStartLogin: (): Promise<boolean> => ipcRenderer.invoke('api:wechat-start-login'),
  wechatLogout: (): Promise<boolean> => ipcRenderer.invoke('api:wechat-logout'),
  wechatGetStatus: (): Promise<any> => ipcRenderer.invoke('api:wechat-get-status'),
  wechatSaveSettings: (settings: any): Promise<boolean> => ipcRenderer.invoke('api:wechat-save-settings', settings),
  syncLlmConfig: (config: any): Promise<boolean> => ipcRenderer.invoke('api:sync-llm-config', config),
  onWechatStatusUpdated: (callback: (data: any) => void): (() => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:wechat-status-updated', subscription)
    return () => {
      ipcRenderer.removeListener('api:wechat-status-updated', subscription)
    }
  },
  onWechatSessionUpdated: (callback: (sessionId?: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId?: string): void => callback(sessionId)
    ipcRenderer.on('api:wechat-session-updated', handler)
    return (): void => { ipcRenderer.removeListener('api:wechat-session-updated', handler) }
  },
  syncMcpConfig: (config: any): Promise<boolean> => ipcRenderer.invoke('api:sync-mcp-config', config),
  testMcpServer: (config: any): Promise<any> => ipcRenderer.invoke('api:test-mcp-server', config),
  getMcpConfig: (): Promise<any> => ipcRenderer.invoke('api:get-mcp-config'),
  onRequestGeolocation: (callback: (data: { requestId: number }) => void): (() => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:request-geolocation', subscription)
    return () => {
      ipcRenderer.removeListener('api:request-geolocation', subscription)
    }
  },
  respondGeolocation: (requestId: number, location: any, error?: string): void => {
    ipcRenderer.send('api:geolocation-response', { requestId, location, error })
  },
  copyText: (text: string): void => {
    ipcRenderer.send('api:copy-text', text)
  },
  copyImage: (imageUrl: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('api:copy-image', imageUrl),
  copyFiles: (filePaths: string[], text?: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('api:copy-files', { filePaths, text }),
  readClipboardFiles: (): Promise<{ type: 'files'; paths: string[] } | { type: 'image'; path: string; name: string } | null> =>
    ipcRenderer.invoke('api:read-clipboard-files'),
  showImageContextMenu: (imageUrl: string): void => {
    ipcRenderer.send('api:show-image-context-menu', imageUrl)
  },
  showTextContextMenu: (selectedText: string): void => {
    ipcRenderer.send('api:show-text-context-menu', selectedText)
  },
  showPetContextMenu: (): void => {
    ipcRenderer.send('api:show-pet-context-menu')
  },
  sendPetReplyToInput: (responseText: string): void => {
    ipcRenderer.send('api:send-pet-reply-to-input', responseText)
  },
  onPetReplyResponse: (callback: (responseText: string) => void): (() => void) => {
    const handler = (_event: any, text: string) => callback(text)
    ipcRenderer.on('pet-reply-response', handler)
    return () => {
      ipcRenderer.removeListener('pet-reply-response', handler)
    }
  },
  // 从快捷输入框向完整对话窗口传递待发送的文本（如粘贴文件后跳转）
  // 使用 localStorage 传递大数据（base64 图片可达数 MB），IPC 仅做轻量通知
  sendPendingInput: (text: string): void => {
    localStorage.setItem('agentpet_pending_input', text)
    ipcRenderer.send('api:send-pending-input')
  },
  onPendingInput: (callback: (text: string) => void): (() => void) => {
    const handler = () => {
      const text = localStorage.getItem('agentpet_pending_input') || ''
      if (text) {
        localStorage.removeItem('agentpet_pending_input')
        callback(text)
      }
    }
    ipcRenderer.on('pending-input', handler)
    return () => {
      ipcRenderer.removeListener('pending-input', handler)
    }
  },
  getPendingInput: (): Promise<string> => {
    return new Promise((resolve) => {
      const text = localStorage.getItem('agentpet_pending_input') || ''
      if (text) {
        localStorage.removeItem('agentpet_pending_input')
        resolve(text)
      } else {
        resolve('')
      }
    })
  },
  startScreenshot: (): void => {
    ipcRenderer.send('api:start-screenshot')
  },
  getScreenshotByDisplayId: (displayId: string): Promise<string> =>
    ipcRenderer.invoke('api:get-screenshot-by-display-id', displayId),
  cancelScreenshot: (): void => {
    ipcRenderer.send('api:cancel-screenshot')
  },
  completeScreenshot: (croppedBase64: string, bounds: { x: number; y: number; width: number; height: number }): void => {
    ipcRenderer.send('api:complete-screenshot', croppedBase64, bounds)
  },
  onSetScreenshotImage: (callback: (data: { path: string; base64: string; width: number; height: number }) => void): (() => void) => {
    const handler = (_event: any, data: { path: string; base64: string; width: number; height: number }) => callback(data)
    ipcRenderer.on('api:set-screenshot-image', handler)
    return () => {
      ipcRenderer.removeListener('api:set-screenshot-image', handler)
    }
  },
  getToolsDefinition: (): Promise<any[]> =>
    ipcRenderer.invoke('api:get-tools-definition'),
  openLocalFile: (url: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('api:open-local-file', url),
  minimizeAgentWindow: (): void => {
    ipcRenderer.send('minimize-agent-window')
  },
  maximizeAgentWindow: (): void => {
    ipcRenderer.send('maximize-agent-window')
  },
  closeAgentWindow: (): void => {
    ipcRenderer.send('close-agent-window')
  },
  isAgentWindowMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke('api:is-agent-window-maximized'),
  ensureWechatSession: (sessionId: string, nickname: string): Promise<boolean> =>
    ipcRenderer.invoke('api:ensure-wechat-session', sessionId, nickname),

  // 工具管理 API
  getToolsSummary: (): Promise<string> =>
    ipcRenderer.invoke('api:get-tools-summary'),
  getToolDocumentation: (toolName: string): Promise<string> =>
    ipcRenderer.invoke('api:get-tool-documentation', toolName),
  getAllToolsInfo: (): Promise<any> =>
    ipcRenderer.invoke('api:get-all-tools-info'),
  reloadTools: (): Promise<{ success: boolean; count?: number; error?: string }> =>
    ipcRenderer.invoke('api:reload-tools'),
  testSshConnection: (config: any): Promise<{ success: boolean; message?: string }> =>
    ipcRenderer.invoke('api:test-ssh-connection', config),
  connectSsh: (sessionId: string, config: any): Promise<{ success: boolean; message?: string }> =>
    ipcRenderer.invoke('api:connect-ssh', sessionId, config),
  disconnectSsh: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('api:disconnect-ssh', sessionId),
  getSshStatus: (sessionId: string): Promise<{ connected: boolean; host?: string; username?: string }> =>
    ipcRenderer.invoke('api:get-ssh-status', sessionId),
  setExecutionDevice: (sessionId: string, type: 'local' | 'ssh'): Promise<void> =>
    ipcRenderer.invoke('api:set-execution-device', sessionId, type),
  getExecutionDevice: (sessionId: string): Promise<'local' | 'ssh'> =>
    ipcRenderer.invoke('api:get-execution-device', sessionId),

  // RPA 任务可视化 API
  getRpaManifest: (): Promise<any[]> => ipcRenderer.invoke('api:get-rpa-manifest'),
  saveRpaManifest: (manifest: any[]): Promise<boolean> => ipcRenderer.invoke('api:save-rpa-manifest', manifest),
  getRpaTaskFlow: (taskId: string): Promise<any> => ipcRenderer.invoke('api:get-rpa-task-flow', taskId),
  saveRpaTaskFlow: (taskId: string, flowData: any): Promise<boolean> => ipcRenderer.invoke('api:save-rpa-task-flow', taskId, flowData),
  runRpaTask: (taskId: string, flowData: any): Promise<boolean> => ipcRenderer.invoke('api:run-rpa-task', taskId, flowData),
  stopRpaTask: (taskId: string): Promise<boolean> => ipcRenderer.invoke('api:stop-rpa-task', taskId),
  respondRpaManualConfirm: (taskId: string, updates?: any): Promise<boolean> => ipcRenderer.invoke('api:respond-rpa-manual-confirm', taskId, updates),
  onRpaLog: (callback: (data: { taskId: string; message: string; level: 'info' | 'warn' | 'error' }) => void): (() => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:rpa-log', handler)
    return () => { ipcRenderer.removeListener('api:rpa-log', handler) }
  },
  onRpaStatusEvent: (callback: (data: { taskId: string; status: 'running' | 'success' | 'failed'; errorMsg?: string }) => void): (() => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:rpa-status-event', handler)
    return () => { ipcRenderer.removeListener('api:rpa-status-event', handler) }
  },
  onRpaStepEvent: (callback: (data: { taskId: string; nodeId: string; state: 'idle' | 'running' | 'paused' | 'success' | 'failed'; data?: any; context?: any }) => void): (() => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:rpa-step-event', handler)
    return () => { ipcRenderer.removeListener('api:rpa-step-event', handler) }
  },
  rpaPickElement: (url: string): Promise<string | null> => ipcRenderer.invoke('api:rpa-pick-element', url),
  rpaRecordActions: (url: string): Promise<any[]> => ipcRenderer.invoke('api:rpa-record-actions', url)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}


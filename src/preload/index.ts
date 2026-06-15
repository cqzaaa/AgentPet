import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  moveWindow: (dx: number, dy: number): void => {
    ipcRenderer.send('move-window', dx, dy)
  },
  setWindowSize: (width: number, height: number): void => {
    ipcRenderer.send('set-window-size', width, height)
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
  getSystemInfo: (): Promise<any> => ipcRenderer.invoke('api:get-system-info'),
  getSkillsPath: (): Promise<string> => ipcRenderer.invoke('api:get-skills-path'),
  openSkillsFolder: (): Promise<void> => ipcRenderer.invoke('api:open-skills-folder'),
  uploadSkillPack: (): Promise<any[]> => ipcRenderer.invoke('api:upload-skill-pack'),
  getSkillsList: (): Promise<any[]> => ipcRenderer.invoke('api:get-skills-list'),
  deleteSkill: (name: string): Promise<any[]> => ipcRenderer.invoke('api:delete-skill', name),
  callLLM: (config: any, messages: any[], workspacePath?: string): Promise<string> =>
    ipcRenderer.invoke('api:call-llm', config, messages, workspacePath),
  selectFile: (): Promise<{ name: string; path: string; content: string } | null> =>
    ipcRenderer.invoke('api:select-file'),
  onToolEvent: (callback: (data: any) => void): (() => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on('api:llm-tool-event', subscription)
    return () => {
      ipcRenderer.removeListener('api:llm-tool-event', subscription)
    }
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
  getLocalSessions: (): Promise<any[] | null> =>
    ipcRenderer.invoke('api:get-local-sessions'),
  saveLocalSessions: (sessions: any[]): Promise<boolean> =>
    ipcRenderer.invoke('api:save-local-sessions', sessions),
  getAvatarsList: (): Promise<any[]> =>
    ipcRenderer.invoke('api:get-avatars-list'),
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
  abortLlm: (): Promise<boolean> =>
    ipcRenderer.invoke('api:abort-llm'),
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
  }
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


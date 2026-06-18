import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      moveWindow: (dx: number, dy: number) => void
      setWindowSize: (width: number, height: number) => void
      endDrag: () => void
      startDrag: () => void
      hoverEnter: () => void
      hoverLeave: () => void
      setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void
      openAgentWindow: () => void
      hideWindow: () => void
      getSystemInfo: () => Promise<any>
      getSkillsPath: () => Promise<string>
      openSkillsFolder: () => Promise<void>
      uploadSkillPack: () => Promise<any[]>
      getSkillsList: () => Promise<any[]>
      callLLM: (config: any, messages: any[], workspacePath?: string) => Promise<string>
      selectFile: () => Promise<{ name: string; path: string; content: string } | null>
      saveChatFile: (sessionId: string, fileName: string, arrayBuffer: ArrayBuffer) => Promise<{ name: string; path: string; safeName: string }>
      onToolEvent: (callback: (data: any) => void) => () => void
      onTokenUsage: (callback: (data: any) => void) => () => void
      setStoragePath: (pathStr: string) => Promise<string>
      getStoragePath: () => Promise<string>
      selectDirectory: (options?: { title?: string }) => Promise<string | null>
      getCustomModel: () => Promise<{ customModelDir: string; customModelFile: string } | null>
      selectModelDir: () => Promise<{ customModelDir: string; customModelFile: string } | null>
      clearCustomModel: () => Promise<void>
      getModelUrl: () => Promise<string>
      getOllamaModels: (baseUrl: string) => Promise<string[]>
      getModels: (config: any) => Promise<string[]>
      getLocalSessions: () => Promise<any[] | null>
      saveLocalSessions: (sessions: any[]) => Promise<boolean>
      getAvatarsList: () => Promise<any[]>
      saveAvatarConfig: (params: { id: string; name: string; languageStyle: string }) => Promise<boolean>
      switchAvatar: (params: { dir: string; configFile: string }) => Promise<any>
      deleteAvatar: (dirPath: string) => Promise<boolean>
      getSandboxMode: () => Promise<boolean>
      setSandboxMode: (enabled: boolean) => Promise<boolean>
      onRequestPermission: (callback: (data: any) => void) => () => void
      respondPermission: (requestId: number, approved: boolean) => void
      abortLlm: () => Promise<boolean>
      getCronTasks: () => Promise<any[] | null>
      saveCronTasks: (tasks: any[]) => Promise<boolean>
      onCronUpdated: (callback: () => void) => () => void
      showNotification: (title: string, body: string) => Promise<boolean>
      onShowBubble: (callback: (text: string, details?: string, taskId?: string, logId?: string) => void) => () => void
      showBubble: (text: string, details?: string, taskId?: string, logId?: string) => void
      openCronLogDetails: (taskId: string, logId: string) => void
      onOpenCronLogDetails: (callback: (taskId: string, logId: string) => void) => () => void
      wechatStartLogin: () => Promise<boolean>
      wechatLogout: () => Promise<boolean>
      wechatGetStatus: () => Promise<any>
      wechatSaveSettings: (settings: any) => Promise<boolean>
      syncLlmConfig: (config: any) => Promise<boolean>
      onWechatStatusUpdated: (callback: (data: any) => void) => () => void
      onWechatSessionUpdated: (callback: () => void) => () => void
      syncMcpConfig: (config: any) => Promise<boolean>
      testMcpServer: (config: any) => Promise<any>
      getMcpConfig: () => Promise<any>
      onRequestGeolocation: (callback: (data: { requestId: number }) => void) => () => void
      respondGeolocation: (requestId: number, location: any, error?: string) => void
      copyText: (text: string) => void
    }
  }
}


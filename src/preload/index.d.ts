import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      moveWindow: (dx: number, dy: number) => void
      setWindowSize: (width: number, height: number, anchor?: 'bottom' | 'top') => void
      endDrag: () => void
      startDrag: () => void
      hoverEnter: () => void
      hoverLeave: () => void
      setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void
      openAgentWindow: () => void
      hideWindow: () => void
      openInputWindow: () => void
      closeInputWindow: () => void
      sendChatToPet: (text: string, isNewSession?: boolean, imagePath?: string) => void
      getSystemInfo: () => Promise<any>
      getSkillsPath: () => Promise<string>
      openSkillsFolder: () => Promise<void>
      uploadSkillPack: () => Promise<any[]>
      getSkillsList: () => Promise<any[]>
      deleteSkill: (name: string) => Promise<any[]>
      getToolsDefinition: () => Promise<any[]>
      callLLM: (config: any, messages: any[], workspacePath?: string) => Promise<string>
      selectFile: () => Promise<{ name: string; path: string; content: string } | null>
      parseFileContent: (filePath: string) => Promise<string>
      parseFileHtml: (filePath: string) => Promise<string>
      readFileBase64: (filePath: string) => Promise<string | null>
      saveClipboardImage: (dataUrl: string) => Promise<{ path: string; name: string } | null>
      getGeneratedFiles: (sessionId?: string) => Promise<{ name: string; path: string; size: number; time: string }[]>
      saveGeneratedFileAs: (filePath: string) => Promise<boolean>
      deleteGeneratedFile: (filePath: string, sessionId?: string) => Promise<boolean>
      onGeneratedFileUpdated: (callback: () => void) => () => void
      saveChatFile: (sessionId: string, fileName: string, arrayBuffer: ArrayBuffer) => Promise<{ name: string; path: string; safeName: string }>
      copyToChatFile: (sessionId: string, sourcePath: string) => Promise<{ path: string; exists: boolean }>
      attachFileFromPath: (filePath: string, sessionId: string) => Promise<{ name: string; path: string; safeName: string; isImage: boolean; content?: string } | null>
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
      appendMemorySummary: (sessionId: string, text: string) => Promise<boolean>
      getMemoryProfile: () => Promise<string>
      writeMemoryProfile: (text: string) => Promise<boolean>
      purifyMemoryPipeline: () => Promise<{ success: boolean; count: number; insertCount?: number }>
      recallExperiences: (queryText: string) => Promise<any[]>
      strengthenExperiences: (ids: string[]) => Promise<boolean>
      getActiveMcpServers: () => Promise<any[]>
      getAvatarsList: () => Promise<any[]>
      saveAvatarConfig: (params: { id: string; name: string; languageStyle: string; voice?: string; scale?: number; xOffset?: number; yOffset?: number }) => Promise<boolean>
      synthesizeTts: (text: string, voice: string) => Promise<ArrayBuffer | null>
      playTtsAudio: (audioBuffer: ArrayBuffer) => Promise<boolean>
      onPlayTtsAudio: (callback: (audioBuffer: ArrayBuffer) => void) => () => void
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
      onWechatSessionUpdated: (callback: (sessionId?: string) => void) => () => void
      syncMcpConfig: (config: any) => Promise<boolean>
      testMcpServer: (config: any) => Promise<any>
      getMcpConfig: () => Promise<any>
      onRequestGeolocation: (callback: (data: { requestId: number }) => void) => () => void
      respondGeolocation: (requestId: number, location: any, error?: string) => void
      copyText: (text: string) => void
      copyImage: (imageUrl: string) => Promise<{ success: boolean; error?: string }>
      copyFiles: (filePaths: string[], text?: string) => Promise<{ success: boolean; error?: string }>
      readClipboardFiles: () => Promise<{ type: 'files'; paths: string[] } | { type: 'image'; path: string; name: string } | null>
      showImageContextMenu: (imageUrl: string) => void
      showTextContextMenu: (selectedText: string) => void
      showPetContextMenu: () => void
      sendPetReplyToInput: (responseText: string) => void
      onPetReplyResponse: (callback: (responseText: string) => void) => () => void
      sendPendingInput: (text: string) => void
      onPendingInput: (callback: (text: string) => void) => () => void
      getPendingInput: () => Promise<string>
      startScreenshot: () => void
      getScreenshotByDisplayId: (displayId: string) => Promise<string>
      cancelScreenshot: () => void
      completeScreenshot: (croppedBase64: string, bounds: { x: number; y: number; width: number; height: number }) => void
      onSetScreenshotImage: (callback: (data: { path: string; base64: string; width: number; height: number }) => void) => () => void
      openLocalFile: (url: string) => Promise<{ success: boolean; error?: string }>
      minimizeAgentWindow: () => void
      maximizeAgentWindow: () => void
      closeAgentWindow: () => void
      isAgentWindowMaximized: () => Promise<boolean>
      testSshConnection: (config: any) => Promise<{ success: boolean; message?: string }>
      connectSsh: (sessionId: string, config: any) => Promise<{ success: boolean; message?: string }>
      disconnectSsh: (sessionId: string) => Promise<void>
      getSshStatus: (sessionId: string) => Promise<{ connected: boolean; host?: string; username?: string }>
      setExecutionDevice: (sessionId: string, type: 'local' | 'ssh') => Promise<void>
      getExecutionDevice: (sessionId: string) => Promise<'local' | 'ssh'>
    }
  }
}


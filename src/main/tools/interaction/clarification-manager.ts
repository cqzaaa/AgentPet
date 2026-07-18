import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import type { WebContents } from 'electron'

export type ClarificationOption = { label: string; value: string }
export type ClarificationQuestion = {
  id: string
  question: string
  options?: ClarificationOption[]
  allowCustom?: boolean
  placeholder?: string
}

type PendingRequest = {
  resolve: (value: { cancelled: boolean; answers: Record<string, string> }) => void
  timer: NodeJS.Timeout
}

class ClarificationManager {
  private pending = new Map<number, PendingRequest>()
  private pendingNotifications = new Map<number, Notification>()
  private nextRequestId = 1

  constructor() {
    ipcMain.on('api:clarification-response', (_event, data) => {
      const requestId = Number(data?.requestId)
      const pending = this.pending.get(requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      this.closeNotification(requestId)
      pending.resolve({
        cancelled: Boolean(data?.cancelled),
        answers: data?.answers && typeof data.answers === 'object' ? data.answers : {}
      })
    })
  }

  public request(questions: ClarificationQuestion[], sessionId?: string, sender?: WebContents): Promise<{ cancelled: boolean; answers: Record<string, string> }> {
    const target = sender ? BrowserWindow.fromWebContents(sender) : (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0])
    if (!target || target.isDestroyed()) return Promise.resolve({ cancelled: true, answers: {} })

    const requestId = this.nextRequestId++
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return
        this.pending.delete(requestId)
        this.closeNotification(requestId)
        resolve({ cancelled: true, answers: {} })
      }, 10 * 60 * 1000)
      this.pending.set(requestId, { resolve, timer })

      target.webContents.send('api:llm-tool-event', { type: 'clarification_request', requestId, questions, sessionId })
      if (!target.isFocused() || target.isMinimized() || !target.isVisible()) {
        this.showClarificationNotification(requestId, target)
      }
    })
  }

  private showClarificationNotification(requestId: number, win: BrowserWindow): void {
    if (!Notification.isSupported()) {
      win.flashFrame(true)
      return
    }

    const notification = new Notification({
      title: 'AgentPet 等待你的决定',
      body: '任务需要你补充信息后才能继续，点击返回应用查看详情。'
    })
    this.pendingNotifications.set(requestId, notification)
    notification.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      app.focus({ steal: true })
      win.focus()
      win.flashFrame(false)
      this.closeNotification(requestId)
    })
    notification.on('close', () => this.pendingNotifications.delete(requestId))
    notification.on('failed', () => this.pendingNotifications.delete(requestId))
    notification.show()
  }

  private closeNotification(requestId: number): void {
    const notification = this.pendingNotifications.get(requestId)
    if (!notification) return
    this.pendingNotifications.delete(requestId)
    notification.close()
  }
}

export const clarificationManager = new ClarificationManager()

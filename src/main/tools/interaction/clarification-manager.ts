import { BrowserWindow, ipcMain } from 'electron'
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
  private nextRequestId = 1

  constructor() {
    ipcMain.on('api:clarification-response', (_event, data) => {
      const requestId = Number(data?.requestId)
      const pending = this.pending.get(requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
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
    target.webContents.send('api:llm-tool-event', { type: 'clarification_request', requestId, questions, sessionId })
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return
        this.pending.delete(requestId)
        resolve({ cancelled: true, answers: {} })
      }, 10 * 60 * 1000)
      this.pending.set(requestId, { resolve, timer })
    })
  }
}

export const clarificationManager = new ClarificationManager()

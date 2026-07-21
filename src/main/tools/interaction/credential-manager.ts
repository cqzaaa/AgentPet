import { BrowserWindow, ipcMain } from 'electron'
import type { WebContents } from 'electron'

export type CredentialRequest = {
  kind: 'paddleocr-api'
  title: string
  description: string
  guideUrl: string
  fieldLabel: string
  placeholder?: string
}

type PendingRequest = {
  resolve: (value: { cancelled: boolean; token: string }) => void
  timer: NodeJS.Timeout
  sessionId?: string
}

class CredentialManager {
  private pending = new Map<number, PendingRequest>()
  private nextRequestId = 1

  constructor() {
    ipcMain.on('api:credential-response', (_event, data) => {
      const requestId = Number(data?.requestId)
      const pending = this.pending.get(requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve({
        cancelled: Boolean(data?.cancelled),
        token: typeof data?.token === 'string' ? data.token.trim() : ''
      })
    })
  }

  public request(
    request: CredentialRequest,
    sessionId?: string,
    sender?: WebContents
  ): Promise<{ cancelled: boolean; token: string }> {
    const target = sender
      ? BrowserWindow.fromWebContents(sender)
      : BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!target || target.isDestroyed()) return Promise.resolve({ cancelled: true, token: '' })

    const requestId = this.nextRequestId++
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return
        this.pending.delete(requestId)
        resolve({ cancelled: true, token: '' })
      }, 10 * 60 * 1000)
      this.pending.set(requestId, { resolve, timer, sessionId })
      target.webContents.send('api:llm-tool-event', {
        type: 'credential_request',
        requestId,
        request,
        sessionId
      })
    })
  }

  public cancelPending(sessionId?: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (sessionId && pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve({ cancelled: true, token: '' })
    }
  }
}

export const credentialManager = new CredentialManager()

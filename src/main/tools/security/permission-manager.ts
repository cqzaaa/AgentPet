import { BrowserWindow, ipcMain } from 'electron'

type PermissionScope = 'once' | 'turn'

type PermissionResponse = {
  approved: boolean
  scope: PermissionScope
}

export class PermissionManager {
  private static instance: PermissionManager
  private pendingPermissions = new Map<number, (response: PermissionResponse) => void>()
  private turnApprovals = new Map<string, number>()
  private nextPermissionRequestId = 1

  private constructor() {
    ipcMain.on('api:permission-response', (_, { requestId, approved, scope }) => {
      const resolve = this.pendingPermissions.get(requestId)
      if (!resolve) return

      resolve({
        approved: !!approved,
        scope: scope === 'turn' ? 'turn' : 'once'
      })
      this.pendingPermissions.delete(requestId)
    })
  }

  public static getInstance(): PermissionManager {
    if (!PermissionManager.instance) {
      PermissionManager.instance = new PermissionManager()
    }
    return PermissionManager.instance
  }

  public async requestCommandPermission(params: {
    command: string
    execCwd: string
    sessionId?: string
    warning?: string
  }): Promise<boolean> {
    if (this.isTurnApprovalGranted(params.sessionId)) {
      return true
    }

    const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!activeWin) {
      console.warn('[PermissionManager] No active window found for command approval')
      return false
    }

    const reqId = this.nextPermissionRequestId++
    activeWin.webContents.send('api:request-permission', {
      requestId: reqId,
      command: params.command,
      execCwd: params.execCwd,
      sessionId: params.sessionId,
      warning: params.warning
    })

    return new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(reqId, (response) => {
        if (response.approved && response.scope === 'turn' && params.sessionId) {
          this.grantTurnApproval(params.sessionId)
        }
        resolve(response.approved)
      })

      setTimeout(() => {
        if (!this.pendingPermissions.has(reqId)) return
        this.pendingPermissions.delete(reqId)
        resolve(false)
      }, 300000)
    })
  }

  public isTurnApprovalGranted(sessionId?: string): boolean {
    if (!sessionId) return false
    const expiresAt = this.turnApprovals.get(sessionId)
    if (!expiresAt) return false

    if (Date.now() > expiresAt) {
      this.turnApprovals.delete(sessionId)
      return false
    }

    return true
  }

  public getNextRequestId(): number {
    return this.nextPermissionRequestId++
  }

  public clearPendingPermissions(): void {
    for (const [, resolve] of this.pendingPermissions.entries()) {
      resolve({ approved: false, scope: 'once' })
    }
    this.pendingPermissions.clear()
    this.turnApprovals.clear()
  }

  private grantTurnApproval(sessionId: string): void {
    this.turnApprovals.set(sessionId, Date.now() + 10 * 60 * 1000)
  }
}

export const permissionManager = PermissionManager.getInstance()

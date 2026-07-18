import { app, BrowserWindow, ipcMain, Notification, WebContents } from 'electron'

type PermissionScope = 'once' | 'turn'

type PermissionResponse = {
  approved: boolean
  scope: PermissionScope
}

export class PermissionManager {
  private static instance: PermissionManager
  private pendingPermissions = new Map<number, (response: PermissionResponse) => void>()
  private pendingNotifications = new Map<number, Notification>()
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
      this.closeNotification(requestId)
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
    sender?: WebContents
  }): Promise<boolean> {
    if (this.isTurnApprovalGranted(params.sessionId)) {
      return true
    }

    const ownerWin = params.sender ? BrowserWindow.fromWebContents(params.sender) : null
    const activeWin = ownerWin || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!activeWin) {
      console.warn('[PermissionManager] No active window found for command approval')
      return false
    }

    const reqId = this.nextPermissionRequestId++
    return new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(reqId, (response) => {
        if (response.approved && response.scope === 'turn' && params.sessionId) {
          this.grantTurnApproval(params.sessionId)
        }
        resolve(response.approved)
      })

      activeWin.webContents.send('api:request-permission', {
        requestId: reqId,
        command: params.command,
        execCwd: params.execCwd,
        sessionId: params.sessionId,
        warning: params.warning
      })

      if (!activeWin.isFocused() || activeWin.isMinimized() || !activeWin.isVisible()) {
        this.showPermissionNotification(reqId, activeWin)
      }

      setTimeout(() => {
        if (!this.pendingPermissions.has(reqId)) return
        this.pendingPermissions.delete(reqId)
        this.closeNotification(reqId)
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
    for (const requestId of this.pendingNotifications.keys()) this.closeNotification(requestId)
    this.turnApprovals.clear()
  }

  private showPermissionNotification(requestId: number, win: BrowserWindow): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: 'AgentPet 需要审批',
      body: '有一项操作正在等待你的确认，点击返回应用查看详情。'
    })
    this.pendingNotifications.set(requestId, notification)
    notification.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      app.focus({ steal: true })
      win.focus()
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

  private grantTurnApproval(sessionId: string): void {
    this.turnApprovals.set(sessionId, Date.now() + 10 * 60 * 1000)
  }
}

export const permissionManager = PermissionManager.getInstance()

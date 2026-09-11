import { app, BrowserWindow, ipcMain, Notification, WebContents } from 'electron'

type PermissionScope = 'once' | 'turn'

type PermissionResponse = {
  approved: boolean
  scope: PermissionScope
  reason?: string
}

export class PermissionManager {
  private static instance: PermissionManager
  private pendingPermissions = new Map<number, (response: PermissionResponse) => void>()
  private pendingNotifications = new Map<number, Notification>()
  private turnApprovals = new Map<string, number>()
  private nextPermissionRequestId = 1

  private constructor() {
    ipcMain.on('api:permission-response', (_, { requestId, approved, scope, reason }) => {
      const resolve = this.pendingPermissions.get(requestId)
      if (!resolve) return

      resolve({
        approved: !!approved,
        scope: scope === 'turn' ? 'turn' : 'once',
        reason: typeof reason === 'string' ? reason.trim().slice(0, 1000) : undefined
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
    forcePrompt?: boolean
    allowTurnScope?: boolean
    interactionOrigin?: 'chat' | 'orchestration'
    taskRunId?: string
    taskStepId?: string
  }): Promise<PermissionResponse> {
    const approvalScopeId =
      params.interactionOrigin === 'orchestration' && params.taskRunId
        ? `${params.sessionId || 'default'}:orchestration:${params.taskRunId}`
        : params.sessionId
    const highRisk = this.isHighRiskRequest(params.command, params.warning)
    if (!params.forcePrompt && !highRisk && this.isTurnApprovalGranted(approvalScopeId)) {
      return { approved: true, scope: 'turn' }
    }

    const ownerWin = params.sender ? BrowserWindow.fromWebContents(params.sender) : null
    const activeWin =
      ownerWin || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!activeWin) {
      console.warn('[PermissionManager] No active window found for command approval')
      return { approved: false, scope: 'once' }
    }

    const reqId = this.nextPermissionRequestId++
    return new Promise<PermissionResponse>((resolve) => {
      this.pendingPermissions.set(reqId, (response) => {
        if (
          response.approved &&
          response.scope === 'turn' &&
          approvalScopeId &&
          params.allowTurnScope !== false
        ) {
          this.grantTurnApproval(approvalScopeId)
        }
        resolve(response)
      })

      activeWin.webContents.send('api:request-permission', {
        requestId: reqId,
        command: params.command,
        execCwd: params.execCwd,
        sessionId: params.sessionId,
        warning: params.warning,
        allowTurnScope: params.allowTurnScope !== false,
        interactionOrigin: params.interactionOrigin || 'chat',
        taskRunId: params.taskRunId,
        taskStepId: params.taskStepId
      })

      if (!activeWin.isFocused() || activeWin.isMinimized() || !activeWin.isVisible()) {
        this.showPermissionNotification(reqId, activeWin, params.interactionOrigin)
      }

      setTimeout(() => {
        if (!this.pendingPermissions.has(reqId)) return
        this.pendingPermissions.delete(reqId)
        this.closeNotification(reqId)
        resolve({ approved: false, scope: 'once' })
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

  private showPermissionNotification(
    requestId: number,
    win: BrowserWindow,
    interactionOrigin?: 'chat' | 'orchestration'
  ): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: interactionOrigin === 'orchestration' ? '多 Agent 编排需要审批' : 'AgentPet 需要审批',
      body:
        interactionOrigin === 'orchestration'
          ? '协作节点正在等待确认，点击返回编排运行台查看详情。'
          : '有一项操作正在等待你的确认，点击返回应用查看详情。'
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
    // Conversation-scoped approval lasts until the session permission state is
    // cleared. High-risk requests are filtered before this grant is consulted.
    this.turnApprovals.set(sessionId, Number.POSITIVE_INFINITY)
  }

  private isHighRiskRequest(command: string, warning?: string): boolean {
    return /删除|永久|高危|敏感|delete_file|\brm\b|\bdel\b|remove-item|purge|format\b/i.test(
      `${command}\n${warning || ''}`
    )
  }
}

export const permissionManager = PermissionManager.getInstance()

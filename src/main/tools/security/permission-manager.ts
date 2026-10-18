import { app, BrowserWindow, ipcMain, Notification, WebContents } from 'electron'
import { createHash } from 'crypto'
import * as fs from 'fs'
import { join } from 'path'
import { getActiveStorageDir } from '../utils/paths'

export interface ScheduledTaskAuthorization {
  scope: 'scheduled-task'
  fingerprint: string
  approvedAt: number
}

export interface AuthorizableScheduledTask {
  name?: string
  interval?: number
  repeat?: boolean
  executeAt?: number
  nextRunAt?: number
  kind?: 'prompt' | 'workflow'
  workflowId?: string
  action?: string
  authorization?: ScheduledTaskAuthorization
}

function scheduledTaskFingerprint(task: AuthorizableScheduledTask): string {
  const isSingleRun = task.repeat === false
  const normalized = isSingleRun
    ? {
        kind: task.kind || 'prompt',
        workflowId: task.kind === 'workflow' ? String(task.workflowId || '') : '',
        repeat: false,
        executeAt: Number(task.executeAt || task.nextRunAt || 0),
        action: task.kind === 'workflow' ? '' : String(task.action || '').trim()
      }
    : {
        kind: task.kind || 'prompt',
        workflowId: task.kind === 'workflow' ? String(task.workflowId || '') : '',
        interval: Number(task.interval) || 0,
        action: task.kind === 'workflow' ? '' : String(task.action || '').trim()
      }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function hasValidScheduledTaskAuthorization(task: AuthorizableScheduledTask): boolean {
  return (
    task.authorization?.scope === 'scheduled-task' &&
    task.authorization.fingerprint === scheduledTaskFingerprint(task)
  )
}

function createScheduledTaskAuthorization(
  task: AuthorizableScheduledTask
): ScheduledTaskAuthorization {
  return {
    scope: 'scheduled-task',
    fingerprint: scheduledTaskFingerprint(task),
    approvedAt: Date.now()
  }
}

function describeScheduledTask(task: AuthorizableScheduledTask): string {
  const isSingleRun = task.repeat === false
  const operation =
    task.kind === 'workflow'
      ? `运行工作流 ${String(task.workflowId || '未选择')}`
      : String(task.action || '').trim() || '未填写执行指令'
  if (isSingleRun) {
    const dueTime = task.executeAt || task.nextRunAt
    const timeStr = dueTime ? new Date(dueTime).toLocaleString('zh-CN') : '立即执行'
    return `单次定时任务「${String(task.name || '未命名任务')}」\n执行时间: ${timeStr}（仅执行一次）\n${operation}`
  }
  const interval = Math.max(0, Number(task.interval) || 0)
  return `循环定时任务「${String(task.name || '未命名任务')}」\n每 ${interval} 秒执行一次\n${operation}`
}
type PermissionScope = 'once' | 'turn'

type PermissionResponse = {
  approved: boolean
  scope: PermissionScope
  reason?: string
}

export function permissionScopeId(params: { sessionId?: string; interactionOrigin?: string; taskRunId?: string }): string | undefined {
  return params.interactionOrigin === 'orchestration' && params.taskRunId
    ? `${params.sessionId || 'default'}:orchestration:${params.taskRunId}`
    : params.sessionId
}

export class PermissionManager {
  private static instance: PermissionManager
  private pendingPermissions = new Map<number, (response: PermissionResponse) => void>()
  private pendingNotifications = new Map<number, Notification>()
  private turnApprovals = new Map<string, number>()
  private scopedApprovalRequests = new Map<string, Promise<PermissionResponse>>()
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
    permissionKind?: 'scheduled-task'
  }): Promise<PermissionResponse> {
    const scheduledTaskId = this.scheduledTaskIdFromSession(params.sessionId)
    if (scheduledTaskId && (await this.isScheduledTaskAuthorized(scheduledTaskId))) {
      return { approved: true, scope: 'turn' }
    }
    const approvalScopeId = permissionScopeId(params)
    const highRisk = this.isHighRiskRequest(params.command, params.warning)
    if (!params.forcePrompt && !highRisk && this.isTurnApprovalGranted(approvalScopeId)) {
      return { approved: true, scope: 'turn' }
    }

    // Tool calls can execute in parallel. Queue approval prompts for the same
    // conversation so the UI never has two active cards. If the first ordinary
    // request grants turn scope, eligible waiters inherit it immediately.
    if (approvalScopeId) {
      const pendingScopedApproval = this.scopedApprovalRequests.get(approvalScopeId)
      if (pendingScopedApproval) {
        const response = await pendingScopedApproval
        if (!params.forcePrompt && !highRisk && response.approved && response.scope === 'turn' && this.isTurnApprovalGranted(approvalScopeId)) {
          return { approved: true, scope: 'turn' }
        }
      }
    }

    const ownerWin = params.sender ? BrowserWindow.fromWebContents(params.sender) : null
    const activeWin =
      ownerWin || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!activeWin) {
      console.warn('[PermissionManager] No active window found for command approval')
      return { approved: false, scope: 'once' }
    }

    const reqId = this.nextPermissionRequestId++
    const permissionRequest = new Promise<PermissionResponse>((resolve) => {
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
        taskStepId: params.taskStepId,
        permissionKind: params.permissionKind
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
    if (approvalScopeId) {
      this.scopedApprovalRequests.set(approvalScopeId, permissionRequest)
    }
    try {
      return await permissionRequest
    } finally {
      if (approvalScopeId && this.scopedApprovalRequests.get(approvalScopeId) === permissionRequest) {
        this.scopedApprovalRequests.delete(approvalScopeId)
      }
    }
  }

  public async requestScheduledTaskAuthorization(
    task: AuthorizableScheduledTask,
    sender?: WebContents
  ): Promise<ScheduledTaskAuthorization | null> {
    if (hasValidScheduledTaskAuthorization(task)) return task.authorization || null
    const response = await this.requestCommandPermission({
      command: describeScheduledTask(task),
      execCwd: getActiveStorageDir(),
      sessionId: `cron-setup:${Date.now()}`,
      warning:
        '确认后，这个定时任务可在无人值守时执行所需操作，不会在每次触发时再次等待审批。修改执行内容或频率后，授权会自动失效。',
      sender,
      forcePrompt: true,
      allowTurnScope: false,
      permissionKind: 'scheduled-task'
    })
    return response.approved ? createScheduledTaskAuthorization(task) : null
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
    this.scopedApprovalRequests.clear()
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

  private scheduledTaskIdFromSession(sessionId?: string): string | null {
    const match = String(sessionId || '').match(/^cron:([^:]+):/)
    return match?.[1] || null
  }

  private async isScheduledTaskAuthorized(taskId: string): Promise<boolean> {
    try {
      const cronPath = join(getActiveStorageDir(), 'cron_tasks.json')
      const tasks = JSON.parse(await fs.promises.readFile(cronPath, 'utf8'))
      if (!Array.isArray(tasks)) return false
      const task = tasks.find((item) => String(item?.id || '') === taskId)
      return !!task && hasValidScheduledTaskAuthorization(task)
    } catch {
      return false
    }
  }

  private isHighRiskRequest(command: string, warning?: string): boolean {
    return /删除|永久|高危|敏感|delete_file|\brm\b|\bdel\b|remove-item|purge|format\b/i.test(
      `${command}\n${warning || ''}`
    )
  }
}

export const permissionManager = PermissionManager.getInstance()

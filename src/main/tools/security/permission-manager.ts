import { BrowserWindow, ipcMain } from 'electron'

export class PermissionManager {
  private static instance: PermissionManager
  private pendingPermissions = new Map<number, (approved: boolean) => void>()
  private nextPermissionRequestId = 1

  private constructor() {
    // 监听渲染进程返回的审批响应
    ipcMain.on('api:permission-response', (_, { requestId, approved }) => {
      const resolve = this.pendingPermissions.get(requestId)
      if (resolve) {
        resolve(!!approved)
        this.pendingPermissions.delete(requestId)
      }
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
    warning?: string
  }): Promise<boolean> {
    const activeWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    if (!activeWin) {
      console.warn('[PermissionManager] 未找到活动窗口，无法请求命令执行审批')
      return false
    }

    const reqId = this.nextPermissionRequestId++
    activeWin.webContents.send('api:request-permission', {
      requestId: reqId,
      command: params.command,
      execCwd: params.execCwd,
      warning: params.warning
    })

    return new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(reqId, resolve)
      // 5分钟超时保护
      setTimeout(() => {
        if (this.pendingPermissions.has(reqId)) {
          resolve(false)
          this.pendingPermissions.delete(reqId)
        }
      }, 300000)
    })
  }

  public getNextRequestId(): number {
    return this.nextPermissionRequestId++
  }

  public clearPendingPermissions(): void {
    if (this.pendingPermissions.size > 0) {
      for (const [, resolve] of this.pendingPermissions.entries()) {
        resolve(false)
      }
      this.pendingPermissions.clear()
    }
  }
}


export const permissionManager = PermissionManager.getInstance()

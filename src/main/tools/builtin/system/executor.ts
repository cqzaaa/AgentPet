import { ipcMain } from 'electron'

import * as os from 'os'
import * as fs from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { getActiveStorageDir, getGeneratedFilesDir } from '../../utils/paths'
import { permissionManager } from '../../security/permission-manager'

const execAsync = promisify(exec)

export class SystemExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. get_system_status
      if (api === 'get_system_status') {
        const cpus = os.cpus()
        const freeMem = os.freemem()
        const totalMem = os.totalmem()
        const info = {
          cpuModel: cpus[0]?.model || 'Unknown CPU',
          cpuCount: cpus.length,
          freeMemory: `${(freeMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
          totalMemory: `${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
          platform: os.platform(),
          release: os.release(),
          uptime: `${Math.round(os.uptime() / 3600)} 小时`
        }
        return { content: JSON.stringify(info, null, 2), success: true }
      }

      // 2. get_location
      if (api === 'get_location') {
        const activeWin = context.event?.sender
        if (!activeWin) {
          return { content: '获取定位失败：无法获取当前活动的渲染进程实例。', success: false }
        }

        const psScript = `
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference  = 'SilentlyContinue'
$WarningPreference  = 'SilentlyContinue'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# 加载 WinRT 类型
$null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType=WindowsRuntime]

# 获取 AsTask 泛型扩展方法
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod } |
  Select-Object -First 1

$geoposType = [Windows.Devices.Geolocation.Geoposition, Windows.Devices.Geolocation, ContentType=WindowsRuntime]
$asTask = $asTaskMethod.MakeGenericMethod($geoposType)

$geo = [Windows.Devices.Geolocation.Geolocator]::new()
$geo.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High

$asyncOp = $geo.GetGeopositionAsync()
$task = $asTask.Invoke($null, @($asyncOp))

if (-not $task.Wait(15000)) {
  Write-Output 'ERROR:LocationTimeout'
} elseif ($task.IsFaulted) {
  Write-Output "ERROR:LocationFailed:$($task.Exception.InnerException.Message)"
} else {
  $pos = $task.Result
  $acc = if ($pos.Coordinate.Accuracy -ne $null) { $pos.Coordinate.Accuracy } else { 50 }
  Write-Output "$($pos.Coordinate.Latitude),$($pos.Coordinate.Longitude),$acc"
}
`
        let winCoords: { latitude: number; longitude: number; accuracy: number } | null = null
        let winError = ''

        try {
          const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
          const { stdout } = await execAsync(`powershell -EncodedCommand ${encoded}`, { timeout: 22000 })
          const out = stdout.trim()

          const coordMatch = out.match(/^(-?\d+\.\d+),(-?\d+\.\d+),?(\d*\.?\d*)$/m)
          if (coordMatch) {
            winCoords = {
              latitude: parseFloat(coordMatch[1]),
              longitude: parseFloat(coordMatch[2]),
              accuracy: coordMatch[3] ? parseFloat(coordMatch[3]) : 50
            }
          } else if (out.startsWith('ERROR:')) {
            winError = out.replace('ERROR:', '')
          } else {
            winError = out || '脚本无输出，请检查 Windows 位置服务权限'
          }
        } catch (psErr: any) {
          winError = psErr?.message || String(psErr)
        }

        if (!winCoords) {
          return {
            content: [
              `获取 Windows 物理定位失败：${winError}`,
              '',
              '请检查以下设置：',
              '① Windows 设置 → 隐私和安全性 → 位置 → 开启「位置服务」',
              '② 同页面开启「允许桌面应用访问你的位置」',
              '③ 确保 Wi-Fi 已连接（用于 Wi-Fi 三角定位）'
            ].join('\n'),
            success: false
          }
        }

        try {
          if (!activeWin.debugger.isAttached()) activeWin.debugger.attach('1.3')
          await activeWin.debugger.sendCommand('Emulation.setGeolocationOverride', {
            latitude: winCoords.latitude,
            longitude: winCoords.longitude,
            accuracy: winCoords.accuracy
          })
        } catch (debugErr: any) {
          console.warn('[Geolocation] debugger 注入失败，直接返回坐标:', debugErr?.message)
          return {
            content: JSON.stringify({
              status: 'success',
              latitude: winCoords.latitude,
              longitude: winCoords.longitude,
              accuracy: `${winCoords.accuracy.toFixed(1)}m`,
              provider: 'windows_winrt_geolocator'
            }, null, 2),
            success: true
          }
        }

        const locationResult = await new Promise<string>((resolve) => {
          const reqId = permissionManager.getNextRequestId()
          activeWin.send('api:request-geolocation', { requestId: reqId })

          const onResponse = (_evt: any, resp: { requestId: number; location?: { latitude: number; longitude: number; accuracy: number }; error?: string }) => {
            if (resp && resp.requestId === reqId) {
              ipcMain.removeListener('api:geolocation-response', onResponse)
              const coords = resp.location || winCoords!
              resolve(JSON.stringify({
                status: 'success',
                latitude: coords.latitude,
                longitude: coords.longitude,
                accuracy: `${typeof coords.accuracy === 'number' ? coords.accuracy.toFixed(1) : coords.accuracy}m`,
                provider: 'windows_winrt_geolocator'
              }, null, 2))
            }
          }

          ipcMain.on('api:geolocation-response', onResponse)

          setTimeout(() => {
            ipcMain.removeListener('api:geolocation-response', onResponse)
            resolve(JSON.stringify({
              status: 'success',
              latitude: winCoords!.latitude,
              longitude: winCoords!.longitude,
              accuracy: `${winCoords!.accuracy.toFixed(1)}m`,
              provider: 'windows_winrt_geolocator'
            }, null, 2))
          }, 15000)
        })

        return { content: locationResult, success: true }
      }

      // 3. manage_cron_task
      if (api === 'manage_cron_task') {
        const { action_type, name: taskName, interval, action, taskId } = args
        const cronPath = join(getActiveStorageDir(), 'cron_tasks.json')
        let tasks: any[] = []
        if (fs.existsSync(cronPath)) {
          const data = await fs.promises.readFile(cronPath, 'utf-8')
          tasks = JSON.parse(data)
        }

        if (action_type === 'create') {
          if (!taskName || !interval || !action) {
            return { content: '创建失败：缺少必要参数（name, interval, action）', success: false }
          }
          const newTask = {
            id: Date.now().toString(),
            name: taskName,
            interval: Math.max(2, interval),
            action: action,
            isActive: true,
            triggerCount: 0,
            lastTriggered: '未触发',
            logs: []
          }
          tasks.push(newTask)
          await fs.promises.writeFile(cronPath, JSON.stringify(tasks, null, 2), 'utf-8')

          context.event?.sender?.send('api:cron-updated')
          return {
            content: JSON.stringify({
              status: 'success',
              message: `成功创建定时任务："${taskName}"`,
              details: `执行周期为每 ${interval} 秒一次，操作指令: "${action}"`
            }),
            success: true
          }
        } else if (action_type === 'delete') {
          if (!taskId) {
            return { content: '删除失败：缺少 taskId 参数', success: false }
          }
          const filtered = tasks.filter((t: any) => t.id !== taskId)
          if (filtered.length === tasks.length) {
            return { content: `未找到 ID 为 ${taskId} 的定时任务`, success: false }
          }
          await fs.promises.writeFile(cronPath, JSON.stringify(filtered, null, 2), 'utf-8')

          context.event?.sender?.send('api:cron-updated')
          return { content: `已成功删除 ID 为 ${taskId} 的定时任务`, success: true }
        }
        return { content: `未知的操作类型: ${action_type}`, success: false }
      }

      // 4. extend_task_loop (实际逻辑在 callLlmInternal 中拦截处理)
      if (api === 'extend_task_loop') {
        return { content: '此工具由系统内部 LLM 循环拦截处理。', success: true }
      }

      // 5. trigger_memory_purify (实际逻辑在 callLlmInternal 中拦截处理)
      if (api === 'trigger_memory_purify') {
        return { content: '此工具由系统内部 LLM 循环拦截处理。', success: true }
      }


      // 7. append_memory_summary
      if (api === 'append_memory_summary') {
        const { content } = args
        if (!content) {
          return { content: '错误：缺少必要参数 content', success: false }
        }
        if (!context.sessionId) {
          return { content: '错误：无法获取当前会话 ID (sessionId为空)', success: false }
        }

        const safeSessionId = context.sessionId.replace(/[<>:"/\\|?*]/g, '_')
        const sessionMemoryDir = join(getActiveStorageDir(), 'chat', safeSessionId, 'memory')
        
        try {
          if (!fs.existsSync(sessionMemoryDir)) {
            await fs.promises.mkdir(sessionMemoryDir, { recursive: true })
          }

          const now = new Date()
          const year = now.getFullYear()
          const month = String(now.getMonth() + 1).padStart(2, '0')
          const day = String(now.getDate()).padStart(2, '0')
          const fileName = `${year}-${month}-${day}.md`
          const filePath = join(sessionMemoryDir, fileName)

          await fs.promises.appendFile(filePath, content + '\n\n', 'utf-8')
          return {
            content: `成功：已将摘要追加写入今日记忆文件 ${fileName}。绝对物理路径: ${filePath}`,
            success: true
          }
        } catch (err: any) {
          return {
            content: `追加记忆失败: ${err.message || err}`,
            success: false
          }
        }
      }

      return { content: `未知的操作类型: ${api}`, success: false }
    } catch (err: any) {
      return {
        content: `系统操作异常: ${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    }
  }

  public getApiNames(): string[] {
    return ['get_system_status', 'get_location', 'manage_cron_task', 'extend_task_loop', 'trigger_memory_purify', 'append_memory_summary']
  }
}

export const systemExecutor = new SystemExecutor()

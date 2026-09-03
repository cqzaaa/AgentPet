import { ipcMain } from 'electron'

import * as os from 'os'
import * as fs from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { getActiveStorageDir } from '../../utils/paths'
import { permissionManager } from '../../security/permission-manager'
import { appendMemorySummaryInternal } from '../../../api/memory'
import { clarificationManager } from '../../interaction/clarification-manager'
import { taskRunner } from '../../../task-runtime/task-runner'
import type { TaskPlanInputStep } from '../../../task-runtime/types'
import { buildUnknownTaskStepFeedback, listTaskStepReferences } from '../../../task-runtime/tool-feedback'
import { skillRegistry } from '../../../skills/skill-registry'
import {
  startManagedPptMasterPreparation,
  waitForManagedPptMasterPreparation
} from '../../../skills/managed-skill-runtime'
import { subagentRunner } from '../../../task-runtime/subagent-runner'
import { SUBAGENT_ROLES, type DelegateTaskInput } from '../../../task-runtime/types'
import { externalAgentManager } from '../../../external-agents'

const execAsync = promisify(exec)

export class SystemExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      if (api === 'update_task_plan') {
        const allowedStatuses = new Set(['pending', 'in_progress', 'completed', 'blocked'])
        const title = String(args.title || '').trim().slice(0, 120)
        const rawSteps = Array.isArray(args.steps) ? args.steps.slice(0, 12) : []
        const seenIds = new Set<string>()
        const steps: TaskPlanInputStep[] = rawSteps
          .map((step: any, index: number) => {
            let id = String(step?.id || `step-${index + 1}`).trim().slice(0, 64) || `step-${index + 1}`
            if (seenIds.has(id)) id = `${id}-${index + 1}`
            seenIds.add(id)
            return {
              id,
              title: String(step?.title || '').trim().slice(0, 180),
              status: (allowedStatuses.has(String(step?.status)) ? String(step.status) : 'pending') as TaskPlanInputStep['status'],
              detail: String(step?.detail || '').trim().slice(0, 500) || undefined,
              goal: String(step?.goal || '').trim().slice(0, 2000) || undefined,
              dependencies: Array.isArray(step?.dependencies) ? step.dependencies.map(String).filter(Boolean).slice(0, 12) : [],
              acceptanceCriteria: String(step?.acceptanceCriteria || '').trim().slice(0, 1000) || undefined,
              resultSummary: String(step?.resultSummary || '').trim().slice(0, 2000) || undefined,
              artifactPaths: Array.isArray(step?.artifactPaths) ? step.artifactPaths.map(String).filter(Boolean).slice(0, 30) : [],
              retryCount: Math.max(0, Math.min(20, Number(step?.retryCount) || 0)),
              agentId: String(step?.agentId || 'agentpet').trim(),
              model: String(step?.model || '').trim() || undefined
            }
          })
          .filter((step: any) => step.title)

        if (!title || steps.length < 2) {
          return { content: 'A new task plan requires a title and at least two valid steps. Do not send empty updates; use update_task_step after creation.', success: false }
        }
        const existing = await taskRunner.getRunForMessage(context.sessionId, context.messageId)
        if (existing) {
          return {
            content: JSON.stringify({
              error: 'plan_already_exists',
              taskRunId: existing.run.id,
              currentStepId: existing.steps.find(step => step.status === 'running')?.id,
              validSteps: listTaskStepReferences(existing.steps),
              message: 'The plan structure is immutable. Retry update_task_step with one exact id from validSteps.'
            }),
            state: existing,
            success: false
          }
        }
        const activeSteps = steps.filter(step => step.status === 'in_progress')
        if (activeSteps.length > 1) {
          return { content: 'A task plan may have only one in_progress step.', success: false }
        }
        if (activeSteps.length === 0) steps[0].status = 'in_progress'

        // Keep the message trace for historical rendering, and mirror the same
        // plan into the durable task tables for long-running task recovery.
        const taskRun = await taskRunner.updatePlan(context.sessionId, context.messageId, {
          title,
          explanation: typeof args.explanation === 'string' ? args.explanation.trim().slice(0, 500) : undefined,
          workspacePath: context.workspacePath || undefined,
          parentTurn: context.turn,
          parentMessageId: context.messageId === undefined ? undefined : String(context.messageId),
          parentToolCallId: context.toolCallId,
          steps
        })

        // The tool call arguments are retained in the message trace. Keep the
        // acknowledgement compact so repeated progress updates cost very little.
        const completed = steps.filter((step: any) => step.status === 'completed').length
        const blocked = steps.some((step: any) => step.status === 'blocked')
        return {
          content: JSON.stringify({
            taskRunId: taskRun.id,
            status: blocked ? 'blocked' : completed === steps.length ? 'completed' : 'active',
            completed,
            total: steps.length,
            currentStepId: steps.find(step => step.status === 'in_progress')?.id,
            steps: steps.map(step => ({ id: step.id, title: step.title, status: step.status }))
          }),
          success: true
        }
      }

      if (api === 'update_task_step') {
        const taskRunId = String(args.taskRunId || '').trim()
        const stepId = String(args.stepId || '').trim()
        const status = String(args.status || '') as 'in_progress' | 'completed' | 'blocked'
        if (!taskRunId || !stepId || !['in_progress', 'completed', 'blocked'].includes(status)) {
          return { content: 'update_task_step requires taskRunId, stepId, and a valid status.', success: false }
        }
        const ownedPlan = await taskRunner.getRun(taskRunId)
        if (!ownedPlan || ownedPlan.run.sessionId !== (context.sessionId || 'default')) {
          return { content: 'Task plan was not found in the current session.', success: false }
        }
        if (!ownedPlan.steps.some(step => step.id === stepId)) {
          return {
            content: JSON.stringify(buildUnknownTaskStepFeedback(stepId, ownedPlan.steps)),
            state: ownedPlan,
            success: false
          }
        }
        const snapshot = await taskRunner.updateStep(taskRunId, stepId, status, {
          detail: typeof args.detail === 'string' ? args.detail.trim().slice(0, 500) || undefined : undefined,
          resultSummary: typeof args.resultSummary === 'string' ? args.resultSummary.trim().slice(0, 2000) || undefined : undefined,
          artifactPaths: Array.isArray(args.artifactPaths) ? args.artifactPaths.map(String).filter(Boolean).slice(0, 30) : undefined
        })
        if (!snapshot) return { content: 'Task plan was not found.', success: false }
        const completed = snapshot.steps.filter(step => step.status === 'completed').length
        const current = snapshot.steps.find(step => step.status === 'running')
        return {
          content: JSON.stringify({
            taskRunId,
            status: snapshot.run.status,
            completed,
            total: snapshot.steps.length,
            currentStepId: current?.id
          }),
          state: snapshot,
          success: true
        }
      }

      if (api === 'list_agents') {
        const agents = await externalAgentManager.list()
        const result = agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          protocol: agent.protocol,
          source: agent.source,
          status: agent.probe?.status || 'unchecked',
          installed: agent.probe?.installed ?? null,
          description: agent.description
        }))
        return { content: JSON.stringify(result), state: result, success: true }
      }

      if (api === 'delegate_tasks') {
        let rawTasks: any[] = Array.isArray(args.tasks) ? args.tasks : []
        if (rawTasks.length === 0 && Array.isArray(args.subtasks)) rawTasks = args.subtasks
        if (rawTasks.length === 0 && typeof args.subtasks === 'string') {
          try {
            const parsed = JSON.parse(args.subtasks)
            if (Array.isArray(parsed)) rawTasks = parsed
          } catch { /* Validation below will return a useful error. */ }
        }
        const allowedRoles = new Set<string>(SUBAGENT_ROLES)
        const tasks: DelegateTaskInput[] = rawTasks.map((task: any, index: number) => ({
          id: String(task?.id || `agent-${index + 1}`).trim(),
          title: String(task?.title || task?.description || `Sub-agent ${index + 1}`).trim(),
          prompt: String(task?.prompt || task?.description || '').trim(),
          role: allowedRoles.has(String(task?.role || task?.type)) ? (task.role || task.type) : 'general',
          agentId: String(task?.agentId || 'agentpet').trim(),
          model: String(task?.model || '').trim() || undefined,
          dependencies: Array.isArray(task?.dependencies) ? task.dependencies.map(String).filter(Boolean) : [],
          acceptanceCriteria: String(task?.acceptanceCriteria || '').trim() || undefined
        }))
        const title = String(args.title || args.goal || 'Delegated task group').trim().slice(0, 120)
        const maxConcurrency = Math.max(1, Math.min(6, Number(args.maxConcurrency) || 3))
        const result = await subagentRunner.delegate(context.sessionId || 'default', context.messageId, context.turn, context.toolCallId, title, tasks, maxConcurrency, context.workspacePath, context.abortSignal)
        return { content: JSON.stringify(result), state: result, success: result.status === 'completed' }
      }

      if (api === 'request_skill') {
        const skills = Array.isArray(args.skills)
          ? args.skills.map((value: any) => ({
              id: String(value?.id || '').trim(),
              sections: Array.isArray(value?.sections)
                ? value.sections.map((section: unknown) => String(section || '').trim()).filter(Boolean)
                : undefined
            })).filter((value: { id: string }) => Boolean(value.id)).slice(0, 3)
          : []
        const reason = String(args.reason || '').trim().slice(0, 500)
        if (skills.length === 0 || !reason) {
          return { content: 'request_skill requires one to three skills and a reason.', success: false }
        }
        const readySkills: typeof skills = []
        const preparing: Array<Record<string, unknown>> = []
        for (const skill of skills) {
          if (skill.id === 'ppt-master' && (!skill.sections || skill.sections.length === 0)) {
            const preparation = startManagedPptMasterPreparation()
            if (preparation.status === 'installed') {
              readySkills.push(skill)
            } else {
              preparing.push({
                id: skill.id,
                status: preparation.status,
                operationId: preparation.operationId,
                startedAt: preparation.startedAt,
                message: preparation.status === 'preparing'
                  ? 'PPT Master 正在后台完成首次安装。请调用 wait_skill_ready 等待并激活该 Skill。'
                  : preparation.error
              })
            }
          } else {
            readySkills.push(skill)
          }
        }
        const result = readySkills.length > 0
          ? await skillRegistry.requestSkills(readySkills, context.sessionId, context.messageId)
          : { loaded: [], rejected: [], remainingSkillBudget: 16_000 }
        const allowedToolNames = [...new Set(result.loaded.flatMap(skill => skill.allowedTools))]
        return {
          content: JSON.stringify({ reason, ...result, preparing }),
          state: {
            loadedSkillIds: result.loaded.map(skill => skill.id),
            allowedToolNames,
            pendingSkillIds: preparing.map(skill => String(skill.id))
          },
          success: result.loaded.length > 0 || preparing.length > 0
        }
      }

      if (api === 'wait_skill_ready') {
        const id = String(args.id || '').trim()
        if (id !== 'ppt-master') {
          return { content: 'wait_skill_ready only supports a pending ppt-master installation.', success: false }
        }
        const timeoutSeconds = Math.max(1, Math.min(600, Number(args.timeout_seconds) || 180))
        const preparation = await waitForManagedPptMasterPreparation({
          timeoutMs: timeoutSeconds * 1000,
          abortSignal: context.abortSignal
        })
        if (preparation.status !== 'installed') {
          return {
            content: JSON.stringify({ id, ...preparation }),
            state: { pendingSkillIds: preparation.status === 'preparing' ? [id] : [] },
            success: preparation.status === 'preparing'
          }
        }
        const result = await skillRegistry.requestSkills([{ id }], context.sessionId, context.messageId)
        const allowedToolNames = [...new Set(result.loaded.flatMap(skill => skill.allowedTools))]
        return {
          content: JSON.stringify({ id, status: 'installed', ...result }),
          state: {
            loadedSkillIds: result.loaded.map(skill => skill.id),
            allowedToolNames,
            pendingSkillIds: []
          },
          success: result.loaded.length > 0
        }
      }

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

      if (api === 'request_user_clarification') {
        const rawQuestions = Array.isArray(args.questions) ? args.questions.slice(0, 3) : []
        const questions = this.dedupeClarificationQuestions(rawQuestions
          .filter(question => question && typeof question.id === 'string' && typeof question.question === 'string')
          .map(question => ({
            id: question.id.slice(0, 80),
            question: question.question.slice(0, 300),
            placeholder: typeof question.placeholder === 'string' ? question.placeholder.slice(0, 160) : '',
            allowCustom: true,
            options: Array.isArray(question.options)
              ? question.options.slice(0, 6).filter((option: any) => option && typeof option.label === 'string' && typeof option.value === 'string').map((option: any) => ({
                label: option.label.slice(0, 80),
                value: option.value.slice(0, 200),
                description: typeof option.description === 'string' ? option.description.slice(0, 120) : ''
              }))
              : []
          })))
        if (questions.length === 0) return { content: '错误：至少需要一个有效的澄清问题。', success: false }

        const response = await clarificationManager.request(questions, context.sessionId, context.event?.sender)
        return {
          content: response.cancelled
            ? '[用户取消了补充信息。请说明无法继续的原因，不要猜测或扩大范围。]'
            : `[用户补充的信息]\n${JSON.stringify(response.answers, null, 2)}\n请基于这些答案继续当前任务。`,
          success: !response.cancelled
        }
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

      // 5. trigger_memory_purify (实际逻辑在 callLlmInternal 中拦截处理)
      if (api === 'trigger_memory_purify') {
        return { content: '此工具由系统内部 LLM 循环拦截处理。', success: true }
      }


      // 7. append_memory_summary
      if (api === 'append_memory_summary') {
        const { title, content } = args
        const actualTitle = title || '未命名主题'
        if (!content) {
          return { content: '错误：缺少必要参数 content', success: false }
        }
        if (!context.sessionId) {
          return { content: '错误：无法获取当前会话 ID (sessionId为空)', success: false }
        }

        try {
          const success = await appendMemorySummaryInternal(context.sessionId, actualTitle, content)
          if (success) {
            return {
              content: `成功：已将摘要追加写入主题记忆 "${actualTitle}"。并且系统已触发后台 Pipeline 即时提纯入库。`,
              success: true
            }
          } else {
            return {
              content: `追加记忆失败，请检查日志。`,
              success: false
            }
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
    return ['update_task_plan', 'update_task_step', 'delegate_tasks', 'request_skill', 'wait_skill_ready', 'get_system_status', 'get_location', 'request_user_clarification', 'manage_cron_task', 'trigger_memory_purify', 'append_memory_summary']
  }

  private dedupeClarificationQuestions<T extends { question: string }>(questions: T[]): T[] {
    const hasSpecificQuestion = questions.some(question => !this.isGenericClarificationPrompt(question.question) && this.isSpecificClarificationQuestion(question.question))
    return questions.filter(question => !(hasSpecificQuestion && this.isGenericClarificationPrompt(question.question)))
  }

  private isGenericClarificationPrompt(question: string): boolean {
    return /(\u7ebf\u7d22|\u6bd4\u5982|\u4f8b\u5982|\u63d0\u4f9b\u4e00\u4e9b|\u5e2e\u6211\u63d0\u4f9b|\u544a\u8bc9\u6211\u4e00\u4e9b|clue|for example)/i.test(question)
  }

  private isSpecificClarificationQuestion(question: string): boolean {
    return /(\u5b8c\u6574\u76ee\u5f55|\u76ee\u5f55|\u8def\u5f84|\u4f4d\u7f6e|\u78c1\u76d8|\u6587\u4ef6\u5939|\u6587\u4ef6\u7c7b\u578b|\u8d26\u53f7|\u5bc6\u7801|\u51ed\u636e|path|directory|folder|drive|account|credential)/i.test(question)
  }
}

export const systemExecutor = new SystemExecutor()

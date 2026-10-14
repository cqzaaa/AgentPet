/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { formatDateTime } from '../utils/helpers'
import type { CronLog, CronTask } from './useAppStore'

interface CronSchedulerOptions {
  setCronTasks: (updater: (tasks: CronTask[]) => CronTask[]) => void
  cronRunningLogsRef: MutableRefObject<Record<string, CronLog>>
  runTaskBackend: (task: CronTask, tempSessionId: string, logId: string) => void | Promise<void>
}

/**
 * 稳健的高精度绝对时间定时调度器：
 * 采用绝对时间戳（nextRunAt / executeAt）进行时间锚定，
 * 不依赖脆弱的组件内存相对秒数累加，杜绝窗口重载或切换时的计时丢失与延迟触发。
 */
export function useCronScheduler({
  setCronTasks,
  cronRunningLogsRef,
  runTaskBackend
}: CronSchedulerOptions): void {
  const runTaskBackendRef = useRef(runTaskBackend)

  useEffect(() => {
    runTaskBackendRef.current = runTaskBackend
  }, [runTaskBackend])

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      const triggered: Array<{ task: CronTask; tempSessionId: string; logId: string }> = []
      let tasksToPersist: CronTask[] | null = null

      setCronTasks(previous => {
        let changed = false
        const next = previous.map(task => {
          if (!task.isActive || !task.authorization || task.kind === 'workflow') return task

          const isSingleRun = task.repeat === false
          let dueAt = task.nextRunAt ?? task.executeAt

          // 若任务尚未初始化 nextRunAt 锚点时间戳，立即依据配置补充初始时间戳
          if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) {
            const fallbackInterval = Math.max(5, task.interval || 60)
            dueAt = now + fallbackInterval * 1000
            task = { ...task, nextRunAt: dueAt }
            changed = true
            return task
          }

          // 尚未到触发时刻
          if (now < dueAt) {
            return task
          }

          // 已到设定时间点，执行触发
          changed = true
          const timeStr = formatDateTime()
          const timestamp = Date.now()
          const tempSessionId = `cron:${task.id}:${timestamp}`
          const newLog: CronLog = {
            id: `${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
            time: timeStr,
            status: 'running',
            message: `定时任务 [${task.name}] 触发。正在后台执行...`,
            messages: [
              { id: `user-${timestamp}`, sender: 'user', text: `执行定时任务指令: ${task.action || '无'}`, time: timeStr },
              { id: `agent-${timestamp}`, sender: 'agent', text: '', isThinking: true, toolSteps: [], time: timeStr }
            ]
          }
          cronRunningLogsRef.current[tempSessionId] = newLog
          triggered.push({ task, tempSessionId, logId: newLog.id })

          return {
            ...task,
            // 单次任务触发后立刻置为已停用，并清除执行时间，永不重复运行
            isActive: isSingleRun ? false : task.isActive,
            nextRunAt: isSingleRun ? undefined : now + Math.max(5, task.interval || 60) * 1000,
            triggerCount: (task.triggerCount || 0) + 1,
            lastTriggered: timeStr,
            logs: [newLog, ...(task.logs || [])].slice(0, 100)
          }
        })

        if (!changed) return previous
        tasksToPersist = next
        return next
      })

      if (tasksToPersist) {
        localStorage.setItem('agentpet_cron_tasks', JSON.stringify(tasksToPersist))
        window.api.saveCronTasks(tasksToPersist).catch(console.error)
      }
      for (const item of triggered) {
        void runTaskBackendRef.current(item.task, item.tempSessionId, item.logId)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [cronRunningLogsRef, setCronTasks])
}

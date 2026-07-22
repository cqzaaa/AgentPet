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

/** Stable one-second scheduler that updates Zustand only when a task actually fires. */
export function useCronScheduler({
  setCronTasks,
  cronRunningLogsRef,
  runTaskBackend
}: CronSchedulerOptions): void {
  const elapsedTimesRef = useRef<Record<string, number>>({})
  const runTaskBackendRef = useRef(runTaskBackend)

  useEffect(() => {
    runTaskBackendRef.current = runTaskBackend
  }, [runTaskBackend])

  useEffect(() => {
    const timer = setInterval(() => {
      const triggered: Array<{ task: CronTask; tempSessionId: string; logId: string }> = []
      let tasksToPersist: CronTask[] | null = null

      setCronTasks(previous => {
        let changed = false
        const next = previous.map(task => {
          if (!task.isActive) return task
          const currentElapsed = (elapsedTimesRef.current[task.id] || 0) + 1
          if (currentElapsed < task.interval) {
            elapsedTimesRef.current[task.id] = currentElapsed
            return task
          }

          changed = true
          elapsedTimesRef.current[task.id] = 0
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
            triggerCount: task.triggerCount + 1,
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

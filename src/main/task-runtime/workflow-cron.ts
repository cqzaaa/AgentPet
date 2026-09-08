import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getActiveStorageDir } from '../tools/utils/paths'
import { taskRunner } from './task-runner'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled'])

interface WorkflowCronLog {
  id: string
  time: string
  status: 'running' | 'success' | 'failed'
  message: string
  taskRunId?: string
}

interface ScheduledTask {
  id: string
  name: string
  interval: number
  lastTriggered: string
  triggerCount: number
  isActive: boolean
  isSystem?: boolean
  kind?: 'prompt' | 'workflow'
  workflowId?: string
  action?: string
  createdAt?: number
  nextRunAt?: number
  logs?: WorkflowCronLog[]
}

function parseTasks(value: string): ScheduledTask[] {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : []
}

async function waitForRun(taskRunId: string): Promise<{ status: string } | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (run: { status: string } | null): void => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve(run)
    }
    const unsubscribe = taskRunner.subscribe((update) => {
      if (update.taskRunId === taskRunId && TERMINAL_STATUSES.has(update.run.status))
        finish(update.run)
    })
    void taskRunner
      .getRun(taskRunId)
      .then((snapshot) => {
        if (!snapshot) finish(null)
        else if (TERMINAL_STATUSES.has(snapshot.run.status)) finish(snapshot.run)
      })
      .catch((error) => {
        if (settled) return
        settled = true
        unsubscribe()
        reject(error)
      })
  })
}

/** Workflow timers live in main; renderer saves may edit configuration, never overwrite live results. */
export class WorkflowCron {
  private queue: Promise<unknown> = Promise.resolve()
  private checking = false
  private timer?: ReturnType<typeof setInterval>
  private readonly active = new Set<string>()
  constructor(
    private readonly startRun: (id: string) => Promise<{ taskRunId: string }>,
    private readonly changed: () => void
  ) {}

  async read(): Promise<ScheduledTask[]> {
    try {
      return parseTasks(await fs.readFile(join(getActiveStorageDir(), 'cron_tasks.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private update(operation: (tasks: ScheduledTask[]) => ScheduledTask[]): Promise<void> {
    const directory = getActiveStorageDir()
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        const file = join(directory, 'cron_tasks.json')
        let current: ScheduledTask[] = []
        try {
          current = parseTasks(await fs.readFile(file, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const tasks = operation(current)
        await fs.mkdir(directory, { recursive: true })
        const temporary = `${file}.${randomUUID()}.tmp`
        await fs.writeFile(temporary, JSON.stringify(tasks, null, 2), 'utf8')
        await fs.rename(temporary, file)
      })
    this.queue = next
    return next
  }

  save(tasks: ScheduledTask[]): Promise<void> {
    return this.update((current) =>
      tasks
        .filter((task) => !task.isSystem)
        .map((task) => {
          if (task.kind !== 'workflow') return task
          if (!task.workflowId || !Number.isFinite(task.interval) || task.interval < 5)
            throw new Error('请选择工作流并设置至少 5 秒的间隔')
          const previous = current.find((item) => item.id === task.id)
          return {
            ...task,
            createdAt: previous?.createdAt || Date.now(),
            nextRunAt:
              previous?.isActive &&
              previous.interval === task.interval &&
              previous.workflowId === task.workflowId
                ? previous.nextRunAt
                : Date.now() + task.interval * 1000,
            ...(previous?.kind === 'workflow'
              ? {
                  logs: previous.logs,
                  triggerCount: previous.triggerCount,
                  lastTriggered: previous.lastTriggered
                }
              : {})
          }
        })
    )
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.tick().catch(console.error)
    }, 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const tasks = await this.read()
      for (const task of tasks) {
        const dueAt = task.nextRunAt
        if (
          task.kind !== 'workflow' ||
          !task.isActive ||
          this.active.has(task.id) ||
          typeof dueAt !== 'number' ||
          !Number.isFinite(dueAt) ||
          dueAt > now
        )
          continue
        // Interrupted, paused, or approval-waiting runs must not be duplicated after a restart.
        const lastLog = task.logs?.find((log) => log.taskRunId)
        if (lastLog?.taskRunId) {
          const snapshot = await taskRunner.getRun(lastLog.taskRunId)
          if (snapshot && ['pending', 'running', 'paused'].includes(snapshot.run.status)) continue
          if (snapshot && lastLog.status === 'running') {
            const completed = snapshot.run.status === 'completed'
            await this.patchLog(task.id, lastLog.id, {
              status: completed ? 'success' : 'failed',
              message: completed
                ? '工作流执行完成'
                : `工作流未完成（${snapshot.run.status}），请打开运行详情`
            })
          }
        }
        this.active.add(task.id)
        const logId = randomUUID()
        let claimed = false
        await this.update((current) =>
          current.map((item) => {
            if (item.id !== task.id || !item.isActive || item.nextRunAt !== dueAt) return item
            claimed = true
            return {
              ...item,
              nextRunAt: now + item.interval * 1000,
              lastTriggered: new Date(now).toLocaleString('zh-CN'),
              triggerCount: (item.triggerCount || 0) + 1,
              logs: [
                {
                  id: logId,
                  time: new Date(now).toLocaleString('zh-CN'),
                  status: 'running' as const,
                  message: '工作流正在启动'
                },
                ...(item.logs || [])
              ].slice(0, 100)
            }
          })
        )
        if (!claimed) {
          this.active.delete(task.id)
          continue
        }
        this.changed()
        void this.execute(task, logId)
          .finally(() => this.active.delete(task.id))
          .catch(console.error)
      }
    } finally {
      this.checking = false
    }
  }

  private async patchLog(
    taskId: string,
    logId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    await this.update((tasks) =>
      tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              logs: (task.logs || []).map((log) => (log.id === logId ? { ...log, ...patch } : log))
            }
          : task
      )
    )
    this.changed()
  }

  private async execute(task: ScheduledTask, logId: string): Promise<void> {
    try {
      if (!task.workflowId) throw new Error('定时任务未选择工作流')
      const { taskRunId } = await this.startRun(task.workflowId)
      await this.patchLog(task.id, logId, { taskRunId, message: '工作流正在执行' })
      const run = await waitForRun(taskRunId)
      await this.patchLog(task.id, logId, {
        status: run?.status === 'completed' ? 'success' : 'failed',
        message:
          run?.status === 'completed'
            ? '工作流执行完成'
            : `工作流未完成（${run?.status || '未知状态'}），请打开运行详情`
      })
    } catch (error) {
      await this.patchLog(task.id, logId, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

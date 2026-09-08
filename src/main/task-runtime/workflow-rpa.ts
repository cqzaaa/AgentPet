import type { TaskStepExecutionRequest, TaskStepExecutionResult } from './types'
import { loadTaskFlow } from '../rpa/rpaStorage'
import { PlaywrightRpaExecutor } from '../rpa/playwrightExecutor'

const activeRpaTasks = new Set<string>()

export async function executeRpaWorkflowStep(
  request: TaskStepExecutionRequest,
  contents: Electron.WebContents
): Promise<TaskStepExecutionResult> {
  const id = request.step.control?.rpaTaskId || ''
  if (activeRpaTasks.has(id) || PlaywrightRpaExecutor.getActive(id))
    throw new Error('此 RPA 子流程正在运行，请结束后重试')
  activeRpaTasks.add(id)
  try {
    const flow = await loadTaskFlow(id)
    if (!flow) throw new Error('RPA 子流程不存在，请重新选择')
    if (request.signal.aborted) throw new Error('执行已取消')
    await request.reportProgress('正在执行 RPA 子流程')
    return await new Promise<TaskStepExecutionResult>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve({ resultSummary: `RPA 子流程 ${id} 执行完成` })
      }
      const abort = (): void => {
        void PlaywrightRpaExecutor.getActive(id)
          ?.stop()
          .finally(() => finish(new Error('RPA 执行已停止')))
        if (!PlaywrightRpaExecutor.getActive(id)) finish(new Error('RPA 执行已停止'))
      }
      request.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, 30 * 60_000)
      void PlaywrightRpaExecutor.run(
        id,
        flow.nodes,
        flow.edges,
        contents,
        {},
        {
          onStatus: (status, error) => {
            if (status === 'success') finish()
            if (status === 'failed') finish(new Error(error || 'RPA 执行失败'))
          }
        }
      ).catch((error) => finish(error))
    })
  } finally {
    activeRpaTasks.delete(id)
  }
}

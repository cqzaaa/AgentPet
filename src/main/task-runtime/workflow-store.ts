import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getActiveStorageDir } from '../tools/utils/paths'
import type { WorkflowDefinition, WorkflowDraft } from '../../preload/workflow-types'
import { validateWorkflow } from './workflow-validation'

/** Templates are separate from execution records. Serialize writes and reject stale edits. */
export class WorkflowStore {
  private pending: Promise<unknown> = Promise.resolve()
  private filename(): string {
    return join(getActiveStorageDir(), 'workflows.json')
  }

  async list(): Promise<WorkflowDefinition[]> {
    try {
      return JSON.parse(await fs.readFile(this.filename(), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  save(draft: WorkflowDraft): Promise<WorkflowDefinition> {
    return this.mutate(async (items) => {
      validateWorkflow(draft)
      const previous = items.find((item) => item.id === draft.id)
      if (draft.id && !previous) throw new Error('工作流已不存在，请另存为新流程')
      if (previous && draft.updatedAt !== previous.updatedAt)
        throw new Error('工作流已被其他窗口修改，请重新打开后编辑')
      const now = Date.now()
      const item: WorkflowDefinition = {
        ...draft,
        id: previous?.id || randomUUID(),
        title: draft.title.trim(),
        createdAt: previous?.createdAt || now,
        updatedAt: Math.max(now, (previous?.updatedAt || 0) + 1)
      }
      return { items: [item, ...items.filter((entry) => entry.id !== item.id)], result: item }
    })
  }

  private mutate<T>(
    operation: (items: WorkflowDefinition[]) => Promise<{ items: WorkflowDefinition[]; result: T }>
  ): Promise<T> {
    const filename = this.filename()
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        const { items, result } = await operation(await this.list())
        await fs.mkdir(getActiveStorageDir(), { recursive: true })
        const temporary = `${filename}.${randomUUID()}.tmp`
        await fs.writeFile(temporary, JSON.stringify(items, null, 2), 'utf8')
        await fs.rename(temporary, filename)
        return result
      })
    this.pending = next
    return next
  }
}

export const workflowStore = new WorkflowStore()

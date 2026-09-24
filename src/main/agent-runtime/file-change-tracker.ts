import fs from 'fs'
import path from 'path'
import { shell } from 'electron'

export interface FileChangeRecord {
  filePath: string
  relativePath: string
  fileName: string
  additions: number
  deletions: number
  originalContent: string
  currentContent: string
  wasCreated?: boolean
}

/**
 * 经典 LCS 行对比算法计算增删行数（带首尾剥离与 O(min(M,N)) 滚动数组优化）
 */
export function computeLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []

  const m = oldLines.length
  const n = newLines.length

  if (m === 0 && n === 0) return { additions: 0, deletions: 0 }
  if (m === 0) return { additions: n, deletions: 0 }
  if (n === 0) return { additions: 0, deletions: m }

  // 1. 先快速剥离公共前缀与公共后缀
  let start = 0
  while (start < m && start < n && oldLines[start] === newLines[start]) {
    start++
  }
  let endOld = m - 1
  let endNew = n - 1
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--
    endNew--
  }

  const midOldCount = endOld - start + 1
  const midNewCount = endNew - start + 1

  if (midOldCount <= 0 && midNewCount <= 0) return { additions: 0, deletions: 0 }
  if (midOldCount <= 0) return { additions: midNewCount, deletions: 0 }
  if (midNewCount <= 0) return { additions: 0, deletions: midOldCount }

  // 2. 对剥离首尾后的中间改动区间，使用一维滚动数组计算 LCS（内存开销仅为 O(min(M,N))，避免大矩阵撑爆内存）
  if (midOldCount * midNewCount <= 16000000) {
    const [shortLines, longLines] = midOldCount <= midNewCount
      ? [oldLines.slice(start, endOld + 1), newLines.slice(start, endNew + 1)]
      : [newLines.slice(start, endNew + 1), oldLines.slice(start, endOld + 1)]
    const shortLen = shortLines.length
    const longLen = longLines.length

    let prev = new Int32Array(shortLen + 1)
    let curr = new Int32Array(shortLen + 1)

    for (let i = 0; i < longLen; i++) {
      const longItem = longLines[i]
      for (let j = 0; j < shortLen; j++) {
        if (longItem === shortLines[j]) {
          curr[j + 1] = prev[j] + 1
        } else {
          curr[j + 1] = curr[j] > prev[j + 1] ? curr[j] : prev[j + 1]
        }
      }
      const temp = prev
      prev = curr
      curr = temp
      curr.fill(0)
    }

    const common = prev[shortLen]
    return {
      additions: midNewCount - common,
      deletions: midOldCount - common
    }
  }

  // 极端超大改动区间（如数十万行全量变化）时兜底
  const deletions = midOldCount
  const additions = midNewCount
  return { additions, deletions }
}

export class FileChangeTracker {
  private workspacePath: string
  // 规范化小写绝对路径 -> 变更记录
  private records = new Map<string, FileChangeRecord>()

  constructor(workspacePath: string = '') {
    this.workspacePath = workspacePath
  }

  private normalizeKey(p: string): string {
    return path.resolve(p).toLowerCase()
  }

  private getRelativePath(targetPath: string): string {
    const absPath = path.resolve(targetPath)
    if (this.workspacePath) {
      const rel = path.relative(this.workspacePath, absPath)
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.replace(/\\/g, '/')
      }
    }
    return absPath.replace(/\\/g, '/')
  }

  /**
   * 记录一次文件写入或修改操作
   */
  public recordChange(
    filePath: string,
    beforeContent: string,
    afterContent: string,
    wasCreated: boolean = false
  ): void {
    const absPath = path.resolve(filePath)
    const key = this.normalizeKey(absPath)
    const existing = this.records.get(key)

    // 如果本轮已记录过该文件，保留最开始的 originalContent，只更新 currentContent
    const originalContent = existing ? existing.originalContent : beforeContent
    const currentContent = afterContent
    const isNew = existing ? existing.wasCreated : wasCreated

    const { additions, deletions } = computeLineDiff(originalContent, currentContent)

    this.records.set(key, {
      filePath: absPath,
      relativePath: this.getRelativePath(absPath),
      fileName: path.basename(absPath),
      additions,
      deletions,
      originalContent,
      currentContent,
      wasCreated: isNew
    })
  }

  /**
   * 获取本轮所有有实际修改的文件变更列表
   */
  public getChanges(): FileChangeRecord[] {
    return Array.from(this.records.values()).filter(
      (r) => r.additions > 0 || r.deletions > 0 || r.originalContent !== r.currentContent
    )
  }

  /**
   * 撤销单项或多项文件变更
   */
  public static async revertChanges(
    changes: FileChangeRecord[]
  ): Promise<{ success: boolean; revertedCount: number; error?: string }> {
    try {
      let revertedCount = 0
      for (const change of changes) {
        if (change.wasCreated) {
          if (fs.existsSync(change.filePath)) {
            await shell.trashItem(change.filePath)
            revertedCount++
          }
        } else {
          // 确保父目录存在
          const dir = path.dirname(change.filePath)
          if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true })
          }
          await fs.promises.writeFile(change.filePath, change.originalContent, 'utf-8')
          revertedCount++
        }
      }
      return { success: true, revertedCount }
    } catch (err: any) {
      console.error('[FileChangeTracker] 撤销文件修改失败:', err)
      return { success: false, revertedCount: 0, error: err.message || String(err) }
    }
  }
}

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
 * 经典 LCS 行对比算法计算增删行数
 */
export function computeLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []

  const m = oldLines.length
  const n = newLines.length

  if (m === 0 && n === 0) return { additions: 0, deletions: 0 }
  if (m === 0) return { additions: n, deletions: 0 }
  if (n === 0) return { additions: 0, deletions: m }

  // 超过百万网格时使用首尾快速匹配，避免过大内存消耗
  if (m * n > 1000000) {
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
    const deletions = Math.max(0, endOld - start + 1)
    const additions = Math.max(0, endNew - start + 1)
    return { additions, deletions }
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const common = dp[m][n]
  return {
    additions: n - common,
    deletions: m - common
  }
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

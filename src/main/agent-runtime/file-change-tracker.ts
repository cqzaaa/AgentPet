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
 * 基于 LCS 与 Patience 分治锚点的行对比算法计算增删行数
 * 优化首尾剥离与大文件稀疏锚点分治，杜绝单大文件两端修改时触发全量兜底导致虚高几千行的缺陷
 */
export function computeLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []

  const m = oldLines.length
  const n = newLines.length

  if (m === 0 && n === 0) return { additions: 0, deletions: 0 }
  if (m === 0) return { additions: n, deletions: 0 }
  if (n === 0) return { additions: 0, deletions: m }

  function lcsRange(sOld: number, eOld: number, sNew: number, eNew: number): number {
    // 1. 局部前缀剥离
    while (sOld <= eOld && sNew <= eNew && oldLines[sOld] === newLines[sNew]) {
      sOld++
      sNew++
    }
    // 2. 局部后缀剥离
    while (eOld >= sOld && eNew >= sNew && oldLines[eOld] === newLines[eNew]) {
      eOld--
      eNew--
    }

    if (sOld > eOld || sNew > eNew) {
      return 0
    }

    const lenOld = eOld - sOld + 1
    const lenNew = eNew - sNew + 1

    // 规模适中（<= 2,000,000）直接一维滚动数组计算 LCS
    if (lenOld * lenNew <= 2000000) {
      const [shortLines, longLines] = lenOld <= lenNew
        ? [oldLines.slice(sOld, eOld + 1), newLines.slice(sNew, eNew + 1)]
        : [newLines.slice(sNew, eNew + 1), oldLines.slice(sOld, eOld + 1)]
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

      return prev[shortLen]
    }

    // 规模超大时：使用 Patience Diff 思想寻找区间内唯一出现的公共行（Unique Line Anchor）分治
    const oldCounts = new Map<string, number>()
    for (let i = sOld; i <= eOld; i++) {
      const line = oldLines[i]
      if (line.trim()) {
        oldCounts.set(line, (oldCounts.get(line) || 0) + 1)
      }
    }

    const newCounts = new Map<string, number>()
    const newIdxMap = new Map<string, number>()
    for (let i = sNew; i <= eNew; i++) {
      const line = newLines[i]
      if (line.trim()) {
        const count = (newCounts.get(line) || 0) + 1
        newCounts.set(line, count)
        if (count === 1) {
          newIdxMap.set(line, i)
        } else {
          newIdxMap.delete(line)
        }
      }
    }

    let bestOldIdx = -1
    let bestNewIdx = -1
    let minDistance = Infinity
    const midOld = (sOld + eOld) / 2

    for (let i = sOld; i <= eOld; i++) {
      const line = oldLines[i]
      if (oldCounts.get(line) === 1 && newIdxMap.has(line)) {
        const dist = Math.abs(i - midOld)
        if (dist < minDistance) {
          minDistance = dist
          bestOldIdx = i
          bestNewIdx = newIdxMap.get(line)!
        }
      }
    }

    if (bestOldIdx !== -1) {
      // 沿锚点前后延伸完全相同的行
      let extStartOld = bestOldIdx
      let extStartNew = bestNewIdx
      while (
        extStartOld > sOld &&
        extStartNew > sNew &&
        oldLines[extStartOld - 1] === newLines[extStartNew - 1]
      ) {
        extStartOld--
        extStartNew--
      }

      let extEndOld = bestOldIdx
      let extEndNew = bestNewIdx
      while (
        extEndOld < eOld &&
        extEndNew < eNew &&
        oldLines[extEndOld + 1] === newLines[extEndNew + 1]
      ) {
        extEndOld++
        extEndNew++
      }

      const matchLen = extEndOld - extStartOld + 1
      const leftCommon = lcsRange(sOld, extStartOld - 1, sNew, extStartNew - 1)
      const rightCommon = lcsRange(extEndOld + 1, eOld, extEndNew + 1, eNew)
      return leftCommon + matchLen + rightCommon
    }

    return 0
  }

  // 顶层首尾剥离
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

  const commonHead = start
  const commonTail = m - 1 - endOld
  const midCommon = lcsRange(start, endOld, start, endNew)
  const totalCommon = commonHead + commonTail + midCommon

  return {
    additions: n - totalCommon,
    deletions: m - totalCommon
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

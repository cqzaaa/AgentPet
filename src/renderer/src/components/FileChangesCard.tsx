import React, { useState, useMemo, useCallback } from 'react'
import {
  FileCode2,
  RotateCcw,
  Check,
  Eye,
  FileText
} from 'lucide-react'
import { FileDiffDrawer, type FileChangeItem } from './FileDiffModal'
import './FileChangesCard.css'

export interface FileChangesCardProps {
  changes: FileChangeItem[]
  onRevertSuccess?: (revertedPaths: string[]) => void
}

export function FileChangesCard({
  changes,
  onRevertSuccess
}: FileChangesCardProps): React.JSX.Element | null {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerIndex, setDrawerIndex] = useState(0)
  const [revertedPaths, setRevertedPaths] = useState<Set<string>>(new Set())
  const [revertingAll, setRevertingAll] = useState(false)

  // [Diff Review] 过滤有效文件变更：必须包含代码增删或属于新建文件
  const validChanges = useMemo(() => {
    if (!Array.isArray(changes)) return []
    return changes.filter(
      (c) => Boolean(c?.filePath) && (c.additions > 0 || c.deletions > 0 || c.wasCreated)
    )
  }, [changes])

  // 计算全局增删统计
  const { totalAdditions, totalDeletions } = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const item of validChanges) {
      additions += item.additions || 0
      deletions += item.deletions || 0
    }
    return { totalAdditions: additions, totalDeletions: deletions }
  }, [validChanges])

  const allReverted = useMemo(() => {
    return (
      validChanges.length > 0 &&
      validChanges.every((item) => revertedPaths.has(item.filePath))
    )
  }, [validChanges, revertedPaths])

  // 撤销全部文件
  const handleRevertAll = useCallback(async () => {
    if (revertingAll || allReverted || !window.api?.revertFileChanges) return
    const pendingChanges = validChanges.filter(
      (item) => !revertedPaths.has(item.filePath)
    )
    if (pendingChanges.length === 0) return

    setRevertingAll(true)
    try {
      const res = await window.api.revertFileChanges(pendingChanges)
      if (res.success) {
        setRevertedPaths((prev) => {
          const next = new Set(prev)
          for (const item of pendingChanges) {
            next.add(item.filePath)
          }
          return next
        })
        onRevertSuccess?.(pendingChanges.map((item) => item.filePath))
      }
    } catch (err) {
      console.error('[FileChangesCard] 全部撤销失败:', err)
    } finally {
      setRevertingAll(false)
    }
  }, [revertingAll, allReverted, validChanges, revertedPaths, onRevertSuccess])

  // 撤销单个文件
  const handleRevertSingle = useCallback(
    async (targetChange: FileChangeItem) => {
      if (
        revertedPaths.has(targetChange.filePath) ||
        !window.api?.revertFileChanges
      )
        return

      try {
        const res = await window.api.revertFileChanges([targetChange])
        if (res.success) {
          setRevertedPaths((prev) => new Set(prev).add(targetChange.filePath))
          onRevertSuccess?.([targetChange.filePath])
        }
      } catch (err) {
        console.error('[FileChangesCard] 单文件撤销失败:', err)
      }
    },
    [revertedPaths, onRevertSuccess]
  )

  // 打开或切换右侧差异审核面板
  const handleOpenReview = useCallback((index: number = 0) => {
    setDrawerIndex(index)
    setDrawerOpen(true)
  }, [])

  // 切换审核面板开关
  const handleToggleReview = useCallback(() => {
    setDrawerOpen((prev) => !prev)
  }, [])

  if (validChanges.length === 0) return null

  return (
    <>
      <div className="file-changes-card" role="region" aria-label="文件修改记录">
        {/* Header 区域 */}
        <header className="file-changes-header">
          <div className="file-changes-header-left">
            <div className="file-changes-badge-icon">
              <FileCode2 size={20} strokeWidth={2} />
            </div>
            <div className="file-changes-title-group">
              <div className="file-changes-title">
                已编辑 {validChanges.length} 个文件
              </div>
              <div className="file-changes-stats">
                <span className="stat-add">+{totalAdditions}</span>
                <span className="stat-del">-{totalDeletions}</span>
              </div>
            </div>
          </div>

          <div className="file-changes-header-actions">
            <button
              type="button"
              className={`file-changes-btn btn-revert ${allReverted ? 'is-reverted' : ''}`}
              onClick={handleRevertAll}
              disabled={allReverted || revertingAll}
              title={allReverted ? '所有修改已撤销' : '撤销本轮所有文件变更'}
            >
              {allReverted ? (
                <>
                  <Check size={13} strokeWidth={2.5} />
                  <span>已撤销</span>
                </>
              ) : (
                <>
                  <RotateCcw size={13} strokeWidth={2} />
                  <span>{revertingAll ? '正在撤销...' : '撤销'}</span>
                </>
              )}
            </button>

            <button
              type="button"
              className={`file-changes-btn btn-review ${drawerOpen ? 'is-active' : ''}`}
              onClick={drawerOpen ? handleToggleReview : () => handleOpenReview(0)}
              title={drawerOpen ? '关闭右侧差异审核面板' : '在右侧弹出逐行差异审核'}
            >
              <Eye size={14} strokeWidth={2} />
              <span>{drawerOpen ? '收起审核' : '审核'}</span>
            </button>
          </div>
        </header>

        {/* 文件修改列表 */}
        <div className="file-changes-list">
          {validChanges.map((item, index) => {
            const isItemReverted = revertedPaths.has(item.filePath)
            const isViewing = drawerOpen && drawerIndex === index
            return (
              <div
                key={item.filePath}
                className={`file-changes-item ${isItemReverted ? 'is-item-reverted' : ''} ${isViewing ? 'is-viewing' : ''}`}
                onClick={() => handleOpenReview(index)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleOpenReview(index)
                  }
                }}
                title={`在右侧审核: ${item.relativePath || item.filePath}`}
              >
                <div className="file-changes-item-left">
                  <FileText size={14} className="file-item-icon" />
                  <span className="file-item-path" title={item.filePath}>
                    {item.relativePath || item.fileName}
                  </span>
                  {isItemReverted && (
                    <span className="file-item-reverted-tag">已撤销</span>
                  )}
                </div>

                <div className="file-changes-item-right">
                  <span className="item-stat-add">+{item.additions}</span>
                  <span className="item-stat-del">-{item.deletions}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 右侧抽屉式 Diff 审核面板（从右侧弹出，与聊天并排，不弹框覆盖） */}
      {drawerOpen && (
        <FileDiffDrawer
          changes={validChanges}
          initialIndex={drawerIndex}
          revertedPaths={revertedPaths}
          onClose={() => setDrawerOpen(false)}
          onRevertFile={handleRevertSingle}
        />
      )}
    </>
  )
}

import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, RotateCcw, FileCode2, Check } from 'lucide-react'
import './FileDiffModal.css'

export interface FileChangeItem {
  filePath: string
  relativePath: string
  fileName: string
  additions: number
  deletions: number
  originalContent: string
  currentContent: string
  wasCreated?: boolean
}

export interface DiffLine {
  type: 'add' | 'del' | 'normal'
  oldLine?: number
  newLine?: number
  content: string
}

/**
 * 基于 LCS 算法生成精确的逐行 Diff
 */
export function computeDiffLines(originalText: string, currentText: string): DiffLine[] {
  const oldLines = originalText ? originalText.split('\n') : []
  const newLines = currentText ? currentText.split('\n') : []
  const m = oldLines.length
  const n = newLines.length

  if (m === 0 && n === 0) return []
  if (m === 0) {
    return newLines.map((text, idx) => ({
      type: 'add',
      newLine: idx + 1,
      content: text
    }))
  }
  if (n === 0) {
    return oldLines.map((text, idx) => ({
      type: 'del',
      oldLine: idx + 1,
      content: text
    }))
  }

  // 二维 DP 计算 LCS 矩阵（如果行数过大截断避免卡顿）
  if (m * n > 1200000) {
    // 大文件简单对齐
    const lines: DiffLine[] = []
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (oldLines[i] === newLines[j]) {
        lines.push({ type: 'normal', oldLine: i + 1, newLine: j + 1, content: oldLines[i] })
        i++
        j++
      } else {
        lines.push({ type: 'del', oldLine: i + 1, content: oldLines[i] })
        lines.push({ type: 'add', newLine: j + 1, content: newLines[j] })
        i++
        j++
      }
    }
    while (i < m) {
      lines.push({ type: 'del', oldLine: i + 1, content: oldLines[i] })
      i++
    }
    while (j < n) {
      lines.push({ type: 'add', newLine: j + 1, content: newLines[j] })
      j++
    }
    return lines
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

  // 回溯还原 diff 序列
  const result: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({
        type: 'normal',
        oldLine: i,
        newLine: j,
        content: oldLines[i - 1]
      })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({
        type: 'add',
        newLine: j,
        content: newLines[j - 1]
      })
      j--
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      result.push({
        type: 'del',
        oldLine: i,
        content: oldLines[i - 1]
      })
      i--
    }
  }

  return result.reverse()
}

export interface FileDiffDrawerProps {
  changes: FileChangeItem[]
  initialIndex?: number
  onClose: () => void
  onRevertFile?: (change: FileChangeItem) => Promise<void>
  revertedPaths?: Set<string>
}

export type FileDiffModalProps = FileDiffDrawerProps

/**
 * 右侧抽屉 / 侧边分栏式文件差异审查面板
 */
export function FileDiffDrawer({
  changes,
  initialIndex = 0,
  onClose,
  onRevertFile,
  revertedPaths = new Set()
}: FileDiffDrawerProps): React.JSX.Element | null {
  const [activeIndex, setActiveIndex] = useState(
    Math.max(0, Math.min(initialIndex, changes.length - 1))
  )
  const [reverting, setReverting] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 抽屉宽度状态，支持从本地持久化加载并自适应默认宽度
  const [drawerWidth, setDrawerWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('agentpet_diff_drawer_width')
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (!isNaN(parsed) && parsed >= 320 && parsed <= 1800) {
          return parsed
        }
      }
    } catch {}
    if (typeof window !== 'undefined') {
      return Math.max(460, Math.min(700, Math.round(window.innerWidth * 0.46)))
    }
    return 560
  })

  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(drawerWidth)

  // 当外部选中的文件索引变化时自动切换到对应 Tab
  useEffect(() => {
    if (initialIndex >= 0 && initialIndex < changes.length) {
      setActiveIndex(initialIndex)
    }
  }, [initialIndex, changes.length])

  // 支持键盘 Esc 快捷键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // 鼠标按下开始拖拽调整大小
  const handleResizerMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    isDraggingRef.current = true
    setIsDragging(true)
    dragStartXRef.current = e.clientX
    dragStartWidthRef.current = drawerWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // 监听全局鼠标移动与释放
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDraggingRef.current) return
      // 面板在右侧，向左拖（delta > 0）变大，向右拖（delta < 0）变小
      const delta = dragStartXRef.current - e.clientX
      const parentWidth = containerRef.current?.parentElement?.clientWidth || window.innerWidth
      const minW = 340
      const maxW = Math.max(minW, parentWidth - 380) // 确保左侧聊天区域至少保留 380px
      const nextWidth = Math.max(minW, Math.min(maxW, dragStartWidthRef.current + delta))
      setDrawerWidth(nextWidth)
    }

    const handleMouseUp = (): void => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        setIsDragging(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setDrawerWidth((curr) => {
          try {
            localStorage.setItem('agentpet_diff_drawer_width', String(curr))
          } catch {}
          return curr
        })
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // 窗口大小变化时自适应调整最大宽度
  useEffect(() => {
    const handleWindowResize = (): void => {
      const parentWidth = containerRef.current?.parentElement?.clientWidth || window.innerWidth
      const maxW = Math.max(340, parentWidth - 380)
      setDrawerWidth((curr) => Math.min(curr, maxW))
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

  // 双击分割条快速恢复默认推荐宽度
  const handleResetWidth = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const defaultW = Math.max(460, Math.min(700, Math.round(window.innerWidth * 0.46)))
    setDrawerWidth(defaultW)
    try {
      localStorage.setItem('agentpet_diff_drawer_width', String(defaultW))
    } catch {}
  }

  const currentFile = changes[activeIndex] || changes[0]
  const isReverted = currentFile ? revertedPaths.has(currentFile.filePath) : false

  const diffLines = useMemo(() => {
    if (!currentFile) return []
    return computeDiffLines(currentFile.originalContent, currentFile.currentContent)
  }, [currentFile])

  const handleSingleRevert = async (): Promise<void> => {
    if (!currentFile || isReverted || reverting || !onRevertFile) return
    setReverting(true)
    try {
      await onRevertFile(currentFile)
    } finally {
      setReverting(false)
    }
  }

  if (!currentFile) return null

  // 渲染抽屉主体
  const drawerNode = (
    <div
      ref={containerRef}
      className={`file-diff-drawer-layer ${isDragging ? 'is-resizing' : ''}`}
      style={{ width: `${drawerWidth}px` }}
      role="region"
      aria-label="文件差异审核面板"
    >
      {/* 拖拽调整大小分割条 */}
      <div
        className={`file-diff-resizer ${isDragging ? 'is-dragging' : ''}`}
        onMouseDown={handleResizerMouseDown}
        onDoubleClick={handleResetWidth}
        title="按住左右拖拽自定义窗口大小，双击恢复默认宽度"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={drawerWidth}
      >
        <div className="file-diff-resizer-line" />
        <div className="file-diff-resizer-handle" />
      </div>

      <aside className="file-diff-drawer">
        {/* 顶部 Header：文件信息与操作栏 */}
        <header className="file-diff-drawer-header">
          <div className="file-diff-header-info">
            <span className="file-diff-header-icon-box" aria-hidden="true">
              <FileCode2 size={18} />
            </span>
            <div className="file-diff-title-group">
              <div className="file-diff-filename-row">
                <span className="file-diff-filename">{currentFile.fileName}</span>
                {currentFile.wasCreated && (
                  <span className="diff-tag-new">新建</span>
                )}
                {isReverted && (
                  <span className="diff-tag-reverted">已撤销</span>
                )}
              </div>
              <span className="file-diff-relpath" title={currentFile.filePath}>
                {currentFile.relativePath || currentFile.fileName}
              </span>
            </div>
            <div className="file-diff-stats">
              <span className="diff-tag-add">+{currentFile.additions}</span>
              <span className="diff-tag-del">-{currentFile.deletions}</span>
            </div>
          </div>

          <div className="file-diff-header-actions">
            {onRevertFile && (
              <button
                type="button"
                className={`file-diff-revert-btn ${isReverted ? 'is-reverted' : ''}`}
                onClick={handleSingleRevert}
                disabled={isReverted || reverting}
                title={isReverted ? '此文件修改已撤销' : '撤销此文件的修改'}
              >
                {isReverted ? (
                  <>
                    <Check size={13} strokeWidth={2.5} />
                    <span>已撤销</span>
                  </>
                ) : (
                  <>
                    <RotateCcw size={13} />
                    <span>{reverting ? '正在撤销...' : '撤销此文件'}</span>
                  </>
                )}
              </button>
            )}

            <button
              ref={closeButtonRef}
              type="button"
              className="file-diff-close-btn"
              onClick={onClose}
              aria-label="关闭审核面板"
              title="关闭审核 (Esc)"
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </header>

        {/* 多文件切换 Tabs */}
        {changes.length > 1 && (
          <div className="file-diff-tabs" role="tablist">
            {changes.map((item, index) => {
              const active = index === activeIndex
              const itemReverted = revertedPaths.has(item.filePath)
              return (
                <button
                  key={item.filePath}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`file-diff-tab-item ${active ? 'is-active' : ''} ${itemReverted ? 'is-tab-reverted' : ''}`}
                  onClick={() => setActiveIndex(index)}
                  title={item.filePath}
                >
                  <span className="file-diff-tab-name">{item.fileName}</span>
                  <span className="file-diff-tab-stat">
                    <span className="tab-add">+{item.additions}</span>
                    <span className="tab-del">-{item.deletions}</span>
                  </span>
                  {itemReverted && (
                    <span className="file-diff-tab-reverted-mark">✓</span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* 逐行代码 Diff 主体视图 */}
        <div className="file-diff-content-wrapper">
          <div className="file-diff-table">
            {diffLines.length === 0 ? (
              <div className="file-diff-empty">无内容变更</div>
            ) : (
              diffLines.map((line, idx) => (
                <div
                  key={idx}
                  className={`file-diff-row diff-type-${line.type}`}
                >
                  <span className="diff-num old-num">
                    {line.oldLine ?? ''}
                  </span>
                  <span className="diff-num new-num">
                    {line.newLine ?? ''}
                  </span>
                  <span className="diff-sign">
                    {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                  </span>
                  <pre className="diff-code">
                    <code>{line.content || ' '}</code>
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  )

  // 挂载到右侧分栏容器 .chat-split-container，若不存在则降级到 document.body
  const targetElement =
    typeof document !== 'undefined'
      ? document.querySelector('.chat-split-container') || document.body
      : null

  if (!targetElement) return null
  return createPortal(drawerNode, targetElement)
}

// 保持向下兼容
export const FileDiffModal = FileDiffDrawer

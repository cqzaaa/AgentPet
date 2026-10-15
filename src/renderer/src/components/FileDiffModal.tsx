import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, RotateCcw, Check } from 'lucide-react'
import { FileIcon } from './FileIcon'
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

type ReviewLine = DiffLine | { type: 'gap'; count: number }

/** 只保留变更附近的上下文，避免把未修改的整份文件挂到 DOM。 */
export function compactDiffLines(lines: DiffLine[], context = 3): ReviewLine[] {
  const changed: number[] = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].type !== 'normal') changed.push(index)
  }
  if (changed.length === 0) return []

  const result: ReviewLine[] = []
  let omitted = 0
  let changedIndex = 0
  for (let index = 0; index < lines.length; index++) {
    while (changedIndex < changed.length && changed[changedIndex] < index) changedIndex++
    const previous = changed[changedIndex - 1] ?? -Infinity
    const next = changed[changedIndex] ?? Infinity
    if (index - previous > context && next - index > context) {
      omitted++
      continue
    }
    if (omitted > 0) result.push({ type: 'gap', count: omitted })
    omitted = 0
    result.push(lines[index])
  }
  if (omitted > 0) result.push({ type: 'gap', count: omitted })
  return result
}

/**
 * 基于 LCS 与 Patience 分治锚点生成精确的逐行 Diff
 * 支持大文件首尾剥离与稀疏唯一锚点递归分治，彻底解决大文件两端修改时导致中间几千行被误算为增删的问题
 */
export function computeDiffLines(originalText: string, currentText: string): DiffLine[] {
  const normalizedOld = originalText ? originalText.replace(/\r\n|\r/g, '\n') : ''
  const normalizedNew = currentText ? currentText.replace(/\r\n|\r/g, '\n') : ''
  const oldLines = normalizedOld ? normalizedOld.split('\n') : []
  const newLines = normalizedNew ? normalizedNew.split('\n') : []
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

  function diffRange(sOld: number, eOld: number, sNew: number, eNew: number): DiffLine[] {
    const res: DiffLine[] = []

    // 1. 局部前缀剥离
    while (sOld <= eOld && sNew <= eNew && oldLines[sOld] === newLines[sNew]) {
      res.push({ type: 'normal', oldLine: sOld + 1, newLine: sNew + 1, content: oldLines[sOld] })
      sOld++
      sNew++
    }

    const trailing: DiffLine[] = []
    // 2. 局部后缀剥离
    while (eOld >= sOld && eNew >= sNew && oldLines[eOld] === newLines[eNew]) {
      trailing.push({ type: 'normal', oldLine: eOld + 1, newLine: eNew + 1, content: oldLines[eOld] })
      eOld--
      eNew--
    }
    trailing.reverse()

    if (sOld > eOld && sNew > eNew) {
      return [...res, ...trailing]
    }

    if (sOld > eOld) {
      for (let j = sNew; j <= eNew; j++) {
        res.push({ type: 'add', newLine: j + 1, content: newLines[j] })
      }
      return [...res, ...trailing]
    }

    if (sNew > eNew) {
      for (let i = sOld; i <= eOld; i++) {
        res.push({ type: 'del', oldLine: i + 1, content: oldLines[i] })
      }
      return [...res, ...trailing]
    }

    const lenOld = eOld - sOld + 1
    const lenNew = eNew - sNew + 1

    // 规模适中（<= 250,000）直接使用精确 DP 计算
    if (lenOld * lenNew <= 250000) {
      const dp: number[][] = Array.from({ length: lenOld + 1 }, () => new Array(lenNew + 1).fill(0))
      for (let i = 0; i < lenOld; i++) {
        for (let j = 0; j < lenNew; j++) {
          if (oldLines[sOld + i] === newLines[sNew + j]) {
            dp[i + 1][j + 1] = dp[i][j] + 1
          } else {
            dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
          }
        }
      }

      const midDiff: DiffLine[] = []
      let i = lenOld
      let j = lenNew
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[sOld + i - 1] === newLines[sNew + j - 1]) {
          midDiff.push({
            type: 'normal',
            oldLine: sOld + i,
            newLine: sNew + j,
            content: oldLines[sOld + i - 1]
          })
          i--
          j--
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
          midDiff.push({
            type: 'add',
            newLine: sNew + j,
            content: newLines[sNew + j - 1]
          })
          j--
        } else {
          midDiff.push({
            type: 'del',
            oldLine: sOld + i,
            content: oldLines[sOld + i - 1]
          })
          i--
        }
      }
      midDiff.reverse()
      return [...res, ...midDiff, ...trailing]
    }

    // 规模超大时：使用 Patience Diff 寻找唯一公共行（Unique Line Anchor）递归分治
    const oldCounts = new Map<string, number>()
    for (let idx = sOld; idx <= eOld; idx++) {
      const line = oldLines[idx]
      if (line.trim()) {
        oldCounts.set(line, (oldCounts.get(line) || 0) + 1)
      }
    }

    const newCounts = new Map<string, number>()
    const newIdxMap = new Map<string, number>()
    for (let idx = sNew; idx <= eNew; idx++) {
      const line = newLines[idx]
      if (line.trim()) {
        const count = (newCounts.get(line) || 0) + 1
        newCounts.set(line, count)
        if (count === 1) {
          newIdxMap.set(line, idx)
        } else {
          newIdxMap.delete(line)
        }
      }
    }

    let bestOldIdx = -1
    let bestNewIdx = -1
    let minDistance = Infinity
    const midOld = (sOld + eOld) / 2

    for (let idx = sOld; idx <= eOld; idx++) {
      const line = oldLines[idx]
      if (oldCounts.get(line) === 1 && newIdxMap.has(line)) {
        const dist = Math.abs(idx - midOld)
        if (dist < minDistance) {
          minDistance = dist
          bestOldIdx = idx
          bestNewIdx = newIdxMap.get(line)!
        }
      }
    }

    if (bestOldIdx !== -1) {
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

      const leftPart = diffRange(sOld, extStartOld - 1, sNew, extStartNew - 1)
      const midPart: DiffLine[] = []
      for (let k = 0; k <= extEndOld - extStartOld; k++) {
        midPart.push({
          type: 'normal',
          oldLine: extStartOld + k + 1,
          newLine: extStartNew + k + 1,
          content: oldLines[extStartOld + k]
        })
      }
      const rightPart = diffRange(extEndOld + 1, eOld, extEndNew + 1, eNew)
      return [...res, ...leftPart, ...midPart, ...rightPart, ...trailing]
    }

    // 实在无唯一行匹配时的保底线性对齐
    for (let idx = sOld; idx <= eOld; idx++) {
      res.push({ type: 'del', oldLine: idx + 1, content: oldLines[idx] })
    }
    for (let idx = sNew; idx <= eNew; idx++) {
      res.push({ type: 'add', newLine: idx + 1, content: newLines[idx] })
    }
    return [...res, ...trailing]
  }

  return diffRange(0, m - 1, 0, n - 1)
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
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1000
    // 默认弹出比例：优先保证左侧主聊天区空间舒展充足（>= 560px），不触发底栏折叠与卡片拥挤
    const computeOptimalDefault = (): number => {
      const target = Math.min(Math.round(winW * 0.36), Math.max(340, winW - 560))
      return Math.max(340, Math.min(600, target))
    }

    try {
      const saved = localStorage.getItem('agentpet_diff_drawer_width')
      if (saved) {
        const parsed = parseInt(saved, 10)
        // 若之前保存的值导致左侧主视口过窄（小于 520px），则重新按推荐比例自适应
        if (!isNaN(parsed) && parsed >= 320 && parsed <= winW - 520) {
          return parsed
        }
      }
    } catch {}
    return computeOptimalDefault()
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

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus({ preventScroll: true })
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

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
    const winW = window.innerWidth
    const target = Math.min(Math.round(winW * 0.36), Math.max(340, winW - 560))
    const defaultW = Math.max(340, Math.min(600, target))
    setDrawerWidth(defaultW)
    try {
      localStorage.setItem('agentpet_diff_drawer_width', String(defaultW))
    } catch {}
  }

  const currentFile = changes[activeIndex] || changes[0]
  const isReverted = currentFile ? revertedPaths.has(currentFile.filePath) : false

  const diffLines = useMemo(() => {
    if (!currentFile) return []
    return compactDiffLines(computeDiffLines(currentFile.originalContent, currentFile.currentContent))
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
              <FileIcon fileName={currentFile.fileName || currentFile.filePath} size={18} />
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
                  <FileIcon fileName={item.fileName || item.filePath} size={13} className="file-diff-tab-icon" />
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
              diffLines.map((line, idx) => line.type === 'gap' ? (
                <div key={`gap-${idx}`} className="file-diff-gap" aria-label={`省略 ${line.count} 行未修改内容`}>
                  ··· 省略 {line.count} 行未修改内容 ···
                </div>
              ) : (
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

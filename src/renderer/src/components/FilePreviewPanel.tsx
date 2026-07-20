import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createViewer, imagePlugin, pdfPlugin, officePlugin, textPlugin } from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import JSZip from 'jszip'
import { AppStore } from '../hooks/useAppStore'
import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Maximize2,
  Minimize2,
  Presentation,
  RotateCw,
  Save,
  Trash2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface FilePreviewPanelProps {
  store: AppStore
}

interface SpreadsheetValidation {
  ranges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>
  options: string[]
}

interface SpreadsheetSheetMetadata {
  hiddenRows: Set<number>
  validations: SpreadsheetValidation[]
}

type SpreadsheetMetadata = Map<string, SpreadsheetSheetMetadata>

function xmlElements(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName))
}

function parseCellAddress(address: string): { row: number; column: number } | null {
  const match = address.replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/i)
  if (!match) return null
  let column = 0
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64
  return { row: Number(match[2]), column }
}

function parseCellRange(range: string): SpreadsheetValidation['ranges'][number] | null {
  const [startValue, endValue = startValue] = range.split(':')
  const start = parseCellAddress(startValue)
  const end = parseCellAddress(endValue)
  if (!start || !end) return null
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column)
  }
}

function normalizeWorksheetTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/')
  return normalized.startsWith('/') ? normalized.slice(1) : `xl/${normalized.replace(/^\.\.\//, '')}`
}

async function loadSpreadsheetMetadata(fileUrl: string): Promise<SpreadsheetMetadata> {
  const response = await fetch(fileUrl)
  if (!response.ok) throw new Error(`无法读取表格预览元数据（${response.status}）`)
  const arrayBuffer = await response.arrayBuffer()
  const [zip, XLSX] = await Promise.all([JSZip.loadAsync(arrayBuffer), import('xlsx')])
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string')
  const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!workbookXml || !relationshipsXml) return new Map()

  const parser = new DOMParser()
  const workbookDocument = parser.parseFromString(workbookXml, 'application/xml')
  const relationshipsDocument = parser.parseFromString(relationshipsXml, 'application/xml')
  const relationshipTargets = new Map(
    xmlElements(relationshipsDocument, 'Relationship').map(element => [
      element.getAttribute('Id') || '',
      normalizeWorksheetTarget(element.getAttribute('Target') || '')
    ])
  )
  const definedNames = new Map(
    xmlElements(workbookDocument, 'definedName').map(element => [
      element.getAttribute('name') || '',
      element.textContent?.trim() || ''
    ])
  )
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })
  const metadata: SpreadsheetMetadata = new Map()

  const resolveOptions = (formula: string): string[] => {
    const trimmed = formula.trim().replace(/^=/, '')
    if (/^".*"$/.test(trimmed)) {
      return trimmed.slice(1, -1).split(',').map(value => value.trim()).filter(Boolean)
    }
    const reference = definedNames.get(trimmed) || trimmed
    const match = reference.match(/^'?((?:[^']|'')+)'?!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i)
    if (!match) return []
    const sheetName = match[1].replace(/''/g, "'")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) return []
    const start = parseCellAddress(`${match[2]}${match[3]}`)
    const end = parseCellAddress(`${match[4] || match[2]}${match[5] || match[3]}`)
    if (!start || !end) return []
    const values: string[] = []
    for (let row = start.row; row <= end.row && values.length < 200; row++) {
      for (let column = start.column; column <= end.column && values.length < 200; column++) {
        const address = XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })
        const value = sheet[address]?.w ?? sheet[address]?.v
        if (value !== undefined && value !== null && String(value).trim()) values.push(String(value).trim())
      }
    }
    return [...new Set(values)]
  }

  for (const sheetElement of xmlElements(workbookDocument, 'sheet')) {
    const sheetName = sheetElement.getAttribute('name') || ''
    const relationshipId = sheetElement.getAttribute('r:id') ||
      sheetElement.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || ''
    const sheetPath = relationshipTargets.get(relationshipId)
    const sheetXml = sheetPath ? await zip.file(sheetPath)?.async('string') : undefined
    if (!sheetName || !sheetXml) continue
    const sheetDocument = parser.parseFromString(sheetXml, 'application/xml')
    const hiddenRows = new Set(
      xmlElements(sheetDocument, 'row')
        .filter(element => element.getAttribute('hidden') === '1' || element.getAttribute('hidden') === 'true')
        .map(element => Number(element.getAttribute('r')))
        .filter(Number.isFinite)
    )
    const validations = xmlElements(sheetDocument, 'dataValidation')
      .filter(element => element.getAttribute('type') === 'list')
      .map(element => {
        const ranges = (element.getAttribute('sqref') || '')
          .split(/\s+/)
          .map(parseCellRange)
          .filter((range): range is NonNullable<ReturnType<typeof parseCellRange>> => Boolean(range))
        const formula = xmlElements(element, 'formula1')[0]?.textContent || ''
        return { ranges, options: resolveOptions(formula) }
      })
      .filter(validation => validation.ranges.length > 0)
    metadata.set(sheetName, { hiddenRows, validations })
  }
  return metadata
}

function enhanceSpreadsheetPreview(container: HTMLElement, metadata: SpreadsheetMetadata): void {
  const sheetPanel = container.querySelector<HTMLElement>('.ofv-sheet')
  const sheetName = sheetPanel?.getAttribute('aria-label') || ''
  const sheetMetadata = metadata.get(sheetName)
  const table = sheetPanel?.querySelector<HTMLTableElement>('.ofv-workbook-table')
  if (!sheetMetadata || !table) return

  for (const row of Array.from(table.rows)) {
    const firstAddress = row.querySelector<HTMLElement>('[data-cell]')?.dataset.cell
    const parsed = firstAddress ? parseCellAddress(firstAddress) : null
    if (parsed && sheetMetadata.hiddenRows.has(parsed.row)) {
      row.hidden = true
      row.setAttribute('aria-hidden', 'true')
    }
  }
  const firstVisibleRow = Array.from(table.rows).find(row => !row.hidden)
  firstVisibleRow?.classList.add('spreadsheet-visible-header')

  for (const cell of Array.from(table.querySelectorAll<HTMLElement>('[data-cell]'))) {
    const address = parseCellAddress(cell.dataset.cell || '')
    if (!address || sheetMetadata.hiddenRows.has(address.row)) continue
    const validation = sheetMetadata.validations.find(item => item.ranges.some(range =>
      address.row >= range.startRow && address.row <= range.endRow &&
      address.column >= range.startColumn && address.column <= range.endColumn
    ))
    if (!validation || cell.querySelector('.spreadsheet-dropdown-indicator')) continue
    cell.classList.add('spreadsheet-dropdown-cell')
    const indicator = document.createElement('span')
    indicator.className = 'spreadsheet-dropdown-indicator'
    indicator.textContent = '⌄'
    indicator.setAttribute('aria-label', '下拉选择字段')
    const optionSummary = validation.options.slice(0, 12).join('、')
    indicator.title = validation.options.length > 0
      ? `下拉选项：${optionSummary}${validation.options.length > 12 ? ` 等 ${validation.options.length} 项` : ''}`
      : '下拉选择字段'
    cell.append(indicator)
  }
}

function FileTypeIcon({ fileName, size = 18 }: { fileName: string; size?: number }): React.JSX.Element {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  let Icon: LucideIcon = File
  let color = '#6b7280'

  if (['doc', 'docx', 'txt', 'md', 'pdf'].includes(ext)) {
    Icon = FileText
    color = ext === 'pdf' ? '#dc2626' : '#2563eb'
  } else if (['xls', 'xlsx', 'csv'].includes(ext)) {
    Icon = FileSpreadsheet
    color = '#15803d'
  } else if (['ppt', 'pptx'].includes(ext)) {
    Icon = Presentation
    color = '#c2410c'
  } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    Icon = FileImage
    color = '#7c3aed'
  } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    Icon = FileArchive
  } else if (['html', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'py', 'json', 'xml'].includes(ext)) {
    Icon = FileCode2
    color = '#d97706'
  }

  return <Icon size={size} strokeWidth={2} color={color} aria-hidden="true" />
}

export function FilePreviewPanel({ store }: FilePreviewPanelProps): React.JSX.Element {
  const {
    generatedFiles,
    setShowFilePanel,
    openTabs,
    setOpenTabs,
    previewFile,
    setPreviewFile,
    previewLoading,
    setPreviewLoading,
    officePreviewRequest,
    setOfficePreviewRequest,
    handlePreviewFile,
    handleDeleteFile,
    isCollapsed
  } = store

  const [filePanelWidth, setFilePanelWidth] = useState(320)
  const [isFakeFullscreen, setIsFakeFullscreen] = useState(false)
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  const viewerRef = useRef<any>(null)
  const [viewerNode, setViewerNode] = useState<HTMLDivElement | null>(null)
  const viewerNodeRef = useRef<HTMLDivElement | null>(null)
  const handleViewerNode = useCallback((node: HTMLDivElement | null): void => {
    viewerNodeRef.current = node
    setViewerNode(node)
  }, [])
  const [viewerReady, setViewerReady] = useState<{ path: string; requestId: string } | null>(null)
  const [viewerError, setViewerError] = useState<{ path: string; message: string } | null>(null)
  const [spreadsheetMetadata, setSpreadsheetMetadata] = useState<SpreadsheetMetadata | null>(null)
  const captureRequestRef = useRef<string | null>(null)
  const officePreviewRequestRef = useRef<any>(officePreviewRequest)
  officePreviewRequestRef.current = officePreviewRequest

  const toolbarContextRef = useRef<any>(null)
  const [zoomLabel, setZoomLabel] = useState('100%')
  const [canZoomIn, setCanZoomIn] = useState(false)
  const [canZoomOut, setCanZoomOut] = useState(false)
  const visibleFileCount = new Set([...generatedFiles, ...openTabs].map(file => file.path)).size
  const [canRotate, setCanRotate] = useState(false)
  const [hasToolbarCtx, setHasToolbarCtx] = useState(false)

  const syncZoomStatus = () => {
    const ctx = toolbarContextRef.current
    if (ctx) {
      setZoomLabel(ctx.zoomLabel || '100%')
      setCanZoomIn(ctx.canCommand('zoom-in'))
      setCanZoomOut(ctx.canCommand('zoom-out'))
      setCanRotate(ctx.canCommand('rotate-right'))
      setHasToolbarCtx(true)
    } else {
      setHasToolbarCtx(false)
    }
  }

  // 拖拽调整面板宽度，限制左侧聊天框的最小宽度为 500px
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = dragStartXRef.current - e.clientX
      const sidebarWidth = isCollapsed ? 68 : 210
      const contentAreaWidth = window.innerWidth - sidebarWidth
      const maxPanelWidth = Math.max(240, contentAreaWidth - 500)
      const newWidth = Math.max(240, Math.min(maxPanelWidth, dragStartWidthRef.current + delta))
      setFilePanelWidth(newWidth)
    }
    const handleMouseUp = () => {
      isDraggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isCollapsed])

  // 监听窗口大小以及侧边栏展开状态，防止聊天区宽度太窄挤压底栏
  useEffect(() => {
    const handleResize = () => {
      const sidebarWidth = isCollapsed ? 68 : 210
      const contentAreaWidth = window.innerWidth - sidebarWidth
      const maxPanelWidth = Math.max(240, contentAreaWidth - 500)
      setFilePanelWidth(prev => Math.min(prev, maxPanelWidth))
    }
    window.addEventListener('resize', handleResize)
    handleResize()
    return () => window.removeEventListener('resize', handleResize)
  }, [isCollapsed])

  // 挂载与销毁文件预览器 (open-file-viewer)
  useEffect(() => {
    if (viewerRef.current) {
      try {
        viewerRef.current.destroy()
      } catch (err) {
        console.error('[open-file-viewer] destroy error:', err)
      }
      viewerRef.current = null
    }

    if (!previewFile || !viewerNode) return

    setPreviewLoading(true)
    setViewerReady(null)
    setViewerError(null)

    try {
      const formattedPath = previewFile.path.replace(/\\/g, '/')
      const fileUrl = `local-file:///${formattedPath}`

      viewerRef.current = createViewer({
        container: viewerNode,
        file: fileUrl,
        fileName: previewFile.name,
        fit: 'width',
        toolbar: {
          render: (ctx) => {
            toolbarContextRef.current = ctx
            setTimeout(() => {
              syncZoomStatus()
            }, 0)
            const div = document.createElement('div')
            div.style.display = 'none'
            return div
          }
        },
        plugins: [
          imagePlugin(),
          pdfPlugin(),
          officePlugin(),
          textPlugin()
        ],
        onLoad: () => {
          setPreviewLoading(false)
          setViewerReady({
            path: previewFile.path,
            requestId: officePreviewRequestRef.current?.requestId || ''
          })
          setTimeout(syncZoomStatus, 100)
        },
        onError: (err) => {
          console.error('[open-file-viewer] preview error:', err)
          setPreviewLoading(false)
          setViewerError({
            path: previewFile.path,
            message: err instanceof Error ? err.message : String(err)
          })
        }
      })

    } catch (err) {
      console.error('[open-file-viewer] 初始化失败:', err)
      setPreviewLoading(false)
    }

    return () => {
      if (viewerRef.current) {
        try {
          viewerRef.current.destroy()
        } catch (_) { }
        viewerRef.current = null
      }
      toolbarContextRef.current = null
      setHasToolbarCtx(false)
      setZoomLabel('100%')
      setCanZoomIn(false)
      setCanZoomOut(false)
      setCanRotate(false)
      setIsFakeFullscreen(false)
    }
  }, [previewFile, viewerNode, setPreviewLoading])

  useEffect(() => {
    let cancelled = false
    setSpreadsheetMetadata(null)
    if (!previewFile || !/\.xlsx$/i.test(previewFile.name)) return
    const formattedPath = previewFile.path.replace(/\\/g, '/')
    void loadSpreadsheetMetadata(`local-file:///${formattedPath}`)
      .then(metadata => {
        if (!cancelled) setSpreadsheetMetadata(metadata)
      })
      .catch(error => {
        console.warn('[FilePreviewPanel] spreadsheet metadata unavailable:', error)
      })
    return () => {
      cancelled = true
    }
  }, [previewFile])

  useEffect(() => {
    if (!viewerNode || !spreadsheetMetadata) return
    let scheduled = false
    const enhance = () => {
      scheduled = false
      enhanceSpreadsheetPreview(viewerNode, spreadsheetMetadata)
    }
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(enhance)
    })
    observer.observe(viewerNode, { childList: true, subtree: true })
    enhance()
    return () => observer.disconnect()
  }, [spreadsheetMetadata, viewerNode])

  // The visible preview is also the AI visual-QA source. Capture evenly sampled
  // viewports so users can watch the exact render that the model will inspect.
  useEffect(() => {
    const request = officePreviewRequest
    if (!request?.requestId || !previewFile || request.file?.path !== previewFile.path) return
    if (captureRequestRef.current === request.requestId) return

    if (viewerError && viewerError.path === previewFile.path) {
      captureRequestRef.current = request.requestId
      window.api.completeOfficePreviewCapture({
        requestId: request.requestId,
        error: viewerError.message
      })
      setOfficePreviewRequest(null)
      return
    }

    if (
      !viewerNode ||
      !viewerReady ||
      viewerReady.path !== previewFile.path ||
      viewerReady.requestId !== request.requestId
    ) {
      return
    }
    const captureNode = viewerNodeRef.current
    if (!captureNode || captureNode !== viewerNode) return

    captureRequestRef.current = request.requestId
    let cancelled = false
    let completed = false
    const capture = async (): Promise<void> => {
      const imagePaths: string[] = []
      const originalScrollTop = captureNode.scrollTop
      try {
        await new Promise(resolve => setTimeout(resolve, 350))
        if (cancelled) return

        const focus = request.focus || { mode: 'overview' }
        const maxFrames = Math.max(1, Math.min(Number(request.maxFrames) || 8, 12))
        if (focus.mode === 'changes' && Array.isArray(focus.sheets) && focus.sheets.length > 0) {
          const targetSheet = String(focus.sheets[0]).trim().toLocaleLowerCase()
          const sheetTab = Array.from(
            captureNode.querySelectorAll<HTMLButtonElement>('.ofv-tabs [role="tab"]')
          ).find(button => (button.textContent || '').trim().toLocaleLowerCase() === targetSheet)
          if (sheetTab && sheetTab.getAttribute('aria-selected') !== 'true') {
            sheetTab.click()
            await new Promise<void>(resolve =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
          }
        }

        const viewportHeight = Math.max(1, captureNode.clientHeight)
        const maxScroll = Math.max(0, captureNode.scrollHeight - viewportHeight)
        const availableFrames = Math.max(1, Math.ceil(captureNode.scrollHeight / viewportHeight))
        const focusedPositions: number[] = []
        const addTarget = (element: Element | null): void => {
          if (!element || !captureNode.contains(element)) return
          const containerBounds = captureNode.getBoundingClientRect()
          const targetBounds = element.getBoundingClientRect()
          const targetTop =
            captureNode.scrollTop + targetBounds.top - containerBounds.top -
            Math.max(0, (viewportHeight - Math.min(targetBounds.height, viewportHeight)) / 2)
          const position = Math.max(0, Math.min(maxScroll, Math.round(targetTop)))
          if (!focusedPositions.some(existing => Math.abs(existing - position) < 48)) {
            focusedPositions.push(position)
          }
        }

        if (focus.mode === 'changes') {
          for (const address of Array.isArray(focus.cells) ? focus.cells : []) {
            const normalizedAddress = String(address).trim().toUpperCase()
            const cell = Array.from(captureNode.querySelectorAll<HTMLElement>('[data-cell]'))
              .find(element => element.dataset.cell?.toUpperCase() === normalizedAddress)
            if (cell) {
              cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' })
              addTarget(cell)
              break
            }
          }

          const pageElements = Array.from(
            captureNode.querySelectorAll(
              '.ofv-pdf-page-wrapper, .ofv-docx-page-frame, .ofv-pptx-viewer > [data-slide-index]'
            )
          )
          for (const rawPage of Array.isArray(focus.pages) ? focus.pages : []) {
            const page = Number(rawPage)
            if (Number.isInteger(page) && page > 0) addTarget(pageElements[page - 1] || null)
          }

          const focusTexts = [
            ...(Array.isArray(focus.texts) ? focus.texts : []),
            ...(Array.isArray(focus.cells) ? focus.cells : []),
            ...(Array.isArray(focus.sheets) ? focus.sheets : [])
          ]
            .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
            .slice(0, 24)
          if (focusTexts.length > 0) {
            const walker = document.createTreeWalker(captureNode, NodeFilter.SHOW_TEXT)
            let node = walker.nextNode()
            while (node && focusedPositions.length < maxFrames * 3) {
              const value = node.textContent || ''
              const normalized = value.toLocaleLowerCase()
              if (focusTexts.some(text => normalized.includes(text.trim().toLocaleLowerCase()))) {
                const parent = node.parentElement
                addTarget(parent?.closest('td, th, [data-slide-index], .ofv-pdf-page-wrapper, .ofv-docx-page-frame') || parent)
              }
              node = walker.nextNode()
            }
          }
        }

        focusedPositions.sort((a, b) => a - b)
        const focusMatched = focus.mode === 'changes' && focusedPositions.length > 0
        const fallbackFrameCount = Math.min(availableFrames, maxFrames)
        const overviewPositions = Array.from({ length: fallbackFrameCount }, (_, index) =>
          fallbackFrameCount === 1 ? 0 : Math.round((maxScroll * index) / (fallbackFrameCount - 1))
        )
        const candidatePositions = focusMatched ? focusedPositions : overviewPositions
        const positions = candidatePositions.slice(0, maxFrames)

        for (let index = 0; index < positions.length; index++) {
          if (cancelled) return
          captureNode.scrollTop = positions[index]
          await new Promise<void>(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
          await new Promise(resolve => setTimeout(resolve, 180))

          const bounds = captureNode.getBoundingClientRect()
          const result = await window.api.captureOfficePreviewFrame({
            requestId: request.requestId,
            index,
            rect: {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.round(bounds.width),
              height: Math.round(bounds.height)
            }
          })
          if (!result.success || !result.path) {
            throw new Error(result.error || `Preview screenshot ${index + 1} failed`)
          }
          imagePaths.push(result.path)
        }

        window.api.completeOfficePreviewCapture({
          requestId: request.requestId,
          imagePaths,
          truncated: candidatePositions.length > positions.length,
          focusMatched: focus.mode !== 'changes' || focusMatched
        })
      } catch (error) {
        window.api.completeOfficePreviewCapture({
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        captureNode.scrollTop = originalScrollTop
        if (!cancelled) {
          completed = true
          setOfficePreviewRequest(null)
        }
      }
    }

    void capture()
    return () => {
      cancelled = true
      if (!completed && captureRequestRef.current === request.requestId) {
        captureRequestRef.current = null
        window.setTimeout(() => {
          if (captureRequestRef.current === request.requestId) return
          window.api.completeOfficePreviewCapture({
            requestId: request.requestId,
            error: 'The visible preview was closed or changed before screenshots finished'
          })
          setOfficePreviewRequest(null)
        }, 300)
      }
    }
  }, [officePreviewRequest, previewFile, setOfficePreviewRequest, viewerError, viewerNode, viewerReady])

  // 监听全屏状态变化（包括原生全屏和应用内全屏），自动 resize 预览组件以填充屏幕
  useEffect(() => {
    const handleFullscreen = () => {
      setTimeout(() => {
        if (viewerRef.current) {
          try {
            viewerRef.current.resize()
          } catch (e) {
            console.error('[FilePreviewPanel] resize error:', e)
          }
        }
      }, 150)
    }
    document.addEventListener('fullscreenchange', handleFullscreen)

    // 应用内全屏状态变化时触发 resize 自适应宽度
    handleFullscreen()

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreen)
    }
  }, [isFakeFullscreen])

  const handleDeleteFileLocal = async (f: { name: string; path: string; size: number }) => {
    await handleDeleteFile(f)
  }

  const handlePreviewFileLocal = async (f: { name: string; path: string; size: number }) => {
    await handlePreviewFile(f)
    if (filePanelWidth < 380) setFilePanelWidth(420)
  }

  const panelStyle: React.CSSProperties = isFakeFullscreen
    ? {
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      zIndex: 99999,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-card)',
      overflow: 'hidden'
    }
    : {
      width: `${filePanelWidth}px`,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-card)',
      overflow: 'hidden',
      flexShrink: 0
    }

  return (
    <>
      {/* 拖拽调整条 */}
      {!isFakeFullscreen && (
        <div
          onMouseDown={(e) => {
            e.preventDefault()
            isDraggingRef.current = true
            dragStartXRef.current = e.clientX
            dragStartWidthRef.current = filePanelWidth
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
          style={{
            width: '5px',
            cursor: 'col-resize',
            background: 'var(--border-color)',
            flexShrink: 0,
            transition: 'background 0.15s',
            position: 'relative'
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--text-muted)'}
          onMouseLeave={e => { if (!isDraggingRef.current) e.currentTarget.style.background = 'var(--border-color)' }}
        />
      )}
      <div style={panelStyle}>
        {/* 面板头部 */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: '13px', fontWeight: 600, display: 'inline-flex', alignItems: 'center' }}>
            <FolderOpen size={17} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
            已生成的文件 ({visibleFileCount})
          </span>
          <button
            onClick={() => { setShowFilePanel(false); setPreviewFile(null); setOpenTabs([]) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px' }}
          ><X size={15} strokeWidth={2} aria-hidden="true" /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {openTabs.length > 0 ? (
            <>
              {/* 有已打开的 Tab 时：上方 Tab 栏 + 下方预览区域 */}
              <div style={{
                display: 'flex',
                flexWrap: 'nowrap',
                overflowX: 'auto',
                overflowY: 'hidden',
                flexShrink: 0,
                gap: '2px',
                padding: '6px 8px 0',
                borderBottom: '1px solid var(--border-color)',
                background: 'var(--bg-menu-hover, rgba(128,128,128,0.03))'
              }}>
                {openTabs.map((f) => {
                  const isActive = previewFile?.path === f.path
                  return (
                    <div
                      key={f.path}
                      onClick={() => handlePreviewFileLocal(f)}
                      title={`${f.name} (${(f.size / 1024).toFixed(1)} KB)`}
                      style={{
                        padding: '4px 8px',
                        cursor: 'pointer',
                        borderRadius: '6px 6px 0 0',
                        border: `1px solid ${isActive ? 'var(--border-color)' : 'transparent'}`,
                        borderBottom: isActive ? '1px solid var(--bg-card)' : '1px solid transparent',
                        background: isActive ? 'var(--bg-card)' : 'transparent',
                        color: isActive ? 'var(--text-menu-active)' : 'var(--text-muted)',
                        fontSize: '11px',
                        fontWeight: isActive ? 600 : 400,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: '150px',
                        transition: 'all 0.15s',
                        marginBottom: '-1px',
                        position: 'relative' as const,
                        zIndex: isActive ? 1 : 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                      onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--bg-menu-hover)'; e.currentTarget.style.color = 'var(--text-primary)' } }}
                      onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' } }}
                    >
                      <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>
                        <FileTypeIcon fileName={f.name} size={17} />
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          // 从 Tab 列表移除
                          const remaining = openTabs.filter(t => t.path !== f.path)
                          setOpenTabs(remaining)
                          if (remaining.length === 0) {
                            setPreviewFile(null)
                          } else if (previewFile?.path === f.path) {
                            const next = remaining[remaining.length - 1]
                            handlePreviewFileLocal(next)
                          }
                        }}
                        title="关闭 Tab"
                        style={{
                          fontSize: '10px',
                          flexShrink: 0,
                          opacity: 0.5,
                          cursor: 'pointer',
                          padding: '0 2px',
                          borderRadius: '3px',
                          lineHeight: 1
                        }}
                        onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(239,68,68,0.15)' }}
                        onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.background = 'transparent' }}
                      ><X size={11} strokeWidth={2} aria-hidden="true" /></span>
                    </div>
                  )
                })}
              </div>

              {/* 预览区域 */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                {/* 预览头部 */}
                <div style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--border-color)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexShrink: 0,
                  background: 'var(--bg-card)'
                }}>
                  <span title={previewFile!.name} style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    marginRight: '8px'
                  }}>{previewFile!.name}</span>

                  {officePreviewRequest?.file?.path === previewFile!.path && (
                    <span style={{
                      fontSize: '10px',
                      color: 'var(--accent-color, #4f8cff)',
                      marginRight: '10px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0
                    }}>
                      {officePreviewRequest.focus?.mode === 'changes'
                        ? 'AI 正在检查改动位置…'
                        : 'AI 正在检查文档预览…'}
                    </span>
                  )}

                  {/* 自定义预览控制（放大、缩小、适应宽度、旋转） */}
                  {hasToolbarCtx && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '2px',
                      marginRight: '12px',
                      background: 'var(--bg-menu-hover, rgba(128,128,128,0.06))',
                      padding: '2px 4px',
                      borderRadius: '6px',
                      flexShrink: 0
                    }}>
                      <button
                        onClick={() => {
                          toolbarContextRef.current?.command('zoom-out')
                          setTimeout(syncZoomStatus, 50)
                        }}
                        disabled={!canZoomOut}
                        title="缩小"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: canZoomOut ? 'pointer' : 'not-allowed',
                          opacity: canZoomOut ? 0.8 : 0.3,
                          padding: '2px 6px',
                          fontSize: '10px',
                          color: 'var(--text-primary)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                        onMouseEnter={e => { if (canZoomOut) e.currentTarget.style.background = 'rgba(128,128,128,0.15)' }}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <ZoomOut size={14} strokeWidth={2} aria-hidden="true" />
                      </button>
                      <span style={{
                        fontSize: '9px',
                        fontWeight: 600,
                        minWidth: '38px',
                        textAlign: 'center',
                        color: 'var(--text-muted)',
                        userSelect: 'none'
                      }}>
                        {zoomLabel}
                      </span>
                      <button
                        onClick={() => {
                          toolbarContextRef.current?.command('zoom-in')
                          setTimeout(syncZoomStatus, 50)
                        }}
                        disabled={!canZoomIn}
                        title="放大"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: canZoomIn ? 'pointer' : 'not-allowed',
                          opacity: canZoomIn ? 0.8 : 0.3,
                          padding: '2px 6px',
                          fontSize: '10px',
                          color: 'var(--text-primary)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                        onMouseEnter={e => { if (canZoomIn) e.currentTarget.style.background = 'rgba(128,128,128,0.15)' }}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <ZoomIn size={14} strokeWidth={2} aria-hidden="true" />
                      </button>
                      <div style={{ width: '1px', height: '10px', background: 'var(--border-color)', margin: '0 2px' }} />
                      <button
                        onClick={() => {
                          setIsFakeFullscreen(!isFakeFullscreen)
                        }}
                        title={isFakeFullscreen ? "退出全屏" : "全屏"}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          opacity: 0.8,
                          padding: '2px 6px',
                          fontSize: '10px',
                          color: 'var(--text-primary)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(128,128,128,0.15)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        {isFakeFullscreen
                          ? <Minimize2 size={14} strokeWidth={2} aria-hidden="true" />
                          : <Maximize2 size={14} strokeWidth={2} aria-hidden="true" />}
                      </button>
                      {canRotate && (
                        <button
                          onClick={() => {
                            toolbarContextRef.current?.command('rotate-right')
                            setTimeout(syncZoomStatus, 50)
                          }}
                          title="顺时针旋转"
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            opacity: 0.8,
                            padding: '2px 6px',
                            fontSize: '10px',
                            color: 'var(--text-primary)',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center'
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(128,128,128,0.15)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}
                        >
                          <RotateCw size={14} strokeWidth={2} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <button onClick={async () => { await window.api.saveGeneratedFileAs(previewFile!.path) }} title="另存为" style={{ background: 'rgba(59,130,246,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#3b82f6', fontSize: '10px' }}><Save size={14} strokeWidth={2} aria-hidden="true" /></button>
                    <button onClick={() => handleDeleteFileLocal(previewFile!)} title="删除" style={{ background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#ef4444', fontSize: '10px' }}><Trash2 size={14} strokeWidth={2} aria-hidden="true" /></button>
                    <button onClick={() => {
                      const remaining = openTabs.filter(t => t.path !== previewFile!.path)
                      setOpenTabs(remaining)
                      if (remaining.length === 0) {
                        setPreviewFile(null)
                      } else {
                        const next = remaining[remaining.length - 1]
                        handlePreviewFileLocal(next)
                      }
                    }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '2px 4px' }}><X size={14} strokeWidth={2} aria-hidden="true" /></button>
                  </div>
                </div>

                {/* 预览正文 */}
                <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                  {previewLoading && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card)', zIndex: 10, color: 'var(--text-muted)', fontSize: '12px' }}>加载中...</div>
                  )}
                  <div ref={handleViewerNode} className="file-preview-viewer-container" style={{ position: 'absolute', inset: 0, overflow: 'auto' }} />
                </div>
              </div>
            </>
          ) : (
            /* 无预览文件时：垂直文件列表 */
            <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
              {generatedFiles.map((f, i) => {
                return (
                  <div
                    key={i}
                    onClick={() => handlePreviewFileLocal(f)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 10px',
                      cursor: 'pointer',
                      borderRadius: '6px',
                      transition: 'background 0.15s',
                      marginBottom: '2px'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-menu-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>
                      <FileTypeIcon fileName={f.name} size={21} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{(f.size / 1024).toFixed(1)} KB</div>
                    </div>
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteFileLocal(f)
                      }}
                      title="删除文件"
                      style={{
                        fontSize: '11px',
                        opacity: 0,
                        cursor: 'pointer',
                        padding: '2px 4px',
                        borderRadius: '3px',
                        color: 'var(--text-muted)',
                        transition: 'opacity 0.15s',
                        flexShrink: 0
                      }}
                      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(239,68,68,0.15)'; e.currentTarget.style.color = '#ef4444' }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
                    ><Trash2 size={14} strokeWidth={2} aria-hidden="true" /></span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

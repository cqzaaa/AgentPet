import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createViewer } from '@open-file-viewer/core'
import { createFileViewerPlugins, localFilePreviewUrl } from './fileViewerPlugins'
import '@open-file-viewer/core/style.css'
import JSZip from 'jszip'
import { AppStore } from '../hooks/useAppStore'
import { Tooltip } from './Tooltip'
import { FileIcon } from './FileIcon'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Maximize2,
  Minimize2,
  RotateCw,
  Save,
  Trash2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'

interface FilePreviewPanelProps {
  store: AppStore
  captureOnly?: boolean
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

type GeneratedFileRecord = {
  name: string
  path: string
  size: number
  time?: string
  role?: 'final' | 'intermediate'
}

function formatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function GeneratedFileSection({
  title,
  files,
  collapsible = false,
  onPreview,
  onDelete
}: {
  title: string
  files: GeneratedFileRecord[]
  collapsible?: boolean
  onPreview: (file: GeneratedFileRecord) => void
  onDelete: (file: GeneratedFileRecord) => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(!collapsible)
  if (files.length === 0) return null

  return (
    <section className="generated-file-section" aria-label={`${title}，共 ${files.length} 个`}>
      {collapsible ? (
        <button
          type="button"
          className="generated-file-section-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span>{title}</span>
          <span className="generated-file-section-count">{files.length}</span>
        </button>
      ) : (
        <div className="generated-file-section-heading">
          <span>{title}</span>
          <span className="generated-file-section-count">{files.length}</span>
        </div>
      )}

      {expanded && (
        <div className="generated-file-section-list">
          {files.map((file) => (
            <div className="generated-file-row" key={file.path}>
              <button
                type="button"
                className="generated-file-open"
                title={`预览 ${file.name}`}
                onClick={() => onPreview(file)}
              >
                <span className="generated-file-icon">
                  <FileTypeIcon fileName={file.name} size={21} />
                </span>
                <span className="generated-file-copy">
                  <span className="generated-file-name">{file.name}</span>
                  <span className="generated-file-size">{formatFileSize(file.size) || (file.size === 0 ? '0 B' : '')}</span>
                </span>
              </button>
              <button
                type="button"
                className="generated-file-delete"
                onClick={() => onDelete(file)}
                title={`删除 ${file.name}`}
                aria-label={`删除 ${file.name}`}
              >
                <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

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
  return <FileIcon fileName={fileName} size={size} />
}

export function FilePreviewPanel({ store, captureOnly = false }: FilePreviewPanelProps): React.JSX.Element {
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
    loadGeneratedFiles,
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
  const finalFiles = generatedFiles.filter(file => file.role !== 'intermediate')
  const intermediateFiles = generatedFiles.filter(file => file.role === 'intermediate')
  const finalArtifactSyncKey = generatedFiles
    .filter(file => file.role === 'final')
    .map(file => file.path)
    .sort()
    .join('\n')
  const lastArtifactSyncKeyRef = useRef('')
  const [canRotate, setCanRotate] = useState(false)
  const [hasToolbarCtx, setHasToolbarCtx] = useState(false)

  useEffect(() => {
    if (!captureOnly) void loadGeneratedFiles()
  }, [captureOnly, loadGeneratedFiles])

  useEffect(() => {
    if (captureOnly || !finalArtifactSyncKey || lastArtifactSyncKeyRef.current === finalArtifactSyncKey) return
    lastArtifactSyncKeyRef.current = finalArtifactSyncKey
    void loadGeneratedFiles()
  }, [captureOnly, finalArtifactSyncKey, loadGeneratedFiles])

  // 当预览文件的 size 缺失或为 0 时，自动异步通过 IPC 探查真实大小并回填
  useEffect(() => {
    if (!previewFile?.path || (typeof previewFile.size === 'number' && previewFile.size > 0)) return
    if (!window.api?.getFileMetadata) return

    let cancelled = false
    window.api.getFileMetadata(previewFile.path).then((meta) => {
      if (cancelled || !meta?.exists || typeof meta.size !== 'number' || meta.size <= 0) return
      setPreviewFile((prev: any) => (prev && prev.path === previewFile.path ? { ...prev, size: meta.size } : prev))
      setOpenTabs((prev: any[]) =>
        prev.map((t) => (t.path === previewFile.path ? { ...t, size: meta.size } : t))
      )
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [previewFile?.path, previewFile?.size, setPreviewFile, setOpenTabs])

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
      const fileUrl = localFilePreviewUrl(previewFile.path)

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
        plugins: createFileViewerPlugins(),
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
    void loadSpreadsheetMetadata(localFilePreviewUrl(previewFile.path))
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
        const captureMode = request.captureMode === 'pages' ? 'pages' : 'overview'
        const maxFrames = Math.max(
          1,
          Math.min(Number(request.maxFrames) || (captureMode === 'pages' ? 500 : 8), captureMode === 'pages' ? 500 : 12)
        )
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

        const findPageElements = (): HTMLElement[] => {
          if (captureMode !== 'pages') return []
          const selectors = [
            '.ofv-pdf-page-wrapper',
            '.ofv-docx-page-frame',
            '.ofv-msdoc-page',
            '.ofv-pptx-viewer > [data-slide-index]'
          ]
          for (const selector of selectors) {
            const matches = Array.from(captureNode.querySelectorAll<HTMLElement>(selector))
            if (matches.length > 0) return matches
          }
          return []
        }
        let pageElements = findPageElements()
        if (pageElements.length > 0) {
          const firstBounds = pageElements[0].getBoundingClientRect()
          const availableWidth = Math.max(1, captureNode.clientWidth - 16)
          const availableHeight = Math.max(1, captureNode.clientHeight - 16)
          const currentZoom = Number(toolbarContextRef.current?.zoom) || 1
          const fitScale = Math.min(availableWidth / firstBounds.width, availableHeight / firstBounds.height, 1)
          if (fitScale < 0.98 && toolbarContextRef.current?.setZoom) {
            toolbarContextRef.current.setZoom(Math.max(0.1, currentZoom * fitScale * 0.96))
            await new Promise<void>(resolve =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
            pageElements = findPageElements()
          }
        }

        focusedPositions.sort((a, b) => a - b)
        const focusMatched = focus.mode === 'changes' && focusedPositions.length > 0
        const fallbackFrameCount = Math.min(availableFrames, maxFrames)
        const overviewPositions = Array.from({ length: fallbackFrameCount }, (_, index) =>
          fallbackFrameCount === 1 ? 0 : Math.round((maxScroll * index) / (fallbackFrameCount - 1))
        )
        const candidatePositions = focusMatched ? focusedPositions : overviewPositions
        const positions = captureMode === 'pages' && pageElements.length === 0
          ? Array.from({ length: Math.min(availableFrames, maxFrames) }, (_, index) =>
            Math.min(maxScroll, index * viewportHeight)
          )
          : candidatePositions.slice(0, maxFrames)
        const pageTargets = captureMode === 'pages' ? pageElements.slice(0, maxFrames) : []
        const captureCount = pageTargets.length || positions.length

        for (let index = 0; index < captureCount; index++) {
          if (cancelled) return
          const pageTarget = pageTargets[index]
          if (pageTarget) {
            const containerBounds = captureNode.getBoundingClientRect()
            const targetBounds = pageTarget.getBoundingClientRect()
            const targetTop = captureNode.scrollTop + targetBounds.top - containerBounds.top
            captureNode.scrollTop = Math.max(0, Math.min(maxScroll,
              targetTop - Math.max(0, (captureNode.clientHeight - targetBounds.height) / 2)))
          }
          else captureNode.scrollTop = positions[index]
          await new Promise<void>(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
          await new Promise(resolve => setTimeout(resolve, 180))

          const containerBounds = captureNode.getBoundingClientRect()
          const targetBounds = pageTarget?.getBoundingClientRect()
          const bounds = targetBounds && targetBounds.width > 0 && targetBounds.height > 0
            ? {
                x: Math.max(containerBounds.x, targetBounds.x),
                y: Math.max(containerBounds.y, targetBounds.y),
                width: Math.min(containerBounds.right, targetBounds.right) - Math.max(containerBounds.x, targetBounds.x),
                height: Math.min(containerBounds.bottom, targetBounds.bottom) - Math.max(containerBounds.y, targetBounds.y)
              }
            : containerBounds
          const result = await window.api.captureOfficePreviewFrame({
            requestId: request.requestId,
            index,
            total: captureCount,
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
          truncated: pageTargets.length > 0
            ? pageElements.length > pageTargets.length
            : candidatePositions.length > positions.length,
          pageCount: pageTargets.length > 0 ? pageElements.length : availableFrames,
          capturedPages: Array.from({ length: captureCount }, (_, index) => index + 1),
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

  const panelDynamicStyle: React.CSSProperties = isFakeFullscreen || captureOnly
    ? {}
    : { width: `${filePanelWidth}px` }

  return (
    <>
      {/* 拖拽调整手柄 */}
      {!isFakeFullscreen && !captureOnly && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整预览面板宽度"
          className="file-preview-resizer"
          onMouseDown={(e) => {
            e.preventDefault()
            isDraggingRef.current = true
            dragStartXRef.current = e.clientX
            dragStartWidthRef.current = filePanelWidth
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        />
      )}
      <div
        style={panelDynamicStyle}
        className={`file-preview-panel-root${isFakeFullscreen ? ' is-fullscreen' : ''}${captureOnly ? ' is-capture-only' : ''}`}
      >
        {/* 面板主顶栏：有已打开的 Tab 时作为统一 Tab 导航，无 Tab 时作为简洁标题栏 */}
        {!captureOnly && (
          <div className="file-preview-top-bar">
            {openTabs.length > 0 ? (
              <div className="file-preview-tabs-container">
                <div className="file-preview-tabs-scroll">
                  {openTabs.map((f) => {
                    const isActive = previewFile?.path === f.path
                    return (
                      <div
                        key={f.path}
                        onClick={() => handlePreviewFileLocal(f)}
                        title={`${f.name}${f.size ? ` (${formatFileSize(f.size)})` : ''}`}
                        className={`file-preview-tab-pill${isActive ? ' active' : ''}`}
                      >
                        <span className="file-preview-tab-icon">
                          <FileTypeIcon fileName={f.name} size={15} />
                        </span>
                        <span className="file-preview-tab-name">{f.name}</span>
                        <Tooltip content="关闭" placement="bottom">
                          <button
                            type="button"
                            className="file-preview-tab-close"
                            onClick={(e) => {
                              e.stopPropagation()
                              const remaining = openTabs.filter(t => t.path !== f.path)
                              setOpenTabs(remaining)
                              if (remaining.length === 0) {
                                setPreviewFile(null)
                              } else if (previewFile?.path === f.path) {
                                const next = remaining[remaining.length - 1]
                                handlePreviewFileLocal(next)
                              }
                            }}
                            aria-label={`关闭 ${f.name}`}
                          >
                            <X size={11} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </Tooltip>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="file-preview-top-title">
                <FolderOpen size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                <span>已生成的文件 ({visibleFileCount})</span>
              </div>
            )}
            <div className="file-preview-top-actions">
              <Tooltip content="收起预览面板" placement="bottom">
                <button
                  type="button"
                  className="file-preview-icon-btn panel-close"
                  onClick={() => { setShowFilePanel(false); setPreviewFile(null); setOpenTabs([]) }}
                  aria-label="关闭预览面板"
                >
                  <X size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {openTabs.length > 0 ? (
            <>
              {/* 预览区域 */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                {/* 扁平高效工具栏：消除冗余大文件名，聚合缩放全屏与文件操作 */}
                <div className="file-preview-sub-toolbar">
                  <div className="file-preview-sub-info">
                    {officePreviewRequest?.file?.path === previewFile!.path ? (
                      <span className="file-preview-ai-status">
                        {officePreviewRequest.focus?.mode === 'changes'
                          ? 'AI 正在检查改动位置…'
                          : 'AI 正在检查文档预览…'}
                      </span>
                    ) : (
                      <span className="file-preview-meta-size">
                        {formatFileSize(previewFile!.size) || (previewFile!.size === 0 ? '0 B' : '')}
                      </span>
                    )}
                  </div>

                  {/* 缩放、旋转与全屏控制胶囊 */}
                  {hasToolbarCtx && (
                    <div className="file-preview-zoom-capsule">
                      <Tooltip content="缩小" placement="bottom">
                        <button
                          type="button"
                          onClick={() => {
                            toolbarContextRef.current?.command('zoom-out')
                            setTimeout(syncZoomStatus, 50)
                          }}
                          disabled={!canZoomOut}
                          className="file-preview-zoom-btn"
                          aria-label="缩小视图"
                        >
                          <ZoomOut size={13} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <span className="file-preview-zoom-val">
                        {zoomLabel}
                      </span>
                      <Tooltip content="放大" placement="bottom">
                        <button
                          type="button"
                          onClick={() => {
                            toolbarContextRef.current?.command('zoom-in')
                            setTimeout(syncZoomStatus, 50)
                          }}
                          disabled={!canZoomIn}
                          className="file-preview-zoom-btn"
                          aria-label="放大视图"
                        >
                          <ZoomIn size={13} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <div className="file-preview-zoom-sep" />
                      <Tooltip content={isFakeFullscreen ? "退出全屏" : "全屏预览"} placement="bottom">
                        <button
                          type="button"
                          onClick={() => setIsFakeFullscreen(!isFakeFullscreen)}
                          className="file-preview-zoom-btn"
                          aria-label={isFakeFullscreen ? "退出全屏" : "全屏"}
                        >
                          {isFakeFullscreen
                            ? <Minimize2 size={13} strokeWidth={2} aria-hidden="true" />
                            : <Maximize2 size={13} strokeWidth={2} aria-hidden="true" />}
                        </button>
                      </Tooltip>
                      {canRotate && (
                        <Tooltip content="顺时针旋转" placement="bottom">
                          <button
                            type="button"
                            onClick={() => {
                              toolbarContextRef.current?.command('rotate-right')
                              setTimeout(syncZoomStatus, 50)
                            }}
                            className="file-preview-zoom-btn"
                            aria-label="顺时针旋转"
                          >
                            <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  )}

                  {/* 文件操作动作：另存为、删除、关闭当前文件 */}
                  <div className="file-preview-actions-bar">
                    <Tooltip content="另存为本地文件" placement="bottom">
                      <button
                        type="button"
                        className="file-preview-action-btn action-save"
                        onClick={async () => { await window.api.saveGeneratedFileAs(previewFile!.path) }}
                        aria-label="另存为"
                      >
                        <Save size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Tooltip content="删除该文件" placement="bottom">
                      <button
                        type="button"
                        className="file-preview-action-btn action-delete"
                        onClick={() => handleDeleteFileLocal(previewFile!)}
                        aria-label="删除文件"
                      >
                        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Tooltip content="关闭当前预览" placement="bottom">
                      <button
                        type="button"
                        className="file-preview-action-btn action-close"
                        onClick={() => {
                          const remaining = openTabs.filter(t => t.path !== previewFile!.path)
                          setOpenTabs(remaining)
                          if (remaining.length === 0) {
                            setPreviewFile(null)
                          } else {
                            const next = remaining[remaining.length - 1]
                            handlePreviewFileLocal(next)
                          }
                        }}
                        aria-label="关闭当前预览"
                      >
                        <X size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {/* 预览正文 */}
                <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                  {previewLoading && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card)', zIndex: 10, color: 'var(--text-muted)', fontSize: '12px' }}>加载中...</div>
                  )}
                  <div ref={handleViewerNode} className="file-preview-viewer-container" style={{ position: 'absolute', inset: 0, overflow: 'auto', scrollbarGutter: 'stable' }} />
                </div>
              </div>
            </>
          ) : (
            /* 无预览文件时：垂直文件列表 */
            <div className="generated-file-groups">
              <GeneratedFileSection
                title="最终产物"
                files={finalFiles}
                onPreview={handlePreviewFileLocal}
                onDelete={handleDeleteFileLocal}
              />
              <GeneratedFileSection
                title="中间产物"
                files={intermediateFiles}
                collapsible
                onPreview={handlePreviewFileLocal}
                onDelete={handleDeleteFileLocal}
              />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents
} from 'electron'
import * as fs from 'fs'
import { randomUUID } from 'crypto'
import { basename, extname, join } from 'path'

import type { ToolContext } from '../../core/types'
import { getGeneratedFilesDir } from '../../utils/paths'

export interface OfficePreviewCaptureResult {
  status: 'success' | 'unavailable' | 'error'
  renderer: 'open-file-viewer'
  imagePaths: string[]
  frames?: number
  truncated?: boolean
  pageCount?: number
  capturedPages?: number[]
  message?: string
}

export interface OfficePreviewFocus {
  mode: 'overview' | 'changes'
  texts?: string[]
  pages?: number[]
  cells?: string[]
  sheets?: string[]
}

interface PendingCapture {
  sender: WebContents
  sessionId?: string
  filePath: string
  imagePaths: string[]
  resolve: (result: OfficePreviewCaptureResult) => void
  timer: NodeJS.Timeout
  abortSignal?: AbortSignal
  abortHandler?: () => void
  messageId?: number
}

interface CaptureFramePayload {
  requestId: string
  index: number
  total?: number
  rect: Rectangle
}

interface CompleteCapturePayload {
  requestId: string
  imagePaths?: string[]
  truncated?: boolean
  focusMatched?: boolean
  pageCount?: number
  capturedPages?: number[]
  error?: string
}

const pendingCaptures = new Map<string, PendingCapture>()
let handlersRegistered = false

function finishCapture(requestId: string, result: OfficePreviewCaptureResult): void {
  const pending = pendingCaptures.get(requestId)
  if (!pending) return
  clearTimeout(pending.timer)
  if (pending.abortSignal && pending.abortHandler) {
    pending.abortSignal.removeEventListener('abort', pending.abortHandler)
  }
  pendingCaptures.delete(requestId)
  pending.resolve(result)
}

function isExpectedSender(pending: PendingCapture, sender: WebContents): boolean {
  return !pending.sender.isDestroyed() && pending.sender.id === sender.id
}

function normalizeCaptureRect(sender: WebContents, rawRect: Rectangle): Rectangle {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window.isDestroyed()) throw new Error('Preview window is unavailable')
  const [contentWidth, contentHeight] = window.getContentSize()
  const x = Math.max(0, Math.min(Math.floor(Number(rawRect?.x) || 0), contentWidth - 1))
  const y = Math.max(0, Math.min(Math.floor(Number(rawRect?.y) || 0), contentHeight - 1))
  const width = Math.max(
    1,
    Math.min(Math.floor(Number(rawRect?.width) || contentWidth), contentWidth - x)
  )
  const height = Math.max(
    1,
    Math.min(Math.floor(Number(rawRect?.height) || contentHeight), contentHeight - y)
  )
  return { x, y, width, height }
}

async function captureFrame(
  event: IpcMainInvokeEvent,
  payload: CaptureFramePayload
): Promise<{ success: boolean; path?: string; error?: string }> {
  const pending = pendingCaptures.get(String(payload?.requestId || ''))
  if (!pending || !isExpectedSender(pending, event.sender)) {
    return { success: false, error: 'Preview capture request is no longer active' }
  }

  try {
    const rect = normalizeCaptureRect(event.sender, payload.rect)
    const image = await event.sender.capturePage(rect)
    if (image.isEmpty()) throw new Error('Electron returned an empty preview image')

    const baseName = basename(pending.filePath, extname(pending.filePath))
      .replace(/[<>:"/\\|?*]/g, '_')
      .slice(0, 80)
    const outputDirectory = join(
      getGeneratedFilesDir(pending.sessionId),
      'rendered',
      `${baseName}-open-file-viewer-${payload.requestId.slice(0, 8)}`
    )
    await fs.promises.mkdir(outputDirectory, { recursive: true })
    const index = Math.max(0, Math.floor(Number(payload.index) || 0))
    const outputPath = join(outputDirectory, `viewport-${String(index + 1).padStart(2, '0')}.png`)
    await fs.promises.writeFile(outputPath, image.toPNG())
    pending.imagePaths[index] = outputPath
    const total = Math.max(1, Math.floor(Number(payload.total) || 1))
    const completed = Math.min(index + 1, total)
    event.sender.send('api:llm-tool-event', {
      type: 'tool_progress',
      name: 'Office 页面捕获',
      detail: `已捕获 ${completed}/${total} 页`,
      progress: Math.round((completed / total) * 100),
      timestamp: Date.now(),
      messageId: pending.messageId,
      sessionId: pending.sessionId
    })
    return { success: true, path: outputPath }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function completeCapture(event: IpcMainEvent, payload: CompleteCapturePayload): void {
  const requestId = String(payload?.requestId || '')
  const pending = pendingCaptures.get(requestId)
  if (!pending || !isExpectedSender(pending, event.sender)) return

  if (payload.error) {
    finishCapture(requestId, {
      status: 'error',
      renderer: 'open-file-viewer',
      imagePaths: [],
      message: payload.error
    })
    return
  }

  // Only trust paths written by the main-process capture handler. Renderer-provided
  // paths are acknowledgements, not authority to inject arbitrary local images.
  const imagePaths = [...new Set(pending.imagePaths.filter((path) => path && fs.existsSync(path)))]
  finishCapture(requestId, {
    status: imagePaths.length > 0 ? 'success' : 'error',
    renderer: 'open-file-viewer',
    imagePaths,
    frames: imagePaths.length,
    truncated: Boolean(payload.truncated),
    pageCount: Number(payload.pageCount) || imagePaths.length,
    capturedPages: Array.isArray(payload.capturedPages) ? payload.capturedPages : undefined,
    message:
      imagePaths.length === 0
        ? 'Preview loaded, but no screenshots were produced'
        : payload.focusMatched === false
          ? 'The changed location could not be identified; overview screenshots were used'
          : undefined
  })
}

function ensurePreviewCaptureHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true
  ipcMain.handle('api:capture-office-preview-frame', captureFrame)
  ipcMain.on('api:complete-office-preview-capture', completeCapture)
}

export async function requestVisibleOfficePreview(
  filePath: string,
  context: ToolContext,
  options: {
    maxFrames?: number
    timeoutMs?: number
    focus?: OfficePreviewFocus
    captureMode?: 'overview' | 'pages'
  } = {}
): Promise<OfficePreviewCaptureResult> {
  ensurePreviewCaptureHandlers()
  const sender = context.event?.sender
  if (!sender || sender.isDestroyed()) {
    return {
      status: 'unavailable',
      renderer: 'open-file-viewer',
      imagePaths: [],
      message: 'This task has no visible chat window; visual preview was skipped'
    }
  }
  if (!fs.existsSync(filePath)) {
    return {
      status: 'error',
      renderer: 'open-file-viewer',
      imagePaths: [],
      message: `Preview file does not exist: ${filePath}`
    }
  }

  const requestId = randomUUID()
  const captureMode = options.captureMode || 'overview'
  const timeoutMs = Math.max(10_000, Math.min(options.timeoutMs || 60_000, 300_000))
  const maxFrames = Math.max(
    1,
    Math.min(options.maxFrames || (captureMode === 'pages' ? 500 : 8), captureMode === 'pages' ? 500 : 12)
  )

  return new Promise<OfficePreviewCaptureResult>((resolve) => {
    const timer = setTimeout(() => {
      finishCapture(requestId, {
        status: 'error',
        renderer: 'open-file-viewer',
        imagePaths: [],
        message: `Visible preview did not finish within ${Math.round(timeoutMs / 1000)} seconds`
      })
    }, timeoutMs)

    const pending: PendingCapture = {
      sender,
      sessionId: context.sessionId,
      filePath,
      imagePaths: [],
      resolve,
      timer,
      abortSignal: context.abortSignal,
      messageId: context.messageId
    }
    pendingCaptures.set(requestId, pending)
    if (context.abortSignal) {
      pending.abortHandler = () => {
        finishCapture(requestId, {
          status: 'error',
          renderer: 'open-file-viewer',
          imagePaths: [],
          message: 'Preview capture was cancelled'
        })
      }
      context.abortSignal.addEventListener('abort', pending.abortHandler, { once: true })
      if (context.abortSignal.aborted) pending.abortHandler()
    }

    if (!pendingCaptures.has(requestId)) return

    sender.send('api:office-preview-request', {
      requestId,
      sessionId: context.sessionId,
      file: {
        name: basename(filePath),
        path: filePath,
        size: fs.statSync(filePath).size,
        time: new Date().toISOString()
      },
      maxFrames,
      captureMode,
      focus: options.focus || { mode: 'overview' }
    })
  })
}

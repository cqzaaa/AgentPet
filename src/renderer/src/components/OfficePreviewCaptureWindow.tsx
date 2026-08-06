import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AppStore } from '../hooks/useAppStore'
import { FilePreviewPanel } from './FilePreviewPanel'

interface PreviewFile {
  name: string
  path: string
  size: number
  time?: string
}

interface OfficePreviewRequest {
  requestId: string
  sessionId?: string
  file: PreviewFile
  maxFrames: number
  captureMode?: 'overview' | 'pages'
  focus?: {
    mode: 'overview' | 'changes'
    texts?: string[]
    pages?: number[]
    cells?: string[]
    sheets?: string[]
  }
}

/**
 * A renderer dedicated to Office visual QA. It deliberately has no chat/session
 * runtime, so document screenshots can be captured without opening or changing
 * the user's file panel.
 */
export function OfficePreviewCaptureWindow(): React.JSX.Element {
  const [generatedFiles, setGeneratedFiles] = useState<PreviewFile[]>([])
  const [openTabs, setOpenTabs] = useState<PreviewFile[]>([])
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [officePreviewRequest, setOfficePreviewRequest] = useState<OfficePreviewRequest | null>(null)

  const handlePreviewFile = useCallback(async (file: PreviewFile): Promise<void> => {
    setPreviewFile(file)
    setOpenTabs([file])
  }, [])

  useEffect(() => window.api.onOfficePreviewRequest((request) => {
    if (!request?.requestId || !request.file?.path) return
    const file = request.file as PreviewFile
    setGeneratedFiles([file])
    setOpenTabs([file])
    setPreviewFile(file)
    setOfficePreviewRequest(request)
  }), [])

  const store = useMemo(() => ({
    generatedFiles,
    setGeneratedFiles,
    setShowFilePanel: () => undefined,
    openTabs,
    setOpenTabs,
    previewFile,
    setPreviewFile,
    previewLoading,
    setPreviewLoading,
    officePreviewRequest,
    setOfficePreviewRequest,
    handlePreviewFile,
    handleDeleteFile: async () => undefined,
    isCollapsed: true
  }) as unknown as AppStore, [
    generatedFiles,
    handlePreviewFile,
    officePreviewRequest,
    openTabs,
    previewFile,
    previewLoading
  ])

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', overflow: 'hidden' }}>
      <FilePreviewPanel store={store} captureOnly />
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { createViewer } from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import { createFileViewerPlugins, localFilePreviewUrl } from './fileViewerPlugins'

export function EmbeddedFileViewer({ path, name, onShowText }: {
  path: string
  name: string
  onShowText: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!container.current) return
    let active = true
    let viewer: ReturnType<typeof createViewer> | undefined
    setLoading(true)
    setError('')
    const fail = (reason: unknown) => {
      if (!active) return
      setLoading(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
    try {
      viewer = createViewer({
        container: container.current,
        file: localFilePreviewUrl(path),
        fileName: name,
        width: '100%',
        height: '100%',
        fit: 'width',
        locale: 'zh-CN',
        toolbar: true,
        plugins: createFileViewerPlugins(),
        onLoad: () => { if (active) setLoading(false) },
        onError: fail
      })
    } catch (reason) {
      fail(reason)
    }
    return () => {
      active = false
      viewer?.destroy()
    }
  }, [path, name, attempt])

  return <div className="wiki-file-preview" aria-label={`预览 ${name}`} aria-busy={loading}>
    <div className="wiki-file-preview-canvas" ref={container} />
    {loading && <div className="wiki-file-preview-status" role="status">正在加载原文…</div>}
    {error && <div className="wiki-file-preview-status" role="alert">
      <strong>无法预览此文件</strong>
      <p>{error}</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
      <button type="button" onClick={onShowText}>查看解析文本</button>
    </div>}
  </div>
}

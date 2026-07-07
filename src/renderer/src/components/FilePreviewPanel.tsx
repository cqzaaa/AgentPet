import React, { useState, useRef, useEffect } from 'react'
import { createViewer, imagePlugin, pdfPlugin, officePlugin, textPlugin } from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import { AppStore } from '../hooks/useAppStore'

interface FilePreviewPanelProps {
  store: AppStore
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
    handlePreviewFile,
    handleDeleteFile
  } = store

  const [filePanelWidth, setFilePanelWidth] = useState(320)
  const [isFakeFullscreen, setIsFakeFullscreen] = useState(false)
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  const viewerRef = useRef<any>(null)
  const [viewerNode, setViewerNode] = useState<HTMLDivElement | null>(null)

  const toolbarContextRef = useRef<any>(null)
  const [zoomLabel, setZoomLabel] = useState('100%')
  const [canZoomIn, setCanZoomIn] = useState(false)
  const [canZoomOut, setCanZoomOut] = useState(false)
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

  // 拖拽调整面板宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = dragStartXRef.current - e.clientX
      const newWidth = Math.max(240, Math.min(800, dragStartWidthRef.current + delta))
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
  }, [])

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
          setTimeout(syncZoomStatus, 100)
        },
        onError: (err) => {
          console.error('[open-file-viewer] preview error:', err)
          setPreviewLoading(false)
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
          <span style={{ fontSize: '13px', fontWeight: 600 }}>📁 已生成的文件 ({generatedFiles.length})</span>
          <button
            onClick={() => { setShowFilePanel(false); setPreviewFile(null); setOpenTabs([]) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px' }}
          >✕</button>
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
                  const ext = f.name.split('.').pop()?.toLowerCase() || ''
                  const extColors: Record<string, string> = {
                    docx: '#2B579A', doc: '#2B579A', pdf: '#D04423', xlsx: '#217346', xls: '#217346', csv: '#217346',
                    pptx: '#D24726', ppt: '#D24726', txt: '#6B7280', md: '#6B7280', json: '#F59E0B', xml: '#F59E0B',
                    html: '#E34C26', css: '#264DE4', js: '#F7DF1E', ts: '#3178C6', py: '#3776AB',
                    png: '#8B5CF6', jpg: '#8B5CF6', jpeg: '#8B5CF6', gif: '#8B5CF6', webp: '#8B5CF6', svg: '#8B5CF6',
                    zip: '#6B7280', rar: '#6B7280', '7z': '#6B7280'
                  }
                  const color = extColors[ext] || '#6B7280'
                  const label = ext.toUpperCase().slice(0, 4)
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
                        <svg width="16" height="18" viewBox="0 0 16 18" fill="none">
                          <path d="M1 1C1 0.447715 1.44772 0 2 0H10L15 5V17C15 17.5523 14.5523 18 14 18H2C1.44772 18 1 17.5523 1 17V1Z" fill="#fff" stroke="#D1D5DB" strokeWidth="1" />
                          <path d="M10 0L15 5H11C10.4477 5 10 4.55228 10 4V0Z" fill="#E5E7EB" />
                          <rect x="0" y="12" width="16" height="6" rx="0" fill={color} />
                          <text x="8" y="16.5" textAnchor="middle" fill="#fff" fontSize="5" fontWeight="700" fontFamily="Arial,sans-serif">{label}</text>
                        </svg>
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
                      >✕</span>
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
                        ➖
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
                        ➕
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
                        {isFakeFullscreen ? "🗗" : "⛶"}
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
                          ↩️
                        </button>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <button onClick={async () => { await window.api.saveGeneratedFileAs(previewFile!.path) }} title="另存为" style={{ background: 'rgba(59,130,246,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#3b82f6', fontSize: '10px' }}>💾</button>
                    <button onClick={() => handleDeleteFileLocal(previewFile!)} title="删除" style={{ background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', color: '#ef4444', fontSize: '10px' }}>🗑</button>
                    <button onClick={() => {
                      const remaining = openTabs.filter(t => t.path !== previewFile!.path)
                      setOpenTabs(remaining)
                      if (remaining.length === 0) {
                        setPreviewFile(null)
                      } else {
                        const next = remaining[remaining.length - 1]
                        handlePreviewFileLocal(next)
                      }
                    }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '2px 4px' }}>✕</button>
                  </div>
                </div>

                {/* 预览正文 */}
                <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                  {previewLoading && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card)', zIndex: 10, color: 'var(--text-muted)', fontSize: '12px' }}>加载中...</div>
                  )}
                  <div ref={setViewerNode} className="file-preview-viewer-container" style={{ position: 'absolute', inset: 0, overflow: 'auto' }} />
                </div>
              </div>
            </>
          ) : (
            /* 无预览文件时：垂直文件列表 */
            <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
              {generatedFiles.map((f, i) => {
                const ext = f.name.split('.').pop()?.toLowerCase() || ''
                const extColors: Record<string, string> = {
                  docx: '#2B579A', doc: '#2B579A', pdf: '#D04423', xlsx: '#217346', xls: '#217346', csv: '#217346',
                  pptx: '#D24726', ppt: '#D24726', txt: '#6B7280', md: '#6B7280', json: '#F59E0B', xml: '#F59E0B',
                  html: '#E34C26', css: '#264DE4', js: '#F7DF1E', ts: '#3178C6', py: '#3776AB',
                  png: '#8B5CF6', jpg: '#8B5CF6', jpeg: '#8B5CF6', gif: '#8B5CF6', webp: '#8B5CF6', svg: '#8B5CF6',
                  zip: '#6B7280', rar: '#6B7280', '7z': '#6B7280'
                }
                const color = extColors[ext] || '#6B7280'
                const label = ext.toUpperCase().slice(0, 4)
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
                      <svg width="20" height="22" viewBox="0 0 16 18" fill="none">
                        <path d="M1 1C1 0.447715 1.44772 0 2 0H10L15 5V17C15 17.5523 14.5523 18 14 18H2C1.44772 18 1 17.5523 1 17V1Z" fill="#fff" stroke="#D1D5DB" strokeWidth="1" />
                        <path d="M10 0L15 5H11C10.4477 5 10 4.55228 10 4V0Z" fill="#E5E7EB" />
                        <rect x="0" y="12" width="16" height="6" rx="0" fill={color} />
                        <text x="8" y="16.5" textAnchor="middle" fill="#fff" fontSize="5" fontWeight="700" fontFamily="Arial,sans-serif">{label}</text>
                      </svg>
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
                    >🗑</span>
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

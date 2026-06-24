import React, { useEffect, useState } from 'react'

export function ScreenshotWindow(): React.JSX.Element {
  const [screenshotData, setScreenshotData] = useState<string>('')
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null)
  const [endPoint, setEndPoint] = useState<{ x: number; y: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [hasSelection, setHasSelection] = useState(false)

  // URL parameters from Hash Router
  const hashPart = window.location.hash
  const queryIndex = hashPart.indexOf('?')
  const queryString = queryIndex !== -1 ? hashPart.substring(queryIndex + 1) : ''
  const params = new URLSearchParams(queryString)
  const displayId = params.get('displayId') || ''
  const scaleFactor = parseFloat(params.get('scaleFactor') || '1')
  const width = parseInt(params.get('width') || '1920')
  const height = parseInt(params.get('height') || '1080')

  useEffect(() => {
    if (displayId) {
      window.api.getScreenshotByDisplayId(displayId).then(data => {
        setScreenshotData(data)
      }).catch(err => {
        console.error('Failed to load screen capture:', err)
      })
    }
  }, [displayId])

  // ESC key and standard key down listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.api.cancelScreenshot()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return // Left click only
    setStartPoint({ x: e.clientX, y: e.clientY })
    setEndPoint({ x: e.clientX, y: e.clientY })
    setIsDragging(true)
    setHasSelection(false)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !startPoint) return
    setEndPoint({ x: e.clientX, y: e.clientY })
  }

  const handleMouseUp = () => {
    if (!isDragging) return
    setIsDragging(false)
    if (startPoint && endPoint) {
      const w = Math.abs(startPoint.x - endPoint.x)
      const h = Math.abs(startPoint.y - endPoint.y)
      if (w > 5 && h > 5) {
        setHasSelection(true)
      } else {
        setHasSelection(false)
        setStartPoint(null)
        setEndPoint(null)
      }
    }
  }

  const handleCancel = () => {
    window.api.cancelScreenshot()
  }

  const handleConfirm = () => {
    if (!startPoint || !endPoint || !screenshotData) return

    const x = Math.min(startPoint.x, endPoint.x)
    const y = Math.min(startPoint.y, endPoint.y)
    const w = Math.abs(startPoint.x - endPoint.x)
    const h = Math.abs(startPoint.y - endPoint.y)

    const img = new Image()
    img.src = screenshotData
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w * scaleFactor
      canvas.height = h * scaleFactor
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(
          img,
          x * scaleFactor,
          y * scaleFactor,
          w * scaleFactor,
          h * scaleFactor,
          0,
          0,
          w * scaleFactor,
          h * scaleFactor
        )
        const croppedBase64 = canvas.toDataURL('image/png')
        window.api.completeScreenshot(croppedBase64, {
          x,
          y,
          width: w,
          height: h
        })
      }
    }
  }

  // Calculate selection box geometry
  let rect = { x: 0, y: 0, w: 0, h: 0 }
  if (startPoint && endPoint) {
    rect.x = Math.min(startPoint.x, endPoint.x)
    rect.y = Math.min(startPoint.y, endPoint.y)
    rect.w = Math.abs(startPoint.x - endPoint.x)
    rect.h = Math.abs(startPoint.y - endPoint.y)
  }

  // Toolbar styling and positioning
  let showToolbar = hasSelection && !isDragging
  let toolbarStyle: React.CSSProperties = {}
  if (showToolbar) {
    const toolbarHeight = 36
    const toolbarWidth = 100
    let top = rect.y + rect.h + 8
    let left = rect.x + rect.w - toolbarWidth

    // Bound checks inside display boundaries
    if (top + toolbarHeight > height) {
      top = rect.y + rect.h - toolbarHeight - 8
      if (top < 0) top = rect.y + 8
    }
    if (left < 0) left = 8

    toolbarStyle = {
      position: 'absolute',
      top: `${top}px`,
      left: `${left}px`,
      display: 'flex',
      gap: '6px',
      background: 'rgba(30, 41, 59, 0.95)',
      backdropFilter: 'blur(10px)',
      padding: '4px 6px',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      border: '1px solid rgba(255,255,255,0.15)',
      zIndex: 10000,
      pointerEvents: 'auto'
    }
  }

  return (
    <div
      className="screenshot-overlay-container"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => {
        e.preventDefault()
        handleCancel()
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        backgroundImage: screenshotData ? `url(${screenshotData})` : 'none',
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat',
        userSelect: 'none',
        cursor: 'crosshair',
        zIndex: 99999,
        overflow: 'hidden'
      }}
    >
      {/* SVG Dim Overlay (镂空高亮遮罩) */}
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none'
        }}
      >
        <path
          fill="rgba(0, 0, 0, 0.45)"
          fillRule="evenodd"
          d={`M 0 0 H ${width} V ${height} H 0 Z M ${rect.x} ${rect.y} H ${rect.x + rect.w} V ${rect.y + rect.h} H ${rect.x} Z`}
        />
        {rect.w > 0 && rect.h > 0 && (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill="transparent"
            stroke="#3b82f6"
            strokeWidth="2"
          />
        )}
      </svg>

      {/* Floating Instruction Badge */}
      {!hasSelection && !isDragging && (
        <div className="screenshot-tip-badge">
          按住并拖动鼠标进行截屏区域选择 | ESC / 右键退出
        </div>
      )}

      {/* Actions Toolbar */}
      {showToolbar && (
        <div style={toolbarStyle} onMouseDown={(e) => e.stopPropagation()}>
          <button className="tb-btn tb-cancel" onClick={handleCancel} title="取消 (ESC)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <button className="tb-btn tb-confirm" onClick={handleConfirm} title="确定">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </button>
        </div>
      )}

      <style>{`
        .screenshot-tip-badge {
          position: absolute;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(30, 41, 59, 0.85);
          backdrop-filter: blur(12px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.12);
          padding: 8px 18px;
          border-radius: 999px;
          color: #f8fafc;
          font-size: 12px;
          font-weight: 500;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
          letter-spacing: 0.5px;
          pointer-events: none;
          animation: tipFadeIn 0.3s ease;
        }

        @keyframes tipFadeIn {
          from { opacity: 0; transform: translate(-50%, 6px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }

        .tb-btn {
          width: 28px;
          height: 28px;
          border: none;
          background: transparent;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s;
        }

        .tb-cancel {
          color: #ef4444;
        }
        .tb-cancel:hover {
          background: rgba(239, 68, 68, 0.15);
        }

        .tb-confirm {
          color: #10b981;
        }
        .tb-confirm:hover {
          background: rgba(16, 185, 129, 0.15);
        }
      `}</style>
    </div>
  )
}

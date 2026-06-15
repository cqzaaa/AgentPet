import React, { useEffect, useState, useRef } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'

// 尺寸自适应配置
const SIZE_CONFIG = {
  targetHeight: 320,   // 期望挂件的高度 (px)
  defaultWidth: 250    // 默认兜底宽度 (px)
}

// Cubism Core 加载状态检测
function isCubismReady(): boolean {
  return typeof (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore !== 'undefined'
}

export function PetWidget(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [modelReady, setModelReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })

  const isDraggingRef = useRef(false)
  const lastXRef = useRef(0)
  const lastYRef = useRef(0)
  const modelRef = useRef<InstanceType<typeof Live2DModel> | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)

  // Listen for model-updated IPC event
  useEffect(() => {
    const handleModelUpdated = (): void => { setReloadKey(prev => prev + 1) }
    window.electron.ipcRenderer.on('model-updated', handleModelUpdated)
    return () => { window.electron.ipcRenderer.removeListener('model-updated', handleModelUpdated) }
  }, [])

  const [bubbleText, setBubbleText] = useState<string | null>(null)
  const [bubbleDetails, setBubbleDetails] = useState<string | null>(null)
  const [bubbleTaskId, setBubbleTaskId] = useState<string | null>(null)
  const [bubbleLogId, setBubbleLogId] = useState<string | null>(null)
  const bubbleTimerRef = useRef<any>(null)

  useEffect(() => {
    if (!window.api.onShowBubble) return
    const unsubscribe = window.api.onShowBubble((text: string, details?: string, taskId?: string, logId?: string) => {
      setBubbleText(text)
      setBubbleDetails(details || null)
      setBubbleTaskId(taskId || null)
      setBubbleLogId(logId || null)
      if (modelRef.current) {
        modelRef.current.motion('TapBody').catch((err) => console.log('Live2D motion failed', err))
      }
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
      // 如果有 details，延长显示时间到 10 秒
      const duration = details ? 10000 : 5000
      bubbleTimerRef.current = setTimeout(() => {
        setBubbleText(null)
        setBubbleDetails(null)
        setBubbleTaskId(null)
        setBubbleLogId(null)
      }, duration)
    })
    return () => {
      unsubscribe()
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
    }
  }, [])

  const handleViewDetails = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const tId = bubbleTaskId
    const lId = bubbleLogId
    // 清除气泡
    setBubbleText(null)
    setBubbleDetails(null)
    setBubbleTaskId(null)
    setBubbleLogId(null)
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)

    // 唤醒主配置中心窗口并定位详情
    if (tId && lId) {
      window.api.openCronLogDetails(tId, lId)
    } else {
      window.api.openAgentWindow()
    }
  }

  // Global mouse events
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDraggingRef.current) return
      const dx = e.screenX - lastXRef.current
      const dy = e.screenY - lastYRef.current
      lastXRef.current = e.screenX
      lastYRef.current = e.screenY
      window.api.moveWindow(dx, dy)
    }
    const handleMouseUp = (): void => {
      if (isDraggingRef.current) { isDraggingRef.current = false; window.api.endDrag() }
    }
    const handleGlobalClick = (): void => {
      setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('click', handleGlobalClick)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('click', handleGlobalClick)
    }
  }, [])

  // Initialize PixiJS + Live2D
  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false

    const waitForCubism = (retries = 20, interval = 100): Promise<void> =>
      new Promise((resolve, reject) => {
        const check = (n: number): void => {
          if (isCubismReady()) { resolve(); return }
          if (n <= 0) { reject(new Error('Cubism Core 未加载，请检查 live2dcubismcore.min.js 路径')); return }
          setTimeout(() => check(n - 1), interval)
        }
        check(retries)
      })

    const init = async (): Promise<void> => {
      await waitForCubism()
      if (destroyed) return

      const app = new PIXI.Application({
        width: SIZE_CONFIG.defaultWidth,
        height: SIZE_CONFIG.targetHeight,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true
      })
      appRef.current = app

      const canvas = app.view as HTMLCanvasElement
      canvas.style.cssText = 'width:100%;height:100%;display:block;'
      containerRef.current!.appendChild(canvas)

      let model: InstanceType<typeof Live2DModel>
      try {
        const modelUrl = await window.api.getModelUrl()
        model = await Live2DModel.from(modelUrl, { autoInteract: false })
      } catch (e) {
        console.error('[Live2D] 模型加载失败:', e)
        setLoadError(`模型加载失败: ${e}`)
        return
      }

      if (destroyed) { model.destroy(); return }

      modelRef.current = model
      app.stage.addChild(model as unknown as PIXI.DisplayObject)

      const origW = model.width || 2048
      const origH = model.height || 2048
      console.log('[Live2D] 原始尺寸:', origW, 'x', origH)

      // 计算自适应尺寸并调整 Electron 窗口与 Canvas 尺寸
      const targetHeight = SIZE_CONFIG.targetHeight
      const aspectRatio = origW / origH
      // 限制宽度在合理范围 150px ~ 450px 之间
      const computedWidth = Math.max(150, Math.min(450, Math.round(targetHeight * aspectRatio)))

      console.log(`[Live2D] 窗口自适应尺寸设置: 宽=${computedWidth}, 高=${targetHeight}`)

      // 调整 Electron 窗口尺寸
      window.api.setWindowSize(computedWidth, targetHeight)

      // 重新调整 Pixi 渲染器分辨率
      app.renderer.resize(computedWidth, targetHeight)

      // 缩放模型，留出微小边缘防切边
      const scale = (targetHeight / origH) * 0.96
      model.scale.set(scale)

      // 居中对齐模型
      model.x = (computedWidth - model.width) / 2
      model.y = (targetHeight - model.height) / 2

      await model.motion('Idle')
      setModelReady(true)
      console.log('[Live2D] 模型就绪！')
    }

    init().catch((e) => { console.error('[Live2D] 初始化异常:', e); setLoadError(String(e)) })

    return () => {
      destroyed = true
      if (appRef.current) {
        appRef.current.destroy(true, { children: true, texture: true, baseTexture: true })
        appRef.current = null
      }
      modelRef.current = null
    }
  }, [reloadKey])

  // 检测鼠标是否悬停在模型上（支持 Live2D hitTest 与模型矩形 Bounds 兜底）
  const checkHoveringModel = (clientX: number, clientY: number): boolean => {
    if (!modelRef.current || !containerRef.current) return false
    const rect = containerRef.current.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    // 1. 优先使用模型内置碰撞区检测
    const hitAreas = modelRef.current.hitTest(x, y)
    if (hitAreas && hitAreas.length > 0) {
      return true
    }

    // 2. 备用方案：检测是否在模型的外包围盒内
    const modelX = modelRef.current.x
    const modelY = modelRef.current.y
    const modelW = modelRef.current.width
    const modelH = modelRef.current.height

    if (
      x >= modelX &&
      x <= modelX + modelW &&
      y >= modelY &&
      y <= modelY + modelH
    ) {
      return true
    }

    return false
  }

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    isDraggingRef.current = true
    lastXRef.current = e.screenX
    lastYRef.current = e.screenY
    window.api.startDrag()
  }

  const handleMouseEnter = (e: React.MouseEvent): void => {
    if (!modelRef.current) return
    const isHovering = checkHoveringModel(e.clientX, e.clientY)
    if (isHovering) {
      window.api.setIgnoreMouseEvents(false)
    } else {
      window.api.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  const handleMouseLeave = (): void => {
    window.api.setIgnoreMouseEvents(true, { forward: true })
    setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev)
  }

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (isDraggingRef.current || !containerRef.current || !modelRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    modelRef.current.focus(x, y)

    // 动态控制鼠标穿透
    const isHovering = checkHoveringModel(e.clientX, e.clientY)
    if (isHovering) {
      window.api.setIgnoreMouseEvents(false)
    } else {
      window.api.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  const handleClick = (e: React.MouseEvent): void => {
    if (!modelRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (modelRef.current.hitTest(x, y).length > 0) modelRef.current.motion('TapBody')
  }

  const handleDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.api.openAgentWindow()
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top
    const menuWidth = 110
    const menuHeight = 82
    let x = clickX
    let y = clickY
    if (x + menuWidth > rect.width) x = rect.width - menuWidth - 8
    if (y + menuHeight > rect.height) y = rect.height - menuHeight - 8
    if (x < 8) x = 8
    if (y < 8) y = 8
    setContextMenu({ x, y, visible: true })
  }

  const handleOpenAgent = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setContextMenu({ x: 0, y: 0, visible: false })
    window.api.openAgentWindow()
  }

  const handleHideWidget = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setContextMenu({ x: 0, y: 0, visible: false })
    window.api.hideWindow()
  }

  return (
    <div
      className="widget-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseMove={handleMouseMove}
      onContextMenu={handleContextMenu}
      style={{ width: '100%', height: '100%', paddingBottom: 0 }}
    >
      {/* 定时提醒气泡 */}
      {bubbleText && (
        <div className="pet-toast-bubble">
          <div className="pet-toast-bubble-content">
            <div>{bubbleText}</div>
            {bubbleDetails && (
              <div className="pet-bubble-link" onClick={handleViewDetails}>
                查看详情
              </div>
            )}
          </div>
          <div className="pet-toast-bubble-arrow" />
        </div>
      )}



      {/* Live2D 渲染容器 */}
      <div
        ref={containerRef}
        className="pet-avatar-wrapper"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 0,
          opacity: modelReady ? 1 : 0,
          transition: 'opacity 0.5s ease'
        }}
      />

      {/* 自定义右键菜单 */}
      {contextMenu.visible && (
        <div
          className="custom-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="menu-item" onClick={handleOpenAgent}>打开窗口</div>
          <div className="menu-item" onClick={handleHideWidget}>隐藏</div>
        </div>
      )}

      {/* 调试错误提示 */}
      {loadError && (
        <div style={{ position: 'absolute', bottom: 40, left: 0, right: 0, background: 'rgba(255,0,0,0.8)', color: '#fff', fontSize: 9, padding: '4px 6px', borderRadius: 6, wordBreak: 'break-all', zIndex: 99 }}>
          {loadError}
        </div>
      )}
    </div>
  )
}

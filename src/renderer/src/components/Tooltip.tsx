import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type CSSProperties,
  type MouseEvent,
  type FocusEvent
} from 'react'
import { createPortal } from 'react-dom'
import './Tooltip.css'

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  /** 触发元素（如图标按钮、链接、文本标签等单个 React 元素） */
  children: ReactElement
  /** 提示标题（主信息，深色突出加粗，如图片中的第一行标题） */
  title?: ReactNode
  /** 详细描述或路径说明（次要浅灰文本，支持自动折行，如图片中的第二行路径） */
  description?: ReactNode
  /** 底部辅助信息/更新时间/标签（如图片中的第三行“更新于 09月10日 11:29”） */
  footer?: ReactNode
  /** 快捷通用内容：当无需三段式时，可直接传入简短文本或自定义 ReactNode */
  content?: ReactNode
  /** 弹出方向，默认为 'top' */
  placement?: TooltipPlacement
  /** 距离触发元素的间距（像素），默认为 8 */
  offset?: number
  /** 鼠标移入后显示的延迟时间（毫秒），默认为 180ms，避免鼠标快速划过时闪烁 */
  enterDelay?: number
  /** 鼠标移出后隐藏的延迟时间（毫秒），默认为 100ms */
  leaveDelay?: number
  /** 是否禁用提示 */
  disabled?: boolean
  /** 最大宽度，默认为 360px */
  maxWidth?: number | string
  /** 是否允许鼠标移动到 tips 卡片内部（例如用户需要划选文字或复制路径），默认为 false */
  interactive?: boolean
  /** 自定义外层类名 */
  className?: string
  /** 自定义内联样式 */
  style?: CSSProperties
}

interface PositionCoords {
  top: number
  left: number
  placement: TooltipPlacement
}

/**
 * 统一复用 Tips / Tooltip 浮层卡片控件
 * 完美还原图片视觉层级：标题 + 描述路径 + 底部时间，同时向下兼容普通紧凑提示
 */
export function Tooltip({
  children,
  title,
  description,
  footer,
  content,
  placement = 'top',
  offset = 8,
  enterDelay = 180,
  leaveDelay = 100,
  disabled = false,
  maxWidth = 360,
  interactive = false,
  className = '',
  style
}: TooltipProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState<PositionCoords | null>(null)

  const triggerElementRef = useRef<HTMLElement | null>(null)
  const tooltipCardRef = useRef<HTMLDivElement | null>(null)
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 是否从子元素上继承 title 作为备选内容
  const childElementProps = isValidElement(children)
    ? (children.props as Record<string, unknown> | undefined)
    : undefined
  const rawChildTitle =
    typeof childElementProps?.title === 'string' ? childElementProps.title : undefined

  const finalTitle = title
  const finalContent = content ?? (!finalTitle && !description && !footer ? rawChildTitle : undefined)

  // 是否有有效展示内容
  const hasContent = Boolean(finalTitle || description || footer || finalContent)
  const canShow = !disabled && hasContent

  // 清除计时器
  const clearTimers = useCallback(() => {
    if (enterTimerRef.current) {
      clearTimeout(enterTimerRef.current)
      enterTimerRef.current = null
    }
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }, [])

  // 计算定位坐标与碰撞翻转
  const updatePosition = useCallback(() => {
    const triggerEl = triggerElementRef.current
    const tipEl = tooltipCardRef.current
    if (!triggerEl || !tipEl || !document.body.contains(triggerEl)) {
      setVisible(false)
      return
    }

    const triggerRect = triggerEl.getBoundingClientRect()
    const tipRect = tipEl.getBoundingClientRect()
    const margin = 8 // 距视口边缘的安全边距

    let currentPlacement = placement

    // 智能碰撞翻转检测 (Collision Flip)
    if (placement === 'top') {
      if (triggerRect.top - tipRect.height - offset < margin) {
        if (window.innerHeight - triggerRect.bottom >= tipRect.height + offset + margin) {
          currentPlacement = 'bottom'
        }
      }
    } else if (placement === 'bottom') {
      if (window.innerHeight - triggerRect.bottom < tipRect.height + offset + margin) {
        if (triggerRect.top >= tipRect.height + offset + margin) {
          currentPlacement = 'top'
        }
      }
    } else if (placement === 'left') {
      if (triggerRect.left - tipRect.width - offset < margin) {
        if (window.innerWidth - triggerRect.right >= tipRect.width + offset + margin) {
          currentPlacement = 'right'
        }
      }
    } else if (placement === 'right') {
      if (window.innerWidth - triggerRect.right < tipRect.width + offset + margin) {
        if (triggerRect.left >= tipRect.width + offset + margin) {
          currentPlacement = 'left'
        }
      }
    }

    let top = 0
    let left = 0

    switch (currentPlacement) {
      case 'top':
        top = triggerRect.top - tipRect.height - offset
        left = triggerRect.left + (triggerRect.width - tipRect.width) / 2
        break
      case 'bottom':
        top = triggerRect.bottom + offset
        left = triggerRect.left + (triggerRect.width - tipRect.width) / 2
        break
      case 'left':
        left = triggerRect.left - tipRect.width - offset
        top = triggerRect.top + (triggerRect.height - tipRect.height) / 2
        break
      case 'right':
        left = triggerRect.right + offset
        top = triggerRect.top + (triggerRect.height - tipRect.height) / 2
        break
    }

    // 视口边界夹紧 (Viewport clamp)，防止水平或垂直溢出窗口
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - tipRect.height - margin))

    setCoords({
      top: Math.round(top),
      left: Math.round(left),
      placement: currentPlacement
    })
  }, [offset, placement])

  // 显示
  const handleShow = useCallback(() => {
    if (!canShow) return
    clearTimers()
    enterTimerRef.current = setTimeout(() => {
      setVisible(true)
    }, enterDelay)
  }, [canShow, clearTimers, enterDelay])

  // 隐藏
  const handleHide = useCallback(() => {
    clearTimers()
    leaveTimerRef.current = setTimeout(() => {
      setVisible(false)
      setCoords(null)
    }, leaveDelay)
  }, [clearTimers, leaveDelay])

  // 重新计算位置
  useLayoutEffect(() => {
    if (!visible) return
    updatePosition()
  }, [visible, updatePosition])

  // 监听窗口滚动和大小改变
  useEffect(() => {
    if (!visible) return
    const handleScrollOrResize = (): void => {
      updatePosition()
    }
    window.addEventListener('resize', handleScrollOrResize)
    window.addEventListener('scroll', handleScrollOrResize, true)
    return () => {
      window.removeEventListener('resize', handleScrollOrResize)
      window.removeEventListener('scroll', handleScrollOrResize, true)
    }
  }, [visible, updatePosition])

  // 组件销毁时清理计时器
  useEffect(() => {
    return () => clearTimers()
  }, [clearTimers])

  if (!isValidElement(children)) {
    return children
  }

  // 区分是否为富卡片模式（如果存在 description 或 footer，则为完整三层卡片；否则为紧凑小提示模式）
  const isCardMode = Boolean(description || footer || (finalTitle && finalContent))
  const isCompact = !isCardMode

  // 合并子元素原有的事件处理，并消除原生 title 属性以防与自定义 Tooltip 重叠
  const childProps = children.props as Record<string, unknown>
  const clonedTrigger = cloneElement(children, {
    title: undefined,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      triggerElementRef.current = e.currentTarget
      handleShow()
      if (typeof childProps.onMouseEnter === 'function') {
        ;(childProps.onMouseEnter as (e: MouseEvent<HTMLElement>) => void)(e)
      }
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      handleHide()
      if (typeof childProps.onMouseLeave === 'function') {
        ;(childProps.onMouseLeave as (e: MouseEvent<HTMLElement>) => void)(e)
      }
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      triggerElementRef.current = e.currentTarget
      handleShow()
      if (typeof childProps.onFocus === 'function') {
        ;(childProps.onFocus as (e: FocusEvent<HTMLElement>) => void)(e)
      }
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      handleHide()
      if (typeof childProps.onBlur === 'function') {
        ;(childProps.onBlur as (e: FocusEvent<HTMLElement>) => void)(e)
      }
    }
  } as React.HTMLAttributes<HTMLElement>)

  // 渲染浮层 DOM 到 body
  const tooltipNode =
    visible && canShow
      ? createPortal(
          <div
            className={`agent-tooltip-portal ${interactive ? 'is-interactive' : ''}`}
            onMouseEnter={interactive ? () => clearTimers() : undefined}
            onMouseLeave={interactive ? () => handleHide() : undefined}
          >
            <div
              ref={tooltipCardRef}
              className={`agent-tooltip-card ${isCompact ? 'is-compact' : ''} ${className}`}
              style={{
                top: coords ? `${coords.top}px` : '-9999px',
                left: coords ? `${coords.left}px` : '-9999px',
                maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
                opacity: coords ? 1 : 0,
                ...style
              }}
              role="tooltip"
            >
              {finalTitle && <div className="agent-tooltip-title">{finalTitle}</div>}
              {finalContent && <div className="agent-tooltip-body">{finalContent}</div>}
              {description && <div className="agent-tooltip-description">{description}</div>}
              {footer && <div className="agent-tooltip-footer">{footer}</div>}
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      {clonedTrigger}
      {tooltipNode}
    </>
  )
}

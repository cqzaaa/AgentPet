import { type ReactNode, type MouseEvent, type SyntheticEvent, useRef, useCallback, useEffect } from 'react'
import { ChevronRight, LoaderCircle, Terminal } from 'lucide-react'
import './ChatActivityGroup.css'
import { formatActivityDuration } from '../hooks/chat-activity-duration'

function anchorSummaryOnCollapse(e: MouseEvent<HTMLElement>) {
  const summary = e.currentTarget
  const details = summary.parentElement as HTMLDetailsElement | null
  if (!details) return
  // 仅在从展开切换到收起时做视口防跳动锚定，避免高度骤降导致视口被甩到历史消息
  if (details.open) {
    const rectBefore = summary.getBoundingClientRect()
    requestAnimationFrame(() => {
      const rectAfter = summary.getBoundingClientRect()
      const delta = rectAfter.top - rectBefore.top
      if (Math.abs(delta) > 2) {
        const scroller = summary.closest<HTMLElement>('[data-virtuoso-scroller="true"]')
          || summary.closest<HTMLElement>('[data-testid="virtuoso-scroller"]')
          || summary.closest<HTMLElement>('.chat-messages-scroll-area')
        if (scroller) {
          scroller.scrollTop += delta
        } else {
          summary.scrollIntoView({ block: 'nearest' })
        }
      }
    })
  }
}

export function ChatTurnActivity({ running, durationMs, children }: {
  running: boolean
  durationMs?: number
  children: ReactNode
}) {
  const contentRef = useRef<HTMLDivElement>(null)

  const handleToggle = useCallback((e: SyntheticEvent<HTMLDetailsElement>) => {
    const details = e.currentTarget
    if (details.open) {
      requestAnimationFrame(() => {
        const contentEl = contentRef.current
        if (!contentEl) return
        contentEl.scrollTop = contentEl.scrollHeight
        setTimeout(() => {
          if (contentEl) {
            contentEl.scrollTop = contentEl.scrollHeight
            const target = contentEl.lastElementChild as HTMLElement | null
            if (target) {
              target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
            }
          }
        }, 40)
      })
    }
  }, [])

  if (running) return <>{children}</>
  return (
    <details className="chat-turn-activity" onToggle={handleToggle}>
      <summary className="chat-activity-summary" onClick={anchorSummaryOnCollapse}>
        <span>{durationMs === undefined ? '处理记录' : `用时 ${formatActivityDuration(durationMs)}`}</span>
        <ChevronRight size={14} className="chat-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-turn-activity-content" ref={contentRef}>{children}</div>
    </details>
  )
}

export function ChatActivityGroup({ count, running, isThinking, activityLabel, children }: {
  count: number
  running: boolean
  isThinking?: boolean
  activityLabel?: string
  children: ReactNode
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const itemsRef = useRef<HTMLDivElement>(null)
  const isAtItemsBottomRef = useRef(true)

  // 展开或跟随最新项定位
  const scrollToLatest = useCallback((smoothOuter = false) => {
    const itemsEl = itemsRef.current
    if (!itemsEl) return
    // 内部容器立即滚到最新（最底部）
    itemsEl.scrollTop = itemsEl.scrollHeight
    isAtItemsBottomRef.current = true

    // 微延迟确认渲染稳定后，定位最新运行工具（或运行中项），确保在外部视口也可见
    requestAnimationFrame(() => {
      if (!itemsEl) return
      itemsEl.scrollTop = itemsEl.scrollHeight
      const target = (itemsEl.querySelector('.chat-tool-step.is-waiting') || itemsEl.lastElementChild) as HTMLElement | null
      if (target) {
        target.scrollIntoView({ block: 'nearest', behavior: smoothOuter ? 'smooth' : 'auto' })
      }
    })
  }, [])

  const handleToggle = useCallback((e: SyntheticEvent<HTMLDetailsElement>) => {
    const details = e.currentTarget
    if (details.open) {
      // 展开时默认定位到最新运行的地方
      requestAnimationFrame(() => {
        scrollToLatest(true)
      })
    }
  }, [scrollToLatest])

  // 监听内部滚动状态：若用户主动向上滚动查阅历史，则暂停自动吸底；滚回底部时恢复
  const handleScroll = useCallback(() => {
    const el = itemsRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 40
    isAtItemsBottomRef.current = atBottom
  }, [])

  // 展开状态下有新步骤追加时，若处于底部则自动跟随到最新工具
  useEffect(() => {
    if (detailsRef.current?.open && isAtItemsBottomRef.current) {
      scrollToLatest(false)
    }
  }, [count, running, children, scrollToLatest])

  return (
    <details className="chat-activity-group" ref={detailsRef} onToggle={handleToggle}>
      <summary className="chat-activity-summary" onClick={anchorSummaryOnCollapse}>
        {running ? <LoaderCircle size={14} className="icon-spin" aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
        <span className={`chat-activity-label${isThinking ? ' chat-activity-shimmer-text' : ''}`} title={activityLabel}>
          {activityLabel || (count > 0 ? running ? '正在运行' : '已运行' : running ? '正在处理' : '处理记录')}
        </span>
        {count > 0 && <span className="chat-activity-count">· {count} 个工具</span>}
        <ChevronRight size={14} className="chat-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-activity-items" ref={itemsRef} onScroll={handleScroll}>{children}</div>
    </details>
  )
}

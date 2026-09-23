import type { ReactNode, MouseEvent } from 'react'
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
  if (running) return <>{children}</>
  return (
    <details className="chat-turn-activity">
      <summary className="chat-activity-summary" onClick={anchorSummaryOnCollapse}>
        <span>{durationMs === undefined ? '处理记录' : `用时 ${formatActivityDuration(durationMs)}`}</span>
        <ChevronRight size={14} className="chat-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-turn-activity-content">{children}</div>
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
  return (
    <details className="chat-activity-group">
      <summary className="chat-activity-summary" onClick={anchorSummaryOnCollapse}>
        {running ? <LoaderCircle size={14} className="icon-spin" aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
        <span className={`chat-activity-label${isThinking ? ' chat-activity-shimmer-text' : ''}`} title={activityLabel}>
          {activityLabel || (count > 0 ? running ? '正在运行' : '已运行' : running ? '正在处理' : '处理记录')}
        </span>
        {count > 0 && <span className="chat-activity-count">· {count} 个工具</span>}
        <ChevronRight size={14} className="chat-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-activity-items">{children}</div>
    </details>
  )
}

import type { ReactNode } from 'react'
import { ChevronRight, LoaderCircle, Terminal } from 'lucide-react'
import './ChatActivityGroup.css'
import { formatActivityDuration } from '../hooks/chat-activity-duration'

export function ChatTurnActivity({ running, durationMs, children }: {
  running: boolean
  durationMs?: number
  children: ReactNode
}) {
  if (running) return <>{children}</>
  return (
    <details className="chat-turn-activity">
      <summary className="chat-activity-summary">
        <span>{durationMs === undefined ? '处理记录' : `用时 ${formatActivityDuration(durationMs)}`}</span>
        <ChevronRight size={14} className="chat-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-turn-activity-content">{children}</div>
    </details>
  )
}

export function ChatActivityGroup({ count, running, children }: {
  count: number
  running: boolean
  children: ReactNode
}) {
  return (
    <details className="chat-activity-group">
      <summary className="chat-activity-summary">
        {running ? <LoaderCircle size={14} className="icon-spin" aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
        <span>{count > 0 ? `${running ? '正在运行' : '已运行'} ${count} 个工具` : running ? '正在处理' : '处理记录'}</span>
        <ChevronRight size={14} className="chat-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-activity-items">{children}</div>
    </details>
  )
}

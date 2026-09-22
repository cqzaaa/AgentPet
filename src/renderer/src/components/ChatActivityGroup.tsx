import type { ReactNode } from 'react'
import { ChevronRight, LoaderCircle, Terminal } from 'lucide-react'
import './ChatActivityGroup.css'

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

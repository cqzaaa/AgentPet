import { type ReactNode, useEffect, useRef } from 'react'
import { ChevronRight, LoaderCircle, Terminal } from 'lucide-react'
import './ChatActivityGroup.css'
import { formatActivityDuration } from '../hooks/chat-activity-duration'
import {
  hasOpenDisclosureDescendant,
  usePersistentDisclosure
} from '../hooks/chat-disclosure-state'

export function ChatTurnActivity({ running, durationMs, persistenceKey, children }: {
  running: boolean
  durationMs?: number
  persistenceKey?: string
  children: ReactNode
}): React.JSX.Element {
  const [isOpen, setIsOpen] = usePersistentDisclosure(
    persistenceKey,
    hasOpenDisclosureDescendant(persistenceKey)
  )
  const wasRunningRef = useRef(running)

  useEffect(() => {
    if (wasRunningRef.current && !running && hasOpenDisclosureDescendant(persistenceKey)) {
      setIsOpen(true)
    }
    wasRunningRef.current = running
  }, [persistenceKey, running, setIsOpen])

  if (running) return <>{children}</>
  return (
    <details
      className="chat-turn-activity"
      open={isOpen}
      onToggle={(event) => setIsOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="chat-activity-summary">
        <span>{durationMs === undefined ? '处理记录' : `用时 ${formatActivityDuration(durationMs)}`}</span>
        <ChevronRight size={14} className="chat-activity-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-turn-activity-content">{children}</div>
    </details>
  )
}

export function ChatActivityGroup({ count, running, isThinking, activityLabel, defaultOpen = false, persistenceKey, children }: {
  count: number
  running: boolean
  isThinking?: boolean
  activityLabel?: string
  defaultOpen?: boolean
  persistenceKey?: string
  children: ReactNode
}): React.JSX.Element {
  const [isOpen, setIsOpen] = usePersistentDisclosure(persistenceKey, defaultOpen)

  return (
    <details
      className="chat-activity-group"
      open={isOpen}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
    >
      <summary className="chat-activity-summary">
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

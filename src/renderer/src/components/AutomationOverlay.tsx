import { useEffect, useMemo, useState, useCallback } from 'react'
import { Check, CircleDotDashed, Eye, Keyboard, MousePointer2, PanelTop, Square } from 'lucide-react'

const labels: Record<string, string> = {
  screenshot: '查看当前屏幕', mouse_move: '移动鼠标', mouse_click: '点击界面',
  mouse_click_relative: '点击目标位置', mouse_scroll: '滚动页面', type_text: '输入文字',
  key_press: '按下快捷键', get_windows: '查找可用窗口', focus_window: '切换目标窗口',
  web_search: '搜索网页', web_fetch: '读取网页'
}

function iconFor(name: string) {
  if (name === 'screenshot') return Eye
  if (name.startsWith('web_')) return PanelTop
  if (name === 'type_text' || name === 'key_press') return Keyboard
  if (name === 'focus_window' || name === 'get_windows') return PanelTop
  return MousePointer2
}

export function AutomationOverlay(): React.JSX.Element {
  const [activeName, setActiveName] = useState('screenshot')
  const [status, setStatus] = useState<'running' | 'done'>('running')
  const [completed, setCompleted] = useState(0)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isAborting, setIsAborting] = useState(false)
  const Icon = useMemo(() => iconFor(activeName), [activeName])

  useEffect(() => {
    return window.api.onAutomationProgress(event => {
      if (event.sessionId) setSessionId(event.sessionId)
      setActiveName(event.name || 'screenshot')
      if (event.type === 'tool_call') {
        setStatus('running')
        setIsAborting(false)
      } else {
        setStatus('done')
        setCompleted(value => value + 1)
      }
    })
  }, [])

  const handleStop = useCallback(async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    setIsAborting(true)
    try {
      await window.api.abortLlm(sessionId || undefined)
    } finally {
      window.api.dismissAutomationOverlay()
    }
  }, [sessionId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleStop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.api.setAutomationOverlayInteractive(false)
    }
  }, [handleStop])

  return (
    <main
      className="automation-overlay"
      aria-live="polite"
      onMouseEnter={() => window.api.setAutomationOverlayInteractive(true)}
      onMouseLeave={() => window.api.setAutomationOverlayInteractive(false)}
    >
      <div className="automation-overlay__signal"><span /></div>
      <div className="automation-overlay__body">
        <div className="automation-overlay__eyebrow">Agent 正在操作电脑</div>
        <div className="automation-overlay__action">
          <span className={`automation-overlay__icon ${status}`}>
            {status === 'done' ? <Check size={16} strokeWidth={3} /> : <Icon size={16} />}
          </span>
          <span className="automation-overlay__action-text">{labels[activeName] || activeName}</span>
          {status === 'running' && !isAborting && (
            <CircleDotDashed className="automation-overlay__spinner" size={16} />
          )}
        </div>
      </div>
      <div className="automation-overlay__meta">
        <div className="automation-overlay__count">{completed} 步完成</div>
        <button
          type="button"
          className={`automation-overlay__stop-btn ${isAborting ? 'is-aborting' : ''}`}
          title="终止操作 (Ctrl+Alt+S / Esc)"
          onClick={handleStop}
          disabled={isAborting}
        >
          <Square size={10} fill="currentColor" strokeWidth={0} />
          <span>{isAborting ? '终止中' : '终止'}</span>
        </button>
      </div>
    </main>
  )
}

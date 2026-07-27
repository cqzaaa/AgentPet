import { useEffect, useMemo, useState } from 'react'
import { Check, CircleDotDashed, Eye, Keyboard, MousePointer2, PanelTop } from 'lucide-react'

const labels: Record<string, string> = {
  screenshot: '查看当前屏幕', mouse_move: '移动鼠标', mouse_click: '点击界面',
  mouse_scroll: '滚动页面', type_text: '输入文字', key_press: '按下快捷键',
  get_windows: '查找可用窗口', focus_window: '切换目标窗口',
  browser_connect: '连接浏览器', browser_navigate: '打开网页',
  browser_search: '搜索网页', browser_snapshot: '读取页面元素', browser_click: '点击页面元素', browser_click_ref: '按元素引用点击'
}

function iconFor(name: string) {
  if (name === 'screenshot') return Eye
  if (name.startsWith('browser_')) return PanelTop
  if (name === 'type_text' || name === 'key_press') return Keyboard
  if (name === 'focus_window' || name === 'get_windows') return PanelTop
  return MousePointer2
}

export function AutomationOverlay(): React.JSX.Element {
  const [activeName, setActiveName] = useState('screenshot')
  const [status, setStatus] = useState<'running' | 'done'>('running')
  const [completed, setCompleted] = useState(0)
  const Icon = useMemo(() => iconFor(activeName), [activeName])

  useEffect(() => {
    return window.api.onAutomationProgress(event => {
      setActiveName(event.name || 'screenshot')
      if (event.type === 'tool_call') setStatus('running')
      else {
        setStatus('done')
        setCompleted(value => value + 1)
      }
    })
  }, [])

  return <main className="automation-overlay" aria-live="polite">
    <div className="automation-overlay__signal"><span /></div>
    <div className="automation-overlay__body">
      <div className="automation-overlay__eyebrow">Agent 正在操作电脑</div>
      <div className="automation-overlay__action">
        <span className={`automation-overlay__icon ${status}`}>
          {status === 'done' ? <Check size={16} strokeWidth={3} /> : <Icon size={16} />}
        </span>
        <span>{labels[activeName] || activeName}</span>
        {status === 'running' && <CircleDotDashed className="automation-overlay__spinner" size={16} />}
      </div>
    </div>
    <div className="automation-overlay__count">{completed} 步完成</div>
  </main>
}

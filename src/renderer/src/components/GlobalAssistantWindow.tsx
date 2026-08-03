import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Blend,
  Bot,
  CircleStop,
  Clock3,
  Download,
  GripHorizontal,
  Maximize2,
  Minimize2,
  Play,
  Radar,
  X
} from 'lucide-react'

interface AssistantResult {
  cycle: number
  content: string
  createdAt: number
}

interface AssistantEvent {
  type: string
  cycle?: number
  content?: string
  message?: string
  nextRunAt?: number | null
  event?: { type?: string; name?: string; detail?: string; args?: unknown; result?: string }
}

interface ToolTraceEntry {
  id: string
  type: string
  name: string
  detail: string
  timestamp: number
}

export function GlobalAssistantWindow(): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('等待任务')
  const [nextRunAt, setNextRunAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [results, setResults] = useState<AssistantResult[]>([])
  const [toolTrace, setToolTrace] = useState<ToolTraceEntry[]>([])
  const [traceExportState, setTraceExportState] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')
  const [opacity, setOpacity] = useState(() => {
    const stored = Number(window.localStorage.getItem('global-assistant-opacity'))
    return Number.isFinite(stored) && stored >= 0.35 && stored <= 1 ? stored : 1
  })
  const [showOpacityControl, setShowOpacityControl] = useState(false)
  const [compact, setCompact] = useState(false)
  const [scheduled, setScheduled] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState(30)
  const resultsRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      window.api.onGlobalAssistantEvent((event: AssistantEvent) => {
        if (event.type === 'cycle_start') {
          setRunning(true)
          setNextRunAt(null)
          setStatus(`第 ${event.cycle || 1} 轮 · 正在观察`)
        } else if (event.type === 'tool_event') {
          const toolName = event.event?.name || '实时页面'
          const eventType = event.event?.type || 'tool_call'
          const rawDetail = event.event?.result || event.event?.detail || (
            event.event?.args ? JSON.stringify(event.event.args) : ''
          )
          setToolTrace((previous) => [
            ...previous,
            {
              id: `${Date.now()}-${previous.length}`,
              type: eventType,
              name: toolName,
              detail: String(rawDetail || ''),
              timestamp: Date.now()
            }
          ])
          setStatus(
            eventType === 'tool_result' ? `已读取 ${toolName}` : `正在调用 ${toolName}`
          )
        } else if (event.type === 'cycle_result') {
          setResults((previous) =>
            [
              ...previous,
              {
                cycle: Number(event.cycle) || previous.length + 1,
                content: String(event.content || '本轮没有文字反馈'),
                createdAt: Date.now()
              }
            ].slice(-100)
          )
          setNextRunAt(typeof event.nextRunAt === 'number' ? event.nextRunAt : null)
          setNow(Date.now())
          setStatus(event.nextRunAt ? '等待下一轮' : '回答完成')
        } else if (event.type === 'cycle_error') {
          setResults((previous) => [
            ...previous,
            {
              cycle: Number(event.cycle) || previous.length + 1,
              content: `本轮执行失败：${String(event.message || '未知错误')}\n任务仍在运行，将在下一轮自动重试。`,
              createdAt: Date.now()
            }
          ].slice(-100))
          setRunning(true)
          setNextRunAt(typeof event.nextRunAt === 'number' ? event.nextRunAt : null)
          setNow(Date.now())
          setStatus('失败 · 等待重试')
        } else if (event.type === 'task_complete') {
          setRunning(false)
          setNextRunAt(null)
          setStatus('回答完成')
        } else if (event.type === 'task_stopped') {
          setRunning(false)
          setNextRunAt(null)
          setStatus('任务已停止')
        } else if (event.type === 'task_error') {
          setRunning(false)
          setNextRunAt(null)
          setStatus(String(event.message || '任务执行失败'))
        }
      }),
    []
  )

  useEffect(() => {
    if (!nextRunAt) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [nextRunAt])

  useEffect(() => {
    const output = resultsRef.current
    if (!output) return
    output.scrollTo({ top: output.scrollHeight, behavior: 'smooth' })
  }, [results])

  useEffect(() => {
    void window.api.setGlobalAssistantOpacity(opacity)
  }, [])

  const countdown = useMemo(() => {
    if (!nextRunAt) return ''
    return `${Math.max(0, Math.ceil((nextRunAt - now) / 1000))} 秒后再次查看`
  }, [nextRunAt, now])

  const startTask = async (): Promise<void> => {
    if (!prompt.trim() || running) return
    setResults([])
    setToolTrace([])
    setTraceExportState('idle')
    setStatus('正在启动')
    setRunning(true)
    try {
      await window.api.startGlobalAssistantTask({
        prompt: prompt.trim(),
        observeMode: 'auto',
        continuous: scheduled ? true : undefined,
        intervalSeconds: scheduled ? intervalSeconds : undefined
      })
    } catch (error) {
      setRunning(false)
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const stopTask = async (): Promise<void> => {
    await window.api.stopGlobalAssistantTask()
    setRunning(false)
    setNextRunAt(null)
    setStatus('任务已停止')
  }

  const updateOpacity = (value: number): void => {
    const next = Math.min(1, Math.max(0.35, value))
    setOpacity(next)
    window.localStorage.setItem('global-assistant-opacity', String(next))
    void window.api.setGlobalAssistantOpacity(next)
  }

  const setCompactMode = async (next: boolean): Promise<void> => {
    setShowOpacityControl(false)
    const changed = await window.api.setGlobalAssistantCompact(next)
    if (changed) setCompact(next)
  }

  const exportCurrentTrace = async (): Promise<void> => {
    if (toolTrace.length === 0 || traceExportState === 'saving') return
    setTraceExportState('saving')
    const datePart = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    try {
      const result = await window.api.exportToolTrace({
        defaultFileName: `global-assistant-trace-${datePart}.json`,
        trace: {
          task: prompt,
          contextMode: 'visible-screen',
          intentMode: 'automatic',
          scheduleMode: 'from-prompt',
          timeline: toolTrace.map((entry, index) => ({
            sequence: index + 1,
            type: entry.type,
            name: entry.name,
            timestamp: entry.timestamp,
            time: new Date(entry.timestamp).toISOString(),
            detail: entry.detail
          })),
          responses: results.map((result) => ({
            cycle: result.cycle,
            createdAt: result.createdAt,
            time: new Date(result.createdAt).toISOString(),
            content: result.content
          }))
        }
      })
      setTraceExportState(result.success ? 'success' : result.error ? 'error' : 'idle')
      if (result.success) window.setTimeout(() => setTraceExportState('idle'), 1800)
    } catch (error) {
      console.error('导出悬浮助手调用过程失败', error)
      setTraceExportState('error')
    }
  }

  if (compact) {
    return (
      <main className="global-assistant-compact-shell">
        <style>{`
          :root { color-scheme: light; }
          * { box-sizing: border-box; }
          html, body, #root { width: 100%; height: 100%; margin: 0; background: transparent; }
          button, input { font: inherit; }
          .global-assistant-compact-shell { width: 100%; height: 100%; padding: 7px; color: #172033; font-family: "Segoe UI Variable", "Microsoft YaHei", sans-serif; }
          .ga-compact { width: 100%; height: 100%; display: flex; align-items: center; gap: 7px; padding: 8px 9px; border: 1px solid rgba(102,126,167,.28); border-radius: 16px; background: rgba(247,250,255,.94); backdrop-filter: blur(20px) saturate(135%); -webkit-app-region: drag; }
          .ga-compact-mark { flex: 0 0 auto; color: #315ee7; display: grid; place-items: center; }
          .ga-compact input { -webkit-app-region: no-drag; min-width: 0; flex: 1; height: 36px; border: 1px solid #d7e0ef; border-radius: 11px; outline: 0; padding: 0 11px; background: rgba(255,255,255,.82); color: #172033; font-size: 12px; }
          .ga-compact input:focus { border-color: rgba(49,94,231,.5); }
          .ga-compact button { -webkit-app-region: no-drag; width: 30px; height: 30px; flex: 0 0 auto; display: grid; place-items: center; border: 0; border-radius: 9px; background: transparent; color: #73839b; cursor: pointer; }
          .ga-compact button:hover { background: #e7edff; color: #315ee7; }
          .ga-compact .primary { background: #315ee7; color: #fff; }
          .ga-compact .primary:hover { background: #254ecb; color: #fff; }
          .ga-compact .danger:hover { background: #ffe9ed; color: #c83d53; }
          @media (max-width: 260px) {
            .global-assistant-compact-shell { padding: 5px; }
            .ga-compact { gap: 4px; padding: 6px; border-radius: 13px; }
            .ga-compact-mark { display: none; }
            .ga-compact input { height: 34px; padding: 0 8px; font-size: 10.5px; }
            .ga-compact button { width: 26px; height: 26px; border-radius: 8px; }
          }
        `}</style>
        <section className="ga-compact">
          <span className="ga-compact-mark"><Radar size={17} /></span>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={running ? status : '输入问题或当前页面任务…'}
            disabled={running}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void startTask()
            }}
            aria-label="悬浮助手输入框"
          />
          {running ? (
            <button className="primary" onClick={() => void stopTask()} title="停止">
              <CircleStop size={15} />
            </button>
          ) : (
            <button className="primary" disabled={!prompt.trim()} onClick={() => void startTask()} title="开始">
              <Play size={14} fill="currentColor" />
            </button>
          )}
          <button onClick={() => void setCompactMode(false)} title="恢复完整窗口">
            <Maximize2 size={15} />
          </button>
          <button className="danger" onClick={() => void window.api.closeGlobalAssistant()} title="隐藏窗口（任务继续）">
            <X size={15} />
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="global-assistant-shell">
      <style>{`
        :root { color-scheme: light; }
        * { box-sizing: border-box; }
        html, body, #root { width: 100%; height: 100%; margin: 0; background: transparent; }
        button, textarea, input { font: inherit; }
        .global-assistant-shell {
          width: 100%; height: 100%; padding: 8px;
          color: #172033; font-family: "Segoe UI Variable", "Microsoft YaHei", sans-serif;
        }
        .ga-card {
          height: 100%; display: flex; flex-direction: column; overflow: hidden;
          border: 1px solid rgba(102, 126, 167, .25); border-radius: 22px;
          background: linear-gradient(155deg, rgba(250,252,255,.97), rgba(237,244,255,.96));
          backdrop-filter: blur(26px) saturate(150%);
        }
        .ga-head { display: flex; align-items: center; gap: 10px; padding: 13px 14px 10px; -webkit-app-region: drag; }
        .ga-grip { color: #8da0bd; display: flex; }
        .ga-orbit { width: 34px; height: 34px; border-radius: 12px; display: grid; place-items: center; color: #315ee7; background: #e7edff; position: relative; }
        .ga-orbit::after { content: ""; position: absolute; inset: -4px; border: 1px solid rgba(49,94,231,.24); border-radius: 15px; animation: gaPulse 2.4s ease-out infinite; }
        .ga-title { min-width: 0; flex: 1; display: flex; flex-direction: column; }
        .ga-title strong { font-size: 13px; letter-spacing: .04em; }
        .ga-title span { margin-top: 2px; font-size: 10.5px; color: #75849d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ga-head-actions { position: relative; display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
        .ga-head-button { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 9px; background: transparent; color: #8090a8; cursor: pointer; }
        .ga-head-button:hover, .ga-head-button.active { color: #315ee7; background: #e7edff; }
        .ga-head-button.close:hover { color: #c83d53; background: #ffe9ed; }
        .ga-opacity-panel { position: absolute; z-index: 5; top: 34px; right: 58px; width: 178px; padding: 10px 11px; border: 1px solid #d7e0ef; border-radius: 12px; background: rgba(248,251,255,.98); }
        .ga-opacity-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: #66768e; font-size: 10.5px; }
        .ga-opacity-panel input { width: 100%; accent-color: #315ee7; }
        .ga-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 14px 14px; gap: 10px; }
        .ga-composer { border: 1px solid #d7e0ef; border-radius: 15px; background: rgba(255,255,255,.78); padding: 8px 10px; }
        .ga-composer textarea { width: 100%; min-height: 34px; max-height: 60px; resize: vertical; border: 0; outline: 0; background: transparent; color: #172033; line-height: 1.5; font-size: 12.5px; }
        .ga-composer textarea::placeholder { color: #95a3b7; }
        .ga-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: #687991; font-size: 10.5px; }
        .ga-run { flex: 1; min-width: 74px; height: 34px; border: 0; border-radius: 11px; padding: 0 13px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; color: white; background: #315ee7; cursor: pointer; }
        .ga-run.stop { background: #24324b; }
        .ga-run:disabled { opacity: .45; cursor: default; }
        .ga-schedule { height: 34px; display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px 3px 7px; border: 1px solid #d7e0ef; border-radius: 11px; background: rgba(255,255,255,.78); }
        .ga-schedule-toggle { height: 26px; display: inline-flex; align-items: center; gap: 4px; padding: 0 5px; border: 0; border-radius: 8px; background: transparent; color: #718198; cursor: pointer; }
        .ga-schedule-toggle.active { color: #315ee7; background: #e7edff; }
        .ga-schedule-toggle:disabled { cursor: default; opacity: .55; }
        .ga-schedule input { width: 36px; height: 25px; padding: 0 3px; border: 0; border-bottom: 1px solid #c9d5e6; outline: 0; background: transparent; color: #24324b; text-align: center; font-size: 10.5px; }
        .ga-schedule input:disabled { color: #9aa8ba; border-bottom-color: transparent; }
        .ga-schedule-unit { padding-right: 2px; color: #8a98ac; }
        .ga-status { display: flex; align-items: center; gap: 7px; min-height: 24px; padding: 0 2px; color: #66768e; font-size: 10.5px; white-space: nowrap; overflow: hidden; }
        .ga-status i { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: ${running ? '#315ee7' : '#9aa8ba'}; }
        .ga-status svg { flex: 0 0 auto; }
        .ga-status > span:not(.ga-countdown) { flex: 0 0 auto; }
        .ga-countdown { flex: 0 0 auto; margin-left: auto; color: #315ee7; white-space: nowrap; }
        .ga-results { flex: 1; min-height: 110px; overflow-y: auto; display: flex; flex-direction: column; padding: 4px 10px; border: 1px solid #dce5f2; border-radius: 13px; background: rgba(255,255,255,.72); scroll-behavior: smooth; }
        .ga-empty { flex: 1; display: grid; place-items: center; text-align: center; color: #8b99ae; font-size: 11px; line-height: 1.6; }
        .ga-empty svg { color: #9bacce; margin-bottom: 7px; }
        .ga-result { padding: 9px 0 10px; border-bottom: 1px solid #e6edf7; }
        .ga-result:last-child { border-bottom: 0; }
        .ga-result-head { display: flex; justify-content: space-between; margin-bottom: 5px; color: #718198; font-size: 9.5px; }
        .ga-result-meta { display: inline-flex; align-items: center; gap: 4px; }
        .ga-result-export { width: 20px; height: 20px; display: grid; place-items: center; border: 0; border-radius: 6px; background: #edf2ff; color: #315ee7; cursor: pointer; }
        .ga-result-export:disabled { cursor: default; opacity: .55; }
        .ga-result-copy { white-space: pre-wrap; color: #28364e; font-size: 11.5px; line-height: 1.55; user-select: text; }
        @keyframes gaPulse { 0% { transform: scale(.85); opacity: .8; } 80%,100% { transform: scale(1.25); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .ga-orbit::after { animation: none; } }
        @media (max-width: 260px) {
          .global-assistant-shell { padding: 5px; }
          .ga-card { border-radius: 16px; }
          .ga-head { min-height: 44px; justify-content: space-between; gap: 5px; padding: 8px 8px 6px; }
          .ga-grip, .ga-title { display: none; }
          .ga-orbit { width: 28px; height: 28px; border-radius: 9px; }
          .ga-orbit::after { display: none; }
          .ga-head-actions { margin-left: auto; }
          .ga-head-button { width: 26px; height: 26px; border-radius: 8px; }
          .ga-opacity-panel { top: 31px; right: 0; width: 165px; }
          .ga-body { padding: 0 8px 8px; gap: 7px; }
          .ga-composer { padding: 7px 8px; border-radius: 12px; }
          .ga-composer textarea { min-height: 30px; max-height: 45px; font-size: 11.5px; }
          .ga-controls { font-size: 9.5px; }
          .ga-run { flex-basis: 100%; width: 100%; height: 29px; padding: 0 8px; border-radius: 9px; font-size: 9px; }
          .ga-schedule { width: 100%; height: 29px; justify-content: center; padding-block: 1px; }
          .ga-schedule-toggle { height: 24px; font-size: 9px; }
          .ga-schedule input { height: 22px; font-size: 9px; }
          .ga-status { min-height: 18px; gap: 4px; font-size: 9px; }
          .ga-status svg { display: none; }
          .ga-results { min-height: 76px; padding: 3px 8px; }
          .ga-empty { font-size: 9.5px; line-height: 1.45; }
          .ga-empty svg { width: 19px; height: 19px; margin-bottom: 3px; }
          .ga-result { padding: 7px 8px; }
          .ga-result-copy { font-size: 10px; line-height: 1.45; }
        }
      `}</style>
      <section className="ga-card">
        <header className="ga-head">
          <span className="ga-grip">
            <GripHorizontal size={15} />
          </span>
          <span className="ga-orbit">
            <Radar size={18} />
          </span>
          <span className="ga-title">
            <strong>全局悬浮助手</strong>
            <span>{status}</span>
          </span>
          <span className="ga-head-actions">
            <button
              className={`ga-head-button ${showOpacityControl ? 'active' : ''}`}
              onClick={() => setShowOpacityControl((value) => !value)}
              aria-label="设置透明度"
              title="设置透明度"
            >
              <Blend size={15} />
            </button>
            <button
              className="ga-head-button"
              onClick={() => void setCompactMode(true)}
              aria-label="最小化为快捷提问栏"
              title="最小化"
            >
              <Minimize2 size={15} />
            </button>
            <button
              className="ga-head-button close"
              onClick={() => void window.api.closeGlobalAssistant()}
              aria-label="隐藏悬浮助手，任务继续运行"
              title="隐藏窗口（任务继续）"
            >
              <X size={16} />
            </button>
            {showOpacityControl && (
              <span className="ga-opacity-panel">
                <span className="ga-opacity-label">
                  <span>窗口透明度</span>
                  <strong>{Math.round(opacity * 100)}%</strong>
                </span>
                <input
                  type="range"
                  min="35"
                  max="100"
                  step="5"
                  value={Math.round(opacity * 100)}
                  onChange={(event) => updateOpacity(Number(event.target.value) / 100)}
                  aria-label="窗口透明度"
                />
              </span>
            )}
          </span>
        </header>
        <div className="ga-body">
          <div className="ga-composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="输入问题或任务；定时查看可直接写在这里…"
              disabled={running}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void startTask()
                }
              }}
            />
          </div>
          <div className="ga-controls">
            {running ? (
              <button className="ga-run stop" onClick={() => void stopTask()}>
                <CircleStop size={14} />
                终止任务
              </button>
            ) : (
              <button className="ga-run" disabled={!prompt.trim()} onClick={() => void startTask()}>
                <Play size={13} fill="currentColor" />
                开始
              </button>
            )}
            <span className="ga-schedule">
              <button
                className={`ga-schedule-toggle ${scheduled ? 'active' : ''}`}
                type="button"
                disabled={running}
                aria-pressed={scheduled}
                title="按固定间隔重复执行当前指令，直到手动终止"
                onClick={() => setScheduled((value) => !value)}
              >
                <Clock3 size={12} />
                定时
              </button>
              <input
                type="number"
                min="5"
                max="3600"
                step="1"
                value={intervalSeconds}
                disabled={running || !scheduled}
                aria-label="重复间隔秒数"
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setIntervalSeconds(Number.isFinite(value) ? Math.min(Math.max(value, 5), 3600) : 30)
                }}
              />
              <span className="ga-schedule-unit">秒</span>
            </span>
          </div>
          <div className="ga-status">
            <i />
            <Activity size={13} />
            <span>{status}</span>
            {countdown && <span className="ga-countdown">{countdown}</span>}
          </div>
          <div className="ga-results" ref={resultsRef} aria-live="polite">
            {results.length === 0 ? (
              <div className="ga-empty">
                <div>
                  <Bot size={24} />
                  <br />
                  普通问题会直接回答。
                  <br />
                  涉及当前屏幕时会先截图判断。
                </div>
              </div>
            ) : (
              results.map((result, index) => (
                <article className="ga-result" key={`${result.cycle}-${result.createdAt}`}>
                  <div className="ga-result-head">
                    <span>第 {result.cycle} 轮反馈</span>
                    <span className="ga-result-meta">
                      <time>
                        {new Date(result.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit'
                        })}
                      </time>
                      {index === results.length - 1 && !running && toolTrace.length > 0 && (
                        <button
                          className="ga-result-export"
                          onClick={() => void exportCurrentTrace()}
                          disabled={traceExportState === 'saving'}
                          aria-label="导出调用过程 JSON"
                          title={traceExportState === 'success' ? '已导出' : traceExportState === 'error' ? '导出失败' : '导出调用过程 JSON'}
                        >
                          <Download size={11} />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="ga-result-copy">{result.content}</div>
                </article>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  )
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Check,
  ChevronLeft,
  CircleStop,
  FolderOpen,
  History,
  Mic,
  PackageOpen,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react'

type RecordingState = 'setup' | 'naming' | 'recording' | 'paused' | 'summarizing' | 'complete'
type PanelView = 'record' | 'history' | 'detail'

interface MeetingRecorderPanelProps {
  llmConfig: Record<string, unknown>
  onClose: () => void
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void
}

interface LocalAudioDevice {
  id: number
  name: string
  host: string
  isDefault: boolean
}

interface MeetingArchiveListItem {
  folderName: string
  folderPath: string
  name: string
  createdAt: string
  durationSeconds: number
  transcription: string
  privacy: string
}

interface MeetingArchiveDetail extends MeetingArchiveListItem {
  transcript: string
  summary: string
  audioPath: string
  metadata: Record<string, unknown>
}

interface TranscriptSegment {
  text: string
  visibleText: string
  seconds: number
  boundary: boolean
}

interface AudioDiagnostics {
  inputRms: number
  outputRms: number
  gain: number
  noiseFloor: number
  channel: number
  sampleRate: number
}

const pad = (value: number): string => String(value).padStart(2, '0')

function createDateSuffix(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

function formatAudioLevel(rms: number): string {
  const safeRms = Math.max(0, Number(rms) || 0)
  const dbfs = safeRms > 0 ? 20 * Math.log10(safeRms) : -Infinity
  return `${(safeRms * 1000).toFixed(1)}‰${Number.isFinite(dbfs) ? ` (${dbfs.toFixed(0)} dBFS)` : ''}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '未知时间'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toLocalAudioUrl(filePath: string): string {
  return filePath ? `local-file:///${filePath.replace(/\\/g, '/')}` : ''
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function renderTranscriptText(text: string): React.ReactNode {
  return text.split(/([，。！？；：、…,.!?;:])/g).map((part, index) =>
    /^[，。！？；：、…,.!?;:]$/.test(part)
      ? <span className="meeting-transcript-punctuation" key={`${part}-${index}`}>{part}</span>
      : part
  )
}

function commitLiveText(liveText: string, recognizedText: string): string {
  if (!liveText) return recognizedText
  if (recognizedText.startsWith(liveText)) return recognizedText
  const punctuation = recognizedText.match(/[，。！？；：、…,.!?;:]+$/)?.[0] || ''
  return punctuation && !/[，。！？；：、…,.!?;:]$/.test(liveText)
    ? `${liveText}${punctuation}`
    : liveText
}

export function MeetingRecorderPanel({ llmConfig, onClose, onToast }: MeetingRecorderPanelProps): React.JSX.Element {
  const [view, setView] = useState<PanelView>('record')
  const [state, setState] = useState<RecordingState>('setup')
  const [prefix, setPrefix] = useState('会议纪要')
  const [dateSuffix] = useState(() => createDateSuffix())
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [finalTranscript, setFinalTranscript] = useState('')
  const [partialTranscript, setPartialTranscript] = useState('')
  const [displayedPartialTranscript, setDisplayedPartialTranscript] = useState('')
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([])
  const [summary, setSummary] = useState('')
  const [recognitionHint, setRecognitionHint] = useState('请选择并测试麦克风')
  const [archivePath, setArchivePath] = useState('')
  const [installRequired, setInstallRequired] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [startingRecording, setStartingRecording] = useState(false)
  const [installProgress, setInstallProgress] = useState(0)
  const [asrEndpoint, setAsrEndpoint] = useState('wss://124.222.33.171/asr')
  const [asrToken, setAsrToken] = useState('')
  const [asrConfigured, setAsrConfigured] = useState(false)
  const [savingAsrConfig, setSavingAsrConfig] = useState(false)
  const [asrConfigOpen, setAsrConfigOpen] = useState(false)
  const [devices, setDevices] = useState<LocalAudioDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | undefined>(undefined)
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: 56 }, () => 0.12))
  const [testLevels, setTestLevels] = useState<number[]>([0, 0])
  const [testStatus, setTestStatus] = useState<'starting' | 'ready' | 'silent' | 'error'>('starting')
  const [testMessage, setTestMessage] = useState('正在连接麦克风…')
  const [audioDiagnostics, setAudioDiagnostics] = useState<AudioDiagnostics | null>(null)
  const [segmentSource, setSegmentSource] = useState('等待服务端分段')
  const [archives, setArchives] = useState<MeetingArchiveListItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [detail, setDetail] = useState<MeetingArchiveDetail | null>(null)

  const finalTranscriptRef = useRef('')
  const partialTranscriptRef = useRef('')
  const displayedPartialTranscriptRef = useRef('')
  const startedAtRef = useRef<number | null>(null)
  const elapsedBeforeResumeRef = useRef(0)
  const stoppingRef = useRef(false)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const meetingName = useMemo(() => `${prefix.trim() || '会议纪要'}_${dateSuffix}`, [dateSuffix, prefix])

  useEffect(() => { finalTranscriptRef.current = finalTranscript }, [finalTranscript])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayedPartialTranscript(current => {
        const target = partialTranscriptRef.current
        if (current === target) return current
        // A two-pass recognizer may revise its provisional text. Preserve the
        // typewriter feel for extensions, but allow a revised preview to replace
        // the temporary line instead of leaving stale or duplicated characters.
        const next = target.startsWith(current)
          ? target.slice(0, current.length + 1)
          : target
        displayedPartialTranscriptRef.current = next
        return next
      })

      setTranscriptSegments(previous => {
        const segmentIndex = previous.findIndex(segment => segment.visibleText !== segment.text)
        if (segmentIndex < 0) return previous
        const next = [...previous]
        const segment = next[segmentIndex]
        next[segmentIndex] = { ...segment, visibleText: segment.text.slice(0, segment.visibleText.length + 1) }
        return next
      })
    }, 38)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const container = transcriptScrollRef.current
      if (container) container.scrollTop = container.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [displayedPartialTranscript, state, summary, transcriptSegments])

  useEffect(() => window.api.onLocalMeetingEvent(event => {
    if (event.type === 'level') {
      const value = Math.max(0.08, Math.min(1, Number(event.value) || 0.08))
      setLevels(previous => [...previous.slice(1), value])
      if (Number.isFinite(Number(event.seconds))) setElapsedSeconds(Math.floor(Number(event.seconds)))
    } else if (event.type === 'model_loading') {
      setRecognitionHint('正在连接 FunASR Paraformer 两遍式服务…')
    } else if (event.type === 'asr_config_required') {
      setAsrConfigured(false)
      setState(current => current === 'naming' ? 'setup' : current)
      setRecognitionHint('请先保存语音服务访问令牌')
    } else if (event.type === 'components_required') {
      setInstallRequired(true)
      setState(current => current === 'naming' ? 'setup' : current)
      setRecognitionHint('需要安装轻量录音组件')
    } else if (event.type === 'model_ready') {
      setRecognitionHint('实时转写中 · 停顿后自动纠错并补标点')
    } else if (event.type === 'speech_active') {
      setRecognitionHint('正在聆听当前语句…')
    } else if (event.type === 'speech_pause') {
      setRecognitionHint('检测到停顿，正在确认当前语句…')
    } else if (event.type === 'audio_quality') {
      setAudioDiagnostics({
        inputRms: Number(event.inputRms) || 0,
        outputRms: Number(event.outputRms) || 0,
        gain: Number(event.gain) || 1,
        noiseFloor: Number(event.noiseFloor) || 0,
        channel: Number(event.channel) || 0,
        sampleRate: Number(event.sampleRate) || 0
      })
    } else if (event.type === 'transcribing') {
      setRecognitionHint('正在补录较短的语句…')
    } else if (event.type === 'partial_transcript') {
      const text = String(event.text || '')
      partialTranscriptRef.current = text
      setPartialTranscript(text)
    } else if (event.type === 'asr_backpressure') {
      const pendingMs = Math.max(0, Number(event.pendingMs) || 0)
      setRecognitionHint(`网络较慢，正在缓冲 ${Math.ceil(pendingMs / 1000)} 秒音频…`)
    } else if (event.type === 'low_input_level' && event.message) {
      setRecognitionHint(String(event.message))
      onToast?.(String(event.message), 'info')
    } else if (event.type === 'transcript' && event.text) {
      const recognizedText = String(event.text).trim()
      const displayedText = displayedPartialTranscriptRef.current
      const liveText = partialTranscriptRef.current.startsWith(displayedText)
        ? partialTranscriptRef.current
        : displayedText
      const text = commitLiveText(liveText, recognizedText)
      const seconds = Math.max(0, Math.round(Number(event.seconds) || 0))
      const boundaryReason = String(event.boundaryReason || '')
      setSegmentSource(boundaryReason === 'server_after_local_pause' ? '服务端在停顿后分段' : '服务端主动分段')
      const visibleLength = commonPrefixLength(displayedText, text)
      setTranscriptSegments(previous => [...previous, { text, visibleText: text.slice(0, visibleLength), seconds, boundary: Boolean(event.boundary) }])
      setFinalTranscript(previous => `${previous}${previous ? '\n' : ''}[${formatDuration(seconds)}] ${text}`)
      partialTranscriptRef.current = ''
      displayedPartialTranscriptRef.current = ''
      setPartialTranscript('')
      setDisplayedPartialTranscript('')
      setRecognitionHint('实时转写中 · 停顿后自动纠错并补标点')
    } else if (event.type === 'silent_input' && event.message) {
      setRecognitionHint(String(event.message))
      onToast?.(String(event.message), 'error')
    } else if ((event.type === 'warning' || event.type === 'fatal') && event.message) {
      setRecognitionHint(String(event.message))
    } else if (event.type === 'component_progress') {
      setInstallProgress(Number(event.progress) || 0)
      if (event.message) setRecognitionHint(String(event.message))
    }
  }), [onToast])

  useEffect(() => window.api.onLocalMicrophoneTestEvent(event => {
    if (event.type === 'test_ready') {
      setTestStatus('ready')
      setTestMessage(`${event.device} · ${event.channels} 个输入音道`)
    } else if (event.type === 'test_level') {
      const next = Array.isArray(event.levels) ? event.levels.map((value: unknown) => Math.min(1, Number(value) || 0)) : [0]
      setTestLevels(next)
      if (Number(event.peak) > 0.005) {
        setTestStatus('ready')
        setTestMessage('麦克风可用，已检测到声音')
      }
    } else if (event.type === 'test_silent') {
      setTestStatus('silent')
      setTestMessage('没有检测到声音，请说话测试或切换设备')
    } else if (event.type === 'test_error') {
      setTestStatus('error')
      setTestMessage(String(event.message || '麦克风测试失败'))
    }
  }), [])

  const loadDevices = async (): Promise<void> => {
    try {
      const list = await window.api.listLocalMeetingDevices()
      setDevices(list)
      const preferred = list.find(device => device.isDefault) || list[0]
      setSelectedDeviceId(current => current ?? preferred?.id)
    } catch (error) {
      setDevices([])
      if ((error instanceof Error ? error.message : String(error)).includes('LOCAL_ASR_COMPONENTS_REQUIRED')) {
        setInstallRequired(true)
      }
    }
  }

  const loadHistory = async (): Promise<void> => {
    setHistoryLoading(true)
    try { setArchives(await window.api.listMeetingArchives()) } finally { setHistoryLoading(false) }
  }

  useEffect(() => {
    void window.api.getQwenAsrConfig().then(config => {
      setAsrEndpoint(config.endpoint)
      setAsrConfigured(config.hasToken)
    }).catch(error => onToast?.(`读取语音服务配置失败：${error instanceof Error ? error.message : String(error)}`, 'error'))
    void loadDevices()
    void loadHistory()
    return () => { void window.api.stopLocalMicrophoneTest() }
  }, [])

  useEffect(() => {
    if (asrConfigured) return undefined
    const refresh = (): void => {
      void window.api.getQwenAsrConfig().then(config => {
        setAsrEndpoint(config.endpoint)
        setAsrConfigured(config.hasToken)
      })
    }
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [asrConfigured])

  useEffect(() => {
    if (view !== 'record' || state !== 'setup' || selectedDeviceId === undefined || installRequired) return undefined
    setTestStatus('starting')
    setTestLevels([0, 0])
    setTestMessage('正在连接麦克风…')
    void window.api.startLocalMicrophoneTest(selectedDeviceId).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('LOCAL_ASR_COMPONENTS_REQUIRED')) setInstallRequired(true)
      else { setTestStatus('error'); setTestMessage(message) }
    })
    return () => { void window.api.stopLocalMicrophoneTest() }
  }, [installRequired, selectedDeviceId, state, view])

  useEffect(() => {
    if (state !== 'recording') return undefined
    const timer = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedSeconds(elapsedBeforeResumeRef.current + Math.floor((Date.now() - startedAtRef.current) / 1000))
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [state])

  const installComponents = async (): Promise<void> => {
    setInstalling(true)
    setInstallProgress(5)
    try {
      if (!(await window.api.installLocalMeetingComponents())) throw new Error('组件安装后验证失败')
      setInstallRequired(false)
      await loadDevices()
      onToast?.('本地录音组件安装完成', 'success')
    } catch (error) {
      onToast?.(`组件安装失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setInstalling(false) }
  }

  const saveAsrConfig = async (): Promise<void> => {
    if (!asrToken.trim() && !asrConfigured) {
      onToast?.('请输入服务器上的语音服务访问令牌', 'info')
      return
    }
    setSavingAsrConfig(true)
    try {
      const config = await window.api.saveQwenAsrConfig({
        endpoint: asrEndpoint,
        ...(asrToken.trim() ? { token: asrToken.trim() } : {})
      })
      setAsrEndpoint(config.endpoint)
      setAsrConfigured(config.hasToken)
      setAsrToken('')
      setAsrConfigOpen(false)
      onToast?.('语音服务配置已加密保存', 'success')
    } catch (error) {
      onToast?.(`保存服务配置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setSavingAsrConfig(false)
    }
  }

  const beginRecording = async (): Promise<void> => {
    if (startingRecording) return
    setStartingRecording(true)
    try {
      await window.api.stopLocalMicrophoneTest()
      setRecognitionHint('正在连接 FunASR 两遍式服务…')
      setFinalTranscript('')
      partialTranscriptRef.current = ''
      displayedPartialTranscriptRef.current = ''
      setPartialTranscript('')
      setDisplayedPartialTranscript('')
      setTranscriptSegments([])
      setAudioDiagnostics(null)
      setSegmentSource('等待服务端分段')
      setSummary('')
      const runtime = await window.api.startLocalMeeting({ model: 'funasr-paraformer-2pass', deviceId: selectedDeviceId })
      if (runtime.model === 'components-required') {
        setInstallRequired(true)
        setState('setup')
        onToast?.('请先安装本地录音组件', 'info')
        return
      }
      if (runtime.model === 'config-required') {
        setAsrConfigured(false)
        setState('setup')
        onToast?.('请先配置语音服务访问令牌', 'info')
        return
      }
      startedAtRef.current = Date.now()
      elapsedBeforeResumeRef.current = 0
      setElapsedSeconds(0)
      setState('recording')
      setRecognitionHint(`${runtime.device} · Paraformer 两遍式实时转写`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('LOCAL_ASR_COMPONENTS_REQUIRED')) setInstallRequired(true)
      else onToast?.(`无法开始录音：${message}`, 'error')
    } finally { setStartingRecording(false) }
  }

  const pauseRecording = (): void => {
    if (state !== 'recording') return
    void window.api.pauseLocalMeeting()
    if (startedAtRef.current !== null) elapsedBeforeResumeRef.current += Math.floor((Date.now() - startedAtRef.current) / 1000)
    startedAtRef.current = null
    setRecognitionHint('本地录音已暂停')
    setState('paused')
  }

  const resumeRecording = (): void => {
    if (state !== 'paused') return
    void window.api.resumeLocalMeeting()
    startedAtRef.current = Date.now()
    setRecognitionHint('实时转写中 · 停顿后自动纠错并补标点')
    setState('recording')
  }

  const summarizeMeeting = async (transcript: string, folderName: string, duration: number): Promise<void> => {
    if (!transcript.trim()) {
      const emptySummary = '# AI 会议总结\n\n未检测到可总结的转写文本。源录音已保存，可稍后重新转写。'
      setSummary(emptySummary)
      await window.api.updateMeetingSummary(folderName, emptySummary)
      setState('complete')
      await loadHistory()
      return
    }
    const messageId = Date.now()
    const sessionId = `meeting-${messageId}`
    setSummary('')
    const unsubscribe = window.api.onLlmTextDelta(data => {
      if (data.sessionId === sessionId && data.messageId === messageId) setSummary(previous => previous + data.content)
    })
    try {
      const result = await window.api.callLLM(
        { ...llmConfig, sessionId, messageId, disableTools: true, isBackground: true },
        [{ role: 'user', content: `请根据逐字稿直接输出中文 Markdown 会议总结，包含会议概览、核心讨论、明确结论、待办事项、风险与待确认项。不要虚构，不要调用工具，不要创建或写入文件，不要输出文件路径，只返回 Markdown 正文。\n\n会议名称：${meetingName}\n录音时长：${formatDuration(duration)}\n\n逐字稿：\n${transcript}` }]
      )
      const finalSummary = result?.trim() || '# AI 会议总结\n\n总结生成失败，请稍后重试。'
      setSummary(finalSummary)
      await window.api.updateMeetingSummary(folderName, finalSummary)
      onToast?.('录音、逐字稿和 AI 总结已归档', 'success')
    } catch (error) {
      const failure = `# AI 会议总结\n\n生成失败：${error instanceof Error ? error.message : '模型服务异常'}\n\n源录音与逐字稿已正常保存。`
      setSummary(failure)
      await window.api.updateMeetingSummary(folderName, failure)
    } finally {
      unsubscribe()
      setState('complete')
      await loadHistory()
    }
  }

  const stopRecording = async (): Promise<void> => {
    if ((state !== 'recording' && state !== 'paused') || stoppingRef.current) return
    stoppingRef.current = true
    setState('summarizing')
    setRecognitionHint('正在等待 Paraformer 完成句末纠错…')
    try {
      const result = await window.api.stopLocalMeeting()
      let transcript = result.transcript || finalTranscriptRef.current
      setRecognitionHint('正在以 SenseVoice 复转写完整录音，长句会在此阶段重新合并…')
      try {
        const finalized = await window.api.finalizeLocalMeeting(result.audioPath)
        transcript = finalized.transcript
        setRecognitionHint(`完整录音已由 ${finalized.model} 复转写`)
      } catch (finalizationError) {
        console.warn('[MeetingRecorder] full-recording finalization failed', finalizationError)
        setRecognitionHint('完整录音复转写暂不可用，已保留实时转写结果')
      }
      setFinalTranscript(transcript)
      const archive = await window.api.archiveLocalMeeting({
        name: meetingName,
        audioPath: result.audioPath,
        transcript,
        durationSeconds: result.durationSeconds,
        createdAt: new Date().toISOString()
      })
      setArchivePath(archive.folderPath)
      await summarizeMeeting(transcript, archive.folderName, result.durationSeconds)
    } catch (error) {
      onToast?.(`结束录音失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      setState('complete')
    } finally { stoppingRef.current = false }
  }

  const openHistory = (): void => {
    if (state === 'recording' || state === 'paused' || state === 'summarizing') return
    void window.api.stopLocalMicrophoneTest()
    setDetail(null)
    setView('history')
    void loadHistory()
  }

  const openDetail = async (folderName: string): Promise<void> => {
    setDetail(await window.api.getMeetingArchive(folderName))
    setView('detail')
  }

  const closePanel = (): void => {
    void window.api.stopLocalMicrophoneTest()
    if (state === 'recording' || state === 'paused') {
      if (!window.confirm('录音仍在进行，关闭会结束并归档本次录音。是否继续？')) return
      void stopRecording()
    }
    onClose()
  }

  const showTabs = state === 'setup' || state === 'naming' || state === 'complete'

  return (
    <aside className="meeting-recorder-panel" aria-label="AI 会议录音">
      <header className="meeting-recorder-header">
        <div className="meeting-recorder-title">
          <span className="meeting-recorder-eyebrow"><Mic size={13} /> AI 会议录音</span>
          <strong>{view === 'history' ? '历史录音' : view === 'detail' ? detail?.name || '录音详情' : state === 'setup' ? '测试麦克风' : state === 'naming' ? '命名录音' : meetingName}</strong>
        </div>
        <div className="meeting-header-actions">
          <button
            type="button"
            className={`meeting-icon-button meeting-asr-config-trigger ${asrConfigured ? 'is-configured' : 'needs-config'}`}
            onClick={() => setAsrConfigOpen(true)}
            aria-label="语音转写服务设置"
            title={asrConfigured ? '语音转写服务已配置' : '配置语音转写服务'}
          >
            <ShieldCheck size={17} />
            <i />
          </button>
          <button type="button" className="meeting-icon-button" onClick={closePanel} aria-label="关闭录音面板"><X size={17} /></button>
        </div>
      </header>

      {showTabs && view !== 'detail' && (
        <nav className="meeting-panel-tabs">
          <button className={view === 'record' ? 'active' : ''} onClick={() => setView('record')}><Radio size={14} />新录音</button>
          <button className={view === 'history' ? 'active' : ''} onClick={openHistory}><History size={14} />历史录音 <span>{archives.length}</span></button>
        </nav>
      )}

      {view === 'history' && (
        <section className="meeting-history-view">
          <div className="meeting-history-heading"><div><strong>全部录音</strong><small>每次录音独立保存音频、逐字稿与总结</small></div><button onClick={() => void loadHistory()} title="刷新"><RefreshCw size={14} /></button></div>
          {historyLoading ? <div className="meeting-history-empty">正在读取归档…</div> : archives.length === 0 ? (
            <div className="meeting-history-empty"><Archive size={24} /><span>还没有历史录音</span><small>完成首次会议录音后会显示在这里</small></div>
          ) : (
            <div className="meeting-history-list">{archives.map(item => (
              <button key={item.folderName} className="meeting-history-item" onClick={() => void openDetail(item.folderName)}>
                <span className="meeting-history-icon"><Mic size={16} /></span>
                <span className="meeting-history-copy"><strong>{item.name}</strong><small>{formatDate(item.createdAt)}</small></span>
                <span className="meeting-history-duration">{formatDuration(item.durationSeconds)}</span>
              </button>
            ))}</div>
          )}
        </section>
      )}

      {view === 'detail' && detail && (
        <section className="meeting-detail-view">
          <button className="meeting-detail-back" onClick={() => { setView('history'); setDetail(null) }}><ChevronLeft size={15} />返回历史录音</button>
          <div className="meeting-detail-meta"><span>{formatDate(detail.createdAt)}</span><span>{formatDuration(detail.durationSeconds)}</span><span><ShieldCheck size={12} />本地归档</span></div>
          {detail.audioPath && <audio className="meeting-audio-player" controls preload="metadata" src={toLocalAudioUrl(detail.audioPath)} />}
          <div className="meeting-detail-block"><h3><Sparkles size={14} />AI 总结</h3><div>{detail.summary || '暂无总结'}</div></div>
          <div className="meeting-detail-block"><h3><Archive size={14} />逐字稿</h3><div>{detail.transcript || '暂无转写文本'}</div></div>
          <button className="meeting-secondary-button" onClick={() => void window.api.showMeetingArchive(detail.folderPath)}><FolderOpen size={15} />打开归档文件夹</button>
        </section>
      )}

      {view === 'record' && state === 'setup' && (
        <section className="meeting-setup-stage">
          <div className="meeting-setup-intro"><div className="meeting-name-mark"><Mic size={25} /></div><div><h2>先测试麦克风</h2><p>说一句话，确认音道有实时变化后再开始会议录音。</p></div></div>
          {installRequired ? (
            <div className="meeting-component-card">
              <div className="meeting-component-icon"><PackageOpen size={20} /></div>
              <div className="meeting-component-copy"><strong>安装本地录音组件</strong><small>只安装麦克风采集依赖，不再下载约 1 GB 的本地识别模型。</small></div>
              {installing && <div className="meeting-install-progress"><i style={{ width: `${installProgress}%` }} /></div>}
              <button className="meeting-primary-button" disabled={installing} onClick={() => void installComponents()}><PackageOpen size={16} />{installing ? '正在安装…' : '安装本地组件'}</button>
            </div>
          ) : (
            <>
              <label className="meeting-device-select"><span>录音设备</span><select value={selectedDeviceId ?? ''} onChange={event => setSelectedDeviceId(Number(event.target.value))}>{devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
              <div className={`meeting-mic-test is-${testStatus}`}>
                <div className="meeting-test-orb"><Mic size={20} /></div>
                <div className="meeting-test-channels">{testLevels.map((level, index) => <div key={index}><span>音道 {index + 1}</span><i><b style={{ width: `${Math.max(2, level * 100)}%` }} /></i></div>)}</div>
                <div className="meeting-test-status"><span>{testStatus === 'ready' ? <Check size={13} /> : <Radio size={13} />}{testMessage}</span><small>声音越大，蓝色音道越长</small></div>
              </div>
              <button className="meeting-primary-button" onClick={() => {
                if (!asrConfigured) {
                  setAsrConfigOpen(true)
                  return
                }
                void window.api.stopLocalMicrophoneTest()
                setState('naming')
              }}>下一步：命名录音</button>
            </>
          )}
        </section>
      )}

      {view === 'record' && state === 'naming' && (
        <section className="meeting-name-stage">
          <button className="meeting-inline-back" onClick={() => setState('setup')}><ChevronLeft size={14} />重新测试麦克风</button>
          <div><h2>开始录音</h2><p>命名后将创建独立文件夹，自动保存源录音、逐字稿和 AI 总结。</p></div>
          <label><span>录音名称前缀</span><input autoFocus value={prefix} maxLength={40} onChange={event => setPrefix(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void beginRecording() }} /></label>
          <div className="meeting-name-preview"><span>最终名称</span><strong>{meetingName}</strong></div>
          <button className={`meeting-primary-button ${startingRecording ? 'is-loading' : ''}`} disabled={startingRecording || !asrConfigured} onClick={() => void beginRecording()}>{startingRecording ? <><RefreshCw className="meeting-button-spinner" size={16} />正在连接 Paraformer…</> : <><Mic size={16} />开始录音与转写</>}</button>
          <small>{startingRecording ? '云端模型就绪后会自动打开麦克风，开头不会丢失。' : asrConfigured ? '实时模型先出字幕，停顿后由离线模型纠错并补标点。' : '请返回上一步配置语音服务访问令牌。'}</small>
        </section>
      )}

      {view === 'record' && !['setup', 'naming'].includes(state) && (
        <>
          <section className={`meeting-wave-section ${state === 'paused' ? 'is-paused' : ''}`}>
            <div className="meeting-status-line"><span className="meeting-live-status"><i />{state === 'recording' ? '录音中' : state === 'paused' ? '已暂停' : state === 'summarizing' ? '正在总结' : '已归档'}</span><span className="meeting-duration">{formatDuration(elapsedSeconds)}</span></div>
            <div className="meeting-wave">{levels.map((level, index) => <i key={index} style={{ height: `${8 + level * 50}px` }} />)}</div>
            <div className="meeting-device-line"><span>{devices.find(device => device.id === selectedDeviceId)?.name || '系统麦克风'}</span><span>Paraformer · 两遍式</span></div>
            {audioDiagnostics && <div className="meeting-device-line"><span>输入 {formatAudioLevel(audioDiagnostics.inputRms)} → 输出 {formatAudioLevel(audioDiagnostics.outputRms)} · 增益 {audioDiagnostics.gain.toFixed(1)}×</span><span>{segmentSource}</span></div>}
            <div className="meeting-record-actions">
              {(state === 'recording' || state === 'paused') && <button className="meeting-secondary-button" onClick={state === 'recording' ? pauseRecording : resumeRecording}>{state === 'recording' ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}{state === 'recording' ? '暂停' : '继续'}</button>}
              {(state === 'recording' || state === 'paused') && <button className="meeting-stop-button" onClick={() => void stopRecording()}><CircleStop size={16} />结束并总结</button>}
              {state === 'complete' && archivePath && <button className="meeting-secondary-button" onClick={() => void window.api.showMeetingArchive(archivePath)}><FolderOpen size={16} />打开归档</button>}
            </div>
          </section>
          <section className="meeting-transcript-section">
            <div className="meeting-section-title"><div><span>实时转写</span><small>{recognitionHint}</small></div>{(state === 'summarizing' || state === 'complete') && <span className="meeting-ai-badge"><Sparkles size={12} />AI 总结</span>}</div>
            <div ref={transcriptScrollRef} className="meeting-transcript-copy" aria-live="polite">{state === 'summarizing' || state === 'complete' ? <div className="meeting-summary-output">{summary || <span className="meeting-streaming"><i />正在整理结论与待办事项…</span>}</div> : transcriptSegments.length || partialTranscript ? <>{transcriptSegments.map((segment, index) => <div className="meeting-transcript-segment" key={`${segment.seconds}-${index}`}><p>{renderTranscriptText(segment.visibleText)}</p>{segment.boundary && segment.visibleText === segment.text && <div className="meeting-pause-divider"><span>{formatDuration(segment.seconds)}</span></div>}</div>)}{partialTranscript && <p className="meeting-streaming">{renderTranscriptText(displayedPartialTranscript)}<i /></p>}</> : finalTranscript ? <p>{renderTranscriptText(finalTranscript)}</p> : <div className="meeting-transcript-empty"><Archive size={22} /><span>说话内容会逐字出现在这里</span><small>实时模型先出字幕，停顿后自动纠错并记录时间</small></div>}</div>
            {state === 'complete' && <div className="meeting-archive-complete"><Check size={14} />文本 + 源录音已保存</div>}
          </section>
        </>
      )}

      {asrConfigOpen && (
        <div className="meeting-config-overlay" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setAsrConfigOpen(false)
        }}>
          <section className="meeting-config-dialog" role="dialog" aria-modal="true" aria-labelledby="meeting-config-title">
            <header>
              <div className="meeting-config-mark"><ShieldCheck size={19} /></div>
              <div>
                <strong id="meeting-config-title">转写服务设置</strong>
                <small>{asrConfigured ? '访问令牌已由 Windows 加密保存' : '首次使用需要配置服务器令牌'}</small>
              </div>
              <button type="button" className="meeting-icon-button" onClick={() => setAsrConfigOpen(false)} aria-label="关闭服务设置"><X size={16} /></button>
            </header>
            <label className="meeting-device-select">
              <span>服务地址</span>
              <input value={asrEndpoint} onChange={event => setAsrEndpoint(event.target.value)} />
            </label>
            <label className="meeting-device-select">
              <span>{asrConfigured ? '更新访问令牌' : '访问令牌'}</span>
              <input type="password" autoComplete="off" value={asrToken} placeholder={asrConfigured ? '留空表示不修改' : '粘贴服务器令牌'} onChange={event => setAsrToken(event.target.value)} />
            </label>
            <p><ShieldCheck size={13} />源录音保存在本机；音频流仅发送到你的 FunASR 服务器。</p>
            <button className="meeting-primary-button" disabled={savingAsrConfig} onClick={() => void saveAsrConfig()}>
              {savingAsrConfig ? '正在保存…' : '保存设置'}
            </button>
          </section>
        </div>
      )}
    </aside>
  )
}

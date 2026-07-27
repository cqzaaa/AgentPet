import { app, WebContents } from 'electron'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import * as fs from 'fs'
import { join, sep } from 'path'
import * as readline from 'readline'
import WebSocket from 'ws'
import { getSecretVault } from './security/secret-vault'
import { writeTextAtomically } from './security/secret-vault-core'
import { officeRuntimeManager } from './tools/interaction/office-runtime-manager'

export interface LocalMeetingResult {
  audioPath: string
  durationSeconds: number
  transcript: string
}

export interface LocalMeetingFinalization {
  transcript: string
  model: string
}

export interface QwenAsrConfig {
  endpoint: string
  hasToken: boolean
}

interface RuntimeEvent {
  type: string
  [key: string]: unknown
}

interface RecorderCompletion {
  audioPath: string
  durationSeconds: number
}

const MAX_ASR_BUFFERED_BYTES = 256 * 1024
const MAX_PENDING_AUDIO_BYTES = 5 * 1024 * 1024

const DEFAULT_QWEN_ASR_ENDPOINT = 'wss://124.222.33.171/asr'
const QWEN_ASR_SECRET_ID = 'qwen-asr-token'

function recorderScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'asr', 'local_meeting_recorder.py')
    : join(process.cwd(), 'resources', 'asr', 'local_meeting_recorder.py')
}

class LocalMeetingRuntime {
  private child: ChildProcessWithoutNullStreams | null = null
  private testChild: ChildProcessWithoutNullStreams | null = null
  private socket: WebSocket | null = null
  private completePromise: Promise<LocalMeetingResult> | null = null
  private resolveComplete: ((result: LocalMeetingResult) => void) | null = null
  private rejectComplete: ((error: Error) => void) | null = null
  private recorderCompletion: RecorderCompletion | null = null
  private asrText = ''
  private liveText = ''
  private transcriptLines: string[] = []
  private sentPcmBytes = 0
  private pendingAudio: Buffer[] = []
  private pendingAudioBytes = 0
  private audioDrainTimer: NodeJS.Timeout | null = null
  private endRequested = false
  private lastSpeechPauseAt = 0
  private asrDone = false
  private finishing = false
  private completionTimer: NodeJS.Timeout | null = null

  public getQwenAsrConfig(): QwenAsrConfig {
    const endpoint = this.readEndpoint()
    const vault = getSecretVault()
    return {
      endpoint,
      hasToken: vault.hasSecret(QWEN_ASR_SECRET_ID) || Boolean(process.env.QWEN_ASR_TOKEN?.trim())
    }
  }

  public saveQwenAsrConfig(input: { endpoint?: string; token?: string; clearToken?: boolean }): QwenAsrConfig {
    const endpoint = this.validateEndpoint(input.endpoint?.trim() || this.readEndpoint())
    writeTextAtomically(this.configPath(), `${JSON.stringify({ endpoint }, null, 2)}\n`)

    const vault = getSecretVault()
    if (input.clearToken) vault.deleteSecret(QWEN_ASR_SECRET_ID)
    const token = input.token?.trim()
    if (token) vault.setSecret(QWEN_ASR_SECRET_ID, token, '语音转写服务令牌')
    return this.getQwenAsrConfig()
  }

  public async start(target: WebContents, _model = 'funasr-paraformer-2pass', deviceId?: number): Promise<{ device: string; model: string }> {
    // Keep the IPC argument for forward-compatible model selection. The
    // current recorder has one server-side Paraformer profile.
    void _model
    if (this.child || this.socket) throw new Error('已有录音正在进行')
    await this.stopMicrophoneTest()

    const runtime = await officeRuntimeManager.ensure({ event: { sender: target } })
    if (!(await this.hasDependencies(runtime.pythonPath, runtime.rootDir))) {
      this.emit(target, { type: 'components_required', model: 'funasr-paraformer-2pass' })
      return { device: '', model: 'components-required' }
    }

    const token = this.readToken()
    if (!token) {
      this.emit(target, { type: 'asr_config_required' })
      return { device: '', model: 'config-required' }
    }

    this.resetSessionState()
    const endpoint = this.readEndpoint()
    this.emit(target, { type: 'model_loading', model: 'FunASR Paraformer 两遍式' })
    await this.connectAsr(target, endpoint, token)

    const recordingsDir = join(app.getPath('userData'), 'meetings', '.recording')
    await fs.promises.mkdir(recordingsDir, { recursive: true })
    const outputPath = join(recordingsDir, `meeting-${Date.now()}.wav`)
    const recorderArgs = [recorderScriptPath(), '--output', outputPath]
    if (Number.isInteger(deviceId)) recorderArgs.push('--device', String(deviceId))

    const child = spawn(runtime.pythonPath, recorderArgs, {
      cwd: runtime.rootDir,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1'
      }
    })
    this.child = child
    this.completePromise = new Promise<LocalMeetingResult>((resolve, reject) => {
      this.resolveComplete = resolve
      this.rejectComplete = reject
    })
    void this.completePromise.catch(() => undefined)

    const ready = new Promise<{ device: string; model: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('本地录音服务启动超时')), 30_000)
      const reader = readline.createInterface({ input: child.stdout })
      reader.on('line', line => {
        let event: RuntimeEvent
        try { event = JSON.parse(line) as RuntimeEvent } catch { return }

        if (event.type === 'audio_chunk') {
          const data = String(event.data || '')
          if (data) this.queueAudio(target, Buffer.from(data, 'base64'))
          return
        }
        if (event.type === 'speech_pause') this.lastSpeechPauseAt = Date.now()
        if (event.type === 'ready') {
          clearTimeout(timeout)
          resolve({ device: String(event.device || '系统默认麦克风'), model: 'funasr-paraformer-2pass' })
          this.emit(target, { type: 'model_ready', model: 'FunASR Paraformer 两遍式' })
        } else if (event.type === 'fatal') {
          clearTimeout(timeout)
          const error = new Error(String(event.message || '本地录音服务异常'))
          reject(error)
          this.fail(error)
        } else if (event.type === 'complete') {
          this.recorderCompletion = {
            audioPath: String(event.audioPath || outputPath),
            durationSeconds: Number(event.durationSeconds || 0)
          }
          this.finishAsrInput(target)
          this.tryComplete(target)
        }
        this.emit(target, event)
      })
    })

    child.stderr.on('data', chunk => console.warn('[LocalMeeting]', String(chunk).trim()))
    child.on('error', error => this.fail(error))
    child.on('close', code => {
      if (code && code !== 0) this.fail(new Error(`本地录音服务退出：${code}`))
      if (this.child === child) this.child = null
    })

    try {
      return await ready
    } catch (error) {
      child.kill()
      this.closeSocket()
      throw error
    }
  }

  public pause(): void { this.send('pause') }
  public resume(): void { this.send('resume') }

  public async listDevices(target: WebContents): Promise<Array<{ id: number; name: string; host: string; isDefault: boolean }>> {
    const runtime = await officeRuntimeManager.ensure({ event: { sender: target } })
    if (!(await this.hasDependencies(runtime.pythonPath, runtime.rootDir))) {
      this.emit(target, { type: 'components_required', model: 'funasr-paraformer-2pass' })
      return []
    }
    const script = [
      'import json, re, sounddevice as sd',
      'devices = list(sd.query_devices())',
      'default_id = int(sd.default.device[0])',
      'items = []',
      'seen = set()',
      'def add_device(index, label, is_default=False):',
      "    device = devices[index]",
      "    host = str(sd.query_hostapis(device['hostapi'])['name'])",
      "    key = re.sub(r'[^a-z0-9\\u4e00-\\u9fff]+', '', label.lower())",
      '    if key in seen: return',
      '    seen.add(key)',
      "    items.append({'id': index, 'name': label, 'host': host, 'isDefault': is_default})",
      'if 0 <= default_id < len(devices):',
      "    default_name = str(devices[default_id]['name']).strip()",
      "    add_device(default_id, '系统默认麦克风 · ' + default_name, True)",
      'headset_pattern = re.compile(r"耳机|headset|hands[- ]?free|bluetooth|buds|airpods|airmars", re.I)',
      'for index, device in enumerate(devices):',
      "    if int(device['max_input_channels']) <= 0 or index == default_id: continue",
      "    raw_name = str(device['name']).strip()",
      "    product_match = re.search(r';\\(([^)]+)\\)\\)?$', raw_name)",
      "    product = product_match.group(1).strip() if product_match else raw_name",
      "    product = re.sub(r'^.*?Hands-Free AG Audio%0\\s*', '', product, flags=re.I).strip(' ;()') or raw_name",
      "    label = product + (' · 耳机麦克风' if headset_pattern.search(raw_name) else ' · 输入设备')",
      '    add_device(index, label, False)',
      'print(json.dumps(items, ensure_ascii=False))'
    ].join('\n')
    const output = await this.run(runtime.pythonPath, ['-c', script], runtime.rootDir, 30_000)
    return JSON.parse(output) as Array<{ id: number; name: string; host: string; isDefault: boolean }>
  }

  public async startMicrophoneTest(target: WebContents, deviceId?: number): Promise<boolean> {
    await this.stopMicrophoneTest()
    const runtime = await officeRuntimeManager.ensure({ event: { sender: target } })
    if (!(await this.hasDependencies(runtime.pythonPath, runtime.rootDir))) {
      this.emit(target, { type: 'components_required', model: 'funasr-paraformer-2pass' })
      return false
    }
    const script = app.isPackaged
      ? join(process.resourcesPath, 'resources', 'asr', 'microphone_test.py')
      : join(process.cwd(), 'resources', 'asr', 'microphone_test.py')
    const args = [script]
    if (Number.isInteger(deviceId)) args.push('--device', String(deviceId))
    const child = spawn(runtime.pythonPath, args, {
      cwd: runtime.rootDir,
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' }
    })
    this.testChild = child
    const reader = readline.createInterface({ input: child.stdout })
    reader.on('line', line => {
      try {
        const event = JSON.parse(line) as RuntimeEvent
        if (!target.isDestroyed()) target.send('api:local-microphone-test-event', event)
      } catch { /* ignore malformed diagnostics */ }
    })
    child.stderr.on('data', chunk => console.warn('[MicrophoneTest]', String(chunk).trim()))
    child.on('close', () => { if (this.testChild === child) this.testChild = null })
    child.on('error', error => {
      if (!target.isDestroyed()) target.send('api:local-microphone-test-event', { type: 'test_error', message: error.message })
      if (this.testChild === child) this.testChild = null
    })
    return true
  }

  public async stopMicrophoneTest(): Promise<boolean> {
    const child = this.testChild
    if (!child) return true
    this.testChild = null
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ action: 'stop' })}\n`)
    setTimeout(() => { if (!child.killed) child.kill() }, 1200)
    return true
  }

  public async installComponents(target: WebContents): Promise<boolean> {
    const runtime = await officeRuntimeManager.ensure({ event: { sender: target } })
    if (!(await this.hasDependencies(runtime.pythonPath, runtime.rootDir))) {
      this.emitProgress(target, 10, '正在安装轻量录音组件')
      await this.run(runtime.pythonPath, [
        '-m', 'pip', 'install', '--only-binary=:all:', '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple',
        'numpy', 'sounddevice==0.5.5'
      ], runtime.rootDir, 10 * 60_000)
    }
    this.emitProgress(target, 100, '录音组件安装完成')
    return await this.hasDependencies(runtime.pythonPath, runtime.rootDir)
  }

  public async stop(): Promise<LocalMeetingResult> {
    if (!this.child || !this.completePromise) throw new Error('当前没有录音任务')
    const completion = this.completePromise
    this.send('stop')
    return await completion
  }

  /**
   * Re-run the complete WAV after recording stops.  The streaming recognizer is
   * optimized for latency and therefore has to segment speech; this endpoint is
   * deliberately kept separate so a failed final pass never loses the live
   * transcript already saved on the device.
   */
  public async finalizeRecording(audioPath: string): Promise<LocalMeetingFinalization> {
    const recordingRoot = fs.realpathSync(join(app.getPath('userData'), 'meetings', '.recording'))
    const sourcePath = fs.realpathSync(audioPath)
    if (!sourcePath.startsWith(`${recordingRoot}${sep}`)) {
      throw new Error('无效的本地录音文件')
    }

    const token = this.readToken()
    if (!token) throw new Error('未配置语音转写服务令牌')
    const audio = await fs.promises.readFile(sourcePath)
    if (!audio.length) throw new Error('录音文件为空')
    const endpoint = this.finalizationUrl()
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-ASR-Token': token
      },
      body: audio,
      signal: AbortSignal.timeout(30 * 60 * 1000)
    })
    const payload = await response.json().catch(() => null) as { text?: unknown; model?: unknown; error?: unknown } | null
    if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `完整录音复转写失败（${response.status}）`)
    const transcript = typeof payload?.text === 'string' ? payload.text.trim() : ''
    if (!transcript) throw new Error('完整录音复转写没有返回文本')
    return { transcript, model: typeof payload?.model === 'string' ? payload.model : 'SenseVoiceSmall' }
  }

  public shutdown(): void {
    void this.stopMicrophoneTest()
    if (this.child) this.child.kill()
    this.closeSocket()
    this.resetSessionState()
  }

  private connectAsr(target: WebContents, endpoint: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, { handshakeTimeout: 20_000 })
      this.socket = socket
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          socket.close()
          reject(new Error('FunASR 服务连接超时'))
        }
      }, 90_000)

      socket.on('open', () => socket.send(JSON.stringify({ type: 'start', token })))
      socket.on('message', data => {
        let event: RuntimeEvent
        try { event = JSON.parse(data.toString()) as RuntimeEvent } catch { return }

        if (event.type === 'ready' && !settled) {
          settled = true
          clearTimeout(timeout)
          resolve()
          return
        }
        if (event.type === 'loading') {
          this.emit(target, { type: 'model_loading', model: 'FunASR Paraformer 两遍式' })
        } else if (event.type === 'text' || event.type === 'partial') {
          const update = String(event.text || '').replace(/[\r\n\t]+/g, '')
          this.liveText = this.mergeLivePreview(this.liveText, update, event)
          this.emit(target, { type: 'partial_transcript', text: this.liveText })
        } else if (event.type === 'final') {
          const elapsedSincePause = Date.now() - this.lastSpeechPauseAt
          const boundaryReason = elapsedSincePause >= 0 && elapsedSincePause <= 3_000
            ? 'server_after_local_pause'
            : 'server_final'
          this.commitFinal(target, String(event.text || ''), boundaryReason)
        } else if (event.type === 'metrics') {
          this.emit(target, { ...event, type: 'asr_metrics' })
        } else if (event.type === 'done') {
          this.asrDone = true
          this.tryComplete(target)
        } else if (event.type === 'busy' || event.type === 'error') {
          const error = new Error(String(event.message || (event.type === 'busy' ? 'FunASR 服务正在处理其他录音' : 'FunASR 服务异常')))
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            reject(error)
          } else {
            this.fail(error)
          }
        }
      })
      socket.on('error', error => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error(`无法连接 FunASR：${error.message}`))
        } else {
          this.fail(new Error(`FunASR 连接中断：${error.message}`))
        }
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error('FunASR 服务在准备完成前关闭了连接'))
        } else if (!this.asrDone && !this.finishing && this.child) {
          this.fail(new Error('FunASR 连接意外断开'))
        }
      })
    })
  }

  private finishAsrInput(target: WebContents): void {
    if (this.finishing) return
    this.finishing = true
    this.endRequested = true
    this.drainAudio(target)
    this.completionTimer = setTimeout(() => {
      this.fail(new Error('FunASR 完成最后转写超时'))
    }, 90_000)
  }

  private sendAsrEnd(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'end' }))
    } else {
      this.fail(new Error('FunASR 连接已断开，无法完成转写'))
      return
    }
  }

  private queueAudio(target: WebContents, pcm: Buffer): void {
    if (this.finishing) return
    this.pendingAudio.push(pcm)
    this.pendingAudioBytes += pcm.length
    if (this.pendingAudioBytes > MAX_PENDING_AUDIO_BYTES) {
      this.fail(new Error('语音服务处理过慢，待发送音频已积压过多；录音已停止以避免转写缺失'))
      return
    }
    this.drainAudio(target)
  }

  private drainAudio(target: WebContents): void {
    if (this.audioDrainTimer) {
      clearTimeout(this.audioDrainTimer)
      this.audioDrainTimer = null
    }
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return

    while (this.pendingAudio.length && socket.bufferedAmount < MAX_ASR_BUFFERED_BYTES) {
      const pcm = this.pendingAudio.shift()
      if (!pcm) break
      this.pendingAudioBytes -= pcm.length
      this.sentPcmBytes += pcm.length
      socket.send(pcm)
    }

    if (this.pendingAudio.length) {
      this.emit(target, { type: 'asr_backpressure', pendingMs: Math.round(this.pendingAudioBytes / 32) })
      this.audioDrainTimer = setTimeout(() => this.drainAudio(target), 25)
    } else if (this.endRequested) {
      this.endRequested = false
      this.sendAsrEnd()
    }
  }

  private mergeLivePreview(previous: string, incoming: string, event: RuntimeEvent): string {
    if (!incoming) return previous
    if (event.delta === true || event.isDelta === true) return `${previous}${incoming}`
    if (!previous || incoming.startsWith(previous) || previous.startsWith(incoming)) return incoming

    const sharedPrefix = this.commonPrefixLength(previous, incoming)
    // A substantial common prefix is a revised snapshot from a two-pass ASR
    // model. Replace it instead of duplicating the already displayed words.
    if (sharedPrefix >= Math.min(previous.length, incoming.length) * 0.5) return incoming
    return `${previous}${incoming}`
  }

  private commonPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length)
    let index = 0
    while (index < limit && left[index] === right[index]) index += 1
    return index
  }

  private tryComplete(target: WebContents): void {
    if (!this.recorderCompletion || !this.asrDone || !this.resolveComplete) return
    if (this.liveText.trim()) this.commitFinal(target, this.liveText)
    const result: LocalMeetingResult = {
      audioPath: this.recorderCompletion.audioPath,
      durationSeconds: this.recorderCompletion.durationSeconds,
      transcript: this.transcriptLines.join('\n')
    }
    const resolve = this.resolveComplete
    this.closeSocket()
    this.resetSessionState()
    resolve(result)
  }

  private fail(error: Error): void {
    const reject = this.rejectComplete
    if (this.child && !this.child.killed) this.child.kill()
    this.closeSocket()
    this.resetSessionState()
    reject?.(error)
  }

  private commitFinal(target: WebContents, value: string, boundaryReason = 'session_end'): void {
    const text = value.replace(/[\r\n\t]+/g, '').trim()
    this.liveText = ''
    this.emit(target, { type: 'partial_transcript', text: '' })
    if (!text) return
    this.asrText = `${this.asrText}${this.asrText ? '\n' : ''}${text}`
    const seconds = Math.max(0, Math.round(this.sentPcmBytes / 32_000))
    this.transcriptLines.push(`[${this.formatTimestamp(seconds)}] ${text}`)
    this.emit(target, { type: 'transcript', text, seconds, boundary: true, boundaryReason })
  }

  private formatTimestamp(seconds: number): string {
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }

  private emit(target: WebContents, event: RuntimeEvent): void {
    if (!target.isDestroyed()) target.send('api:local-meeting-event', event)
  }

  private emitProgress(target: WebContents, progress: number, message: string): void {
    this.emit(target, { type: 'component_progress', progress, message })
  }

  private send(action: string): void {
    if (!this.child || this.child.stdin.destroyed) return
    this.child.stdin.write(`${JSON.stringify({ action })}\n`)
  }

  private async hasDependencies(pythonPath: string, cwd: string): Promise<boolean> {
    const check = await this.run(pythonPath, ['-c', 'import numpy, sounddevice'], cwd, 30_000).catch(() => null)
    return check !== null
  }

  private run(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const childProcess = spawn(executable, args, {
        cwd,
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' }
      })
      let output = ''
      let errorOutput = ''
      const timer = setTimeout(() => { childProcess.kill(); reject(new Error('本地录音组件操作超时')) }, timeoutMs)
      childProcess.stdout.on('data', chunk => { output += String(chunk) })
      childProcess.stderr.on('data', chunk => { errorOutput += String(chunk) })
      childProcess.on('error', reject)
      childProcess.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve(output)
        else reject(new Error(errorOutput || `进程退出：${code}`))
      })
    })
  }

  private configPath(): string {
    return join(app.getPath('userData'), 'qwen-asr.json')
  }

  private readEndpoint(): string {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath(), 'utf8')) as { endpoint?: unknown }
      return this.validateEndpoint(String(parsed.endpoint || DEFAULT_QWEN_ASR_ENDPOINT))
    } catch {
      return DEFAULT_QWEN_ASR_ENDPOINT
    }
  }

  private readToken(): string {
    return getSecretVault().getSecret(QWEN_ASR_SECRET_ID)?.trim() || process.env.QWEN_ASR_TOKEN?.trim() || ''
  }

  private finalizationUrl(): string {
    const realtime = new URL(this.readEndpoint())
    realtime.protocol = realtime.protocol === 'wss:' ? 'https:' : 'http:'
    return new URL('/asr-finalize/transcribe', realtime).toString()
  }

  private validateEndpoint(value: string): string {
    let endpoint: URL
    try { endpoint = new URL(value) } catch { throw new Error('语音转写服务地址无效') }
    const localhost = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
    if (endpoint.protocol !== 'wss:' && !(localhost && endpoint.protocol === 'ws:')) {
      throw new Error('语音转写服务必须使用 wss:// 安全连接')
    }
    return endpoint.toString()
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
  }

  private resetSessionState(): void {
    if (this.completionTimer) clearTimeout(this.completionTimer)
    if (this.audioDrainTimer) clearTimeout(this.audioDrainTimer)
    this.completionTimer = null
    this.audioDrainTimer = null
    this.child = null
    this.completePromise = null
    this.resolveComplete = null
    this.rejectComplete = null
    this.recorderCompletion = null
    this.asrText = ''
    this.liveText = ''
    this.transcriptLines = []
    this.sentPcmBytes = 0
    this.pendingAudio = []
    this.pendingAudioBytes = 0
    this.endRequested = false
    this.lastSpeechPauseAt = 0
    this.asrDone = false
    this.finishing = false
  }
}

export const localMeetingRuntime = new LocalMeetingRuntime()

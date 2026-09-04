import type { SessionNotification } from '@agentclientprotocol/sdk'

/** Ordered ACP notifications with bounded buffering and CLI backpressure. */
export class AcpUpdateBuffer {
  private queue: Array<{ value: SessionNotification; bytes: number }> = []
  private bytes = 0
  private text: SessionNotification | undefined
  private textBytes = 0
  private sentText = false
  private timer?: ReturnType<typeof setTimeout>
  private pumping?: Promise<void>
  private error?: Error
  private closed = false
  private stop!: () => void
  private readonly stopped = new Promise<void>((resolve) => {
    this.stop = resolve
  })

  constructor(
    private readonly send: (value: SessionNotification) => Promise<void>,
    private readonly flow: { pause(): void; resume(): void; fail(error: Error): void }
  ) {}

  notify(value: SessionNotification): void {
    if (this.closed || this.error) return
    const update = value.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      if (!this.sentText) {
        this.sentText = true
        this.enqueue(value)
        return
      }
      const previous = this.text?.update
      if (
        this.text?.sessionId === value.sessionId &&
        previous?.sessionUpdate === 'agent_message_chunk' &&
        previous.content.type === 'text'
      ) {
        previous.content.text += update.content.text
      } else {
        this.flushText()
        this.text = { ...value, update: { ...update, content: { ...update.content } } }
      }
      this.textBytes += Buffer.byteLength(update.content.text)
      if (this.textBytes >= 4096) this.flushText()
      else if (!this.timer) this.timer = setTimeout(() => this.flushText(), 30)
    } else {
      this.flushText()
      this.enqueue(value)
    }
  }

  private flushText(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const text = this.text
    this.text = undefined
    this.textBytes = 0
    if (text) this.enqueue(text)
  }

  private enqueue(value: SessionNotification): void {
    if (this.error || this.closed) return
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.bytes + bytes > 4 * 1024 * 1024 || this.queue.length >= 1024) {
      this.fail(new Error('ACP 更新队列超过容量限制'))
      return
    }
    this.queue.push({ value, bytes })
    this.bytes += bytes
    if (this.bytes >= 256 * 1024 || this.queue.length >= 128) this.flow.pause()
    this.startPump()
  }

  private startPump(): void {
    if (this.pumping) return
    this.pumping = this.pump()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.pumping = undefined
        if (this.queue.length && !this.error && !this.closed) this.startPump()
      })
  }

  private async pump(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const item = this.queue[0]
      await Promise.race([this.send(item.value), this.stopped])
      if (this.closed) return
      this.queue.shift()
      this.bytes -= item.bytes
      if (this.bytes < 128 * 1024 && this.queue.length < 64) this.flow.resume()
    }
  }

  private fail(error: unknown): void {
    if (this.error || this.closed) return
    this.error = error instanceof Error ? error : new Error(String(error))
    this.dispose()
    this.flow.fail(this.error)
  }

  async finish(): Promise<void> {
    this.flushText()
    while (this.pumping) await this.pumping
    if (this.error) throw this.error
  }

  dispose(): void {
    this.closed = true
    this.stop()
    clearTimeout(this.timer)
    this.text = undefined
    this.queue = []
    this.bytes = 0
  }
}

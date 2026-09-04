/** Lossless ordered batches. Producers wait at the high-water mark. */
export class EventBatcher<T> {
  private queue: Array<{ event: T; bytes: number }> = []
  private bytes = 0
  private timer?: ReturnType<typeof setTimeout>
  private pumping?: Promise<void>
  private error?: Error
  private waiters: Array<() => void> = []

  constructor(
    private readonly consume: (events: T[]) => Promise<void>,
    private readonly batchSize = 64
  ) {}

  async push(event: T): Promise<void> {
    if (this.error) throw this.error
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes > 4 * 1024 * 1024) throw new Error('单条 Agent 日志超过容量限制')
    while (this.bytes + bytes > 4 * 1024 * 1024) {
      this.start()
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      if (this.error) throw this.error
    }
    this.queue.push({ event, bytes })
    this.bytes += bytes
    if (this.queue.length >= this.batchSize) this.start()
    else if (!this.timer && !this.pumping) this.timer = setTimeout(() => this.start(), 20)
    if (this.queue.length >= this.batchSize * 2) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      if (this.error) throw this.error
    }
  }

  private start(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.pumping || this.error) return
    this.pumping = this.pump()
      .catch((error) => {
        this.error = error instanceof Error ? error : new Error(String(error))
        this.queue = []
        this.bytes = 0
      })
      .finally(() => {
        this.pumping = undefined
        this.waiters.splice(0).forEach((resolve) => resolve())
        if (this.queue.length && !this.error) this.start()
      })
  }

  private async pump(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.batchSize)
      await this.consume(batch.map((item) => item.event))
      this.bytes -= batch.reduce((total, item) => total + item.bytes, 0)
      this.waiters.splice(0).forEach((resolve) => resolve())
    }
  }

  async flush(): Promise<void> {
    this.start()
    while (this.pumping) await this.pumping
    if (this.error) throw this.error
  }
}

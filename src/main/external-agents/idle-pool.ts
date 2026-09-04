/** Exclusive leases: warm processes may be reused, running tasks never share one. */
export class IdlePool<T> {
  private idle: Array<{ key: string; value: T; timer: ReturnType<typeof setTimeout> }> = []
  private active = new Set<T>()
  private generation = 0

  constructor(
    private readonly destroy: (value: T) => Promise<void>,
    private readonly healthy: (value: T) => boolean,
    private readonly idleMs = 120_000,
    private readonly maxIdle = 2
  ) {}

  async acquire(
    key: string,
    create: () => Promise<T>
  ): Promise<{ value: T; release(reusable: boolean): Promise<void> }> {
    const generation = this.generation
    let value: T | undefined
    const index = this.idle.findIndex((entry) => entry.key === key)
    if (index >= 0) {
      const entry = this.idle.splice(index, 1)[0]
      clearTimeout(entry.timer)
      if (this.healthy(entry.value)) value = entry.value
      else await this.destroy(entry.value)
    }
    value ??= await create()
    const resource = value
    if (generation !== this.generation) {
      await this.destroy(resource)
      throw new Error('Agent 运行时已关闭')
    }
    this.active.add(resource)
    let released = false
    return {
      value: resource,
      release: async (reusable) => {
        if (released) return
        released = true
        this.active.delete(resource)
        if (!reusable || generation !== this.generation || !this.healthy(resource)) {
          await this.destroy(resource)
          return
        }
        const oldest = this.idle.length >= this.maxIdle ? this.idle.shift() : undefined
        if (oldest) clearTimeout(oldest.timer)
        const timer = setTimeout(() => {
          this.idle = this.idle.filter((entry) => entry.value !== resource)
          void this.destroy(resource).catch(() => {})
        }, this.idleMs)
        timer.unref()
        this.idle.push({ key, value: resource, timer })
        if (oldest) await this.destroy(oldest.value)
      }
    }
  }

  async dispose(): Promise<void> {
    this.generation++
    const resources = [...this.active, ...this.idle.map((entry) => entry.value)]
    this.idle.forEach((entry) => clearTimeout(entry.timer))
    this.idle = []
    this.active.clear()
    await Promise.allSettled(resources.map((value) => this.destroy(value)))
  }
}

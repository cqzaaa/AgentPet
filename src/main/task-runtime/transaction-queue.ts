export interface TransactionDatabase {
  exec(sql: string): Promise<unknown>
}

/** Serializes transactions for one SQLite connection. */
export class TransactionQueue {
  private tail: Promise<void> = Promise.resolve()

  public async run<T>(database: TransactionDatabase, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    let started = false
    try {
      await database.exec('BEGIN IMMEDIATE')
      started = true
      const result = await operation()
      await database.exec('COMMIT')
      return result
    } catch (error) {
      if (started) {
        try { await database.exec('ROLLBACK') } catch { /* Preserve the original error. */ }
      }
      throw error
    } finally {
      release()
    }
  }
}

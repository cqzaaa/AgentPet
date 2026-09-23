import type { Stats } from 'fs'
import { normalize } from 'path'

export type ReadRange = { start: number; end: number }
type CachedRead = { version: string; text: string; ranges: ReadRange[] }

export function fileVersion(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

export function canonicalReadPath(filePath: string): string {
  const normalized = normalize(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// Access checks and realpath resolution happen in FileExecutor before every lookup.
// Cache full plain text, but only mark ranges actually returned without truncation as seen.
export class FileReadCache {
  private entries = new Map<string, CachedRead>()
  private bytes = 0

  clearSession(session: string): void {
    for (const [key, entry] of this.entries) {
      if (JSON.parse(key)[0] !== session) continue
      this.bytes -= entry.text.length * 2
      this.entries.delete(key)
    }
  }

  forgetRanges(session: string, filePath: string, version: string): void {
    const entry = this.get(session, filePath, version)
    if (entry) entry.ranges = []
  }

  private key(session: string, filePath: string): string {
    return JSON.stringify([session, canonicalReadPath(filePath)])
  }

  get(session: string, filePath: string, version: string): CachedRead | undefined {
    const key = this.key(session, filePath)
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.version !== version) {
      this.bytes -= entry.text.length * 2
      this.entries.delete(key)
      return
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  put(session: string, filePath: string, version: string, text: string): void {
    if (text.length > 1024 * 1024) return
    const key = this.key(session, filePath)
    const old = this.entries.get(key)
    if (old?.version === version) return
    if (old) this.bytes -= old.text.length * 2
    this.entries.delete(key)
    this.entries.set(key, { version, text, ranges: [] })
    this.bytes += text.length * 2
    while (this.entries.size > 64 || this.bytes > 8 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldest)!.text.length * 2
      this.entries.delete(oldest)
    }
  }

  record(session: string, filePath: string, version: string, ranges: ReadRange[]): number {
    const entry = this.get(session, filePath, version)
    if (!entry) return 0
    const overlap = ranges.reduce((total, range) => total + entry.ranges.reduce((sum, seen) =>
      sum + Math.max(0, Math.min(range.end, seen.end) - Math.max(range.start, seen.start) + 1), 0), 0)
    const merged: ReadRange[] = []
    for (const range of [...entry.ranges, ...ranges].sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1)
      if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
      else merged.push({ ...range })
    }
    entry.ranges = merged.slice(-200)
    return overlap
  }
}

export const fileReadCache = new FileReadCache()

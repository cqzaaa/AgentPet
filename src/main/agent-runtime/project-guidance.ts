import * as fs from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { getActiveStorageDir } from '../tools/utils/paths'

type GuidanceSource = {
  path: string
  content: string
  size: number
  modifiedAt: number
}

type GuidanceCandidate = Omit<GuidanceSource, 'content'>

type GuidanceCacheEntry = {
  fingerprint: string
  combined: string
  sources: GuidanceSource[]
}

export type ProjectGuidance = {
  combined: string
  sources: Array<{ path: string; size: number }>
  projectRoot?: string
}

const DEFAULT_MAX_BYTES = 32 * 1024
const cache = new Map<string, GuidanceCacheEntry>()

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child))
  return value === '' || (!value.startsWith('..') && !value.includes(':'))
}

function findProjectRoot(startPath: string): string {
  let current = resolve(startPath)
  while (true) {
    if (fs.existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(startPath)
    current = parent
  }
}

function directoriesFromRoot(root: string, target: string): string[] {
  if (!isWithin(root, target)) return [target]
  const segments = relative(root, target).split(/[\\/]+/).filter(Boolean)
  const directories = [root]
  for (const segment of segments) directories.push(join(directories[directories.length - 1], segment))
  return directories
}

async function firstReadableInstruction(directory: string): Promise<GuidanceCandidate | null> {
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const path = join(directory, name)
    try {
      const stat = await fs.promises.stat(path)
      if (!stat.isFile() || stat.size === 0) continue
      return { path: resolve(path), size: stat.size, modifiedAt: stat.mtimeMs }
    } catch {
      // Missing or unreadable guidance at one scope does not block lower scopes.
    }
  }
  return null
}

function formatGuidance(sources: GuidanceSource[], maxBytes: number): string {
  let remaining = maxBytes
  const sections: string[] = []
  for (const source of sources) {
    if (remaining <= 0) break
    let selected = source.content
    if (Buffer.byteLength(selected, 'utf8') > remaining) {
      let low = 0
      let high = selected.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (Buffer.byteLength(selected.slice(0, middle), 'utf8') <= remaining) low = middle
        else high = middle - 1
      }
      selected = selected.slice(0, low)
    }
    const content = selected.trim()
    if (content) {
      sections.push(`<agent_guidance source=${JSON.stringify(source.path)}>\n${content}\n</agent_guidance>`)
      remaining -= Buffer.byteLength(selected, 'utf8')
    }
  }
  return sections.join('\n\n')
}

export async function loadProjectGuidance(options: {
  sessionId?: string
  workspacePath?: string
  maxBytes?: number
}): Promise<ProjectGuidance> {
  const workspacePath = String(options.workspacePath || '').trim()
  const projectRoot = workspacePath ? findProjectRoot(workspacePath) : undefined
  const directories = projectRoot && workspacePath
    ? directoriesFromRoot(projectRoot, resolve(workspacePath))
    : []

  const candidates: GuidanceCandidate[] = []
  const globalSource = await firstReadableInstruction(getActiveStorageDir())
  if (globalSource) candidates.push(globalSource)
  for (const directory of directories) {
    const source = await firstReadableInstruction(directory)
    if (source && !candidates.some(candidate => candidate.path === source.path)) candidates.push(source)
  }

  const fingerprint = candidates
    .map(source => `${source.path}:${source.size}:${source.modifiedAt}`)
    .join('|')
  const cacheKey = `${options.sessionId || 'default'}:${workspacePath || '<none>'}`
  const cached = cache.get(cacheKey)
  if (cached?.fingerprint === fingerprint) {
    return {
      combined: cached.combined,
      sources: cached.sources.map(source => ({ path: source.path, size: source.size })),
      projectRoot
    }
  }

  const sources: GuidanceSource[] = []
  for (const candidate of candidates) {
    try {
      const content = await fs.promises.readFile(candidate.path, 'utf8')
      if (content.trim()) sources.push({ ...candidate, content })
    } catch {
      // A file may disappear after stat; the next turn will rebuild the chain.
    }
  }
  const combined = formatGuidance(sources, Math.max(1024, options.maxBytes || DEFAULT_MAX_BYTES))
  cache.set(cacheKey, { fingerprint, combined, sources })
  if (cache.size > 100) cache.delete(cache.keys().next().value as string)
  return {
    combined,
    sources: sources.map(source => ({ path: source.path, size: source.size })),
    projectRoot
  }
}

export function clearProjectGuidanceCache(sessionId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${sessionId}:`)) cache.delete(key)
  }
}

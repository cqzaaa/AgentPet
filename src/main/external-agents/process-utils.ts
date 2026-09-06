import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const executableCache = new Map<string, { expires: number; value: Promise<string | null> }>()

export function clearExecutableCache(): void {
  executableCache.clear()
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Repair the common Windows code-page failure where a CLI locator returns a
 * path such as C:\Users\��\AppData\... for a non-ASCII account name.
 * Only replacement-character usernames are rewritten, so an intentionally
 * configured path belonging to another valid Windows user is never redirected.
 */
function repairCorruptedWindowsUserPath(candidate: string): string | null {
  if (process.platform !== 'win32' || !candidate.includes('\uFFFD')) return null
  const resolved = path.resolve(candidate)
  const parts = resolved.split(path.sep)
  const homeDir = path.resolve(os.homedir())
  const homeParts = homeDir.split(path.sep)
  if (
    parts.length < 4 ||
    homeParts.length < 3 ||
    parts[0].toLowerCase() !== homeParts[0].toLowerCase() ||
    parts[1].toLowerCase() !== homeParts[1].toLowerCase() ||
    !parts[2].includes('\uFFFD')
  ) {
    return null
  }
  return path.join(homeDir, ...parts.slice(3))
}

async function firstExistingPath(candidates: Array<string | null | undefined>): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate
  }
  return null
}

async function locateOnPath(command: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise(resolve => {
    const child = spawn(locator, [command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.once('error', () => resolve(null))
    child.once('close', code => {
      const matches = output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      const first = process.platform === 'win32'
        ? matches.find(value => /\.(exe|cmd|bat)$/i.test(value)) || matches[0]
        : matches[0]
      resolve(code === 0 && first ? first.trim() : null)
    })
  })
}

export function spawnAgentProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; detached?: boolean }
): ChildProcessWithoutNullStreams {
  const isCommandShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  const child = spawn(isCommandShim ? `"${executable}"` : executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: options.detached,
    windowsHide: options.detached !== true,
    shell: isCommandShim,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.once('error', () => clearExecutableCache())
  return child
}

async function newestMatch(parent: string, childName: string): Promise<string | null> {
  try {
    const directories = await readdir(parent, { withFileTypes: true })
    const matches = await Promise.all(directories.filter(entry => entry.isDirectory()).map(async entry => {
      const candidate = path.join(parent, entry.name, childName)
      if (!await exists(candidate)) return null
      return { candidate, modifiedAt: (await stat(candidate)).mtimeMs }
    }))
    return matches.filter((value): value is { candidate: string; modifiedAt: number } => Boolean(value))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.candidate || null
  } catch {
    return null
  }
}

async function windowsFallbacks(command: string): Promise<string[]> {
  const homeDir = os.homedir()
  // Some Windows launchers expose LOCALAPPDATA/APPDATA with a mis-decoded
  // non-ASCII username. Keep the environment value as a candidate, but also
  // derive the known folders from os.homedir(), which uses the native Windows
  // Unicode API. The resolver validates every candidate before returning it.
  const localAppDataRoots = Array.from(new Set([
    process.env.LOCALAPPDATA,
    path.join(homeDir, 'AppData', 'Local')
  ].filter(Boolean))) as string[]
  const appDataRoots = Array.from(new Set([
    process.env.APPDATA,
    path.join(homeDir, 'AppData', 'Roaming')
  ].filter(Boolean))) as string[]
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
  const base = path.basename(command).replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase()
  if (base === 'codex') {
    const bundledCandidates = await Promise.all(
      localAppDataRoots.map(root => newestMatch(path.join(root, 'OpenAI', 'Codex', 'bin'), 'codex.exe'))
    )
    return [
      ...bundledCandidates,
      ...appDataRoots.map(root => path.join(root, 'npm', 'codex.cmd')),
      ...programFiles.map(root => path.join(root, 'OpenAI', 'Codex', 'codex.exe'))
    ].filter(Boolean) as string[]
  }
  if (base === 'agy') {
    return [
      ...localAppDataRoots.flatMap(root => [
        path.join(root, 'agy', 'bin', 'agy.exe'),
        path.join(root, 'Programs', 'agy', 'bin', 'agy.exe')
      ]),
      ...appDataRoots.map(root => path.join(root, 'agy', 'bin', 'agy.exe')),
      ...programFiles.map(root => path.join(root, 'agy', 'bin', 'agy.exe'))
    ]
  }
  if (base === 'claude' || base === 'gemini') {
    return appDataRoots.map(root => path.join(root, 'npm', `${base}.cmd`))
  }
  return []
}

export async function resolveExecutable(command: string, aliases: string[] = []): Promise<string | null> {
  const key = JSON.stringify([command, aliases, process.env.PATH, process.env.PATHEXT, process.cwd()])
  const cached = executableCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  if (executableCache.size >= 128) executableCache.delete(executableCache.keys().next().value!)
  const entry = { expires: Date.now() + 60_000, value: resolveExecutableUncached(command, aliases) }
  executableCache.set(key, entry)
  try {
    const resolved = await entry.value
    if (!resolved && executableCache.get(key) === entry) executableCache.delete(key)
    return resolved
  } catch (error) {
    if (executableCache.get(key) === entry) executableCache.delete(key)
    throw error
  }
}

async function resolveExecutableUncached(command: string, aliases: string[]): Promise<string | null> {
  for (const value of [command, ...aliases].map(item => item.trim()).filter(Boolean)) {
    if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
      const resolvedPath = await firstExistingPath([value, repairCorruptedWindowsUserPath(value)])
      if (resolvedPath) return resolvedPath
      continue
    }
    const fromPath = await locateOnPath(value)
    // `where.exe` writes using the active Windows code page. Decoding that
    // output as UTF-8 can corrupt Chinese usernames, so never trust it until
    // the returned path has been checked on disk.
    const resolvedFromPath = await firstExistingPath([
      fromPath,
      fromPath ? repairCorruptedWindowsUserPath(fromPath) : null
    ])
    if (resolvedFromPath) return resolvedFromPath
    if (process.platform === 'win32') {
      for (const candidate of await windowsFallbacks(value)) {
        if (await exists(candidate)) return candidate
      }
    } else {
      const localBin = path.join(os.homedir(), '.local', 'bin', value)
      if (await exists(localBin)) return localBin
    }
  }
  return null
}

export async function preferNativeWindowsExecutable(resolved: string, executableName: string): Promise<string> {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) return resolved
  const candidates = [
    path.join(path.dirname(resolved), executableName),
    path.join(path.dirname(path.dirname(resolved)), executableName)
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return resolved
}

export async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const killed = await new Promise<boolean>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('error', () => resolve(false))
      killer.once('close', code => resolve(code === 0))
    })
    if (killed) return
  } else if (child.kill('SIGTERM')) {
    return
  }
  child.kill('SIGKILL')
}

export function classifyAgentError(error: unknown): 'auth_required' | 'error' {
  const text = error instanceof Error ? error.message : String(error)
  return /auth|login|sign[ -]?in|unauthori[sz]ed|credential|not logged|未登录/i.test(text) ? 'auth_required' : 'error'
}

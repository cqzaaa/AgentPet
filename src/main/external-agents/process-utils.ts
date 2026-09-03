import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
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
  return spawn(isCommandShim ? `"${executable}"` : executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: options.detached,
    windowsHide: options.detached !== true,
    shell: isCommandShim,
    stdio: ['pipe', 'pipe', 'pipe']
  })
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
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
  const base = path.basename(command).replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase()
  if (base === 'codex') {
    const bundled = await newestMatch(path.join(localAppData, 'OpenAI', 'Codex', 'bin'), 'codex.exe')
    return [
      bundled,
      path.join(appData, 'npm', 'codex.cmd'),
      ...programFiles.map(root => path.join(root, 'OpenAI', 'Codex', 'codex.exe'))
    ].filter(Boolean) as string[]
  }
  if (base === 'agy') {
    return [
      path.join(localAppData, 'agy', 'bin', 'agy.exe'),
      path.join(localAppData, 'Programs', 'agy', 'bin', 'agy.exe'),
      path.join(appData, 'agy', 'bin', 'agy.exe'),
      ...programFiles.map(root => path.join(root, 'agy', 'bin', 'agy.exe'))
    ]
  }
  if (base === 'claude' || base === 'gemini') {
    return [path.join(appData, 'npm', `${base}.cmd`)]
  }
  return []
}

export async function resolveExecutable(command: string, aliases: string[] = []): Promise<string | null> {
  for (const value of [command, ...aliases].map(item => item.trim()).filter(Boolean)) {
    if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
      if (await exists(value)) return value
      continue
    }
    const fromPath = await locateOnPath(value)
    if (fromPath) return fromPath
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
  return /auth|login|unauthori[sz]ed|credential|not logged/i.test(text) ? 'auth_required' : 'error'
}

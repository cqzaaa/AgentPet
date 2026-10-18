import { assessCommand, type CommandShell } from './command-policy'

type CommandSegment = { raw: string; command: string; args: string }

function splitCommandSegments(command: string): string[] {
  const segments: string[] = []
  let quote: '"' | "'" | null = null
  let current = ''

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    const next = command[i + 1]
    const prev = command[i - 1]

    if ((char === '"' || char === "'") && prev !== '`' && prev !== '\\') {
      quote = quote === char ? null : quote || char
      current += char
      continue
    }

    if (!quote && (char === '|' || char === ';')) {
      if (current.trim()) segments.push(current.trim())
      current = ''
      if (next === char && (char === '|')) i += 1
      continue
    }

    if (!quote && char === '&' && next === '&') {
      if (current.trim()) segments.push(current.trim())
      current = ''
      i += 1
      continue
    }

    current += char
  }

  if (current.trim()) segments.push(current.trim())
  return segments
}

function parseSegment(raw: string): CommandSegment {
  const trimmed = raw.trim()
  const match = trimmed.match(/^&?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+([\s\S]*))?$/)
  const command = (match?.[1] || match?.[2] || match?.[3] || '').toLowerCase()
  return {
    raw: trimmed,
    command,
    args: match?.[4]?.trim() || ''
  }
}

function unwrapCmdCommand(segment: CommandSegment): string | null {
  const executable = executableBasename(segment.command)
  if (executable !== 'cmd' && executable !== 'cmd.exe') return null
  const match = segment.args.match(/^(?:(?:\/d|\/s)\s+)*\/c\s+([\s\S]+)$/i)
  if (!match) return null
  const inner = match[1].trim()
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
    return inner.slice(1, -1).trim()
  }
  return inner
}

export function getCommandSegments(command: string): CommandSegment[] {
  return splitCommandSegments(command).map(parseSegment)
}

function executableBasename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * Detect local shell commands that would select a Python installation through
 * PATH (or an explicitly supplied executable path). Local Python work must use
 * run_python so it stays on AgentPet's managed runtime. This intentionally
 * examines executable positions only, not arbitrary arguments containing the
 * word "python".
 */
export function invokesPythonExecutable(command: string): boolean {
  return getCommandSegments(command).some(segment => {
    const executable = executableBasename(segment.command)
    return /^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/.test(executable) ||
      /^(?:pip(?:\d+(?:\.\d+)*)?)(?:\.exe)?$/.test(executable)
  })
}

/** Detect commands that must use AgentPet's managed Node/npm runtime. */
export function invokesNodeExecutable(command: string): boolean {
  return getCommandSegments(command).some(segment => {
    const executable = executableBasename(segment.command)
    if (/^(?:node|npm|npx|corepack)(?:\.cmd|\.exe)?$/.test(executable)) return true
    const wrappedCommand = unwrapCmdCommand(segment)
    return wrappedCommand ? invokesNodeExecutable(wrappedCommand) : false
  })
}

// Compatibility entry points share the audit pipeline's complete-command policy.
export function looksLikeReadOnlyInspection(command: string): boolean {
  return getCommandSegments(command).some(segment => assessCommand(segment.raw).kind === 'read-only')
}

export function isReadOnlyCommand(command: string, shell?: CommandShell): boolean {
  return assessCommand(command, shell).kind === 'read-only'
}

export function isRoutineWorkspaceCommand(command: string, shell?: CommandShell): boolean {
  const { kind } = assessCommand(command, shell)
  return kind === 'read-only' || kind === 'verification'
}

export function checkCommandSafety(command: string): { safe: boolean; warning?: string } {
  const trimmed = command.trim().toLowerCase()

  if (
    (/(^|[\s;&|])(format)\b/.test(trimmed) && !/(^|[\s;&|])format-(table|list|wide|custom|hex)\b/.test(trimmed)) ||
    /(^|[\s;&|])(mkfs|dd\s+if=)\b/.test(trimmed)
  ) {
    return { safe: false, warning: '检测到磁盘格式化或底层硬盘扇区写入操作，此操作可能导致不可逆的数据丢失。' }
  }

  if (/\b(shutdown|reboot|init 0|init 6)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到关机或重启系统的命令，运行后会中断当前桌面助手服务。' }
  }

  if (/\bnet\s+user\b/.test(trimmed) || /\bnet\s+localgroup\b/.test(trimmed) || /\b(useradd|userdel|groupadd|groupdel)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到本地系统账户或特权组管理命令，请核对后再执行。' }
  }

  if (/\breg\s+(add|delete|import)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到修改 Windows 注册表的操作，误改关键注册表项可能导致系统或应用异常。' }
  }

  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|\/\*|\/etc|\/var|\/usr|\/bin|\/boot)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到递归删除 Linux 系统关键路径的高危操作。' }
  }

  if (/\bdel\b.*\b(c:|d:)\\\s*(\*|\/s)/.test(trimmed) || /\bdel\b.*\b\\\s*\/s/.test(trimmed)) {
    return { safe: false, warning: '检测到递归删除 Windows 磁盘根目录或整盘数据的高危操作。' }
  }

  if (/\b(rm|del|rd|rmdir|remove-item)\b/.test(trimmed)) {
    return { safe: false, warning: '检测到文件或目录删除命令，需手动核对批准后执行。' }
  }

  if (/-executionpolicy\s+bypass\b/.test(trimmed) || /-ep\s+bypass\b/.test(trimmed)) {
    return { safe: false, warning: '检测到绕过 PowerShell 执行策略的行为，请核对脚本来源后再执行。' }
  }

  return { safe: true }
}

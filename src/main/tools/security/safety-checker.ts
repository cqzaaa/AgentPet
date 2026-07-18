type CommandSegment = {
  raw: string
  command: string
  args: string
}

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'dir',
  'echo',
  'findstr',
  'format-custom',
  'format-list',
  'format-table',
  'format-wide',
  'get-childitem',
  'get-ciminstance',
  'get-command',
  'get-content',
  'get-date',
  'get-eventlog',
  'get-item',
  'get-itemproperty',
  'get-location',
  'get-nettcpconnection',
  'get-process',
  'get-service',
  'get-winevent',
  'get-wmiobject',
  'grep',
  'head',
  'hostname',
  'less',
  'ls',
  'more',
  'measure-object',
  'netstat',
  'nslookup',
  'out-string',
  'ping',
  'pwd',
  'rg',
  'select-object',
  'select-string',
  'sort-object',
  'systeminfo',
  'tail',
  'tasklist',
  'test-connection',
  'test-netconnection',
  'test-path',
  'tracert',
  'type',
  'wc',
  'where-object',
  'whoami',
  'write-output'
])

const VERSION_COMMANDS = new Set([
  'cargo',
  'docker',
  'git',
  'go',
  'java',
  'node',
  'npm',
  'npx',
  'pip',
  'pnpm',
  'python',
  'rustc',
  'tsc',
  'yarn'
])

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'log',
  'remote',
  'show',
  'status',
  'tag'
])

function hasShellRedirection(command: string): boolean {
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    const prev = command[i - 1]

    if ((char === '"' || char === "'") && prev !== '`' && prev !== '\\') {
      quote = quote === char ? null : quote || char
      continue
    }

    if (!quote && (char === '>' || char === '<')) {
      return true
    }
  }

  return false
}

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
  const match = trimmed.match(/^&?\s*([^\s]+)(?:\s+([\s\S]*))?$/)
  const command = (match?.[1] || '').replace(/^["']|["']$/g, '').toLowerCase()
  return {
    raw: trimmed,
    command,
    args: match?.[2]?.trim() || ''
  }
}

function isGitReadOnly(args: string): boolean {
  const tokens = args.toLowerCase().split(/\s+/).filter(Boolean)
  const subcommand = tokens.find(token => !token.startsWith('-'))

  if (!subcommand) return false
  if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return true

  return subcommand === 'config' && (tokens.includes('--list') || tokens.includes('-l'))
}

function isVersionCheck(command: string, args: string): boolean {
  const firstArg = args.toLowerCase().split(/\s+/).find(Boolean)
  return VERSION_COMMANDS.has(command) && (firstArg === '-v' || firstArg === '--version')
}

function isReadOnlySegment(segment: CommandSegment): boolean {
  if (!segment.command) return false
  if (READ_ONLY_COMMANDS.has(segment.command)) return true
  if (segment.command === 'git') return isGitReadOnly(segment.args)
  return isVersionCheck(segment.command, segment.args)
}

export function getCommandSegments(command: string): CommandSegment[] {
  return splitCommandSegments(command).map(parseSegment)
}

export function looksLikeReadOnlyInspection(command: string): boolean {
  const segments = getCommandSegments(command)
  return segments.some(segment => isReadOnlySegment(segment))
}

// Returns true only when every command segment is a non-mutating inspection command.
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || hasShellRedirection(trimmed)) return false

  const segments = getCommandSegments(trimmed)
  return segments.length > 0 && segments.every(segment => isReadOnlySegment(segment))
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

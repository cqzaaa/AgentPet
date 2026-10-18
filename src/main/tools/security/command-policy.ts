export type CommandShell = 'powershell' | 'cmd' | 'bash'
export type CommandAssessment = {
  kind: 'read-only' | 'verification' | 'review' | 'sensitive'
  reason: string
  segment?: string
}

type ParsedCommand = { words: string[]; raw: string }
type ParseResult = { commands: ParsedCommand[]; reason?: string }

// This is a deliberately limited literal-command grammar, not a shell evaluator.
// Scripts, interpolation and ambiguous syntax are reviewed as a whole.
function parseLiteralCommands(source: string, shell: CommandShell): ParseResult {
  const commands: ParsedCommand[] = []
  let words: string[] = []
  let value = ''
  let started = false
  let quote = ''
  let start = 0
  let reason: string | undefined
  const flushWord = (): void => {
    if (started) words.push(value)
    value = ''
    started = false
  }
  const flushCommand = (end: number): void => {
    flushWord()
    if (words.length) commands.push({ words, raw: source.slice(start, end).trim() })
    words = []
    start = end + 1
  }
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    if (quote) {
      if (char === quote) {
        if (shell === 'powershell' && next === quote) { value += char; i++; continue }
        quote = ''
        if (next && !/\s|[;&|\n\r]/.test(next)) reason ||= '包含混合引号参数'
      } else {
        if (quote === '"' && (char === '`' || (char === '$' && next && /[a-zA-Z_{?(^]/.test(next))) && shell !== 'cmd') {
          reason ||= '包含变量展开或命令替换'
        }
        if (shell === 'cmd' && /[%!]/.test(char)) reason ||= '包含 CMD 环境变量展开'
        if (quote === '"' && ((shell === 'bash' && char === '\\') || (shell === 'powershell' && char === '`'))) {
          reason ||= '包含需要按脚本审核的转义语法'
        }
        value += char
      }
      continue
    }
    if (char === '"' || (char === "'" && shell !== 'cmd')) {
      // Quote splicing can hide command names or options. Ordinary quoted
      // arguments are supported; mixed literal/quoted tokens go to review.
      if (started && !value.endsWith('=')) reason ||= '包含混合引号参数'
      quote = char
      started = true
    } else if (char === '#' && shell !== 'cmd' && !started) {
      while (i < source.length && source[i] !== '\n') i++
      flushCommand(i)
    } else if (char === ';' || char === '|' || char === '\n' || char === '\r' || char === '&') {
      if (char === '&' && shell === 'powershell' && !words.length && !started && next !== '&') {
        continue // PowerShell's literal call operator: & git.exe status
      }
      if (char === ';' && shell === 'cmd') reason ||= 'CMD 不使用分号分隔命令'
      flushCommand(i)
      if ((char === '&' || char === '|') && next === char) { i++; start = i + 1 }
    } else if (/\s/.test(char)) {
      flushWord()
    } else {
      if (/[<>]/.test(char)) reason ||= '包含输入或输出重定向'
      if (/[$`(){}^]/.test(char) || (shell === 'cmd' && /[%!]/.test(char))) {
        reason ||= '包含脚本、变量展开或命令替换'
      }
      if (shell === 'bash' && char === '\\') reason ||= '包含需要按脚本审核的转义语法'
      if (char === '@') reason ||= '包含 PowerShell 数组、哈希表或脚本语法'
      started = true
      value += char
    }
  }
  flushCommand(source.length)
  if (quote) reason ||= '命令引号未闭合'
  return { commands, reason }
}

const READ_COMMANDS = new Set([
  'cat', 'dir', 'echo', 'findstr', 'grep', 'head', 'hostname', 'ls', 'pwd', 'rg',
  'tail', 'type', 'wc', 'whoami', 'where', 'which', 'uname', 'stat', 'file',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi', 'get-itemproperty',
  'get-location', 'gl', 'get-command', 'gcm', 'get-date', 'get-filehash', 'get-acl',
  'get-process', 'get-service', 'get-ciminstance', 'get-wmiobject', 'get-winevent',
  'get-eventlog', 'get-nettcpconnection', 'select-string', 'sls', 'select-object',
  'select', 'where-object', 'sort-object', 'measure-object', 'compare-object',
  'format-list', 'format-table', 'format-wide', 'format-custom', 'format-hex',
  'out-string', 'write-output', 'test-path', 'split-path', 'join-path', 'resolve-path',
  'convertfrom-json', 'convertto-json', 'convertfrom-csv', 'convertto-csv',
  'netstat', 'tasklist', 'systeminfo'
])
const GIT_QUERIES = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'show-ref', 'for-each-ref', 'merge-base', 'cat-file', 'count-objects', 'check-ignore',
  'check-attr', 'describe', 'name-rev', 'shortlog', 'blame', 'grep'
])
const VERSION_COMMANDS = new Set(['git', 'node', 'npm', 'pnpm', 'yarn', 'python', 'py', 'pip', 'tsc', 'go', 'cargo', 'rustc', 'java', 'docker'])
const VERIFICATION_SCRIPT = /^(?:check|lint|test|typecheck)(?::[a-z0-9._-]+)*$/i
const SENSITIVE_COMMANDS = new Set([
  'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'clear-content',
  'format', 'mkfs', 'dd', 'shutdown', 'reboot', 'useradd', 'userdel', 'net', 'reg',
  'chmod', 'chown', 'set-acl', 'set-executionpolicy', 'disable-netfirewallrule',
  'set-netfirewallprofile', 'stop-process', 'kill', 'taskkill'
])

const readOnly = (): CommandAssessment => ({ kind: 'read-only', reason: '已确认是只读查询' })
const review = (reason: string): CommandAssessment => ({ kind: 'review', reason })
const sensitive = (reason: string): CommandAssessment => ({ kind: 'sensitive', reason })

function hasOption(args: string[], pattern: RegExp): boolean {
  const end = args.indexOf('--')
  return (end < 0 ? args : args.slice(0, end)).some(arg => pattern.test(arg))
}

// For commands with both query and mutation modes, accept query options only.
function queryOptions(args: string[], flags: Set<string>, values: Set<string>, positional = false): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return positional
    if (!arg.startsWith('-')) { if (positional) continue; return false }
    const equals = arg.indexOf('=')
    const key = equals < 0 ? arg : arg.slice(0, equals)
    if (values.has(key)) { if (equals < 0 && ++i >= args.length) return false; continue }
    if (!flags.has(arg)) return false
  }
  return true
}

function assessGit(input: string[]): CommandAssessment {
  const args = [...input]
  while (args[0]?.startsWith('-')) {
    const flag = args.shift()!
    if (['--no-pager', '--no-optional-locks', '--literal-pathspecs'].includes(flag)) continue
    if (flag === '-C' || flag === '--git-dir' || flag === '--work-tree') {
      if (!args.shift()) return review('Git 全局参数缺少路径')
      continue
    }
    if (/^--(?:git-dir|work-tree)=.+/.test(flag)) continue
    return review(`Git 全局选项 ${flag} 需要审核`)
  }
  const subcommand = args.shift() || ''
  if (GIT_QUERIES.has(subcommand)) {
    if (hasOption(args, /^(?:--output(?:=|$)|--ext-diff$|--textconv$|--filters$|--open-files-in-pager(?:=|$)|-O)/)) {
      return review('Git 查询包含写出文件或运行外部程序的选项')
    }
    return readOnly()
  }
  if (subcommand === 'branch' || subcommand === 'tag') {
    const flags = new Set(['--list', '-l', '--all', '-a', '--remotes', '-r', '-v', '-vv', '--verbose', '--show-current', '--no-color', '--ignore-case'])
    const values = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--color'])
    if (queryOptions(args, flags, values, args.includes('--list') || args.includes('-l'))) return readOnly()
    return sensitive(`git ${subcommand} 可能创建、修改或删除引用`)
  }
  if (subcommand === 'remote') {
    if (!args.length || (args.length === 1 && ['-v', '--verbose'].includes(args[0]))) return readOnly()
    if (args[0] === 'get-url' && queryOptions(args.slice(1), new Set(['--push', '--all']), new Set(), true)) return readOnly()
    if (args[0] === 'show' && args.includes('-n') && args.length === 3) return readOnly()
    return sensitive('Git 远程操作可能修改配置或访问远程仓库')
  }
  if (subcommand === 'config') {
    const flags = new Set(['--global', '--local', '--system', '--worktree', '--show-origin', '--show-scope', '--includes', '--no-includes', '--null', '-z', '--name-only'])
    const values = new Set(['--file', '-f', '--type', '--default'])
    const queries = new Set(['--list', '-l', '--get', '--get-all', '--get-regexp', '--get-urlmatch'])
    const actions = args.filter(arg => queries.has(arg))
    if (actions.length === 1 && queryOptions(args, new Set([...flags, ...queries]), values, !['--list', '-l'].includes(actions[0]))) return readOnly()
    if (['list', 'get'].includes(args[0]) && queryOptions(args.slice(1), flags, values, args[0] === 'get')) return readOnly()
    return sensitive('git config 参数可能修改 Git 配置')
  }
  return sensitive(`git ${subcommand || '命令'} 尚未确认为查询操作`)
}

function assessLiteral(command: ParsedCommand, depth: number): CommandAssessment {
  const [rawName, ...args] = command.words
  // Do not trust an arbitrary executable just because its basename is git/rg.
  if (/[\\/]/.test(rawName)) return review('显式程序路径需要确认其实际程序')
  const name = rawName.toLowerCase().replace(/\.(exe|cmd)$/i, '')
  if (args.includes('--%')) return review('包含 PowerShell 停止解析标记')
  if (SENSITIVE_COMMANDS.has(name)) return sensitive(`命令 ${name} 涉及删除、系统设置或进程控制`)
  if (args.some(arg => /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|credentials|cookies|login data)(?:[\\/]|$)/i.test(arg))) {
    return sensitive('目标可能包含凭据或敏感配置')
  }
  if (name === 'cmd') {
    let index = 0
    while (['/d', '/s'].includes(args[index]?.toLowerCase())) index++
    if (args[index]?.toLowerCase() !== '/c' || index + 1 >= args.length) return review('CMD 包装参数不明确')
    // Multiple already-unquoted words would lose their original quoting.
    if (args.length !== index + 2) return review('CMD 包装命令需要整体审核')
    return assessCommand(args[index + 1], 'cmd', depth + 1)
  }
  if (['bash', 'sh', 'zsh'].includes(name)) {
    if (args.length !== 2 || !['-c', '-lc'].includes(args[0])) return review('Shell 包装命令需要整体审核')
    return assessCommand(args[1], 'bash', depth + 1)
  }
  if (['powershell', 'pwsh'].includes(name)) {
    const lower = args.map(arg => arg.toLowerCase())
    const index = lower.indexOf('-command')
    if (index < 0 || args.length !== index + 2 || !lower.slice(0, index).every(arg => ['-noprofile', '-noninteractive', '-nologo'].includes(arg))) return review('PowerShell 包装脚本需要整体审核')
    return assessCommand(args[index + 1], 'powershell', depth + 1)
  }
  if (VERSION_COMMANDS.has(name) && args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) return readOnly()
  if (name === 'git') return assessGit(args)
  if (READ_COMMANDS.has(name)) {
    if (name === 'file' && hasOption(args, /^(?:--compile$|-C)/)) return review('file 参数会生成编译文件')
    if (name === 'rg' && hasOption(args, /^(?:--pre(?:=|$)|--hostname-bin(?:=|$))/)) return review('rg 参数会运行外部程序')
    if (['get-wmiobject', 'gwmi'].includes(name) && hasOption(args, /^-(?:enableallprivileges|impersonation|credential)/i)) return review('WMI 参数涉及凭据或权限')
    if (hasOption(args, /^-(?:outvariable|ov|pipelinevariable|pv)$/i)) return review('PowerShell 参数会修改会话变量')
    return readOnly()
  }
  if (['npm', 'pnpm', 'yarn'].includes(name)) {
    const scriptIndex = ['run', 'run-script'].includes(args[0]) ? 1 : 0
    const script = args[scriptIndex]
    if ((scriptIndex === 1 || script === 'test' || name === 'yarn') && VERIFICATION_SCRIPT.test(script || '') &&
        !hasOption(args.slice(scriptIndex + 1), /^(?:--prefix|--cwd|--dir|-C|--global|-g|--script-shell)(?:=|$)/i)) {
      return { kind: 'verification', reason: `项目检查脚本 ${script}` }
    }
    return review('包管理命令不属于已确认的项目检查脚本')
  }
  if (name === 'tsc' && args.includes('--noEmit') && args[args.indexOf('--noEmit') + 1] !== 'false' && !args.includes('--build') && !args.includes('-b')) {
    return { kind: 'verification', reason: 'TypeScript 无输出类型检查' }
  }
  return review(`未识别命令 ${rawName} 的副作用`)
}

/** Highest-risk segment wins; no substring or executable-prefix approval. */
export function assessCommand(command: string, shell: CommandShell = 'powershell', depth = 0): CommandAssessment {
  if (depth > 3 || command.length > 32_000) return review('命令过长或 Shell 嵌套过深')
  const parsed = parseLiteralCommands(command, shell)
  if (parsed.reason) return review(parsed.reason)
  if (!parsed.commands.length) return review('命令为空或无法解析')
  let result = readOnly()
  const priority = { 'read-only': 0, verification: 1, review: 2, sensitive: 3 }
  for (const segment of parsed.commands) {
    const assessment = assessLiteral(segment, depth)
    if (priority[assessment.kind] > priority[result.kind]) result = { ...assessment, segment: segment.raw }
  }
  return result
}

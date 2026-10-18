export type VerificationStatus = 'passed' | 'failed' | 'running' | 'unverified'

/** Recognition is only for checkpoint navigation, never permission or command safety. */
export function isVerificationCommand(command: string): boolean {
  // A shell chain/pipeline may hide an earlier check's failure behind its final exit code.
  const unquoted = command.trim().replace(/"[^"]*"|'[^']*'/g, '').replace(/^&\s+/, '')
  if (/[;&|\r\n`]/.test(unquoted)) return false
  const tokens = (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [])
    .map(token => token.replace(/^(["'])(.*)\1$/, '$2'))
  if (tokens[0] === '&') tokens.shift()
  const executable = (tokens.shift() || '').split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd)$/i, '').toLowerCase()
  const checkName = /^(?:test|typecheck|lint|check|verify|build)(?::[\w.-]+)*$/i
  if (executable === 'node') {
    if (tokens[0] === '--test' || tokens[0] === '--check' || tokens[0] === '-c') return true
    // Only the entry script counts; arguments to an unrelated script are not checks.
    const script = (tokens[0] || '').split(/[\\/]/).pop() || ''
    return /^(?:verify|check|test)[-_.].+\.(?:cjs|mjs|js)$/i.test(script) ||
      /\.(?:test|spec)\.(?:cjs|mjs|js)$/i.test(script)
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    return checkName.test(tokens[0] === 'run' ? tokens[1] || '' : tokens[0] || '')
  }
  if (executable === 'npx') {
    if (tokens[0] === 'prettier') return tokens.includes('--check') || tokens.includes('-c')
    return /^(?:tsc|eslint|stylelint|vitest|jest)$/.test(tokens[0] || '')
  }
  if (['pytest', 'vitest', 'jest', 'tsc', 'eslint', 'stylelint'].includes(executable)) return true
  if (executable === 'prettier') return tokens.includes('--check') || tokens.includes('-c')
  return (executable === 'cargo' && /^(?:test|check)$/.test(tokens[0] || '')) ||
    (executable === 'go' && tokens[0] === 'test')
}

export function summarizeCodingVerification(
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
  state?: Record<string, unknown>
): Record<string, unknown> | null {
  if (toolName !== 'run_terminal_command' && toolName !== 'run_command') return null
  const command = String(args.command || '')
  if (!isVerificationCommand(command)) return null
  const exitCode = typeof state?.exitCode === 'number' && Number.isInteger(state.exitCode)
    ? state.exitCode : undefined
  // Tool success means transport/execution succeeded, not that the check passed.
  // Restored history and SSH results may have no exit evidence: keep them unverified.
  const status: VerificationStatus = !success ? 'failed'
    : exitCode !== undefined ? (exitCode === 0 ? 'passed' : 'failed')
      : toolName === 'run_command' && state?.shell_id ? 'running' : 'unverified'
  return {
    command: command.slice(0, 500),
    cwd: args.cwd || args.working_directory,
    shell: args.shell || 'default',
    status,
    exitCode,
    shell_id: state?.shell_id
  }
}

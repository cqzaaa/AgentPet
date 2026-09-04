import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function buildLoginTerminalScript(executable: string, args: string[]): string {
  const command = `& ${[executable, ...args].map(quotePowerShell).join(' ')}`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  // Let Windows create the visible console and its standard handles. Giving the
  // interactive process Node's ignored stdio connects it to NUL instead.
  return [
    "$ErrorActionPreference = 'Stop'",
    `$terminal = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-NoExit', '-EncodedCommand', '${encoded}') -WorkingDirectory ${quotePowerShell(os.homedir())} -WindowStyle Normal -PassThru`,
    'Start-Sleep -Milliseconds 800',
    '$terminal.Refresh()',
    "if ($terminal.HasExited) { throw 'Login terminal exited before it was ready' }",
    "Write-Output 'AGENTPET_LOGIN_TERMINAL_STARTED'"
  ].join('\n')
}

export async function openLoginTerminal(executable: string, args: string[], env?: Record<string, string>): Promise<void> {
  if (process.platform !== 'win32') throw new Error('请在系统终端中运行对应 CLI 登录')
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = buildLoginTerminalScript(executable, args)
  await new Promise<void>((resolve, reject) => {
    const launcher = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: os.homedir(), env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8192) }
    launcher.stdout.on('data', collect)
    launcher.stderr.on('data', collect)
    const timer = setTimeout(() => {
      launcher.kill()
      reject(new Error('打开登录终端超时，请检查桌面是否已有登录窗口'))
    }, 15_000)
    launcher.once('error', error => { clearTimeout(timer); reject(error) })
    launcher.once('close', code => {
      clearTimeout(timer)
      if (code === 0 && output.includes('AGENTPET_LOGIN_TERMINAL_STARTED')) resolve()
      else reject(new Error(`打开登录终端失败：${output.trim() || `退出码 ${code}`}`))
    })
  })
}

import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'

export interface StdioCommand {
  command: string
  args: string[]
}

/** Node cannot spawn Windows npm/npx .cmd shims with shell:false. Run their JS entry directly. */
export function resolveStdioCommand(command: string, args: string[] = []): StdioCommand {
  const trimmed = command.trim()
  if (process.platform !== 'win32') return { command: trimmed, args }

  const name = basename(trimmed).toLowerCase().replace(/\.cmd$/, '')
  if (name !== 'npx' && name !== 'npm') return { command: trimmed, args }

  const directories = isAbsolute(trimmed)
    ? [dirname(trimmed)]
    : (process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const directory of directories) {
    const cli = join(directory, 'node_modules', 'npm', 'bin', `${name}-cli.js`)
    const node = join(directory, 'node.exe')
    if (existsSync(cli) && existsSync(node)) {
      return { command: node, args: [cli, ...args] }
    }
  }

  throw new Error(`找不到 ${name} 的 Node 启动文件。请安装 Node.js，或填写可执行文件的完整路径。`)
}

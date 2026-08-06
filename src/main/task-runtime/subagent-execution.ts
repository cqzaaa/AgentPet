import type { SubagentRole } from './types'

export const SUBAGENT_IDLE_TIMEOUT_MS = 90_000

const READ_TOOLS = ['read_file', 'list_directory', 'get_file_metadata', 'find_files', 'grep_content']
const WRITE_TOOLS = ['write_file', 'edit_file', 'move_file']
const TERMINAL_TOOLS = ['run_terminal_command', 'run_command', 'get_command_output', 'kill_command']
const WEB_TOOLS = ['web_search', 'web_fetch', 'browser_search', 'browser_click']

export function getSubagentToolNames(role: SubagentRole | undefined): string[] {
  const byRole: Record<SubagentRole, string[]> = {
    researcher: [...READ_TOOLS, 'write_file', ...WEB_TOOLS],
    coder: [...READ_TOOLS, ...WRITE_TOOLS, ...TERMINAL_TOOLS],
    reviewer: [...READ_TOOLS, 'run_terminal_command'],
    general: [...READ_TOOLS, ...WRITE_TOOLS, ...TERMINAL_TOOLS, ...WEB_TOOLS]
  }
  return [...new Set(byRole[role || 'general'])]
}

export async function nextWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(new Error(`子 Agent 连续 ${Math.round(timeoutMs / 1000)} 秒没有模型或工具进展`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isIllustratorConnector } from '../../../preload/illustrator-connector'
import { resolveStdioCommand } from './stdio-command'

interface StdioLaunchConfig {
  id?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

interface StdioLaunchContext {
  event?: { sender: WebContents }
  sessionId?: string
}

/** Shared by normal connections, reconnects and the settings connection test. */
export async function resolveMcpStdioLaunch(
  config: StdioLaunchConfig,
  context: StdioLaunchContext = {}
): Promise<{
  command: string
  args: string[]
  env: Record<string, string>
}> {
  if (!config.command?.trim()) throw new Error('stdio MCP 服务缺少启动命令')
  if (isIllustratorConnector(config) && /^npx(?:\.cmd)?$/i.test(config.command.trim())) {
    const { nodeRuntimeManager } = await import('../interaction/node-runtime-manager')
    const { buildManagedNodeEnvironment } = await import('../interaction/node-runtime-environment')
    const runtime = await nodeRuntimeManager.ensure(context)
    const npxCliPath = join(runtime.nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (!existsSync(npxCliPath)) {
      throw new Error(`AgentPet Node 隔离环境缺少 npx 入口文件：${npxCliPath}`)
    }
    // Apply managed paths last so inherited/user npm settings cannot redirect its packages or cache.
    const environment = buildManagedNodeEnvironment(runtime, { ...process.env, ...config.env })
    return {
      command: runtime.nodePath,
      args: [npxCliPath, ...(config.args || [])],
      env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    }
  }
  return {
    ...resolveStdioCommand(config.command, config.args || []),
    env: { ...getDefaultEnvironment(), ...config.env }
  }
}

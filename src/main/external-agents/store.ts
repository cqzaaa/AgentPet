import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ExternalAgentDefinition, ExternalAgentUpsertInput } from './types'

interface StoredAgents {
  version: 1
  agents: ExternalAgentDefinition[]
}

function normalizeArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return []
  return args.slice(0, 64).map(value => String(value).trim()).filter(Boolean)
}

function normalizeEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  return Object.fromEntries(
    Object.entries(env as Record<string, unknown>)
      .slice(0, 64)
      .map(([key, value]) => [key.trim(), String(value)])
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  )
}

export class ExternalAgentStore {
  private get filePath(): string {
    return path.join(app.getPath('userData'), 'agents.json')
  }

  public async list(): Promise<ExternalAgentDefinition[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredAgents
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) return []
      return parsed.agents.filter(agent => agent?.source === 'custom')
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.warn('[Agents] failed to read catalog:', error)
      return []
    }
  }

  public async upsert(input: ExternalAgentUpsertInput): Promise<ExternalAgentDefinition> {
    const name = String(input.name || '').trim().slice(0, 100)
    const executable = String(input.executable || '').trim().slice(0, 1000)
    if (!name) throw new Error('Agent 名称不能为空')
    if (!executable) throw new Error('可执行文件不能为空')

    const agents = await this.list()
    const existing = input.id ? agents.find(agent => agent.id === input.id) : undefined
    const definition: ExternalAgentDefinition = {
      id: existing?.id || `custom-${randomUUID()}`,
      name,
      description: String(input.description || '').trim().slice(0, 500),
      source: 'custom',
      protocol: 'acp-v1',
      executable,
      args: normalizeArgs(input.args),
      env: normalizeEnv(input.env),
      enabled: input.enabled !== false
    }
    const next = existing
      ? agents.map(agent => agent.id === existing.id ? definition : agent)
      : [...agents, definition]
    await this.save(next)
    return definition
  }

  public async delete(id: string): Promise<boolean> {
    const agents = await this.list()
    const next = agents.filter(agent => agent.id !== id)
    if (next.length === agents.length) return false
    await this.save(next)
    return true
  }

  private async save(agents: ExternalAgentDefinition[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    await writeFile(tempPath, JSON.stringify({ version: 1, agents } satisfies StoredAgents, null, 2), 'utf8')
    await rename(tempPath, this.filePath)
  }
}

import * as fs from 'fs'
import { createHash } from 'crypto'
import { join, relative, resolve, sep } from 'path'
import { getActiveStorageDir } from '../tools/utils/paths'

export type SkillSourceType = 'import' | 'skillhub' | 'legacy'

export type SkillIndexRecord = {
  schemaVersion: 1
  id: string
  archiveName: string
  name: string
  description: string
  descriptionZh?: string
  descriptionEn?: string
  version?: string
  triggers: string[]
  allowedTools: string[]
  skillMdPaths: string[]
  enabled: boolean
  estimatedTokens: number
  contentHash: string
  source: { type: SkillSourceType; url?: string }
  installedAt: number
  updatedAt: number
}

type ParsedFrontmatter = {
  name?: string
  description?: string
  description_zh?: string
  description_en?: string
  version?: string
  trigger?: string[]
  triggers?: string[]
  allowedTools?: string[]
  'allowed-tools'?: string[]
}

function skillsDirectory(): string {
  return join(getActiveStorageDir(), 'skills')
}

function indexDirectory(): string {
  return join(skillsDirectory(), '.agentpet', 'index')
}

function safeId(value: string): string {
  return value.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100) || `skill-${Date.now()}`
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  return Math.max(1, Math.ceil(cjk + (text.length - cjk) / 4))
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  return trimmed
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return trimmed ? [unquote(trimmed)] : []
  const body = trimmed.slice(1, -1)
  const values: string[] = []
  let current = ''
  let quote = ''
  for (const char of body) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char
      current += char
    } else if (char === ',' && !quote) {
      if (current.trim()) values.push(unquote(current))
      current = ''
    } else current += char
  }
  if (current.trim()) values.push(unquote(current))
  return values.filter(Boolean)
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return {}
  const result: Record<string, string | string[]> = {}
  let listKey = ''
  let blockKey = ''
  let blockSeparator = ' '
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (blockKey && /^\s+/.test(rawLine) && !/^\s*-\s+/.test(rawLine)) {
      const previous = String(result[blockKey] || '')
      result[blockKey] = `${previous}${previous ? blockSeparator : ''}${rawLine.trim()}`
      continue
    }
    blockKey = ''
    const listItem = rawLine.match(/^\s*-\s+(.+)$/)
    if (listItem && listKey) {
      const list = Array.isArray(result[listKey]) ? result[listKey] as string[] : []
      list.push(unquote(listItem[1]))
      result[listKey] = list
      continue
    }
    const field = rawLine.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (!field) continue
    const key = field[1]
    const value = field[2]
    if (value === '|' || value === '>') {
      blockKey = key
      blockSeparator = value === '|' ? '\n' : ' '
      listKey = ''
      result[key] = ''
      continue
    }
    listKey = value ? '' : key
    result[key] = value.startsWith('[') ? parseInlineList(value) : unquote(value)
  }
  return result as ParsedFrontmatter
}

async function findSkillFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.toLowerCase() === 'skill.md') result.push(path)
    }
  }
  await walk(root)
  return result
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(indexDirectory(), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await fs.promises.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.promises.rename(temporaryPath, path)
}

function indexPath(id: string): string {
  return join(indexDirectory(), `${safeId(id)}.json`)
}

async function readIndex(path: string): Promise<SkillIndexRecord | null> {
  try { return JSON.parse(await fs.promises.readFile(path, 'utf8')) as SkillIndexRecord } catch { return null }
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase()
  const latin = normalized.match(/[a-z0-9][a-z0-9._-]*/g) || []
  const cjkRuns = normalized.match(/[\u3400-\u9fff]+/g) || []
  const cjk: string[] = []
  for (const run of cjkRuns) {
    if (run.length === 1) cjk.push(run)
    else for (let index = 0; index < run.length - 1; index += 1) cjk.push(run.slice(index, index + 2))
  }
  return [...latin, ...cjk]
}

function bm25(query: string, records: SkillIndexRecord[]): SkillIndexRecord[] {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return records.slice(0, 10)
  const documents = records.map(record => {
    const weightedText = `${record.name} ${record.name} ${record.name} ${record.description} ${record.triggers.join(' ')} ${record.triggers.join(' ')} ${record.triggers.join(' ')} ${record.triggers.join(' ')} ${record.triggers.join(' ')}`
    return tokenize(weightedText)
  })
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length)
  const scores = records.map((record, recordIndex) => {
    const document = documents[recordIndex]
    const frequencies = new Map<string, number>()
    for (const token of document) frequencies.set(token, (frequencies.get(token) || 0) + 1)
    let score = record.triggers.some(trigger => query.toLowerCase().includes(trigger.toLowerCase())) ? 25 : 0
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) || 0
      if (!frequency) continue
      const documentFrequency = documents.filter(candidate => candidate.includes(token)).length
      const idf = Math.log(1 + (records.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * document.length / Math.max(1, averageLength))
      score += idf * frequency * 2.2 / denominator
    }
    return { record, score }
  })
  return scores.filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 10).map(item => item.record)
}

export class SkillRegistry {
  private loadedByTurn = new Map<string, { ids: Set<string>; tokens: number }>()

  public async indexArchive(archiveName: string, folderPath: string, source: SkillIndexRecord['source'] = { type: 'import' }): Promise<SkillIndexRecord | null> {
    const id = safeId(archiveName)
    const previous = await readIndex(indexPath(id))
    const skillFiles = await findSkillFiles(folderPath)
    if (skillFiles.length === 0) return null
    const contents = await Promise.all(skillFiles.map(path => fs.promises.readFile(path, 'utf8')))
    const metadata = contents.map(parseFrontmatter)
    const first = metadata[0] || {}
    const triggers = [...new Set(metadata.flatMap(item => item.trigger || item.triggers || []).map(String).map(value => value.trim()).filter(Boolean))]
    const allowedTools = [...new Set(metadata.flatMap(item => item.allowedTools || item['allowed-tools'] || []).map(String).map(value => value.trim()).filter(Boolean))]
    const description = String(first.description || first.description_zh || first.description_en || '').trim().slice(0, 500)
    const now = Date.now()
    const record: SkillIndexRecord = {
      schemaVersion: 1,
      id,
      archiveName,
      name: String(first.name || id).trim().slice(0, 120),
      description: description || `Skill package ${id}`,
      descriptionZh: first.description_zh ? String(first.description_zh).slice(0, 500) : undefined,
      descriptionEn: first.description_en ? String(first.description_en).slice(0, 500) : undefined,
      version: first.version ? String(first.version).slice(0, 40) : undefined,
      triggers: triggers.slice(0, 40),
      allowedTools: allowedTools.slice(0, 40),
      skillMdPaths: skillFiles.map(path => relative(folderPath, path).replace(/\\/g, '/')),
      enabled: previous?.enabled === true,
      estimatedTokens: contents.reduce((sum, content) => sum + estimateTokens(content), 0),
      contentHash: `sha256:${createHash('sha256').update(contents.join('\n---\n')).digest('hex')}`,
      source: previous?.source || source,
      installedAt: previous?.installedAt || now,
      updatedAt: now
    }
    await atomicWriteJson(indexPath(id), record)
    return record
  }

  public async getRecord(idOrArchive: string): Promise<SkillIndexRecord | null> {
    const id = safeId(idOrArchive)
    return readIndex(indexPath(id))
  }

  public async setEnabled(idOrArchive: string, enabled: boolean): Promise<SkillIndexRecord | null> {
    const record = await this.getRecord(idOrArchive)
    if (!record) return null
    record.enabled = enabled
    record.updatedAt = Date.now()
    await atomicWriteJson(indexPath(record.id), record)
    return record
  }

  public async listIndexed(): Promise<SkillIndexRecord[]> {
    const entries = await fs.promises.readdir(indexDirectory(), { withFileTypes: true }).catch(() => [])
    const records = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => readIndex(join(indexDirectory(), entry.name))))
    return records
      .filter((record): record is SkillIndexRecord => Boolean(record) && fs.existsSync(join(skillsDirectory(), record!.archiveName)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  public async buildCatalog(query: string): Promise<{ catalog: string; candidates: SkillIndexRecord[]; enabledCount: number }> {
    const enabled = (await this.listIndexed()).filter(record => record.enabled)
    const candidates = enabled.length > 10 ? bm25(query, enabled) : enabled
    if (candidates.length === 0) return { catalog: '', candidates, enabledCount: enabled.length }
    const lines = candidates.map(record => {
      const triggers = record.triggers.slice(0, 10).join(', ')
      return `- id: ${record.id}\n  name: ${record.name}\n  description: ${record.description.slice(0, 240)}${triggers ? `\n  triggers: ${triggers}` : ''}\n  estimated_tokens: ${record.estimatedTokens}`
    })
    return {
      catalog: `<available_skills>\n${lines.join('\n')}\n</available_skills>\n需要完整技能规范时调用 request_skill；不要根据名称猜测未加载的规则。`,
      candidates,
      enabledCount: enabled.length
    }
  }

  public async requestSkills(ids: string[], sessionId?: string, messageId?: number): Promise<{ loaded: Array<{ id: string; name: string; instructions: string; estimatedTokens: number; artifactRoot: string }>; rejected: Array<{ id: string; reason: string }>; remainingSkillBudget: number }> {
    const turnKey = `${sessionId || 'default'}:${messageId || 'unknown'}`
    if (!this.loadedByTurn.has(turnKey)) {
      if (this.loadedByTurn.size >= 200) this.loadedByTurn.delete(this.loadedByTurn.keys().next().value as string)
      this.loadedByTurn.set(turnKey, { ids: new Set(), tokens: 0 })
    }
    const turnState = this.loadedByTurn.get(turnKey)!
    const loaded: Array<{ id: string; name: string; instructions: string; estimatedTokens: number; artifactRoot: string }> = []
    const rejected: Array<{ id: string; reason: string }> = []
    let remainingSkillBudget = Math.max(0, 6000 - turnState.tokens)
    for (const rawId of [...new Set(ids.map(safeId))].slice(0, 3)) {
      if (turnState.ids.size >= 3) { rejected.push({ id: rawId, reason: '本轮最多加载 3 个 Skill' }); continue }
      const record = await this.getRecord(rawId)
      if (!record) { rejected.push({ id: rawId, reason: 'Skill 不存在' }); continue }
      if (!record.enabled) { rejected.push({ id: rawId, reason: 'Skill 未启用' }); continue }
      if (turnState.ids.has(record.id)) { rejected.push({ id: rawId, reason: '本轮已经加载' }); continue }
      if (record.estimatedTokens > remainingSkillBudget) { rejected.push({ id: rawId, reason: '超过本轮 Skill token 预算' }); continue }
      const folderRoot = resolve(skillsDirectory(), record.archiveName.replace(/\.zip$/i, ''))
      const rootPrefix = `${folderRoot}${sep}`
      const contents: string[] = []
      let unsafePath = false
      for (const relativePath of record.skillMdPaths) {
        const absolutePath = resolve(folderRoot, relativePath)
        if (!absolutePath.startsWith(rootPrefix)) { unsafePath = true; break }
        contents.push(await fs.promises.readFile(absolutePath, 'utf8'))
      }
      if (unsafePath) { rejected.push({ id: rawId, reason: 'Skill 索引路径不安全' }); continue }
      remainingSkillBudget -= record.estimatedTokens
      turnState.tokens += record.estimatedTokens
      turnState.ids.add(record.id)
      loaded.push({ id: record.id, name: record.name, instructions: contents.join('\n\n---\n\n'), estimatedTokens: record.estimatedTokens, artifactRoot: folderRoot })
    }
    return { loaded, rejected, remainingSkillBudget }
  }

  public async removeIndex(idOrArchive: string): Promise<void> {
    await fs.promises.rm(indexPath(safeId(idOrArchive)), { force: true })
  }
}

export const skillRegistry = new SkillRegistry()

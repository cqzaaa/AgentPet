import { extractEntityCandidates, parseEntityEvidence, type WikiEntityNodeRow, type EntityCandidate } from './wiki-entities'
import type { WikiGraphData, WikiSyncProgress } from '../../preload/wiki-types'
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import * as fs from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { Database } from 'sqlite'

import { buildKnowledgeNodes, parseKnowledgeFile } from './knowledgeBase'
import { officeRuntimeManager } from '../tools/interaction/office-runtime-manager'
import {
  embedTexts,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embeddingContentHash
} from '../embedding/embedding-client'

interface WikiDependencies {
  getDB: () => Promise<Database>
}

interface KnowledgeNodeRow {
  id: string
  parent_id: string | null
  node_type: string
  heading_path: string
  title: string
  content: string
}

interface ExistingWikiItem {
  id: string
  documentId: string
  contentHash: string
}

interface WikiLinkSourceRow {
  id: string
  relativePath: string
  absolutePath: string
  title: string
  editable: number
}

interface WikiGraphItemRow {
  id: string
  relativePath: string
  title: string
  itemKind: 'page' | 'document'
  fileType: string
  fileSize: number
}

interface WikiGraphLinkRow {
  id: string
  fromItemId: string
  toItemId: string | null
  targetText: string
  linkType: string
}

interface WikiGraphEntityLinkRow {
  entityId: string
  entityName: string
  entityType: string
  itemId: string
  mentionCount: number
  confidence: number
  evidenceJson: string
}

interface WikiSourceLinkRow {
  id: string
  itemId: string
  resource: string
  relativePath: string
  startLine: number | null
  endLine: number | null
  claimId: string
  statement: string
  version: string
  status: 'linked' | 'verified' | 'missing'
}

interface ParsedRepositoryResource {
  resource: string
  relativePath: string
  startLine: number | null
  endLine: number | null
}

interface WikiSourceCandidate extends ParsedRepositoryResource {
  claimId: string
  statement: string
  version: string
  status: 'linked' | 'verified' | 'missing'
}

interface WikiFileEntry {
  absolutePath: string
  relativePath: string
  parentPath: string
  fileType: string
  title: string
  fileSize: number
  modifiedAt: number
  contentHash: string
}

const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'json', 'html', 'htm',
  'xml', 'yaml', 'yml'
])
const EDITABLE_EXTENSIONS = new Set(['md', 'txt'])
const SEARCHABLE_NODE_TYPES = new Set([
  'clause', 'item', 'paragraph', 'list', 'table', 'table_row', 'figure', 'caption'
])
const IGNORED_DIRECTORIES = new Set(['.git', '.agentpet', 'node_modules', 'dist', 'out'])
const MAX_WORKSPACE_FILES = 2000
const latestSyncByWorkspace = new Map<string, WikiSyncProgress>()
const workspaceWatchers = new Map<string, { rootPath: string; watcher: fs.FSWatcher; timer: NodeJS.Timeout | null }>()
const syncingWorkspaces = new Map<string, Promise<WikiSyncProgress>>()
function publishSyncProgress(_event: { sender: WebContents } | undefined, progress: WikiSyncProgress): void {
  progress.updatedAt = Date.now()
  latestSyncByWorkspace.set(progress.workspaceId, { ...progress })
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('api:wiki-sync-progress', { ...progress })
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(resolve(rootPath), resolve(candidatePath))
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex')
}

async function collectWorkspaceFiles(rootPath: string): Promise<WikiFileEntry[]> {
  const result: WikiFileEntry[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))
    for (const entry of entries) {
      if (result.length >= MAX_WORKSPACE_FILES) return
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue
      const absolutePath = join(directory, entry.name)
      if (!isWithinRoot(rootPath, absolutePath)) continue
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const fileType = extname(entry.name).slice(1).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.has(fileType)) continue
      const stat = await fs.promises.stat(absolutePath)
      const relativePath = normalizeRelativePath(relative(rootPath, absolutePath))
      result.push({
        absolutePath,
        relativePath,
        parentPath: normalizeRelativePath(dirname(relativePath) === '.' ? '' : dirname(relativePath)),
        fileType,
        title: basename(entry.name, extname(entry.name)),
        fileSize: stat.size,
        modifiedAt: stat.mtimeMs,
        contentHash: await hashFile(absolutePath)
      })
    }
  }
  await walk(rootPath)
  return result
}

function parseHeadingPath(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function embeddingText(row: KnowledgeNodeRow): string {
  const path = parseHeadingPath(row.heading_path).slice(1).join(' / ')
  return [
    `节点类型：${String(row.node_type || '')}`,
    path ? `章节路径：${path}` : '',
    row.title ? `标题：${String(row.title)}` : '',
    `正文：${String(row.content || '')}`
  ].filter(Boolean).join('\n').slice(0, 24_000)
}

async function indexWikiDocument(database: Database, documentId: string): Promise<void> {
  const rows = await database.all<KnowledgeNodeRow[]>(`
    SELECT n.* FROM knowledge_nodes n WHERE n.document_id = ?
  `, documentId)
  const searchable = rows.filter(row => SEARCHABLE_NODE_TYPES.has(row.node_type)
    || (row.node_type === 'article' && !rows.some(child => child.parent_id === row.id && ['clause', 'item'].includes(child.node_type))))
  try {
    for (const row of searchable) {
      await database.run('DELETE FROM knowledge_nodes_fts WHERE node_id = ?', row.id)
      await database.run(
        'INSERT INTO knowledge_nodes_fts (node_id, title, content, heading_path) VALUES (?, ?, ?, ?)',
        row.id, row.title || '', row.content || '', parseHeadingPath(row.heading_path).slice(1).join(' / ')
      )
    }
  } catch {
    // SQLite builds without FTS5 still use the in-process lexical search path.
  }

  for (let offset = 0; offset < searchable.length; offset += 16) {
    const batch = searchable.slice(offset, offset + 16)
    const texts = batch.map(embeddingText)
    const vectors = await embedTexts(texts)
    for (let index = 0; index < batch.length; index++) {
      const vector = vectors[index]
      if (!vector) continue
      await database.run(`
        INSERT INTO knowledge_embeddings (node_id, model, dimensions, vector, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          model = excluded.model,
          dimensions = excluded.dimensions,
          vector = excluded.vector,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `, batch[index].id, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, JSON.stringify(vector),
      embeddingContentHash(texts[index]), Date.now())
    }
  }
}

async function removeIndexedDocument(database: Database, documentId: string): Promise<void> {
  const document = await database.get<{ profileJson: string }>(
    'SELECT profile_json AS profileJson FROM knowledge_documents WHERE id = ?',
    documentId
  )
  const nodeIds = await database.all<Array<{ id: string }>>('SELECT id FROM knowledge_nodes WHERE document_id = ?', documentId)
  try {
    for (const row of nodeIds) await database.run('DELETE FROM knowledge_nodes_fts WHERE node_id = ?', row.id)
  } catch {
    // FTS5 may be unavailable.
  }
  await database.run('DELETE FROM knowledge_documents WHERE id = ?', documentId)
  try {
    const profile = JSON.parse(document?.profileJson || '{}') as { imageAssetDir?: unknown }
    const assetDirectory = typeof profile.imageAssetDir === 'string' ? resolve(profile.imageAssetDir) : ''
    const assetRoot = resolve(join(app.getPath('userData'), 'knowledge-assets'))
    if (assetDirectory && assetDirectory.startsWith(`${assetRoot}${sep}`)) {
      await fs.promises.rm(assetDirectory, { recursive: true, force: true })
    }
  } catch {
    // Older index rows can omit media metadata; the database entry is still safe to remove.
  }
}

async function upsertWikiFile(
  database: Database,
  workspaceId: string,
  entry: WikiFileEntry,
  event?: { sender: WebContents },
  onProgress?: (detail: string) => void
): Promise<{ itemId: string; documentId: string; changed: boolean }> {
  const existing = await database.get<ExistingWikiItem>(`
    SELECT id, document_id AS documentId, content_hash AS contentHash
    FROM wiki_items WHERE workspace_id = ? AND relative_path = ?
  `, workspaceId, entry.relativePath)
  if (existing?.contentHash === entry.contentHash) {
    const document = ['pdf', 'md'].includes(entry.fileType)
      ? await database.get<{ parser: string; profileJson: string }>('SELECT parser, profile_json AS profileJson FROM knowledge_documents WHERE id = ?', existing.documentId)
      : null
    // Upgrade cached general PDFs once; retry degraded conversions on explicit sync.
    const currentMarkdownIndex = entry.fileType !== 'md' || document?.profileJson.includes('"wikiMarkdownVersion":2')
    if (currentMarkdownIndex && (entry.fileType !== 'pdf' || document?.parser === 'docling-2.60.0+rapidocr'
      || (document?.parser === 'pymupdf-layout+legal-cn-v1' && !document.profileJson.includes('enhancedParseFailed')))) {
      return { itemId: existing.id, documentId: existing.documentId, changed: false }
    }
  }

  const parsed = await parseKnowledgeFile(entry.absolutePath, event, onProgress)
  if (entry.fileType === 'md') parsed.profile = { ...parsed.profile, wikiMarkdownVersion: 2 }
  const nodes = parsed.nodes || buildKnowledgeNodes(entry.title, parsed.blocks)
  const itemId = existing?.id || randomUUID()
  const documentId = existing?.documentId || randomUUID()
  const now = Date.now()
  const parseStatus = nodes.length <= 1 || parsed.characterCount < 80 || parsed.qualityScore < 0.6
    ? 'needs_review'
    : 'ready'

  if (existing?.documentId) {
    const oldNodes = await database.all<Array<{ id: string }>>('SELECT id FROM knowledge_nodes WHERE document_id = ?', documentId)
    try {
      for (const row of oldNodes) await database.run('DELETE FROM knowledge_nodes_fts WHERE node_id = ?', row.id)
    } catch {
      // FTS5 may be unavailable.
    }
  }

  await database.exec('BEGIN TRANSACTION')
  try {
    if (existing?.documentId) {
      await database.run('DELETE FROM knowledge_nodes WHERE document_id = ?', documentId)
      await database.run(`
        UPDATE knowledge_documents SET name = ?, source_path = ?, file_type = ?, file_size = ?,
          parser = ?, parse_status = ?, warning = ?, quality_score = ?, profile_json = ?,
          character_count = ?, node_count = ?, updated_at = ? WHERE id = ?
      `, basename(entry.absolutePath), entry.absolutePath, entry.fileType, entry.fileSize,
      parsed.parser, parseStatus, parsed.warning, parsed.qualityScore, JSON.stringify(parsed.profile),
      parsed.characterCount, nodes.length, now, documentId)
    } else {
      await database.run(`
        INSERT INTO knowledge_documents (
          id, knowledge_base_id, name, source_path, file_type, file_size, parser,
          parse_status, warning, quality_score, profile_json, character_count, node_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, documentId, workspaceId, basename(entry.absolutePath), entry.absolutePath, entry.fileType,
      entry.fileSize, parsed.parser, parseStatus, parsed.warning, parsed.qualityScore,
      JSON.stringify(parsed.profile), parsed.characterCount, nodes.length, now, now)
    }

    for (const node of nodes) {
      await database.run(`
        INSERT INTO knowledge_nodes (
          id, document_id, parent_id, node_type, level, title, heading_path,
          content, order_index, page_start, page_end, token_count, confidence,
          source_meta, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, node.id, documentId, node.parentId, node.type, node.level, node.title,
      JSON.stringify(node.headingPath), node.content, node.orderIndex, node.pageStart,
      node.pageEnd, node.tokenCount, node.confidence, JSON.stringify(node.sourceMeta), now)
    }

    await database.run(`
      INSERT INTO wiki_items (
        id, workspace_id, document_id, relative_path, absolute_path, parent_path, title,
        item_kind, file_type, editable, content_hash, file_size, modified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, relative_path) DO UPDATE SET
        document_id = excluded.document_id,
        absolute_path = excluded.absolute_path,
        parent_path = excluded.parent_path,
        title = excluded.title,
        item_kind = excluded.item_kind,
        file_type = excluded.file_type,
        editable = excluded.editable,
        content_hash = excluded.content_hash,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at,
        updated_at = excluded.updated_at
    `, itemId, workspaceId, documentId, entry.relativePath, entry.absolutePath, entry.parentPath,
    entry.title, EDITABLE_EXTENSIONS.has(entry.fileType) ? 'page' : 'document', entry.fileType,
    EDITABLE_EXTENSIONS.has(entry.fileType) ? 1 : 0, entry.contentHash, entry.fileSize,
    entry.modifiedAt, now, now)
    await database.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', now, workspaceId)
    await database.exec('COMMIT')
  } catch (error) {
    await database.exec('ROLLBACK')
    throw error
  }
  await indexWikiDocument(database, documentId)
  return { itemId, documentId, changed: true }
}

function normalizedLinkKey(value: string): string {
  return normalizeRelativePath(value)
    .replace(/\.(?:md|txt)$/i, '')
    .replace(/^\.\//, '')
    .trim()
    .toLocaleLowerCase('zh-CN')
}

function parseRepositoryResource(value: string): ParsedRepositoryResource | null {
  const raw = value.trim().replace(/^['"]|['"]$/g, '')
  if (!raw.startsWith('repo://')) return null
  const body = raw.slice('repo://'.length)
  const hashIndex = body.indexOf('#')
  const encodedPath = hashIndex < 0 ? body : body.slice(0, hashIndex)
  const encodedFragment = hashIndex < 0 ? '' : body.slice(hashIndex + 1)
  let decodedPath = ''
  let decodedFragment = ''
  try {
    decodedPath = decodeURIComponent(encodedPath).replace(/\\/g, '/').replace(/^\.\//, '')
    decodedFragment = encodedFragment ? decodeURIComponent(encodedFragment) : ''
  } catch {
    return null
  }
  const parts = decodedPath.split('/')
  if (!decodedPath || decodedPath.startsWith('/') || /^[a-z]:\//i.test(decodedPath)
    || parts.some(part => !part || part === '.' || part === '..'
      || [...part].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127))) return null
  const lowerPath = decodedPath.toLowerCase()
  if (lowerPath === '.git' || lowerPath.startsWith('.git/') || lowerPath === 'openwiki' || lowerPath.startsWith('openwiki/')) return null
  let startLine: number | null = null
  let endLine: number | null = null
  if (decodedFragment) {
    const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(decodedFragment)
    if (!match) return null
    startLine = Number(match[1])
    endLine = Number(match[2] || match[1])
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || endLine < startLine) return null
  }
  const encoded = parts.map(part => encodeURIComponent(part)).join('/')
  return {
    resource: `repo://${encoded}${startLine ? `#L${startLine}-L${endLine}` : ''}`,
    relativePath: decodedPath,
    startLine,
    endLine
  }
}

function frontmatterRepositoryResources(content: string): ParsedRepositoryResource[] {
  if (!content.startsWith('---')) return []
  const end = content.indexOf('\n---', 3)
  if (end < 0) return []
  const frontmatter = content.slice(3, end)
  const resources: ParsedRepositoryResource[] = []
  for (const match of frontmatter.matchAll(/^\s*(?:-\s*)?resource:\s*(.+?)\s*$/gm)) {
    const resource = parseRepositoryResource(match[1])
    if (resource) resources.push(resource)
  }
  return resources
}

function claimsSidecarPath(rootPath: string, pagePath: string): string | null {
  const normalized = normalizeRelativePath(pagePath)
  if (!/^openwiki\/.+\.md$/i.test(normalized)) return null
  const relativePage = normalized.slice('openwiki/'.length).replace(/\.md$/i, '.json')
  const candidate = resolve(rootPath, 'openwiki', '.claims', relativePage)
  return isWithinRoot(rootPath, candidate) ? candidate : null
}

async function sourceFileAvailable(rootPath: string, relativePath: string): Promise<boolean> {
  const candidate = resolve(rootPath, relativePath)
  if (!isWithinRoot(rootPath, candidate)) return false
  try {
    const stat = await fs.promises.lstat(candidate)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    return isWithinRoot(await fs.promises.realpath(rootPath), await fs.promises.realpath(candidate))
  } catch {
    return false
  }
}

async function rebuildWikiSources(database: Database, workspaceId: string, rootPath: string): Promise<void> {
  const pages = await database.all<Array<{ id: string; relativePath: string; absolutePath: string }>>(`
    SELECT id, relative_path AS relativePath, absolute_path AS absolutePath
    FROM wiki_items WHERE workspace_id = ? AND file_type = 'md'
    ORDER BY relative_path COLLATE NOCASE
  `, workspaceId)
  const collected: Array<WikiSourceCandidate & { itemId: string }> = []
  for (const page of pages) {
    let content = ''
    try {
      content = await fs.promises.readFile(page.absolutePath, 'utf8')
    } catch {
      continue
    }
    const candidates = new Map<string, WikiSourceCandidate>()
    for (const source of frontmatterRepositoryResources(content)) {
      candidates.set(source.resource, { ...source, claimId: '', statement: '', version: '', status: 'linked' })
    }
    const sidecarPath = claimsSidecarPath(rootPath, page.relativePath)
    let verified = false
    if (sidecarPath) {
      try {
        const parsed = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8')) as {
          claims?: Array<{ id?: unknown; statement?: unknown; evidence?: Array<{ resource?: unknown; version?: unknown }> }>
          verification?: unknown
        }
        verified = Boolean(parsed.verification)
        for (const claim of Array.isArray(parsed.claims) ? parsed.claims : []) {
          const claimId = typeof claim.id === 'string' ? claim.id : ''
          const statement = typeof claim.statement === 'string' ? claim.statement.trim() : ''
          for (const evidence of Array.isArray(claim.evidence) ? claim.evidence : []) {
            if (typeof evidence.resource !== 'string') continue
            const source = parseRepositoryResource(evidence.resource)
            if (!source) continue
            const key = `${source.resource}\n${claimId}`
            candidates.set(key, {
              ...source,
              claimId,
              statement,
              version: typeof evidence.version === 'string' ? evidence.version : '',
              status: verified ? 'verified' : 'linked'
            })
          }
        }
      } catch {
        // A malformed or partially-written sidecar must not hide frontmatter sources.
      }
    }
    const claimedPaths = new Set([...candidates.values()].filter(source => source.claimId).map(source => source.relativePath))
    for (const [key, source] of candidates) {
      if (!source.claimId && claimedPaths.has(source.relativePath)) {
        candidates.delete(key)
        continue
      }
      if (!await sourceFileAvailable(rootPath, source.relativePath)) source.status = 'missing'
      collected.push({ ...source, itemId: page.id })
    }
  }

  const now = Date.now()
  await database.exec('BEGIN TRANSACTION')
  try {
    await database.run('DELETE FROM wiki_item_sources WHERE workspace_id = ?', workspaceId)
    for (const source of collected) {
      const id = `source-link:${createHash('sha256').update(`${source.itemId}:${source.resource}:${source.claimId}`).digest('hex').slice(0, 32)}`
      await database.run(`
        INSERT INTO wiki_item_sources (
          id, workspace_id, item_id, resource, relative_path, start_line, end_line,
          claim_id, statement, version, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, workspaceId, source.itemId, source.resource, source.relativePath,
      source.startLine, source.endLine, source.claimId, source.statement, source.version,
      source.status, now, now)
    }
    await database.exec('COMMIT')
  } catch (error) {
    await database.exec('ROLLBACK')
    throw error
  }
}

async function rebuildWikiEntities(database: Database, workspaceId: string): Promise<void> {
  const rows = await database.all<WikiEntityNodeRow[]>(`
    SELECT n.id AS nodeId, n.heading_path AS headingPath, wi.id AS itemId, wi.title AS itemTitle, n.node_type AS nodeType,
      COALESCE(n.title, '') AS title, COALESCE(n.content, '') AS content, n.page_start AS pageStart
    FROM wiki_items wi
    JOIN knowledge_nodes n ON n.document_id = wi.document_id
    WHERE wi.workspace_id = ? AND n.node_type <> 'document'
    ORDER BY wi.id, n.order_index
  `, workspaceId)
  const byItem = new Map<string, Map<string, EntityCandidate>>()
  for (const row of rows) {
    let itemEntities = byItem.get(row.itemId)
    if (!itemEntities) {
      itemEntities = new Map<string, EntityCandidate>()
      byItem.set(row.itemId, itemEntities)
    }
    for (const candidate of extractEntityCandidates(row)) {
      const existing = itemEntities.get(candidate.normalizedName)
      if (existing) {
        existing.mentionCount += candidate.mentionCount
        existing.confidence = Math.max(existing.confidence, candidate.confidence)
        for (const evidence of candidate.evidence) {
          if (!existing.evidence.some(value => value.nodeId === evidence.nodeId) && existing.evidence.length < 8) existing.evidence.push(evidence)
        }
      } else {
        itemEntities.set(candidate.normalizedName, candidate)
      }
    }
  }

  const now = Date.now()
  await database.exec('BEGIN TRANSACTION')
  try {
    await database.run('DELETE FROM wiki_entities WHERE workspace_id = ?', workspaceId)
    for (const [itemId, entityMap] of byItem) {
      const ranked = [...entityMap.values()]
        .filter(entity => entity.confidence >= 0.84)
        .sort((left, right) => (right.confidence * 4 + Math.log2(right.mentionCount + 1)) - (left.confidence * 4 + Math.log2(left.mentionCount + 1)))
        .slice(0, 20)
      for (const entity of ranked) {
        const entityId = `entity:${createHash('sha256').update(`${workspaceId}:${entity.normalizedName}`).digest('hex').slice(0, 24)}`
        await database.run(`
          INSERT INTO wiki_entities (
            id, workspace_id, name, normalized_name, entity_type, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, normalized_name) DO UPDATE SET
            name = CASE WHEN length(excluded.name) < length(name) THEN excluded.name ELSE name END,
            entity_type = excluded.entity_type,
            updated_at = excluded.updated_at
        `, entityId, workspaceId, entity.name, entity.normalizedName, entity.entityType, now, now)
        await database.run(`
          INSERT INTO wiki_item_entities (
            item_id, entity_id, mention_count, confidence, evidence_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, itemId, entityId, entity.mentionCount, entity.confidence,
        JSON.stringify(entity.evidence), now, now)
      }
    }
    await database.exec('COMMIT')
  } catch (error) {
    await database.exec('ROLLBACK')
    throw error
  }
}

async function rebuildWikiLinks(database: Database, workspaceId: string): Promise<void> {
  const items = await database.all<WikiLinkSourceRow[]>(`
    SELECT id, relative_path AS relativePath, absolute_path AS absolutePath, title, editable
    FROM wiki_items WHERE workspace_id = ? ORDER BY relative_path
  `, workspaceId)
  const lookup = new Map<string, WikiLinkSourceRow>()
  for (const item of items) {
    const withoutExtension = item.relativePath.replace(/\.[^.]+$/, '')
    for (const key of [item.relativePath, withoutExtension, item.title, basename(withoutExtension)]) {
      const normalized = normalizedLinkKey(key)
      if (normalized && !lookup.has(normalized)) lookup.set(normalized, item)
    }
  }
  await database.run('DELETE FROM wiki_links WHERE workspace_id = ?', workspaceId)
  for (const item of items.filter(candidate => candidate.editable)) {
    let content = ''
    try {
      content = await fs.promises.readFile(item.absolutePath, 'utf8')
    } catch {
      continue
    }
    const wikiTargets = [...content.matchAll(/\[\[([^\]]+)\]\]/g)]
      .map(match => ({
        targetText: match[1].split('|')[0].split('#')[0].trim(),
        linkType: 'explicit'
      }))
      .filter(target => Boolean(target.targetText))
    const markdownTargets = [...content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)]
      .map(match => match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0])
      .map(rawTarget => {
        if (!rawTarget || rawTarget.startsWith('#') || rawTarget.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(rawTarget)) return null
        let decodedTarget = ''
        try {
          decodedTarget = decodeURIComponent(rawTarget.split(/[?#]/)[0]).replace(/\\/g, '/')
        } catch {
          return null
        }
        if (!decodedTarget) return null
        const targetText = normalizeRelativePath(join(dirname(item.relativePath), decodedTarget))
        if (!targetText || targetText === '..' || targetText.startsWith('../')) return null
        return { targetText, linkType: 'markdown' }
      })
      .filter((target): target is { targetText: string; linkType: string } => target !== null)
    const targets = new Map([...wikiTargets, ...markdownTargets]
      .map(target => [`${target.linkType}:${target.targetText}`, target]))
    for (const { targetText, linkType } of targets.values()) {
      const target = lookup.get(normalizedLinkKey(targetText))
      await database.run(`
        INSERT INTO wiki_links (id, workspace_id, from_item_id, to_item_id, target_text, link_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, randomUUID(), workspaceId, item.id, target?.id || null, targetText, linkType, Date.now())
    }
  }
}

async function syncWorkspace(
  database: Database,
  workspaceId: string,
  rootPath: string,
  event?: { sender: WebContents }
): Promise<WikiSyncProgress> {
  const progress: WikiSyncProgress = {
    workspaceId,
    status: 'running',
    total: 0,
    completed: 0,
    failed: 0,
    currentFile: '',
    updatedAt: Date.now()
  }
  publishSyncProgress(event, progress)
  const files = await collectWorkspaceFiles(rootPath)
  progress.total = files.length
  publishSyncProgress(event, progress)
  const currentPaths = new Set(files.map(file => file.relativePath))
  const removed = await database.all<Array<{ documentId: string }>>(`
    SELECT document_id AS documentId FROM wiki_items
    WHERE workspace_id = ? AND relative_path NOT IN (${files.map(() => '?').join(',') || "''"})
  `, workspaceId, ...files.map(file => file.relativePath))
  for (const item of removed) {
    if (item.documentId) await removeIndexedDocument(database, item.documentId)
  }

  for (const file of files) {
    progress.currentFile = file.relativePath
    publishSyncProgress(event, progress)
    try {
      await upsertWikiFile(database, workspaceId, file, event, detail => {
        progress.currentFile = `${file.relativePath} · ${detail}`
        publishSyncProgress(event, progress)
      })
      progress.completed += 1
    } catch (error) {
      progress.failed += 1
      console.warn(`[Wiki] Failed to index ${file.relativePath}:`, error)
    }
    publishSyncProgress(event, progress)
  }
  if (currentPaths.size === 0) {
    await database.run('DELETE FROM wiki_links WHERE workspace_id = ?', workspaceId)
    await database.run('DELETE FROM wiki_entities WHERE workspace_id = ?', workspaceId)
    await database.run('DELETE FROM wiki_item_sources WHERE workspace_id = ?', workspaceId)
  } else {
    progress.currentFile = '关联页面与源码依据'
    publishSyncProgress(event, progress)
    await rebuildWikiSources(database, workspaceId, rootPath)
    await rebuildWikiLinks(database, workspaceId)
    progress.currentFile = '提取正文实体关系'
    publishSyncProgress(event, progress)
    await rebuildWikiEntities(database, workspaceId)
  }
  progress.currentFile = ''
  progress.status = 'completed'
  publishSyncProgress(event, progress)
  return progress
}

function safePageName(value: string): string {
  const invalid = '<>:"/\\|?*'
  return Array.from(value.trim())
    .map(character => character.charCodeAt(0) < 32 || invalid.includes(character) ? '-' : character)
    .join('')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
}

export function registerWikiAPIs(deps: WikiDependencies): void {
  ipcMain.handle('api:wiki-get-parser-component', () => officeRuntimeManager.getDoclingStatus())
  ipcMain.handle('api:wiki-install-parser-component', event => officeRuntimeManager.installDocling({ event }))
  // Own the promise in main: every caller joins the same job, including after navigation.
  const startSync = (workspaceId: string, rootPath: string, event?: { sender: WebContents }): Promise<WikiSyncProgress> => {
    const current = syncingWorkspaces.get(workspaceId)
    if (current) return current
    const task = deps.getDB()
      .then(database => syncWorkspace(database, workspaceId, rootPath, event))
      .catch(error => {
        const previous = latestSyncByWorkspace.get(workspaceId)
        publishSyncProgress(event, {
          workspaceId, total: 0, completed: 0, failed: 0, currentFile: '', updatedAt: Date.now(),
          ...previous, status: 'failed', error: error instanceof Error ? error.message : String(error)
        })
        throw error
      })
      .finally(() => syncingWorkspaces.delete(workspaceId))
    syncingWorkspaces.set(workspaceId, task)
    return task
  }
  const ensureWorkspaceWatcher = (workspaceId: string, rootPath: string, sender?: WebContents): void => {
    const current = workspaceWatchers.get(workspaceId)
    if (current?.rootPath === rootPath) return
    current?.watcher.close()
    try {
      const state: { rootPath: string; watcher: fs.FSWatcher; timer: NodeJS.Timeout | null } = {
        rootPath,
        watcher: null as unknown as fs.FSWatcher,
        timer: null
      }
      state.watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
        const changedPath = normalizeRelativePath(String(filename || ''))
        const isClaimsChange = /^openwiki\/\.claims\//i.test(changedPath)
        if (!changedPath || changedPath.split('/').some(part => IGNORED_DIRECTORIES.has(part)
          || (part.startsWith('.') && !(isClaimsChange && part === '.claims')))) return
        if (state.timer) clearTimeout(state.timer)
        state.timer = setTimeout(() => {
          state.timer = null
          if (syncingWorkspaces.has(workspaceId)) return
          void startSync(workspaceId, rootPath, sender ? { sender } : undefined)
            .catch(error => console.warn(`[Wiki] Background sync failed for ${workspaceId}:`, error))
        }, 900)
      })
      workspaceWatchers.set(workspaceId, state)
    } catch (error) {
      console.warn(`[Wiki] File watching is unavailable for ${rootPath}:`, error)
    }
  }

  ipcMain.handle('api:wiki-list-workspaces', async () => {
    const database = await deps.getDB()
    return database.all(`
      SELECT kb.id, kb.name, kb.description, kb.root_path AS rootPath,
        kb.created_at AS createdAt, kb.updated_at AS updatedAt,
        COUNT(DISTINCT wi.id) AS itemCount,
        COUNT(DISTINCT CASE WHEN wi.item_kind = 'page' THEN wi.id END) AS pageCount
      FROM knowledge_bases kb
      LEFT JOIN wiki_items wi ON wi.workspace_id = kb.id
      WHERE COALESCE(kb.root_path, '') <> ''
      GROUP BY kb.id ORDER BY kb.updated_at DESC
    `)
  })

  ipcMain.handle('api:wiki-open-workspace', async event => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const selection = await dialog.showOpenDialog(window, {
      title: '选择 Wiki 工作区文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const rootPath = resolve(selection.filePaths[0])
    const database = await deps.getDB()
    const existing = await database.get('SELECT id FROM knowledge_bases WHERE root_path = ?', rootPath)
    if (existing?.id) {
      ensureWorkspaceWatcher(existing.id, rootPath, event.sender)
      return existing.id
    }
    const id = randomUUID()
    const now = Date.now()
    await database.run(`
      INSERT INTO knowledge_bases (id, name, description, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, id, basename(rootPath), '以本地文件夹为内容源的 Wiki 工作区', rootPath, now, now)
    ensureWorkspaceWatcher(id, rootPath, event.sender)
    return id
  })

  ipcMain.handle('api:wiki-sync-workspace', async (event, workspaceId: string) => {
    const database = await deps.getDB()
    const workspace = await database.get('SELECT root_path AS rootPath FROM knowledge_bases WHERE id = ?', workspaceId)
    const rootPath = resolve(String(workspace?.rootPath || ''))
    if (!workspace?.rootPath || !fs.existsSync(rootPath)) throw new Error('WIKI_WORKSPACE_NOT_FOUND')
    ensureWorkspaceWatcher(workspaceId, rootPath, event.sender)
    return startSync(workspaceId, rootPath, event)
  })

  ipcMain.handle('api:wiki-remove-workspace', async (_, workspaceId: string) => {
    if (syncingWorkspaces.has(workspaceId)) throw new Error('工作区正在同步，请等待完成后再移除。')
    const database = await deps.getDB()
    const watcher = workspaceWatchers.get(workspaceId)
    if (watcher?.timer) clearTimeout(watcher.timer)
    watcher?.watcher.close()
    workspaceWatchers.delete(workspaceId)
    latestSyncByWorkspace.delete(workspaceId)
    const documents = await database.all<Array<{ documentId: string }>>(`
      SELECT document_id AS documentId FROM wiki_items WHERE workspace_id = ?
    `, workspaceId)
    for (const document of documents) {
      if (document.documentId) await removeIndexedDocument(database, document.documentId)
    }
    await database.run('DELETE FROM knowledge_bases WHERE id = ?', workspaceId)
    return true
  })

  ipcMain.handle('api:wiki-get-sync-progress', (_, workspaceId: string) => {
    return latestSyncByWorkspace.get(workspaceId) || null
  })

  ipcMain.handle('api:wiki-list-items', async (_, workspaceId: string) => {
    const database = await deps.getDB()
    return database.all(`
      SELECT id, workspace_id AS workspaceId, document_id AS documentId,
        relative_path AS relativePath, absolute_path AS absolutePath, parent_path AS parentPath,
        title, item_kind AS itemKind, file_type AS fileType, editable, file_size AS fileSize,
        modified_at AS modifiedAt, updated_at AS updatedAt
      FROM wiki_items WHERE workspace_id = ? ORDER BY relative_path COLLATE NOCASE
    `, workspaceId)
  })

  ipcMain.handle('api:wiki-read-item', async (_, itemId: string) => {
    const database = await deps.getDB()
    const item = await database.get(`
      SELECT wi.id, wi.workspace_id AS workspaceId, wi.document_id AS documentId,
        wi.relative_path AS relativePath, wi.absolute_path AS absolutePath,
        wi.parent_path AS parentPath, wi.title, wi.item_kind AS itemKind,
        wi.file_type AS fileType, wi.editable, wi.file_size AS fileSize,
        kb.root_path AS rootPath
      FROM wiki_items wi JOIN knowledge_bases kb ON kb.id = wi.workspace_id WHERE wi.id = ?
    `, itemId)
    if (!item || !isWithinRoot(item.rootPath, item.absolutePath)) return null
    let content = ''
    if (item.editable) content = await fs.promises.readFile(item.absolutePath, 'utf8')
    return { ...item, content }
  })

  ipcMain.handle('api:wiki-delete-item', async (_, itemId: string) => {
    const database = await deps.getDB()
    const item = await database.get<{
      workspaceId: string; documentId: string | null; rootPath: string; absolutePath: string; relativePath: string
    }>(`
      SELECT wi.workspace_id AS workspaceId, wi.document_id AS documentId, kb.root_path AS rootPath,
        wi.absolute_path AS absolutePath, wi.relative_path AS relativePath
      FROM wiki_items wi JOIN knowledge_bases kb ON kb.id = wi.workspace_id WHERE wi.id = ?
    `, itemId)
    if (!item || !item.rootPath || !item.relativePath) throw new Error('WIKI_ITEM_NOT_FOUND')
    const rootPath = await fs.promises.realpath(item.rootPath)
    const absolutePath = resolve(rootPath, item.relativePath)
    if (!isWithinRoot(rootPath, absolutePath) || resolve(item.absolutePath) !== absolutePath) {
      throw new Error('WIKI_PATH_OUTSIDE_WORKSPACE')
    }
    const stat = await fs.promises.lstat(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink() || !isWithinRoot(rootPath, await fs.promises.realpath(absolutePath))) {
      throw new Error('WIKI_ITEM_INVALID')
    }
    await shell.trashItem(absolutePath)
    if (item.documentId) await removeIndexedDocument(database, item.documentId)
    await database.run('DELETE FROM wiki_items WHERE id = ?', itemId)
    await rebuildWikiSources(database, item.workspaceId, item.rootPath)
    await rebuildWikiLinks(database, item.workspaceId)
    await rebuildWikiEntities(database, item.workspaceId)
    return true
  })

  ipcMain.handle('api:wiki-create-page', async (event, workspaceId: string, title: string, parentPath = '') => {
    const database = await deps.getDB()
    const workspace = await database.get('SELECT root_path AS rootPath FROM knowledge_bases WHERE id = ?', workspaceId)
    const rootPath = resolve(String(workspace?.rootPath || ''))
    const pageName = safePageName(title)
    if (!workspace?.rootPath || !pageName || !fs.existsSync(rootPath)) throw new Error('WIKI_PAGE_INVALID')
    const targetDirectory = resolve(rootPath, normalizeRelativePath(parentPath))
    if (!isWithinRoot(rootPath, targetDirectory)) throw new Error('WIKI_PATH_OUTSIDE_WORKSPACE')
    await fs.promises.mkdir(targetDirectory, { recursive: true })
    let targetPath = join(targetDirectory, `${pageName}.md`)
    let suffix = 2
    while (fs.existsSync(targetPath)) targetPath = join(targetDirectory, `${pageName}-${suffix++}.md`)
    await fs.promises.writeFile(targetPath, `# ${pageName}\n\n`, 'utf8')
    const stat = await fs.promises.stat(targetPath)
    const entry: WikiFileEntry = {
      absolutePath: targetPath,
      relativePath: normalizeRelativePath(relative(rootPath, targetPath)),
      parentPath: normalizeRelativePath(relative(rootPath, dirname(targetPath))),
      fileType: 'md',
      title: pageName,
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      contentHash: await hashFile(targetPath)
    }
    const indexed = await upsertWikiFile(database, workspaceId, entry, event)
    await rebuildWikiSources(database, workspaceId, rootPath)
    await rebuildWikiLinks(database, workspaceId)
    await rebuildWikiEntities(database, workspaceId)
    return indexed.itemId
  })

  ipcMain.handle('api:wiki-save-page', async (event, itemId: string, content: string) => {
    const database = await deps.getDB()
    const item = await database.get(`
      SELECT wi.*, kb.root_path AS rootPath FROM wiki_items wi
      JOIN knowledge_bases kb ON kb.id = wi.workspace_id WHERE wi.id = ?
    `, itemId)
    if (!item || !item.editable || !isWithinRoot(item.rootPath, item.absolute_path)) {
      throw new Error('WIKI_PAGE_NOT_EDITABLE')
    }
    const normalizedContent = String(content || '').replace(/\r\n/g, '\n')
    const contentHash = createHash('sha256').update(normalizedContent, 'utf8').digest('hex')
    if (contentHash === item.content_hash) return { saved: false, itemId }
    await fs.promises.writeFile(item.absolute_path, normalizedContent, 'utf8')
    await database.run(`
      INSERT INTO wiki_revisions (id, item_id, content, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, randomUUID(), itemId, normalizedContent, contentHash, Date.now())
    const stat = await fs.promises.stat(item.absolute_path)
    const entry: WikiFileEntry = {
      absolutePath: item.absolute_path,
      relativePath: item.relative_path,
      parentPath: item.parent_path,
      fileType: item.file_type,
      title: item.title,
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      contentHash
    }
    await upsertWikiFile(database, item.workspace_id, entry, event)
    await rebuildWikiSources(database, item.workspace_id, item.rootPath)
    await rebuildWikiLinks(database, item.workspace_id)
    await rebuildWikiEntities(database, item.workspace_id)
    return { saved: true, itemId }
  })

  ipcMain.handle('api:wiki-list-revisions', async (_, itemId: string) => {
    const database = await deps.getDB()
    return database.all(`
      SELECT id, item_id AS itemId, content_hash AS contentHash, created_at AS createdAt,
        length(content) AS characterCount
      FROM wiki_revisions WHERE item_id = ? ORDER BY created_at DESC LIMIT 30
    `, itemId)
  })

  ipcMain.handle('api:wiki-read-source', async (_, workspaceId: string, resource: string) => {
    const database = await deps.getDB()
    const source = await database.get<{
      relativePath: string; startLine: number | null; endLine: number | null; rootPath: string
    }>(`
      SELECT wis.relative_path AS relativePath, wis.start_line AS startLine,
        wis.end_line AS endLine, kb.root_path AS rootPath
      FROM wiki_item_sources wis
      JOIN knowledge_bases kb ON kb.id = wis.workspace_id
      WHERE wis.workspace_id = ? AND wis.resource = ? LIMIT 1
    `, workspaceId, resource)
    if (!source?.rootPath || !source.relativePath) throw new Error('WIKI_SOURCE_NOT_FOUND')
    const rootPath = await fs.promises.realpath(source.rootPath)
    const absolutePath = resolve(rootPath, source.relativePath)
    if (!isWithinRoot(rootPath, absolutePath)) throw new Error('WIKI_SOURCE_OUTSIDE_WORKSPACE')
    const stat = await fs.promises.lstat(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('WIKI_SOURCE_UNREADABLE')
    const physicalPath = await fs.promises.realpath(absolutePath)
    if (!isWithinRoot(rootPath, physicalPath)) throw new Error('WIKI_SOURCE_OUTSIDE_WORKSPACE')
    const lines = (await fs.promises.readFile(physicalPath, 'utf8')).replace(/\r/g, '').split('\n')
    const excerptStart = source.startLine ? Math.max(1, source.startLine - 5) : 1
    const excerptEnd = source.endLine
      ? Math.min(lines.length, source.endLine + 5)
      : Math.min(lines.length, 180)
    return {
      resource,
      relativePath: source.relativePath,
      absolutePath: physicalPath,
      startLine: source.startLine,
      endLine: source.endLine,
      excerptStart,
      excerptEnd,
      totalLines: lines.length,
      truncated: excerptEnd < lines.length,
      lines: lines.slice(excerptStart - 1, excerptEnd).map((text, index) => ({ number: excerptStart + index, text }))
    }
  })

  ipcMain.handle('api:wiki-get-graph', async (_, workspaceId: string, focusItemId?: string, focusEntityId?: string): Promise<WikiGraphData> => {
    const database = await deps.getDB()
    const allItems = await database.all<WikiGraphItemRow[]>(`
      SELECT id, relative_path AS relativePath, title, item_kind AS itemKind,
        file_type AS fileType, file_size AS fileSize
      FROM wiki_items WHERE workspace_id = ? ORDER BY relative_path COLLATE NOCASE
    `, workspaceId)
    const explicitLinks = await database.all<WikiGraphLinkRow[]>(`
      SELECT id, from_item_id AS fromItemId, to_item_id AS toItemId,
        target_text AS targetText, link_type AS linkType
      FROM wiki_links WHERE workspace_id = ?
    `, workspaceId)
    const entityLinks = await database.all<WikiGraphEntityLinkRow[]>(`
      SELECT e.id AS entityId, e.name AS entityName, e.entity_type AS entityType,
        wie.item_id AS itemId, wie.mention_count AS mentionCount,
        wie.confidence, wie.evidence_json AS evidenceJson
      FROM wiki_item_entities wie
      JOIN wiki_entities e ON e.id = wie.entity_id
      WHERE e.workspace_id = ?
      ORDER BY wie.confidence DESC, wie.mention_count DESC
    `, workspaceId)
    const sourceLinks = await database.all<WikiSourceLinkRow[]>(`
      SELECT id, item_id AS itemId, resource, relative_path AS relativePath,
        start_line AS startLine, end_line AS endLine, claim_id AS claimId,
        statement, version, status
      FROM wiki_item_sources WHERE workspace_id = ?
      ORDER BY relative_path COLLATE NOCASE, start_line
    `, workspaceId)

    let selectedEntityIds = new Set<string>()
    let selectedSourcePaths = new Set<string>()
    let includedItemIds = new Set<string>()
    let focusEntityLinks: WikiGraphEntityLinkRow[] = []
    let focusSourceLinks: WikiSourceLinkRow[] = []
    const relatedScores = new Map<string, { score: number; sharedEntities: Set<string>; sharedSources: Set<string>; directLink: boolean }>()
    if (focusItemId) {
      includedItemIds.add(focusItemId)
      focusEntityLinks = entityLinks
        .filter(link => link.itemId === focusItemId)
        .sort((left, right) => (right.confidence * 4 + Math.log2(right.mentionCount + 1)) - (left.confidence * 4 + Math.log2(left.mentionCount + 1)))
        .slice(0, 18)
      selectedEntityIds = new Set(focusEntityLinks.map(link => link.entityId))
      for (const link of entityLinks) {
        if (link.itemId === focusItemId || !selectedEntityIds.has(link.entityId)) continue
        const current = relatedScores.get(link.itemId) || { score: 0, sharedEntities: new Set<string>(), sharedSources: new Set<string>(), directLink: false }
        current.score += link.confidence + Math.min(3, link.mentionCount) * 0.15
        current.sharedEntities.add(link.entityName)
        relatedScores.set(link.itemId, current)
      }
      focusSourceLinks = sourceLinks.filter(link => link.itemId === focusItemId).slice(0, 36)
      selectedSourcePaths = new Set(focusSourceLinks.map(link => link.relativePath))
      for (const link of sourceLinks) {
        if (link.itemId === focusItemId || !selectedSourcePaths.has(link.relativePath)) continue
        const current = relatedScores.get(link.itemId) || { score: 0, sharedEntities: new Set<string>(), sharedSources: new Set<string>(), directLink: false }
        current.score += 2.4
        current.sharedSources.add(link.relativePath)
        relatedScores.set(link.itemId, current)
      }
      for (const link of explicitLinks) {
        const linkedItemId = link.fromItemId === focusItemId ? link.toItemId : link.toItemId === focusItemId ? link.fromItemId : null
        if (!linkedItemId || linkedItemId === focusItemId) continue
        const current = relatedScores.get(linkedItemId) || { score: 0, sharedEntities: new Set<string>(), sharedSources: new Set<string>(), directLink: false }
        current.score += 3.2
        current.directLink = true
        relatedScores.set(linkedItemId, current)
      }
      for (const [itemId] of [...relatedScores.entries()].sort((left, right) => right[1].score - left[1].score).slice(0, 10)) {
        includedItemIds.add(itemId)
      }
    } else {
      const entityScores = new Map<string, { score: number; itemIds: Set<string> }>()
      for (const link of entityLinks) {
        const current = entityScores.get(link.entityId) || { score: 0, itemIds: new Set<string>() }
        current.score += link.confidence + Math.min(4, link.mentionCount) * 0.12
        current.itemIds.add(link.itemId)
        entityScores.set(link.entityId, current)
      }
      selectedEntityIds = new Set([...entityScores.entries()]
        .sort((left, right) => (right[1].itemIds.size * 3 + right[1].score) - (left[1].itemIds.size * 3 + left[1].score))
        .slice(0, 18)
        .map(([entityId]) => entityId))
      const itemScores = new Map<string, number>()
      for (const link of entityLinks) {
        if (!selectedEntityIds.has(link.entityId)) continue
        itemScores.set(link.itemId, (itemScores.get(link.itemId) || 0) + link.confidence)
      }
      includedItemIds = new Set([...itemScores.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 16)
        .map(([itemId]) => itemId))
      const sourceScores = new Map<string, Set<string>>()
      for (const link of sourceLinks) {
        const itemIds = sourceScores.get(link.relativePath) || new Set<string>()
        itemIds.add(link.itemId)
        sourceScores.set(link.relativePath, itemIds)
      }
      selectedSourcePaths = new Set([...sourceScores.entries()]
        .sort((left, right) => right[1].size - left[1].size)
        .slice(0, 14)
        .map(([relativePath]) => relativePath))
      const sourceItemScores = new Map<string, number>()
      for (const link of sourceLinks) {
        if (!selectedSourcePaths.has(link.relativePath)) continue
        sourceItemScores.set(link.itemId, (sourceItemScores.get(link.itemId) || 0) + 1)
      }
      for (const [itemId] of [...sourceItemScores.entries()].sort((left, right) => right[1] - left[1]).slice(0, 16)) {
        includedItemIds.add(itemId)
      }
      const linkedItemScores = new Map<string, number>()
      for (const link of explicitLinks) {
        linkedItemScores.set(link.fromItemId, (linkedItemScores.get(link.fromItemId) || 0) + 1)
        if (link.toItemId) linkedItemScores.set(link.toItemId, (linkedItemScores.get(link.toItemId) || 0) + 1)
      }
      for (const [itemId] of [...linkedItemScores.entries()].sort((left, right) => right[1] - left[1]).slice(0, 16)) {
        includedItemIds.add(itemId)
      }
    }

    // Entity exploration must include its documents even outside the overview window.
    if (focusEntityId) {
      selectedEntityIds = new Set([focusEntityId])
      includedItemIds = new Set(entityLinks.filter(link => link.entityId === focusEntityId).map(link => link.itemId))
      selectedSourcePaths = new Set(sourceLinks.filter(link => includedItemIds.has(link.itemId)).map(link => link.relativePath))
    } else if (!focusItemId) {
      if (!includedItemIds.size) includedItemIds = new Set(allItems.slice(0, 80).map(item => item.id))
    }
    const matchingItems = allItems.filter(item => includedItemIds.has(item.id))
    const items = matchingItems.slice(0, 80)
    includedItemIds = new Set(items.map(item => item.id))
    const visibleEntityLinks = entityLinks.filter(link => selectedEntityIds.has(link.entityId) && includedItemIds.has(link.itemId))
    const visibleSourceLinks = sourceLinks.filter(link => selectedSourcePaths.has(link.relativePath) && includedItemIds.has(link.itemId))
    const entityById = new Map(visibleEntityLinks.map(link => [link.entityId, link]))
    const sourceByPath = new Map(visibleSourceLinks.map(link => [link.relativePath, link]))
    const visibleExplicitLinks = explicitLinks.filter(link => link.toItemId
      && includedItemIds.has(link.fromItemId) && includedItemIds.has(link.toItemId))
    const nodes: WikiGraphData['nodes'] = [
      ...items.map(item => ({
        id: item.id,
        itemId: item.id,
        label: item.title,
        kind: item.itemKind,
        fileType: item.fileType,
        relativePath: item.relativePath,
        size: item.fileSize
      })),
      ...[...entityById.values()].map(entity => ({
        id: entity.entityId,
        itemId: null,
        label: entity.entityName,
        kind: 'entity',
        entityType: entity.entityType,
        fileType: '',
        relativePath: ''
      })),
      ...[...sourceByPath.values()].map(source => ({
        id: `source:${createHash('sha256').update(source.relativePath).digest('hex').slice(0, 24)}`,
        itemId: null,
        label: basename(source.relativePath),
        kind: 'source',
        fileType: extname(source.relativePath).slice(1).toLowerCase(),
        relativePath: source.relativePath,
        resource: source.resource
      }))
    ]
    const evidenceEdges = new Map<string, { id: string; source: string; target: string; kind: string; weight: number }>()
    for (const link of visibleSourceLinks) {
      const target = `source:${createHash('sha256').update(link.relativePath).digest('hex').slice(0, 24)}`
      const key = `${link.itemId}:${target}`
      const current = evidenceEdges.get(key)
      if (current) current.weight += 1
      else evidenceEdges.set(key, { id: `evidence:${key}`, source: link.itemId, target, kind: 'evidence', weight: 1 })
    }
    const edges = [
      ...visibleExplicitLinks.map(link => ({
        id: link.id,
        source: link.fromItemId,
        target: link.toItemId as string,
        kind: link.linkType,
        weight: 1
      })),
      ...visibleEntityLinks.map(link => ({
        id: `mention:${link.itemId}:${link.entityId}`,
        source: link.itemId,
        target: link.entityId,
        kind: 'mention',
        weight: link.mentionCount
      })),
      ...evidenceEdges.values()
    ]
    if (focusEntityId) {
      for (const link of visibleEntityLinks) {
        const item = items.find(item => item.id === link.itemId)!
        for (const [index, evidence] of parseEntityEvidence(link.evidenceJson).entries()) {
          const id = `fragment:${link.itemId}:${evidence.nodeId || index}`
          nodes.push({ id, itemId: item.id, label: evidence.title, kind: 'fragment',
            fileType: item.fileType, relativePath: item.relativePath, evidence })
          edges.push({ id: `mentions:${id}`, source: link.entityId, target: id, kind: 'mention', weight: 1 })
          edges.push({ id: `belongs:${id}`, source: id, target: item.id, kind: 'contains', weight: 1 })
        }
      }
    }
    const entities = focusEntityLinks.map(link => ({
      id: link.entityId,
      name: link.entityName,
      type: link.entityType,
      mentionCount: link.mentionCount,
      confidence: link.confidence,
      evidence: parseEntityEvidence(link.evidenceJson)
    }))
    const relatedItems = [...relatedScores.entries()]
      .sort((left, right) => right[1].score - left[1].score)
      .slice(0, 10)
      .map(([itemId, relation]) => {
        const related = allItems.find(item => item.id === itemId)
        return related ? {
          id: related.id,
          title: related.title,
          relativePath: related.relativePath,
          fileType: related.fileType,
          sharedEntities: [...relation.sharedEntities].slice(0, 5),
          sharedSources: [...relation.sharedSources].slice(0, 4),
          directLink: relation.directLink
        } : null
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    const backlinks = focusItemId
      ? explicitLinks.filter(link => link.toItemId === focusItemId)
        .map(link => allItems.find(item => item.id === link.fromItemId))
        .filter((item): item is WikiGraphItemRow => Boolean(item))
      : []
    const unresolved = focusItemId
      ? explicitLinks.filter(link => link.fromItemId === focusItemId && !link.toItemId && link.linkType === 'explicit')
      : []
    return { nodes, edges, entities, sources: focusSourceLinks, relatedItems, backlinks, unresolved, truncated: matchingItems.length > items.length }
  })
}

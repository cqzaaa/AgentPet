import { ipcMain } from 'electron'
import * as fs from 'fs'
import { join, relative } from 'path'
import {
  embedText,
  embedTexts,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embeddingContentHash
} from '../embedding/embedding-client'

export interface MemoryDependencies {
  getDB: () => Promise<any>
  getActiveChatDir: () => string
  getActiveStorageDir: () => string
  getSystemLlmConfig: () => any
  callLlmInternal: (config: any, messages: any[], storageDir: string) => Promise<string>
}

let memoryDeps: MemoryDependencies | null = null

class LRUCache<K, V> {
  private map = new Map<K, V>()
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) this.map.delete(oldestKey)
    }
    this.map.set(key, value)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  clear(): void {
    this.map.clear()
  }
}

// 已更新只读历史 Markdown 文件的内容缓存，避免重复文件 I/O 读取（LRU 限定最大 200 条）
const fileContentCache = new LRUCache<string, string>(200)

export async function appendMemorySummaryInternal(sessionId: string, title: string, content: string): Promise<boolean> {
  if (!memoryDeps) {
    console.error('[Memory] memoryDeps 尚未初始化')
    return false
  }
  try {
    if (!sessionId || !title || !content) return false
    const chatDir = memoryDeps.getActiveChatDir()
    const storageDir = memoryDeps.getActiveStorageDir()
    const safeSessionId = sessionId.replace(/[<>:"/\\|?*]/g, '_')
    const sessionMemoryDir = join(storageDir, 'memory', safeSessionId)
    
    if (!fs.existsSync(sessionMemoryDir)) {
      await fs.promises.mkdir(sessionMemoryDir, { recursive: true })
    }

    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hour = String(now.getHours()).padStart(2, '0')
    const minute = String(now.getMinutes()).padStart(2, '0')
    const second = String(now.getSeconds()).padStart(2, '0')
    const ms = String(now.getMilliseconds()).padStart(3, '0')
    
    // 生成带具体时间戳的唯一文件名，避免任务同名累加
    const timeSuffix = `${year}${month}${day}_${hour}${minute}${second}_${ms}`
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_')
    const fileName = `${safeTitle}_${timeSuffix}.md`
    const filePath = join(sessionMemoryDir, fileName)

    // 扫描关联缓存 .agentpet_cache
    const cacheDir = join(chatDir, safeSessionId, '.agentpet_cache')
    const relatedCaches: string[] = []
    if (fs.existsSync(cacheDir)) {
      try {
        const cacheFiles = await fs.promises.readdir(cacheDir)
        const nowTime = Date.now()
        for (const file of cacheFiles) {
          const cacheFilePath = join(cacheDir, file)
          const stat = await fs.promises.stat(cacheFilePath)
          const isMentioned = content.includes(file)
          const isRecent = (nowTime - stat.mtimeMs) < 30 * 60 * 1000 // 30分钟内
          
          if (isMentioned || isRecent) {
            const relPath = relative(chatDir, cacheFilePath).replace(/\\/g, '/')
            relatedCaches.push(relPath)
          }
        }
      } catch (err) {
        console.error('[Memory] 扫描 .agentpet_cache 失败:', err)
      }
    }

    const timeStr = now.toLocaleString('zh-CN', { hour12: false })
    const metaHeader = `<!-- 元数据\n记录时间: ${timeStr}\n会话ID: ${sessionId}\n-->\n\n`
    
    let linkSection = ''
    if (relatedCaches.length > 0) {
      const mentionedList: string[] = []

      for (const relPath of relatedCaches) {
        const fileName = relPath.split('/').pop() || relPath
        const absPath = join(chatDir, relPath).replace(/\\/g, '/')
        
        if (content.includes(fileName) || content.includes(relPath)) {
          mentionedList.push(`* 显式引用了本地缓存文档：[\`${relPath}\`](file:///${absPath})`)
        }
      }
      
      if (mentionedList.length > 0) {
        linkSection += '\n\n---\n### 🔗 关联缓存引用\n'
        linkSection += mentionedList.join('\n') + '\n\n'
      }
    }

    // 直接新建独立文件写入，不再累加旧文件
    await fs.promises.writeFile(filePath, metaHeader + content + linkSection + '\n\n', 'utf-8')
    console.log(`[Memory] 成功创建独立主题记忆文件: ${filePath}`)

    // 自动在后台异步触发 Pipeline 进行提纯整理，使新生成的记忆即时生效入库
    runPurifyMemoryPipeline(sessionId).catch(err => console.error('[Memory] 后台经验提纯失败:', err))
    
    return true
  } catch (e) {
    console.error('[Memory] 写入独立主题记忆失败', e)
    return false
  }
}

function parseMemoryEmbedding(value: unknown): number[] | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed) || parsed.length !== EMBEDDING_DIMENSIONS) return null
    const vector = parsed.map(Number)
    return vector.every(Number.isFinite) ? vector : null
  } catch {
    return null
  }
}

async function ensureMemoryEmbeddings(database: any, rows: any[]): Promise<void> {
  // Incremental backfill prevents a large legacy memory library from blocking one recall.
  const pending = rows.filter(row => !parseMemoryEmbedding(row.embedding)).slice(0, 64)
  for (let offset = 0; offset < pending.length; offset += 16) {
    const batch = pending.slice(offset, offset + 16)
    const vectors = await embedTexts(batch.map(row => String(row.fact || '').slice(0, 24_000)))
    for (let index = 0; index < batch.length; index++) {
      const vector = vectors[index]
      if (!vector) continue
      const row = batch[index]
      const hash = embeddingContentHash(String(row.fact || ''))
      await database.run(`
        UPDATE persona_memories
        SET embedding = ?, embedding_model = ?, embedding_hash = ?
        WHERE id = ?
      `, JSON.stringify(vector), EMBEDDING_MODEL, hash, row.id)
      row.embedding = JSON.stringify(vector)
      row.embedding_model = EMBEDDING_MODEL
      row.embedding_hash = hash
    }
  }
}

export function registerMemoryAPIs(deps: MemoryDependencies) {
  memoryDeps = deps

  // 追加写入每日 Markdown 摘要（用会话文件夹进行隔离）
  ipcMain.handle('api:append-memory-summary', async (_, sessionId: string, titleOrContent: string, maybeContent?: string) => {
    let title = '未命名主题'
    let content = titleOrContent
    if (maybeContent !== undefined) {
      title = titleOrContent
      content = maybeContent
    }
    return appendMemorySummaryInternal(sessionId, title, content)
  })

  // 获取顶级全局画像 profile.md
  ipcMain.handle('api:get-memory-profile', async () => {
    try {
      const filePath = join(deps.getActiveStorageDir(), 'memory', 'profile.md')
      if (fs.existsSync(filePath)) {
        return await fs.promises.readFile(filePath, 'utf-8')
      }
      return ''
    } catch (e) {
      console.error('读取 profile.md 失败', e)
      return ''
    }
  })

  // 覆盖写入顶级全局画像 profile.md
  ipcMain.handle('api:write-memory-profile', async (_, text: string) => {
    try {
      const dirPath = join(deps.getActiveStorageDir(), 'memory')
      if (!fs.existsSync(dirPath)) {
        await fs.promises.mkdir(dirPath, { recursive: true })
      }
      const filePath = join(dirPath, 'profile.md')
      await fs.promises.writeFile(filePath, text, 'utf-8')
      return true
    } catch (e) {
      console.error('写入 profile.md 失败', e)
      return false
    }
  })

  ipcMain.handle('api:purify-memory-pipeline', async (_, sessionId?: string) => {
    return runPurifyMemoryPipeline(sessionId)
  })

  // 第四层：多路混合检索召回相关避坑经验与个人偏好 (仿 SAG 本地 SQL 动态图关联 RAG 架构)
  ipcMain.handle('api:recall-experiences', async (_, queryText: string) => {
    try {
      if (!queryText || !queryText.trim()) return []
      const database = await deps.getDB()
      
      // 1. 获取库中所有关联记录及实体映射（支持经验、习惯和偏好）
      const rows = await database.all("SELECT id, fact, strength, last_accessed_at, created_at, keywords, category, link, embedding, embedding_model, embedding_hash FROM persona_memories WHERE category IN ('experience', 'habit', 'preference')") as any[]
      if (rows.length === 0) return []
      await ensureMemoryEmbeddings(database, rows)
      const queryEmbedding = await getEmbeddingInternal(deps.getSystemLlmConfig(), queryText)

      const linkRows = await database.all(`
        SELECT memory_id, entity_name, entity_type, confidence
        FROM memory_entity_links
        WHERE entity_type IN ('person', 'work', 'program', 'organization', 'product', 'location')
          AND confidence >= 0.75
      `) as { memory_id: string, entity_name: string, entity_type: string, confidence: number }[]
      
      // 构建每个记忆与其包含的实体的映射 Map<memoryId, Set<entityName>>
      const memoryToEntities = new Map<string, Set<string>>()
      linkRows.forEach(link => {
        const memId = link.memory_id
        if (!memoryToEntities.has(memId)) {
          memoryToEntities.set(memId, new Set())
        }
        memoryToEntities.get(memId)!.add(link.entity_name.toLowerCase().trim())
      })

      // 2. 一阶激活实体提取：寻找出现在用户提问中的实体词
      const uniqueEntities = new Set(linkRows.map(r => r.entity_name.toLowerCase().trim()))
      const lowerQuery = queryText.toLowerCase()
      const firstOrderActive = new Set<string>()
      uniqueEntities.forEach(ent => {
        if (queryContainsEntity(lowerQuery, ent)) {
          firstOrderActive.add(ent)
        }
      })

      // 3. 动态二阶实体联想 (多跳联想)
      const secondOrderActive = new Set<string>()
      if (firstOrderActive.size > 0) {
        // A. 找出包含任意一阶实体词的所有直接相关记忆 (一阶记忆)
        const firstOrderMemories = new Set<string>()
        memoryToEntities.forEach((entitiesSet, memId) => {
          for (const ent of firstOrderActive) {
            if (entitiesSet.has(ent)) {
              firstOrderMemories.add(memId)
              break
            }
          }
        })

        // B. 找出这些一阶记忆关联的、不属于一阶激活实体的其它实体作为二阶实体
        const secondOrderCounts = new Map<string, number>()
        firstOrderMemories.forEach(memId => {
          const entitiesSet = memoryToEntities.get(memId)
          if (entitiesSet) {
            entitiesSet.forEach(ent => {
              if (!firstOrderActive.has(ent)) {
                secondOrderCounts.set(ent, (secondOrderCounts.get(ent) || 0) + 1)
              }
            })
          }
        })
        ;[...secondOrderCounts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 10)
          .forEach(([entity]) => secondOrderActive.add(entity))
      }

      // Score the complete local corpus. The previous if/else structure sent
      // embedding-enabled queries through a raw-strength top-100 cutoff, which
      // excluded newer exact matches before lexical/vector scoring.
      const candidateRows = rows

      const now = Date.now()
      // Pure-local retrieval is driven by lexical evidence. Graph links can only
      // expand a candidate after its text has established a topic anchor.
      const queryTerms = extractRetrievalTerms(queryText)
      const documentFrequency = new Map<string, number>()
      for (const row of rows) {
        const rowTerms = new Set(extractRetrievalTerms(row.fact || ''))
        for (const term of queryTerms) {
          if (rowTerms.has(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1)
        }
      }
      const totalIdf = [...queryTerms].reduce(
        (total, term) => total + inverseDocumentFrequency(rows.length, documentFrequency.get(term) || 0),
        0
      )
      const lexicalMatch = (fact: string) => {
        const factTerms = new Set(extractRetrievalTerms(fact))
        const matches = [...queryTerms].filter(term => factTerms.has(term))
        const weightedMatch = matches.reduce(
          (total, term) => total + inverseDocumentFrequency(rows.length, documentFrequency.get(term) || 0),
          0
        )
        const nonNumericMatches = matches.filter(term => !/^\d+$/.test(term))
        return {
          score: totalIdf > 0 ? weightedMatch / totalIdf : 0,
          grounded: nonNumericMatches.length >= 2 || nonNumericMatches.some(term => term.length >= 4)
        }
      }

      const scoredResults = candidateRows.map(row => {
        // A. 指数时间衰退实际强度 (S_now)
        const lastAccess = row.last_accessed_at || row.created_at || now
        const deltaDays = (now - lastAccess) / (1000 * 60 * 60 * 24)
        const sNow = Math.max(0, row.strength * Math.exp(-0.1 * deltaDays))

        // 过滤深度遗忘的知识 (强度小于 0.2)
        if (sNow < 0.2) {
          return { ...row, sNow, score: 0 }
        }

        // B. 动态实体图谱匹配得分 (Graph Score，仿 SAG 核心逻辑)
        let graphScore = 0
        const rowEntities = memoryToEntities.get(row.id)
        if (rowEntities && firstOrderActive.size > 0) {
          let hasFirstOrder = false
          let hasSecondOrder = false
          
          for (const ent of rowEntities) {
            if (firstOrderActive.has(ent)) {
              hasFirstOrder = true
              break
            }
            if (secondOrderActive.has(ent)) {
              hasSecondOrder = true
            }
          }

          if (hasFirstOrder) {
            graphScore = 1.0 // 直接一阶相关
          } else if (hasSecondOrder) {
            graphScore = 0.5 // 间接二阶关联相关 (实现多跳召回)
          }
        }

        // C. BGE-M3 semantic similarity.
        const storedEmbedding = parseMemoryEmbedding(row.embedding)
        const vectorScore = queryEmbedding && storedEmbedding
          ? cosineSimilarity(queryEmbedding, storedEmbedding)
          : 0

        // D. 纯本地文本 Jaccard 相似度匹配分 (Jaccard Score)
        const lexical = lexicalMatch(row.fact || '')

        // E. 融合计算综合打分
        // Text evidence is primary. A graph hit without a lexical topic anchor
        // is ignored, so broad terms cannot independently trigger recall.
        const graphContribution = lexical.grounded ? graphScore : 0
        const score = 0.55 * lexical.score + 0.25 * vectorScore + 0.1 * graphContribution + 0.1 * sNow

        return {
          id: row.id,
          fact: row.fact,
          link: row.link,
          sNow,
          vectorScore,
          graphScore,
          jaccardScore: lexical.score,
          score
        }
      })

      // Filter weak fused candidates, then sort by RRF score.
      const lexicalRank = scoredResults.filter(r => r.jaccardScore > 0)
        .sort((a, b) => b.jaccardScore - a.jaccardScore)
      const vectorRank = scoredResults.filter(r => r.vectorScore >= 0.42)
        .sort((a, b) => b.vectorScore - a.vectorScore)
      const graphRank = scoredResults.filter(r => r.graphScore > 0)
        .sort((a, b) => b.graphScore - a.graphScore)
      const rrfScores = new Map<string, number>()
      const addRrf = (ranked: typeof scoredResults) => ranked.slice(0, 100).forEach((item, index) => {
        rrfScores.set(item.id, (rrfScores.get(item.id) || 0) + 1 / (60 + index + 1))
      })
      addRrf(lexicalRank)
      addRrf(vectorRank)
      addRrf(graphRank)
      const maxRrf = 3 / 61
      for (const item of scoredResults) {
        const fused = (rrfScores.get(item.id) || 0) / maxRrf
        item.score = fused * 0.9 + Math.min(1, item.sNow) * 0.1
      }

      const activeResults = scoredResults.filter(r =>
        r.sNow >= 0.2
        && r.score > 0.12
        && (r.jaccardScore > 0 || r.vectorScore >= 0.42 || r.graphScore > 0)
      )
      activeResults.sort((a, b) => b.score - a.score)
      const top3 = activeResults.slice(0, 3)

      // 异步读取关联的总结 markdown 文件内容
      const chatDir = deps.getActiveChatDir()
      const finalTop3 = await Promise.all(top3.map(async (item, index) => {
        let relatedContent = ''
        let absolutePath = ''
        
        // 性能微调：仅物理读取并提取最相关 Top 1 的关联文件内容
        // Top 2 与 Top 3 仅保留事实说明 (fact)，但依旧返回 absolutePath，允许模型在需要时调用 read_file 访问
        if (item.link && index === 0) {
          // 对关联路径去重，且只读取最近（最后追加）的最多 2 个不同的文件，其余仅作为链接返回
          const paths: string[] = Array.from(new Set((item.link as string).split(',').map((p: string) => p.trim()).filter((p: string) => p.length > 0)))
          const pathsToRead = paths.slice(-2)
          
          for (const rawPath of pathsToRead) {
            let targetPath: string = rawPath
            // 兼容相对路径：如果是相对路径，则使用 chatDir 定位
            if (!targetPath.includes(':') && !targetPath.startsWith('/') && !targetPath.startsWith('\\')) {
              targetPath = join(chatDir, targetPath)
            }
            
            let fileToRead: string = targetPath
            
            // 检查缓存
            if (fileContentCache.has(fileToRead)) {
              relatedContent += (relatedContent ? '\n\n' : '') + fileContentCache.get(fileToRead)
              absolutePath = fileToRead.replace(/\\/g, '/')
              continue
            }
            
            let exists = await fs.promises.access(fileToRead).then(() => true).catch(() => false)
            if (!exists && fileToRead.toLowerCase().endsWith('.md')) {
              const updatedPath = fileToRead.replace(/\.md$/i, '_已更新.md')
              if (fileContentCache.has(updatedPath)) {
                relatedContent += (relatedContent ? '\n\n' : '') + fileContentCache.get(updatedPath)
                absolutePath = updatedPath.replace(/\\/g, '/')
                continue
              }
              if (await fs.promises.access(updatedPath).then(() => true).catch(() => false)) {
                fileToRead = updatedPath
                exists = true
              }
            }
            
            if (exists) {
              try {
                const text = await fs.promises.readFile(fileToRead, 'utf-8')
                const sliceText = text.length > 8000 ? text.slice(0, 8000) + '\n...(内容过长已截断)...' : text
                fileContentCache.set(fileToRead, sliceText)
                relatedContent += (relatedContent ? '\n\n' : '') + sliceText
                absolutePath = fileToRead.replace(/\\/g, '/')
              } catch (readErr) {
                console.error(`[Recall] 读取关联记忆文件失败: ${fileToRead}`, readErr)
              }
            }
          }
        }
        
        return {
          ...item,
          relatedContent: relatedContent || undefined,
          absolutePath: absolutePath || undefined
        }
      }))

      console.log(`[Recall] 仿 SAG 多跳召回了 ${finalTop3.length} 条相关经验:`, finalTop3.map(t => `${t.fact.substring(0, 30)}... (score: ${t.score.toFixed(3)})`))
      return {
        results: finalTop3,
        debug: {
          selectedIds: finalTop3.map(item => item.id),
          firstOrderActive: Array.from(firstOrderActive),
          secondOrderActive: Array.from(secondOrderActive),
          allScored: scoredResults
            .filter(r => r.score > 0.01)
            .sort((a, b) => b.score - a.score)
            .map(r => ({
              id: r.id,
              fact: r.fact,
              score: r.score,
              vectorScore: r.vectorScore || 0,
              graphScore: r.graphScore || 0,
              jaccardScore: r.jaccardScore || 0,
              sNow: r.sNow || 0
            }))
        }
      }
    } catch (err) {
      console.error('召回经验失败', err)
      return []
    }
  })

  // 强化被大模型复习的经验（重置强度）
  ipcMain.handle('api:strengthen-experiences', async (_, ids: string[]) => {
    try {
      if (!Array.isArray(ids) || ids.length === 0) return true
      const database = await deps.getDB()
      const now = Date.now()
      await database.run('BEGIN TRANSACTION')
      try {
        for (const id of ids) {
          await database.run("UPDATE persona_memories SET strength = 1.0, last_accessed_at = ? WHERE id = ?", now, id)
        }
        await database.run('COMMIT')
      } catch (txErr) {
        await database.run('ROLLBACK')
        throw txErr
      }
      console.log(`[Recall] 成功强化复习了记忆: ${ids.join(', ')}`)
      return true
    } catch (err) {
      console.error('强化记忆失败', err)
      return false
    }
  })
}

// 计算两个向量的余弦相似度
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// 获取文本的 Embedding 向量（已禁用云端 API，始终返回 null，走纯文本+图谱匹配）
async function getEmbeddingInternal(
  _config: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
  },
  text: string
): Promise<number[] | null> {
  return embedText(text)
}

// Keywords and n-grams belong to lexical retrieval, not the entity graph.
// Keep only explicitly typed, high-confidence named entities.
async function repairMemoryEntityLinks(db: any) {
  try {
    await db.run(`
      DELETE FROM memory_entity_links
      WHERE entity_type NOT IN ('person', 'work', 'program', 'organization', 'product', 'location')
         OR confidence < 0.75
         OR length(trim(entity_name)) < 2
         OR length(trim(entity_name)) > 80
         OR lower(trim(entity_name)) IN (
           'id', 'web_search', 'web_fetch', 'read_file', 'write_file',
           'get-current-date', 'debug', 'workflow', 'tool'
         )
    `)
  } catch (migrationErr) {
    console.error('[Migration] 清理无效记忆实体关系失败:', migrationErr)
  }
}

type LocalMemoryFact = {
  fact: string
  keywords: string[]
  entities: MemoryEntity[]
  category: 'experience'
}

type MemoryEntity = {
  name: string
  type: 'person' | 'work' | 'program' | 'organization' | 'product' | 'location'
  confidence: number
}

const MEMORY_ENTITY_TYPES = new Set<MemoryEntity['type']>([
  'person', 'work', 'program', 'organization', 'product', 'location'
])

const BLOCKED_MEMORY_ENTITY_NAMES = new Set([
  'id', 'web_search', 'web_fetch', 'read_file', 'write_file',
  'get-current-date', 'debug', 'workflow', 'tool'
])

function normalizeMemoryEntities(value: unknown): MemoryEntity[] {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, MemoryEntity>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const raw = candidate as { name?: unknown, type?: unknown, confidence?: unknown }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase().trim() : ''
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0
    if (name.length < 2 || name.length > 80 || !MEMORY_ENTITY_TYPES.has(type as MemoryEntity['type'])) continue
    if (BLOCKED_MEMORY_ENTITY_NAMES.has(name.toLowerCase())) continue
    if (!Number.isFinite(confidence) || confidence < 0.75 || confidence > 1) continue
    const entity = { name, type: type as MemoryEntity['type'], confidence }
    const existing = unique.get(`${entity.type}:${entity.name.toLowerCase()}`)
    if (!existing || existing.confidence < entity.confidence) unique.set(`${entity.type}:${entity.name.toLowerCase()}`, entity)
  }
  return [...unique.values()]
}

const LOCAL_MEMORY_SECTIONS = [
  '可复用经验',
  '错误与恢复',
  '任务结果',
  '关键变更与证据'
]

function normalizeMemoryFact(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#\[\](){}]/g, '')
    .replace(/[\s，。；：、,.!?！？:;"'“”‘’/\\|-]+/g, '')
    .trim()
}

/**
 * Local, language-agnostic lexical terms. Chinese is represented by overlapping
 * 2–4 character phrases; Latin words and numbers remain intact.
 */
function extractRetrievalTerms(value: string): Set<string> {
  const terms = new Set<string>()
  const normalized = value.toLowerCase()
  for (const match of normalized.matchAll(/[a-z][a-z0-9_.-]{1,31}|\d{2,}/g)) {
    terms.add(match[0])
  }
  for (const match of normalized.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const sequence = match[0]
    for (let size = 2; size <= Math.min(3, sequence.length); size++) {
      for (let index = 0; index <= sequence.length - size; index++) {
        terms.add(sequence.slice(index, index + size))
      }
    }
  }
  return terms
}

function inverseDocumentFrequency(documentCount: number, documentFrequency: number): number {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

function queryContainsEntity(normalizedQuery: string, normalizedEntity: string): boolean {
  if (!normalizedEntity) return false
  if (/[㐀-鿿]/.test(normalizedEntity)) {
    return normalizedQuery.includes(normalizedEntity)
  }
  const escaped = normalizedEntity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(normalizedQuery)
}

function extractLocalKeywords(text: string): string[] {
  const keywords = new Set<string>()
  const sanitizedText = text
    .replace(/[A-Za-z]:[\\/][^\s）)]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
  const stopWords = new Set([
    '成功', '完成', '任务', '用户', '助手', '系统', '当前', '已经', '进行', '需要',
    '可以', '通过', '使用', '相关', '结果', '文件', '内容', '这个', '以及', '一个'
  ])

  for (const match of sanitizedText.matchAll(/[A-Za-z][A-Za-z0-9_.:/-]{1,31}/g)) {
    const value = match[0].replace(/[.,:;/]+$/g, '')
    if (value.length >= 2) keywords.add(value)
  }

  for (const match of sanitizedText.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const sequence = match[0]
    if (sequence.length <= 10 && !stopWords.has(sequence)) keywords.add(sequence)
    for (const size of [3, 2]) {
      for (let index = 0; index <= sequence.length - size; index++) {
        const value = sequence.slice(index, index + size)
        if (!stopWords.has(value)) keywords.add(value)
        if (keywords.size >= 30) break
      }
      if (keywords.size >= 30) break
    }
    if (keywords.size >= 30) break
  }

  return [...keywords].slice(0, 30)
}

function extractLocalMemoryFacts(title: string, markdown: string): LocalMemoryFact[] {
  const withoutBackup = markdown
    .replace(/<details>[\s\S]*?<\/details>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
  const candidates: Array<{ section: string; text: string; priority: number }> = []
  let activeSection = ''

  for (const rawLine of withoutBackup.split(/\r?\n/)) {
    const heading = /^#{2,4}\s+(.+)$/.exec(rawLine.trim())
    if (heading) {
      activeSection = LOCAL_MEMORY_SECTIONS.find(section => heading[1].includes(section)) || ''
      continue
    }
    if (!activeSection) continue

    const text = rawLine
      .trim()
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .replace(/\[([^\]]+)\]\(<[^>]+>\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 8 || /^[-—]+$/.test(text)) continue
    if (activeSection === '错误与恢复' && /^(?:无|未)(?:错误|异常|失败|发生错误)/.test(text)) continue
    const priority = activeSection === '错误与恢复' || activeSection === '可复用经验'
      ? 0
      : activeSection === '任务结果'
        ? 1
        : 2
    candidates.push({ section: activeSection, text: text.slice(0, 260), priority })
  }

  if (candidates.length === 0) {
    const fallback = withoutBackup
      .split(/\r?\n/)
      .map(line => line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim())
      .find(line => line.length >= 12 && !line.startsWith('记录时间') && !line.startsWith('会话ID'))
    if (fallback) candidates.push({ section: '任务结果', text: fallback.slice(0, 260), priority: 1 })
  }

  const seen = new Set<string>()
  return candidates
    .sort((left, right) => left.priority - right.priority)
    .filter(candidate => {
      const normalized = normalizeMemoryFact(candidate.text)
      if (!normalized || seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
    .slice(0, 5)
    .map(candidate => {
      const fact = `${candidate.section}：${candidate.text}`
      return {
        fact,
        keywords: extractLocalKeywords(`${title} ${fact}`),
        entities: [],
        category: 'experience' as const
      }
    })
}

async function upsertLocalMemoryFacts(
  database: any,
  facts: LocalMemoryFact[],
  sourcePath: string
): Promise<number> {
  const existingRows = await database.all(
    "SELECT id, fact, link FROM persona_memories WHERE category = 'experience'"
  ) as Array<{ id: string; fact: string; link?: string }>
  let insertCount = 0

  for (const item of facts) {
    const normalized = normalizeMemoryFact(item.fact)
    const matched = existingRows.find(row => normalizeMemoryFact(row.fact) === normalized)
    const now = Date.now()
    const targetId = matched?.id || `exp_${now}_${Math.random().toString(36).slice(2, 7)}`
    const links = new Set((matched?.link || '').split(',').map(value => value.trim()).filter(Boolean))
    links.add(sourcePath.replace(/\\/g, '/'))
    const link = [...links].join(', ')

    if (matched) {
      await database.run(
        'UPDATE persona_memories SET strength = MIN(1.0, strength + 0.2), last_accessed_at = ?, keywords = ?, link = ? WHERE id = ?',
        now,
        JSON.stringify(item.keywords),
        link,
        targetId
      )
    } else {
      await database.run(`
        INSERT INTO persona_memories (id, fact, strength, last_accessed_at, created_at, category, keywords, embedding, link)
        VALUES (?, ?, 1.0, ?, ?, 'experience', ?, NULL, ?)
      `, targetId, item.fact, now, now, JSON.stringify(item.keywords), link)
      existingRows.push({ id: targetId, fact: item.fact, link })
      insertCount++
    }

    await database.run('DELETE FROM memory_entity_links WHERE memory_id = ?', targetId)
    for (const entity of item.entities) {
      await database.run(
        'INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_name, entity_type, confidence, created_at) VALUES (?, ?, ?, ?, ?)',
        targetId,
        entity.name,
        entity.type,
        entity.confidence,
        now
      )
    }
  }
  return insertCount
}

// 第三层：系统内置画像整理与避坑经验沉淀的后台 pipeline
export async function runPurifyMemoryPipeline(targetSessionId?: string) {
  if (!memoryDeps) {
    console.warn('[Purify] memoryDeps 未初始化，跳过后台整理')
    return { success: false, count: 0, insertCount: 0 }
  }
  const { getDB, getActiveStorageDir, getSystemLlmConfig, callLlmInternal } = memoryDeps

  try {
    const database = await getDB()
    
    let sessions: { id: string; name: string }[] = []
    if (targetSessionId) {
      sessions = await database.all('SELECT id, name FROM sessions WHERE id = ?', targetSessionId) as { id: string; name: string }[]
      console.log(`[Purify] 针对单会话启动增量提纯, 会话ID: ${targetSessionId}`)
    } else {
      sessions = await database.all('SELECT id, name FROM sessions') as { id: string; name: string }[]
      console.log('[Purify] 针对全量会话启动全局提纯')
    }
    
    let allSummariesCombined = ''
    const processedFiles: string[] = []
    const pendingSummaries: Array<{ filePath: string; title: string; content: string }> = []

    for (const sess of sessions) {
      const safeSessionId = sess.id.replace(/[<>:"/\\|?*]/g, '_')
      const sessionMemoryDir = join(getActiveStorageDir(), 'memory', safeSessionId)
      if (!fs.existsSync(sessionMemoryDir)) continue

      const files = await fs.promises.readdir(sessionMemoryDir)
      for (const file of files) {
        if (file.endsWith('.md') && !file.endsWith('_已更新.md') && file !== 'profile.md') {
          const filePath = join(sessionMemoryDir, file)
          try {
            const content = await fs.promises.readFile(filePath, 'utf-8')
            allSummariesCombined += `\n### 会话: ${sess.name} (文件: ${file.replace(/\.md$/i, '')})\n${content}\n`
            processedFiles.push(filePath)
            pendingSummaries.push({
              filePath,
              title: file.replace(/_\d{8}_\d{6}_\d{3}\.md$/i, '').replace(/\.md$/i, ''),
              content
            })
          } catch (e) {
            console.error(`读取会话主目录文件失败: ${filePath}`, e)
          }
        }
      }
    }

    // 2. 提取技术事实、报错经验与生活习惯偏好，写入 persona_memories
    let insertCount = 0
    if (!targetSessionId) {
      const experienceSystemPrompt = `你是一个核心知识提炼与个人习惯偏好沉淀专家。请分析主人最近的对话摘要，从中提纯并总结出以下三类结构化记忆事实与偏好：
1. 【技术核心与源码要点】：例如源码结构解读要点、业务逻辑核心细节、系统架构设计决策等（分类 category 归入 "experience"）。
2. 【避坑纠错与工具经验】：例如工具执行失败/报错原因、排卡调试经验、环境兼容性问题及具体的避坑防线（分类 category 归入 "experience"）。
3. 【个人喜好与生活习惯】：例如主人平时喜欢什么类型的音乐或运动（喜好）、主人的作息或工作时间安排、特定的沟通偏好（如"喜欢直接看代码而非冗长解释"）（分类 category 归入 "preference" 或 "habit"）。

对于每一条沉淀事实，你必须输出为 JSON 格式的数组。格式如下：
[
  {
    "fact": "简明扼要的事实、习惯或喜好描述（例如：'React 18 并发渲染的核心是...'，或 '主人非常喜欢听民谣和古典音乐'，或 '主人习惯在每天早上 9 点查看服务器运行日志'）",
    "keywords": ["React", "Scheduler"] 或 ["民谣", "古典音乐", "喜好"] 或 ["服务器日志", "查看习惯"],
    "category": "experience" 或 "preference" 或 "habit"
  }
]
如果你没有发现任何有价值的事实、习惯或喜好，请直接输出空数组 []。
请不要输出任何 Markdown 标记或多余的解释，只输出合法的 JSON 数组本身。`

      const experienceMessages = [
        { role: 'system', content: experienceSystemPrompt },
        {
          role: 'system',
          content: 'For every memory item, also return an "entities" array. Each entry must be {"name":"...","type":"person|work|program|organization|product|location","confidence":0.0-1.0}. Include only concrete named entities with confidence >= 0.75. Do not include topics, dates, years, recency words, rankings, statuses, actions, tool names, or generic descriptive keywords as entities.'
        },
        { role: 'user', content: `【最近收集的对话摘要历史】\n${allSummariesCombined}\n\n请从中提取有价值的避坑经验、技术事实、生活喜好或习惯并输出为 JSON 数组。` }
      ]

      console.log('[Purify] 正在调用大模型提炼避坑经验与个人偏好...')
      const experienceRawJson = await callLlmInternal(getSystemLlmConfig(), experienceMessages, getActiveStorageDir())
      
      let jsonText = experienceRawJson.trim()
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(json)?/, '').replace(/```$/, '').trim()
      }
      
      let experiences: any[] = []
      let extractionSucceeded = false
      try {
        const parsed = JSON.parse(jsonText)
        experiences = Array.isArray(parsed) ? parsed : []
        extractionSucceeded = experiences.some(item => item && typeof item.fact === 'string' && item.fact.trim())
      } catch (je) {
        console.error('[Purify] 解析避坑经验 JSON 失败, raw response:', experienceRawJson, je)
      }

      if (Array.isArray(experiences) && experiences.length > 0) {
        for (const item of experiences) {
          if (!item.fact) continue
          const entities = normalizeMemoryEntities(item.entities)
          
          let emb: number[] | null = null
          try {
            emb = await getEmbeddingInternal(getSystemLlmConfig(), item.fact)
          } catch (ee) {
            console.error('[Purify] 获取向量失败', ee)
          }

          // 查询是否有相似的已有经验/喜好事实（不限分类）
          const rows = await database.all("SELECT id, fact, embedding FROM persona_memories WHERE category IN ('experience', 'habit', 'preference')") as any[]
          
          let matchedId: string | null = null
          if (emb && rows.length > 0) {
            for (const row of rows) {
              if (row.embedding) {
                try {
                  const dbEmb = JSON.parse(row.embedding)
                  if (Array.isArray(dbEmb)) {
                    const sim = cosineSimilarity(emb, dbEmb)
                    if (sim > 0.88) {
                      matchedId = row.id
                      break
                    }
                  }
                } catch {}
              }
            }
          }

          if (!matchedId) {
            const exactMatch = rows.find(r => r.fact.trim() === item.fact.trim())
            if (exactMatch) {
              matchedId = exactMatch.id
            }
          }

          const now = Date.now()
          const targetId = matchedId || `exp_${now}_${Math.random().toString(36).substring(2, 7)}`
          
          const linkPath = processedFiles.map(fp => fp.replace(/\\/g, '/')).join(', ')

          const categoryVal = (item.category === 'habit' || item.category === 'preference') ? item.category : 'experience'

          if (matchedId) {
            await database.run("UPDATE persona_memories SET strength = MIN(1.0, strength + 0.3), last_accessed_at = ?, link = ? WHERE id = ?", now, linkPath, matchedId)
            console.log(`[Purify] 强化已有记忆事实 (ID: ${matchedId}, 分类: ${categoryVal})`)
          } else {
            await database.run(`
              INSERT INTO persona_memories (id, fact, strength, last_accessed_at, created_at, category, keywords, embedding, link)
              VALUES (?, ?, 1.0, ?, ?, ?, ?, ?, ?)
            `,
              targetId,
              item.fact,
              now,
              now,
              categoryVal,
              JSON.stringify(item.keywords || []),
              emb ? JSON.stringify(emb) : null,
              linkPath
            )
            insertCount++
            console.log(`[Purify] 写入新记忆事实 (ID: ${targetId}, 分类: ${categoryVal}): ${item.fact}`)
          }

          // 仿 SAG 机制：写入实体多对多关联关系图谱
          try {
            // 先清理旧有的实体绑定，以防大模型更新时实体关键词发生变更
            await database.run("DELETE FROM memory_entity_links WHERE memory_id = ?", targetId)

            if (entities.length > 0) {
              for (const entity of entities) {
                await database.run(
                  "INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_name, entity_type, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
                  targetId,
                  entity.name,
                  entity.type,
                  entity.confidence,
                  now
                )
              }
            }
          } catch (linkErr) {
            console.error(`[Purify] 写入实体关联图谱失败 (ID: ${targetId})`, linkErr)
          }
        }
      }

      // 全部提纯并抽取完成，标记已处理文件
      if (extractionSucceeded) {
        for (const filePath of processedFiles) {
          try {
            const newFilePath = filePath.replace(/\.md$/i, '_已更新.md')
            await fs.promises.rename(filePath, newFilePath)
          } catch (renameErr) {
            console.error(`[Purify] 标记文件为已更新失败: ${filePath}`, renameErr)
          }
        }
      } else if (processedFiles.length > 0) {
        console.warn(`[Purify] 本轮未提取到有效事实，保留 ${processedFiles.length} 个源文件以便下次重试。`)
      }
    } else {
      let locallyProcessed = 0
      for (const summary of pendingSummaries) {
        const facts = extractLocalMemoryFacts(summary.title, summary.content)
        if (facts.length === 0) {
          console.log(`[Purify] 单会话本地提纯未发现可入库条目，保留原文件: ${summary.filePath}`)
          continue
        }

        await database.run('BEGIN TRANSACTION')
        try {
          insertCount += await upsertLocalMemoryFacts(database, facts, summary.filePath)
          await database.run('COMMIT')
        } catch (error) {
          await database.run('ROLLBACK')
          throw error
        }

        const updatedPath = summary.filePath.replace(/\.md$/i, '_已更新.md')
        await fs.promises.rename(summary.filePath, updatedPath)
        locallyProcessed++
        console.log(`[Purify] 单会话本地提纯完成: ${facts.length} 条经验，来源: ${updatedPath}`)
      }
      console.log(`[Purify] 单会话增量提纯完成，共处理 ${locallyProcessed} 个记忆文件，新增 ${insertCount} 条结构化经验`)
    }

    await repairMemoryEntityLinks(database)
    fileContentCache.clear()
    return { success: true, count: processedFiles.length, insertCount }
  } catch (e: any) {
    console.error('画像整理 pipeline 失败', e)
    throw new Error(`画像整理 Pipeline 失败: ${e.message || e}`)
  }
}

let lastCleanupTimeCache: number | null = null

export function getLastCleanupTime(): number | null {
  if (lastCleanupTimeCache !== null) {
    return lastCleanupTimeCache
  }
  if (!memoryDeps) return null
  try {
    const storageDir = memoryDeps.getActiveStorageDir()
    const filePath = join(storageDir, 'memory', '.last_cleanup')
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim()
      const time = parseInt(content, 10)
      if (!isNaN(time)) {
        lastCleanupTimeCache = time
        return time
      }
    }
  } catch (e) {
    console.error('[Memory] 读取 last_cleanup 时间失败', e)
  }
  return null
}

export function updateLastCleanupTime(): void {
  if (!memoryDeps) return
  try {
    const now = Date.now()
    const storageDir = memoryDeps.getActiveStorageDir()
    const dirPath = join(storageDir, 'memory')
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
    const filePath = join(dirPath, '.last_cleanup')
    fs.writeFileSync(filePath, String(now), 'utf-8')
    lastCleanupTimeCache = now
  } catch (e) {
    console.error('[Memory] 写入 last_cleanup 时间失败', e)
  }
}


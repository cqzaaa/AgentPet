import { ipcMain } from 'electron'
import * as fs from 'fs'
import { join, relative } from 'path'
import { getLocalEmbedding } from './localEmbedding'

export interface MemoryDependencies {
  getDB: () => Promise<any>
  getActiveChatDir: () => string
  getActiveStorageDir: () => string
  getSystemLlmConfig: () => any
  callLlmInternal: (config: any, messages: any[], storageDir: string) => Promise<string>
}

let memoryDeps: MemoryDependencies | null = null

export async function appendMemorySummaryInternal(sessionId: string, title: string, content: string): Promise<boolean> {
  if (!memoryDeps) {
    console.error('[Memory] memoryDeps 尚未初始化')
    return false
  }
  try {
    if (!sessionId || !title || !content) return false
    const chatDir = memoryDeps.getActiveChatDir()
    const safeSessionId = sessionId.replace(/[<>:"/\\|?*]/g, '_')
    const sessionMemoryDir = join(chatDir, safeSessionId, 'memory')
    
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
      linkSection += '\n\n---\n### 🔗 关联缓存引用\n'
      
      const mentionedList: string[] = []
      const recentList: string[] = []
      
      // 简单的分句，支持换行、句号、感叹号、问号、分号
      const sentences = content
        .split(/[\n\r。？！]/)
        .map(s => s.trim())
        .filter(s => s.length > 0)

      for (const relPath of relatedCaches) {
        const fileName = relPath.split('/').pop() || relPath
        const matchedSentences = sentences.filter(s => s.includes(fileName))
        const absPath = join(chatDir, relPath).replace(/\\/g, '/')
        
        if (matchedSentences.length > 0) {
          for (const sentence of matchedSentences) {
            const shortSentence = sentence.length > 80 ? sentence.substring(0, 80) + '...' : sentence
            mentionedList.push(`* 在正文 “*...${shortSentence}...*” 中，关联了缓存：[\`${relPath}\`](file:///${absPath})`)
          }
        } else {
          recentList.push(`* 关联了最近修改的缓存：[\`${relPath}\`](file:///${absPath})`)
        }
      }
      
      if (mentionedList.length > 0) {
        linkSection += '#### 句内引用：\n' + mentionedList.join('\n') + '\n'
      }
      if (recentList.length > 0) {
        linkSection += '#### 最近修改关联（未在正文显式提及）：\n' + recentList.join('\n') + '\n'
      }
      
      // 插入向后兼容提取管道的 HTML 注释，务必换行单独成行，防止 --> 被正则捕获
      linkSection += `\n<!--\n关联缓存: ${relatedCaches.join(', ')}\n-->\n`
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

  // 第四层：多路混合检索召回相关避坑经验 (仿 SAG 本地 SQL 动态图关联 RAG 架构)
  ipcMain.handle('api:recall-experiences', async (_, queryText: string) => {
    try {
      if (!queryText || !queryText.trim()) return []
      const database = await deps.getDB()
      
      // 1. 获取库中所有避坑经验记录及实体映射
      const rows = await database.all("SELECT id, fact, strength, last_accessed_at, created_at, keywords, embedding FROM persona_memories WHERE category = 'experience'") as any[]
      if (rows.length === 0) return []

      const linkRows = await database.all("SELECT memory_id, entity_name FROM memory_entity_links") as { memory_id: string, entity_name: string }[]
      
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
        if (lowerQuery.includes(ent)) {
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
        firstOrderMemories.forEach(memId => {
          const entitiesSet = memoryToEntities.get(memId)
          if (entitiesSet) {
            entitiesSet.forEach(ent => {
              if (!firstOrderActive.has(ent)) {
                secondOrderActive.add(ent)
              }
            })
          }
        })
      }

      // 4. 尝试生成提问的 Embedding 向量 (优先 SiliconFlow)
      let queryEmb: number[] | null = null
      try {
        queryEmb = await getEmbeddingInternal(deps.getSystemLlmConfig(), queryText)
      } catch (e) {
        console.error('召回计算提问向量失败', e)
      }

      // 5. 本地轻量级 Jaccard 相似度辅助算法
      const jaccardSimilarity = (strA: string, strB: string): number => {
        const cleanTokens = (str: string) => {
          return new Set(str.toLowerCase().match(/[\w\-]+|[\u4e00-\u9fa5]/g) || [])
        }
        const setA = cleanTokens(strA)
        const setB = cleanTokens(strB)
        if (setA.size === 0 || setB.size === 0) return 0
        const intersection = new Set([...setA].filter(x => setB.has(x)))
        const union = new Set([...setA, ...setB])
        return intersection.size / union.size
      }

      const now = Date.now()
      
      const scoredResults = rows.map(row => {
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

        // C. 向量相似度得分 (Vector Score)
        let vectorScore = 0
        if (queryEmb && row.embedding) {
          try {
            const dbEmb = JSON.parse(row.embedding)
            if (Array.isArray(dbEmb)) {
              vectorScore = cosineSimilarity(queryEmb, dbEmb)
              // 归一化 [-1, 1] 到 [0, 1]
              vectorScore = (vectorScore + 1) / 2
            }
          } catch {}
        }

        // D. 纯本地文本 Jaccard 相似度匹配分 (Jaccard Score)
        const jaccardScore = jaccardSimilarity(queryText, row.fact)

        // E. 融合计算综合打分
        let score = 0
        if (queryEmb && row.embedding) {
          // 有向量支持：加权图谱、向量相似度、本地文本分及时间衰减
          score = 0.4 * vectorScore + 0.3 * graphScore + 0.2 * jaccardScore + 0.1 * sNow
        } else {
          // 无向量支持（降级模式）：完全依赖图谱分、本地文本匹配和时间衰减
          score = 0.5 * graphScore + 0.3 * jaccardScore + 0.2 * sNow
        }

        return {
          id: row.id,
          fact: row.fact,
          sNow,
          vectorScore,
          graphScore,
          jaccardScore,
          score
        }
      })

      // 过滤低相关分，并按得分从高到低排序
      const activeResults = scoredResults.filter(r => r.sNow >= 0.2 && r.score > 0.05)
      activeResults.sort((a, b) => b.score - a.score)
      const top3 = activeResults.slice(0, 3)

      console.log(`[Recall] 仿 SAG 多跳召回了 ${top3.length} 条相关经验:`, top3.map(t => `${t.fact.substring(0, 30)}... (score: ${t.score.toFixed(3)})`))
      return {
        results: top3,
        debug: {
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

// 获取文本的 Embedding 向量，仅通过本地提取（未就绪时返回 null 并自动降级为文本/图谱模糊匹配）
async function getEmbeddingInternal(
  _config: { 
    provider: string; 
    apiKey: string; 
    baseUrl: string; 
    model: string; 
  }, 
  text: string
): Promise<number[] | null> {
  try {
    const localEmb = await getLocalEmbedding(text)
    if (localEmb) {
      return localEmb
    }
  } catch (localErr) {
    console.warn('[Embedding] 本地向量计算异常:', localErr)
  }
  return null
}

// 辅助函数：自动扫描库内向量维度不符的老数据，重新生成向量嵌入并更新
async function autoMigrateOldEmbeddings(db: any) {
  if (!memoryDeps) return
  try {
    const rows = await db.all("SELECT id, fact, keywords, embedding FROM persona_memories WHERE category = 'experience'") as any[]
    if (rows.length === 0) return

    // 1. 增量自动扫描并补建实体多对多关联图谱
    let linkRebuiltCount = 0
    for (const row of rows) {
      let keywordsList: string[] = []
      try {
        if (row.keywords) {
          const parsedKw = JSON.parse(row.keywords)
          keywordsList = Array.isArray(parsedKw) ? parsedKw : []
        }
      } catch {}

      if (keywordsList.length > 0) {
        const linkCount = await db.get("SELECT COUNT(*) as cnt FROM memory_entity_links WHERE memory_id = ?", row.id) as { cnt: number }
        if (linkCount && linkCount.cnt === 0) {
          const now = Date.now()
          for (const kw of keywordsList) {
            if (kw && typeof kw === 'string' && kw.trim()) {
              await db.run("INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_name, created_at) VALUES (?, ?, ?)", row.id, kw.trim(), now)
            }
          }
          linkRebuiltCount++
        }
      }
    }
    if (linkRebuiltCount > 0) {
      console.log(`[Migration] 成功为 ${linkRebuiltCount} 条历史经验自动完成了实体多对多关联图谱的重建补建`)
    }

    // 2. 检测期望的向量维度并做向量重嵌入
    let expectedLen = 1024 
    const sampleEmb = await getEmbeddingInternal(memoryDeps.getSystemLlmConfig(), "test")
    if (sampleEmb && sampleEmb.length > 0) {
      expectedLen = sampleEmb.length
    } else {
      console.log('[Migration] 未获取到当前活动的向量生成模型，跳过向量增量更新。')
      return
    }

    const rowsToMigrate = rows.filter(row => {
      if (!row.embedding) return true
      try {
        const parsed = JSON.parse(row.embedding)
        return !Array.isArray(parsed) || parsed.length !== expectedLen
      } catch {
        return true
      }
    })

    if (rowsToMigrate.length === 0) {
      return
    }

    console.log(`[Migration] 检测到有 ${rowsToMigrate.length} 条历史避坑数据没有向量或向量维度不匹配，正在重算并迁移更新...`)

    let updateCount = 0
    for (const row of rowsToMigrate) {
      try {
        const newEmb = await getEmbeddingInternal(memoryDeps.getSystemLlmConfig(), row.fact)
        if (newEmb && newEmb.length === expectedLen) {
          await db.run("UPDATE persona_memories SET embedding = ? WHERE id = ?", JSON.stringify(newEmb), row.id)
          updateCount++
        }
      } catch (err) {
        console.error(`[Migration] 更新历史数据向量失败 (ID: ${row.id}):`, err)
      }
    }
    console.log(`[Migration] 历史向量库增量更新迁移完毕，成功更新了 ${updateCount} 条数据。当前使用维度为 ${expectedLen}`)
  } catch (migrationErr) {
    console.error('[Migration] 执行历史老数据向量增量更新抛出异常:', migrationErr)
  }
}

// 第三层：系统内置画像整理与避坑经验沉淀的后台 pipeline
export async function runPurifyMemoryPipeline(targetSessionId?: string) {
  if (!memoryDeps) {
    console.warn('[Purify] memoryDeps 未初始化，跳过后台整理')
    return { success: false, count: 0, insertCount: 0 }
  }
  const { getActiveChatDir, getDB, getActiveStorageDir, getSystemLlmConfig, callLlmInternal } = memoryDeps

  try {
    const chatDir = getActiveChatDir()
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
    const sessionCaches = new Set<string>()
    
    // 搜集所有会话下的 memory 文件夹内的 md 摘要，以及会话主目录下的关键字 md 文件
    for (const sess of sessions) {
      const safeSessionId = sess.id.replace(/[<>:"/\\|?*]/g, '_')
      
      // 1. 扫描会话 memory 文件夹（全部 md 文件）
      const sessionMemoryDir = join(chatDir, safeSessionId, 'memory')
      if (fs.existsSync(sessionMemoryDir)) {
        const files = await fs.promises.readdir(sessionMemoryDir)
        const mdFiles = files.filter(f => f.toLowerCase().endsWith('.md') && !f.toLowerCase().endsWith('_已更新.md'))
        for (const file of mdFiles) {
          const filePath = join(sessionMemoryDir, file)
          try {
            const stat = await fs.promises.stat(filePath)
            if (stat.isFile()) {
              const content = await fs.promises.readFile(filePath, 'utf-8')
              
              // 提取关联缓存路径
              const cacheMatch = content.match(/关联缓存:\s*([^\n]+)/)
              if (cacheMatch && cacheMatch[1]) {
                cacheMatch[1].split(',').map(s => s.trim()).forEach(c => {
                  if (c) sessionCaches.add(c)
                })
              }

              allSummariesCombined += `\n### 会话: ${sess.name} (日期: ${file.replace(/\.md$/i, '')})\n${content}\n`
              processedFiles.push(filePath)
            }
          } catch (e) {
            console.error(`读取 memory 目录文件失败: ${filePath}`, e)
          }
        }
      }

      // 2. 扫描会话主目录本身（全部 md 文件，不包括子目录）
      const sessionRootDir = join(chatDir, safeSessionId)
      if (fs.existsSync(sessionRootDir)) {
        const files = await fs.promises.readdir(sessionRootDir)
        const mdFiles = files.filter(f => f.toLowerCase().endsWith('.md') && !f.toLowerCase().endsWith('_已更新.md'))
        for (const file of mdFiles) {
          const filePath = join(sessionRootDir, file)
          try {
            const stat = await fs.promises.stat(filePath)
            if (stat.isFile()) {
              const content = await fs.promises.readFile(filePath, 'utf-8')

              // 提取关联缓存路径
              const cacheMatch = content.match(/关联缓存:\s*([^\n]+)/)
              if (cacheMatch && cacheMatch[1]) {
                cacheMatch[1].split(',').map(s => s.trim()).forEach(c => {
                  if (c) sessionCaches.add(c)
                })
              }

              allSummariesCombined += `\n### 会话: ${sess.name} (根文件: ${file.replace(/\.md$/i, '')})\n${content}\n`
              processedFiles.push(filePath)
            }
          } catch (e) {
            console.error(`读取会话根目录文件失败: ${filePath}`, e)
          }
        }
      }
    }

    if (!allSummariesCombined.trim()) {
      console.log('[Purify] 无摘要历史，跳过大模型合并，只执行数据库状态清理。')
      await autoMigrateOldEmbeddings(database)
      return { success: true, count: 0, insertCount: 0 }
    }

    // 1. 合并更新全局画像 profile.md
    const currentProfilePath = join(getActiveStorageDir(), 'memory', 'profile.md')
    let currentProfile = ''
    if (fs.existsSync(currentProfilePath)) {
      currentProfile = await fs.promises.readFile(currentProfilePath, 'utf-8')
    }

    const profileSystemPrompt = `你是一个高级人物画像整理专家。你的任务是分析主人（用户）最近的对话摘要，提纯、合并并更新主人的全局长期人物画像。
人物画像必须严格按照以下五个维度进行整理：
1. 工作背景
2. 个人背景
3. 当前关注
4. 近期动态
5. 避坑重点与习惯

请合并新摘要中体现的信息，如果与过去的信息有冲突，以新的为准。
请以 Markdown 格式输出最新的全局人物画像（不要包含任何思考过程、JSON、多余的分析或客套话，直接输出画像的 Markdown 文本内容）。`

    const profileMessages = [
      { role: 'system', content: profileSystemPrompt },
      { role: 'user', content: `【当前的全局人物画像】\n${currentProfile || '（暂无）'}\n\n【最近收集的对话摘要历史】\n${allSummariesCombined}\n\n请根据上面的对话摘要，对当前的全局人物画像进行提纯、增量合并和覆盖更新，输出最新版本的画像。` }
    ]

    console.log('[Purify] 正在调用大模型更新人物画像...')
    const updatedProfile = await callLlmInternal(getSystemLlmConfig(), profileMessages, getActiveStorageDir())
    
    const globalMemoryDir = join(getActiveStorageDir(), 'memory')
    if (!fs.existsSync(globalMemoryDir)) {
      await fs.promises.mkdir(globalMemoryDir, { recursive: true })
    }
    await fs.promises.writeFile(join(globalMemoryDir, 'profile.md'), updatedProfile.trim(), 'utf-8')
    console.log('[Purify] 人物画像 profile.md 覆盖更新成功。')

    // 2. 提取报错与避坑经验，写入 persona_memories
    const experienceSystemPrompt = `你是一个核心技术知识提炼与避坑经验沉淀专家。请分析主人最近的对话摘要，从中提纯并总结出以下两类结构化经验：
1. 【技术核心与源码要点】：例如源码结构解读要点、业务逻辑核心细节、系统架构设计决策等。
2. 【避坑纠错与工具经验】：例如工具执行失败/报错原因、排卡调试经验、环境兼容性问题及具体的避坑防线。

对于每一条经验，你必须输出为 JSON 格式的数组。格式如下：
[
  {
    "fact": "简明扼要的经验/技术事实描述（例如：'React 18 并发渲染的核心是通过 Scheduler 进行时间片调度'，或 '在 Windows 下用 read_file 读写被 Office 占用的 Excel 时会报错，应提示用户先关闭 Office'）",
    "keywords": ["React", "Scheduler", "调度"]
  }
]
如果你没有发现任何有价值的技术知识要点或避坑经验，请直接输出空数组 []。
请不要输出任何 Markdown 标记或多余的解释，只输出合法的 JSON 数组本身。`

    const experienceMessages = [
      { role: 'system', content: experienceSystemPrompt },
      { role: 'user', content: `【最近收集的对话摘要历史】\n${allSummariesCombined}\n\n请从中提取有价值的避坑经验或技术事实并输出为 JSON 数组。` }
    ]

    console.log('[Purify] 正在调用大模型提炼避坑经验...')
    const experienceRawJson = await callLlmInternal(getSystemLlmConfig(), experienceMessages, getActiveStorageDir())
    
    let jsonText = experienceRawJson.trim()
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(json)?/, '').replace(/```$/, '').trim()
    }
    
    let experiences: any[] = []
    try {
      experiences = JSON.parse(jsonText)
    } catch (je) {
      console.error('[Purify] 解析避坑经验 JSON 失败, raw response:', experienceRawJson, je)
    }

    let insertCount = 0
    if (Array.isArray(experiences) && experiences.length > 0) {
      for (const item of experiences) {
        if (!item.fact) continue
        
        let emb: number[] | null = null
        try {
          emb = await getEmbeddingInternal(getSystemLlmConfig(), item.fact)
        } catch (ee) {
          console.error('[Purify] 获取向量失败', ee)
        }

        // 查询是否有相似的已有经验
        const rows = await database.all("SELECT id, fact, embedding FROM persona_memories WHERE category = 'experience'") as any[]
        
        let matchedId: string | null = null
        if (emb && rows.length > 0) {
          for (const row of rows) {
            if (row.embedding) {
              try {
                const dbEmb = JSON.parse(row.embedding)
                if (Array.isArray(dbEmb)) {
                  const sim = cosineSimilarity(emb, dbEmb)
                  if (sim > 0.85) {
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
        
        const linkPath = processedFiles.map(fp => relative(chatDir, fp).replace(/\\/g, '/')).join(', ')

        if (matchedId) {
          await database.run("UPDATE persona_memories SET strength = MIN(1.0, strength + 0.3), last_accessed_at = ?, link = ? WHERE id = ?", now, linkPath, matchedId)
          console.log(`[Purify] 强化已有避坑经验 (ID: ${matchedId})`)
        } else {
          await database.run(`
            INSERT INTO persona_memories (id, fact, strength, last_accessed_at, created_at, category, keywords, embedding, link)
            VALUES (?, ?, 1.0, ?, ?, 'experience', ?, ?, ?)
          `,
            targetId,
            item.fact,
            now,
            now,
            JSON.stringify(item.keywords || []),
            emb ? JSON.stringify(emb) : null,
            linkPath
          )
          insertCount++
          console.log(`[Purify] 写入新避坑经验 (ID: ${targetId}): ${item.fact}`)
        }

        // 仿 SAG 机制：写入实体多对多关联关系图谱
        try {
          // 先清理旧有的实体绑定，以防大模型更新时实体关键词发生变更
          await database.run("DELETE FROM memory_entity_links WHERE memory_id = ?", targetId)

          const keywordsList = Array.isArray(item.keywords) ? item.keywords : []
          if (keywordsList.length > 0) {
            for (const kw of keywordsList) {
              if (kw && typeof kw === 'string' && kw.trim()) {
                await database.run("INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_name, created_at) VALUES (?, ?, ?)", targetId, kw.trim(), now)
              }
            }
          }
        } catch (linkErr) {
          console.error(`[Purify] 写入实体关联图谱失败 (ID: ${targetId})`, linkErr)
        }
      }
    }

    // 全部提纯并抽取完成，标记已处理文件
    for (const filePath of processedFiles) {
      try {
        const newFilePath = filePath.replace(/\.md$/i, '_已更新.md')
        await fs.promises.rename(filePath, newFilePath)
      } catch (renameErr) {
        console.error(`[Purify] 标记文件为已更新失败: ${filePath}`, renameErr)
      }
    }

    await autoMigrateOldEmbeddings(database)
    return { success: true, count: processedFiles.length, insertCount }
  } catch (e: any) {
    console.error('画像整理 pipeline 失败', e)
    throw new Error(`画像整理 Pipeline 失败: ${e.message || e}`)
  }
}


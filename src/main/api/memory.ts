import { ipcMain, net } from 'electron'
import * as fs from 'fs'
import { join } from 'path'

export interface MemoryDependencies {
  getDB: () => Promise<any>
  getActiveChatDir: () => string
  getActiveStorageDir: () => string
  getSystemLlmConfig: () => any
  callLlmInternal: (config: any, messages: any[], storageDir: string) => Promise<string>
}

let memoryDeps: MemoryDependencies | null = null

export function registerMemoryAPIs(deps: MemoryDependencies) {
  memoryDeps = deps

  // 追加写入每日 Markdown 摘要（用会话文件夹进行隔离）
  ipcMain.handle('api:append-memory-summary', async (_, sessionId: string, text: string) => {
    try {
      if (!sessionId) return false
      const chatDir = deps.getActiveChatDir()
      const safeSessionId = sessionId.replace(/[<>:"/\\|?*]/g, '_')
      const sessionMemoryDir = join(chatDir, safeSessionId, 'memory')
      
      if (!fs.existsSync(sessionMemoryDir)) {
        await fs.promises.mkdir(sessionMemoryDir, { recursive: true })
      }

      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const fileName = `${year}-${month}-${day}.md`
      const filePath = join(sessionMemoryDir, fileName)

      await fs.promises.appendFile(filePath, text + '\n\n', 'utf-8')
      return true
    } catch (e) {
      console.error('追加写入每日摘要失败', e)
      return false
    }
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

  ipcMain.handle('api:purify-memory-pipeline', async () => {
    return runPurifyMemoryPipeline()
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

// 获取文本的 Embedding 向量，支持优雅降级
async function getEmbeddingInternal(
  config: { 
    provider: string; 
    apiKey: string; 
    baseUrl: string; 
    model: string; 
  }, 
  text: string
): Promise<number[] | null> {
  // 优先尝试 SiliconFlow 的免费高精度向量嵌入
  const sfApiKey = process.env.SILICONFLOW_API_KEY
  if (sfApiKey) {
    try {
      console.log('[Embedding] 正在通过 SiliconFlow (BAAI/bge-m3) 获取向量...')
      const sfResponse = await net.fetch("https://api.siliconflow.cn/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${sfApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: text,
          model: "BAAI/bge-m3"
        }),
        signal: AbortSignal.timeout(8000)
      })

      if (sfResponse.ok) {
        const sfData: any = await sfResponse.json()
        if (sfData && sfData.data && sfData.data[0] && sfData.data[0].embedding) {
          console.log('[Embedding] SiliconFlow 向量获取成功')
          return sfData.data[0].embedding
        }
      } else {
        const sfErr = await sfResponse.text().catch(() => '')
        console.warn(`[Embedding] SiliconFlow 响应错误 (HTTP ${sfResponse.status}): ${sfErr}，将尝试回退。`)
      }
    } catch (err) {
      console.warn('[Embedding] SiliconFlow 请求异常，将尝试回退至系统配置大模型向量:', err)
    }
  }

  // 回退逻辑：使用既有大模型提供商的向量接口
  try {
    const { provider, apiKey, baseUrl } = config
    if (!apiKey && provider !== 'ollama') {
      return null
    }
    let url = ''
    const headers: any = {
      'Content-Type': 'application/json'
    }
    const body: any = {
      input: text
    }

    if (provider === 'gemini') {
      const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
      url = `${effectiveBaseUrl}/embeddings`
      headers['Authorization'] = `Bearer ${apiKey}`
      body.model = 'text-embedding-004'
    } else if (provider === 'openai') {
      const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1'
      url = `${effectiveBaseUrl}/embeddings`
      headers['Authorization'] = `Bearer ${apiKey}`
      body.model = 'text-embedding-3-small'
    } else if (provider === 'deepseek') {
      return null
    } else if (provider === 'ollama') {
      const effectiveBaseUrl = baseUrl || 'http://localhost:11434/v1'
      url = `${effectiveBaseUrl}/embeddings`
      body.model = 'nomic-embed-text'
    } else {
      url = `${baseUrl}/embeddings`
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
      body.model = 'text-embedding-3-small'
    }

    const response = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    })

    if (!response.ok) {
      return null
    }

    const data: any = await response.json()
    if (data && data.data && data.data[0] && data.data[0].embedding) {
      return data.data[0].embedding
    }
    return null
  } catch (err) {
    console.warn('[Embedding] 回退向量接口异常，降级为纯文本模糊搜索', err)
    return null
  }
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
export async function runPurifyMemoryPipeline() {
  if (!memoryDeps) {
    console.warn('[Purify] memoryDeps 未初始化，跳过后台整理')
    return { success: false, count: 0, insertCount: 0 }
  }
  const { getActiveChatDir, getDB, getActiveStorageDir, getSystemLlmConfig, callLlmInternal } = memoryDeps

  try {
    const chatDir = getActiveChatDir()
    const database = await getDB()
    const sessions = await database.all('SELECT id, name FROM sessions') as { id: string; name: string }[]
    
    let allSummariesCombined = ''
    const processedFiles: string[] = []
    
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
    const experienceSystemPrompt = `你是一个任务纠错与避坑经验沉淀专家。请分析主人最近的对话摘要（特别是工具执行失败或报错的部分），提取并总结出结构化的“纠错避坑经验”。
对于每一条经验，你必须输出为 JSON 格式的数组。格式如下：
[
  {
    "fact": "简明扼要的经验/事实描述，例如：在Windows下用read_file读写Excel时，如果Office软件正在占用，应先提示主人手动关闭。",
    "keywords": ["read_file", "excel", "permission", "locked"]
  }
]
如果你没有发现任何有价值的避坑经验或工具报错，请直接输出空数组 []。
请不要输出任何 Markdown 标记或多余的解释，只输出合法的 JSON 数组本身。`

    const experienceMessages = [
      { role: 'system', content: experienceSystemPrompt },
      { role: 'user', content: `【最近收集的对话摘要历史】\n${allSummariesCombined}\n\n请从中提取避坑经验并输出为 JSON 数组。` }
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

        if (matchedId) {
          await database.run("UPDATE persona_memories SET strength = MIN(1.0, strength + 0.3), last_accessed_at = ? WHERE id = ?", now, matchedId)
          console.log(`[Purify] 强化已有避坑经验 (ID: ${matchedId})`)
        } else {
          await database.run(`
            INSERT INTO persona_memories (id, fact, strength, last_accessed_at, created_at, category, keywords, embedding)
            VALUES (?, ?, 1.0, ?, ?, 'experience', ?, ?)
          `,
            targetId,
            item.fact,
            now,
            now,
            JSON.stringify(item.keywords || []),
            emb ? JSON.stringify(emb) : null
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


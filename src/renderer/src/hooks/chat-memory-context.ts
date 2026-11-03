/* eslint-disable @typescript-eslint/no-explicit-any */
type MemoryApi = Pick<Window['api'], 'getMemoryProfile' | 'recallExperiences'>

export async function loadChatMemoryContext(
  enabled: boolean,
  query: string,
  api: MemoryApi
): Promise<{ memoryContext: string; relevantExperiences: any[]; recallDebug: any }> {
  if (!enabled) return { memoryContext: '', relevantExperiences: [], recallDebug: null }

  const [profileContent, recallResponse] = await Promise.all([
    api.getMemoryProfile().catch((error: unknown) => { console.error('获取人物画像失败:', error); return '' }),
    api.recallExperiences(query).catch((error: unknown) => { console.error('获取避坑经验失败:', error); return [] })
  ])
  const recallResult: any = recallResponse
  const relevantExperiences: any[] = Array.isArray(recallResult) ? recallResult : recallResult?.results || []
  const recallDebug = !Array.isArray(recallResult) ? recallResult?.debug || null : null
  const memoryContext = `\n\n🧠 【长期人物画像与背景设定】\n${profileContent || '暂无详细人物画像。'}` +
    (relevantExperiences.length > 0
      ? `\n\n💡 【相关历史经验与避坑指南】\n${relevantExperiences.map((experience: any, index: number) => {
          let item = `${index + 1}. ${experience.fact}`
          if (experience.relatedContent) {
            item += `\n   [关联的原始总结上下文]:\n   """\n   ${experience.relatedContent.replace(/\n/g, '\n   ')}\n   """`
          } else if (experience.absolutePath) {
            item += `\n   [对应原始归档文件路径，若需了解详情你可以使用 read_file 访问该路径]: ${experience.absolutePath}`
          }
          return item
        }).join('\n')}`
      : '')
  return { memoryContext, relevantExperiences, recallDebug }
}

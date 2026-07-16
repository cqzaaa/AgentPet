import * as fs from 'fs'
import * as path from 'path'
import { IToolExecutor, ToolContext, ToolResult, WebSource } from '../../core/types'
import { getActiveStorageDir } from '../../utils/paths'
import { LocalBrowser } from './localBrowser'

export class WebExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. web_search
      if (api === 'web_search') {
        const { query } = args
        if (!query) return { content: '错误：缺少必要参数 query', success: false }

        // 使用 Electron 本地无头浏览器获取 Bing 搜索结果。
        const results = await LocalBrowser.localSearch(query)
        if (results.length === 0) {
          return { content: `未找到与 "${query}" 相关的搜索结果。`, success: true }
        }

        const fetchedAt = new Date().toISOString()
        const sources: WebSource[] = results.map((result, index) => ({
          id: `S${index + 1}`,
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          fetchedAt,
          sourceType: 'search'
        }))
        const sourceContext = sources
          .map(source => `[${source.id}] 标题: ${source.title}\nURL: ${source.url}\n摘要: ${source.snippet || '无'}`)
          .join('\n\n')

        return {
          content: `<web_sources>\n${sourceContext}\n</web_sources>\n\n回答中对依赖网页的事实必须引用上述来源 ID（例如 [S1]），不得编造其他引用。`,
          state: { sources },
          success: true
        }
      }

      // 2. web_fetch
      if (api === 'web_fetch') {
        const { url } = args
        if (!url) return { content: '错误：缺少必要参数 url', success: false }

        let textContent = ''

        // 使用 Electron 本地浏览器加载、清理并转换为 Markdown 正文。
        textContent = await LocalBrowser.localFetch(url)

        if (!textContent || !textContent.trim()) {
          return { content: '成功加载网页，但未提取到任何正文文本。', success: true }
        }

        textContent = textContent.trim()

        // 缓存长网页到本地文件
        const safeSessionId = context.sessionId ? context.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') : 'default_session'
        const cacheDir = path.join(getActiveStorageDir(), 'chat', safeSessionId, '.agentpet_cache')
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true })
        }
        
        const timestamp = Date.now()
        // 去除 URL 中可能导致文件名的非法字符
        const safeUrlName = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)
        const cacheFileName = `web_fetch_${safeUrlName}_${timestamp}.md`
        const cacheFilePath = path.join(cacheDir, cacheFileName)
        
        fs.writeFileSync(cacheFilePath, textContent, 'utf-8')

        // 返回摘要与引导信息，防止爆满
        const previewLength = 4000
        let displayContent = textContent.slice(0, previewLength)
        if (textContent.length > previewLength) {
          displayContent += `\n\n...[以下省略 ${textContent.length - previewLength} 字符]`
        }

        const relPath = `.agentpet_cache/${cacheFileName}`
        const source: WebSource = {
          id: 'S1',
          title: textContent.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(url).hostname,
          url,
          snippet: textContent.replace(/^#.+\n*/, '').replace(/\s+/g, ' ').slice(0, 300),
          fetchedAt: new Date().toISOString(),
          sourceType: 'fetch'
        }
        const finalResult = `<web_sources>\n[S1] 标题: ${source.title}\nURL: ${source.url}\n摘要: ${source.snippet}\n</web_sources>\n回答中对依赖本网页的事实必须引用 [S1]。

【网页抓取成功】
全文已保存至本地缓存文件：
${cacheFilePath}

================预览内容================
${displayContent}
========================================

⚠️ 【系统强制指令】：网页的完整离线 Markdown 内容已成功保存至相对路径：\`${relPath}\`。
由于网页内容较长，上方预览已被系统截断。如果您根据上述预览无法 100% 把握回答主人的问题，您【必须】立即调用 \`read_file\` 工具，传入参数 \`file_path: "${relPath}"\` 来阅读该缓存文件的完整内容，绝对不允许向主人进行猜测回答或直接发起二次联网搜索！`

        return { content: finalResult, state: { sources: [source] }, success: true }
      }

      return { content: `未知的操作类型: ${api}`, success: false }
    } catch (err: any) {
      return {
        content: `网页抓取失败：${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    }
  }

  public getApiNames(): string[] {
    return ['web_search', 'web_fetch']
  }
}

export const webExecutor = new WebExecutor()

import * as fs from 'fs'
import * as path from 'path'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
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

        /* 之前使用的 Jina.ai 搜索逻辑已注释
        const searchUrl = `https://s.jina.ai/${encodeURIComponent(query)}`
        const response = await net.fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Authorization': 'Bearer jina_01998ab7ad694519abec1e712b5cd6ecpJTAmfuva19C6pOPQ5Z71dUbQucc'
          }
        })

        if (!response.ok) {
          const errMsg = await response.text().catch(() => '')
          return { content: `联网搜索失败：Jina.ai 搜索服务返回状态码 ${response.status}${errMsg ? ' - ' + errMsg : ''}`, success: false }
        }

        const data = await response.text()
        return { content: data || `未找到与 "${query}" 相关的搜索结果。`, success: true }
        */

        // 改用本地无头浏览器获取搜索结果（基于必应）
        const results = await LocalBrowser.localSearch(query)
        if (results.length === 0) {
          return { content: `未找到与 "${query}" 相关的搜索结果。`, success: true }
        }

        const formattedResults = results
          .map((r, i) => `[${i + 1}] 标题: ${r.title}\n链接: ${r.url}\n摘要: ${r.snippet}\n`)
          .join('\n')

        return { content: formattedResults, success: true }
      }

      // 2. web_fetch
      if (api === 'web_fetch') {
        const { url } = args
        if (!url) return { content: '错误：缺少必要参数 url', success: false }

        let textContent = ''

        /* 之前使用的 Jina.ai 抓取及本地隐藏 BrowserWindow 兜底降级逻辑已注释
        // 优先使用 Jina.ai Reader 进行抓取与清洗（效果最好）
        try {
          const readerUrl = `https://r.jina.ai/${url}`
          const response = await net.fetch(readerUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Authorization': 'Bearer jina_01998ab7ad694519abec1e712b5cd6ecpJTAmfuva19C6pOPQ5Z71dUbQucc'
            }
          })
          if (response.ok) {
            const data = await response.text()
            if (data && data.trim()) {
              textContent = data
            }
          }
        } catch (jinaErr: any) {
          console.warn('[web_fetch] Jina Reader 抓取失败，降级到本地 BrowserWindow 后台渲染抓取:', jinaErr.message)
        }

        // 兜底方案：使用隐藏的 BrowserWindow 进行本地加载并渲染提取文字
        if (!textContent) {
          textContent = await new Promise<string>((resolve, reject) => {
            const tempWin = new BrowserWindow({
              show: false,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                images: false, // 禁用图片加载
              }
            })

            const timer = setTimeout(() => {
              tempWin.destroy()
              reject(new Error('网页加载超时（15秒）'))
            }, 15000)

            tempWin.webContents.on('did-finish-load', async () => {
              try {
                const text = await tempWin.webContents.executeJavaScript(`
                  (() => {
                    const excludes = ['script', 'style', 'nav', 'footer', 'iframe', 'header', 'noscript'];
                    excludes.forEach(tag => {
                      document.querySelectorAll(tag).forEach(el => el.remove());
                    });
                    return document.body.innerText || document.body.textContent || '';
                  })()
                `)
                clearTimeout(timer)
                tempWin.destroy()
                resolve(text)
              } catch (err) {
                clearTimeout(timer)
                tempWin.destroy()
                reject(err)
              }
            })

            tempWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
              clearTimeout(timer)
              tempWin.destroy()
              reject(new Error(`网页加载失败: ${errorDescription} (代码: ${errorCode})`))
            })

            tempWin.loadURL(url).catch(err => {
              clearTimeout(timer)
              tempWin.destroy()
              reject(err)
            })
          })
        }
        */

        // 直接调用本地浏览器加载、智能清理并转换为结构化的 Markdown 正文
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
        const finalResult = `【网页抓取成功】
全文已保存至本地缓存文件：
${cacheFilePath}

================预览内容================
${displayContent}
========================================

⚠️ 【系统强制指令】：网页的完整离线 Markdown 内容已成功保存至相对路径：\`${relPath}\`。
由于网页内容较长，上方预览已被系统截断。如果您根据上述预览无法 100% 把握回答主人的问题，您【必须】立即调用 \`read_file\` 工具，传入参数 \`file_path: "${relPath}"\` 来阅读该缓存文件的完整内容，绝对不允许向主人进行猜测回答或直接发起二次联网搜索！`

        return { content: finalResult, success: true }
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

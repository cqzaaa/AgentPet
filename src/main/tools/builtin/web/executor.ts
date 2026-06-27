import { net, BrowserWindow } from 'electron'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'

export class WebExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    _context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. web_search
      if (api === 'web_search') {
        const { query } = args
        if (!query) return { content: '错误：缺少必要参数 query', success: false }

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
      }

      // 2. web_fetch
      if (api === 'web_fetch') {
        const { url } = args
        if (!url) return { content: '错误：缺少必要参数 url', success: false }

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
              return { content: data, success: true }
            }
          }
        } catch (jinaErr: any) {
          console.warn('[web_fetch] Jina Reader 抓取失败，降级到本地 BrowserWindow 后台渲染抓取:', jinaErr.message)
        }

        // 兜底方案：使用隐藏的 BrowserWindow 进行本地加载并渲染提取文字
        const textContent = await new Promise<string>((resolve, reject) => {
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

        if (!textContent || !textContent.trim()) {
          return { content: '成功加载网页，但本地未提取到任何正文文本。', success: true }
        }

        // 截取前 12000 个字符以防超过模型上下文限制
        return { content: textContent.trim().slice(0, 12000), success: true }
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

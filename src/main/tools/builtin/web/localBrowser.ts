import { BrowserWindow } from 'electron'
import { isIP } from 'net'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export class LocalBrowser {
  private static readonly TIMEOUT_MS = 15000

  // 创建统一配置的隐藏窗口
  private static createHiddenWindow(): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        images: false // 禁用图片加载以大幅提升渲染速度
      }
    })

    // 禁用音频视频资源以提速
    win.webContents.setAudioMuted(true)

    // 设置通用的常规浏览器 User-Agent，避免部分网站直接识别并拦截 Electron
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    win.webContents.setUserAgent(userAgent)

    return win
  }

  private static assertSafeRemoteUrl(value: string): void {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('无效的网页 URL')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('仅允许抓取 http 或 https 网页')
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const privateIpv4 = (ip: string) => {
      const parts = ip.split('.').map(Number)
      return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168)
    }
    const isPrivateIpv6 = host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        (isIP(host) === 4 && privateIpv4(host)) || (isIP(host) === 6 && isPrivateIpv6)) {
      throw new Error('为保护本机和内网，不允许访问本地或私网地址')
    }
  }

  /**
   * 本地搜索服务（使用 Bing）
   */
  public static async localSearch(query: string): Promise<SearchResult[]> {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ')
    if (!normalizedQuery) {
      throw new Error('搜索关键词不能为空')
    }

    return new Promise<SearchResult[]>((resolve, reject) => {
      const win = this.createHiddenWindow()
      let isResolved = false
      let isSearchPage = false

      const cleanup = () => {
        isResolved = true
        clearTimeout(timer)
        if (!win.isDestroyed()) {
          win.destroy()
        }
      }

      // 超时控制
      const timer = setTimeout(() => {
        if (!isResolved) {
          cleanup()
          reject(new Error('搜索请求超时（15秒）'))
        }
      }, this.TIMEOUT_MS)

      win.webContents.on('did-finish-load', async () => {
        if (isResolved) return
        // The first load only initializes Bing's cookie-backed session.
        if (!isSearchPage) return
        try {
          // 提取 Bing 的自然搜索结果。
          const searchResponse = (await win.webContents.executeJavaScript(`
            (() => {
              const submittedQuery = (document.querySelector('#sb_form_q')?.value || '').trim();
              const list = [];
              const items = document.querySelectorAll('#b_results .b_algo');
              items.forEach(item => {
                const titleEl = item.querySelector('h2 a');
                const snippetEl = item.querySelector('.b_caption p') || item.querySelector('.b_algoSlug');
                if (titleEl) {
                  const title = titleEl.innerText || titleEl.textContent || '';
                  const url = titleEl.getAttribute('href') || '';
                  const snippet = snippetEl ? (snippetEl.innerText || snippetEl.textContent || '') : '';
                  if (title.trim() && url.startsWith('http')) {
                    list.push({
                      title: title.trim(),
                      url: url.trim(),
                      snippet: snippet.trim()
                    });
                  }
                }
              });
              return { submittedQuery, results: list };
            })()
          `)) as { submittedQuery: string; results: SearchResult[] }

          // Do not return a result page if Bing changed the submitted query
          // during a regional redirect or client-side navigation.
          const actualQuery = searchResponse.submittedQuery.replace(/\s+/g, ' ')
          if (actualQuery && actualQuery !== normalizedQuery) {
            throw new Error(`Bing 搜索词被改写：期望“${normalizedQuery}”，实际为“${actualQuery}”`)
          }

          cleanup()
          resolve(searchResponse.results.slice(0, 5))
        } catch (err) {
          cleanup()
          reject(err)
        }
      })

      // 页面加载错误处理
      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        if (isResolved) return
        // 忽略非核心组件资源加载中断（-3 是经常出现的非致命错误）
        if (errorCode === -3 || errorCode === -2) {
          return
        }
        cleanup()
        reject(new Error(`搜索页面加载失败: ${errorDescription} (代码: ${errorCode})`))
      })

      // Keep the request shape aligned with a regular browser Bing search.
      // Forcing mkt/setlang makes the Electron request differ from the user's
      // working URL and can trigger Bing's degraded automated-search response.
      const searchUrl = new URL('https://www.bing.com/search')
      searchUrl.searchParams.set('q', normalizedQuery)
      searchUrl.searchParams.set('form', 'QBLH')

      // Establish MUID/MUIDB and related cookies before searching, using this
      // exact BrowserWindow session. Bing otherwise may search only the first
      // Chinese character while leaving the full term in #sb_form_q.
      win.loadURL('https://www.bing.com/').then(() => {
        if (isResolved) return
        isSearchPage = true
        return win.loadURL(searchUrl.toString())
      }).catch(err => {
        if (isResolved) return
        cleanup()
        reject(err)
      })
    })
  }

  /**
   * 本地网页爬取服务 (加载 URL 并提取 Markdown)
   */
  public static async localFetch(url: string): Promise<string> {
    this.assertSafeRemoteUrl(url)
    return new Promise<string>((resolve, reject) => {
      const win = this.createHiddenWindow()
      let isResolved = false

      const cleanup = () => {
        isResolved = true
        clearTimeout(timer)
        if (!win.isDestroyed()) {
          win.destroy()
        }
      }

      // 超时控制
      const timer = setTimeout(() => {
        if (!isResolved) {
          cleanup()
          reject(new Error('网页抓取超时（15秒）'))
        }
      }, this.TIMEOUT_MS)

      win.webContents.on('did-finish-load', async () => {
        if (isResolved) return
        try {
          // 注入高效的 DOM 遍历与清洗逻辑，提取核心正文并生成简易 Markdown
          const markdownContent = (await win.webContents.executeJavaScript(`
            (() => {
              // 1. 移除无关的、可能会干扰正文理解的干扰元素
              const badSelectors = [
                'script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript', 
                'aside', '.ads', '#ads', '.sidebar', '.menu', '.navigation', '.footer',
                '.header', '.comment-list', '#comments', '.reply', '.related-posts'
              ];
              badSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => el.remove());
              });

              // 2. 选择正文的主要根容器（优先考虑 article 和 main，其次为 body）
              let root = document.querySelector('article') || document.querySelector('main') || document.body;
              
              // 3. 递归遍历 DOM 并转换为结构化 Markdown
              function parseNode(node) {
                if (node.nodeType === 3) { // 文本节点
                  return node.nodeValue;
                }
                if (node.nodeType !== 1) { // 其它非元素节点直接丢弃
                  return '';
                }

                const tagName = node.tagName.toUpperCase();

                // 忽略被 CSS 隐藏的元素
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') {
                  return '';
                }

                let childText = '';
                node.childNodes.forEach(child => {
                  childText += parseNode(child);
                });

                // 处理不同的标签并翻译成 Markdown 格式
                switch (tagName) {
                  case 'H1':
                    return '\\n\\n# ' + childText.trim() + '\\n\\n';
                  case 'H2':
                    return '\\n\\n## ' + childText.trim() + '\\n\\n';
                  case 'H3':
                    return '\\n\\n### ' + childText.trim() + '\\n\\n';
                  case 'H4':
                  case 'H5':
                  case 'H6':
                    return '\\n\\n#### ' + childText.trim() + '\\n\\n';
                  case 'P':
                    return '\\n\\n' + childText.trim() + '\\n\\n';
                  case 'BR':
                    return '\\n';
                  case 'LI':
                    return '\\n- ' + childText.trim();
                  case 'UL':
                  case 'OL':
                    return '\\n' + childText + '\\n';
                  case 'A':
                    const href = node.getAttribute('href');
                    const linkText = childText.trim();
                    if (href && href.startsWith('http') && linkText && linkText.length < 100) {
                      return ' [' + linkText + '](' + href + ') ';
                    }
                    return ' ' + linkText + ' ';
                  case 'PRE':
                  case 'CODE':
                    if (tagName === 'PRE') {
                      return '\\n\\n\`\`\`\\n' + (node.innerText || node.textContent || '') + '\\n\`\`\`\\n\\n';
                    }
                    return ' \` ' + childText.trim() + ' \` ';
                  case 'DIV':
                    // 如果 div 下只有唯一的文本子节点，增加换行，提高段落可读性
                    if (node.childNodes.length === 1 && node.childNodes[0].nodeType === 3) {
                      return '\\n' + childText.trim() + '\\n';
                    }
                    return childText;
                  default:
                    return childText;
                }
              }

              const title = document.title ? document.title.trim() : '';
              let markdown = parseNode(root);
              
              // 整理连贯空行
              markdown = markdown.replace(/\\n{3,}/g, '\\n\\n').trim();

              return "# " + title + "\\n\\n" + markdown;
            })()
          `)) as string

          cleanup()
          resolve(markdownContent)
        } catch (err) {
          cleanup()
          reject(err)
        }
      })

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        if (isResolved) return
        if (errorCode === -3 || errorCode === -2) {
          return
        }
        cleanup()
        reject(new Error(`网页加载失败: ${errorDescription} (代码: ${errorCode})`))
      })

      win.webContents.on('will-redirect', (event, redirectUrl) => {
        try {
          this.assertSafeRemoteUrl(redirectUrl)
        } catch (err) {
          event.preventDefault()
          cleanup()
          reject(err)
        }
      })

      win.loadURL(url).catch(err => {
        if (isResolved) return
        cleanup()
        reject(err)
      })
    })
  }
}

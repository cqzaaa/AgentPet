import { BrowserWindow } from 'electron'
import { promises as dns } from 'dns'
import { isIP } from 'net'
import { randomUUID } from 'crypto'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

interface BrowserOptions {
  timeoutMs?: number
  abortSignal?: AbortSignal
}

interface SearchOptions extends BrowserOptions {
  maxResults?: number
}

export class LocalBrowser {
  private static readonly DEFAULT_TIMEOUT_MS = 30000
  private static readonly MIN_TIMEOUT_MS = 5000
  private static readonly MAX_TIMEOUT_MS = 120000
  private static automationWindow: BrowserWindow | null = null

  private static normalizeTimeout(timeoutMs?: number): number {
    const value = Number(timeoutMs) || this.DEFAULT_TIMEOUT_MS
    return Math.min(Math.max(value, this.MIN_TIMEOUT_MS), this.MAX_TIMEOUT_MS)
  }

  private static isPrivateIp(ip: string): boolean {
    const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '')
    if (isIP(normalized) === 4) {
      const parts = normalized.split('.').map(Number)
      return (
        parts[0] === 0 ||
        parts[0] === 10 ||
        parts[0] === 127 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        parts[0] >= 224
      )
    }
    if (isIP(normalized) === 6) {
      return (
        normalized === '::' ||
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe80:') ||
        normalized.startsWith('ff') ||
        normalized.startsWith('::ffff:127.') ||
        normalized.startsWith('::ffff:10.') ||
        normalized.startsWith('::ffff:192.168.')
      )
    }
    return false
  }

  private static async assertSafeRemoteUrl(value: string): Promise<URL> {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('无效的网页 URL')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('仅允许抓取 http 或 https 网页')
    }
    if (parsed.username || parsed.password) {
      throw new Error('网页 URL 不得包含用户名或密码')
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      this.isPrivateIp(host)
    ) {
      throw new Error('为保护本机和内网，不允许访问本地或私网地址')
    }

    if (!isIP(host)) {
      let addresses: Array<{ address: string }>
      try {
        addresses = await dns.lookup(host, { all: true, verbatim: true })
      } catch {
        throw new Error(`无法解析网页域名：${host}`)
      }
      if (addresses.length === 0 || addresses.some((item) => this.isPrivateIp(item.address))) {
        throw new Error('为保护本机和内网，该域名解析到了私网或无效地址')
      }
    }
    return parsed
  }

  private static async createHiddenWindow(mode: 'search' | 'fetch'): Promise<BrowserWindow> {
    const isFetch = mode === 'fetch'
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: isFetch,
        webSecurity: true,
        images: false,
        ...(isFetch ? { partition: `agentpet-web-${randomUUID()}` } : {})
      }
    })

    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    )

    // Bing 搜索必须沿用默认 Session，让首页初始化的 MUID/MUIDB Cookie
    // 与后续搜索请求保持一致。隔离分区和请求拦截仅用于任意网页抓取。
    if (!isFetch) return win

    win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false)
    )
    const safetyCache = new Map<string, boolean>()
    win.webContents.session.webRequest.onBeforeRequest(async (details, callback) => {
      try {
        const parsed = new URL(details.url)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          callback({ cancel: false })
          return
        }
        const cacheKey = `${parsed.protocol}//${parsed.hostname}`
        if (!safetyCache.has(cacheKey)) {
          await this.assertSafeRemoteUrl(parsed.toString())
          safetyCache.set(cacheKey, true)
        }
        callback({ cancel: false })
      } catch {
        callback({ cancel: true })
      }
    })

    return win
  }

  public static async localSearch(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ')
    if (!normalizedQuery) throw new Error('搜索关键词不能为空')

    const timeoutMs = this.normalizeTimeout(options.timeoutMs)
    const maxResults = Math.min(Math.max(Number(options.maxResults) || 8, 1), 15)
    const win = await this.createHiddenWindow('search')

    return new Promise<SearchResult[]>((resolve, reject) => {
      let settled = false
      let isSearchPage = false

      const cleanup = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.abortSignal?.removeEventListener('abort', onAbort)
        if (!win.isDestroyed()) win.destroy()
      }
      const fail = (error: unknown): void => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const succeed = (results: SearchResult[]): void => {
        cleanup()
        resolve(results)
      }
      const onAbort = (): void => fail(new Error('UserAborted'))
      const timer = setTimeout(
        () => fail(new Error(`搜索请求超时（${timeoutMs / 1000}秒）`)),
        timeoutMs
      )

      if (options.abortSignal?.aborted) return onAbort()
      options.abortSignal?.addEventListener('abort', onAbort, { once: true })

      win.webContents.on('did-finish-load', async () => {
        if (settled || !isSearchPage) return
        try {
          const response = (await win.webContents.executeJavaScript(`
            (() => {
              const submittedQuery = (document.querySelector('#sb_form_q')?.value || '').trim();
              const pageText = (document.body?.innerText || '').slice(0, 5000);
              const title = document.title || '';
              const list = [];
              const selectors = ['#b_results .b_algo', 'main .b_algo', '#b_results > li'];
              const items = document.querySelectorAll(selectors.join(','));
              items.forEach(item => {
                const titleEl = item.querySelector('h2 a, h3 a');
                const snippetEl = item.querySelector('.b_caption p, .b_algoSlug, p');
                if (!titleEl) return;
                const titleText = titleEl.innerText || titleEl.textContent || '';
                const href = titleEl.getAttribute('href') || '';
                const snippet = snippetEl ? (snippetEl.innerText || snippetEl.textContent || '') : '';
                if (titleText.trim() && (href.startsWith('http://') || href.startsWith('https://'))) {
                  list.push({ title: titleText.trim(), url: href.trim(), snippet: snippet.trim() });
                }
              });
              return { submittedQuery, results: list, pageText, title };
            })()
          `)) as {
            submittedQuery: string
            results: SearchResult[]
            pageText: string
            title: string
          }

          if (
            /captcha|unusual traffic|验证|人机|机器人/i.test(
              `${response.title}\n${response.pageText}`
            )
          ) {
            throw new Error('搜索服务触发了人机验证，请稍后重试')
          }
          const actualQuery = response.submittedQuery.replace(/\s+/g, ' ')
          if (actualQuery && actualQuery !== normalizedQuery) {
            throw new Error(`Bing 搜索词被改写：期望“${normalizedQuery}”，实际为“${actualQuery}”`)
          }

          const seen = new Set<string>()
          const results = response.results
            .filter((item) => {
              try {
                const parsed = new URL(item.url)
                if (!['http:', 'https:'].includes(parsed.protocol)) return false
                parsed.hash = ''
                const key = parsed.toString()
                if (seen.has(key)) return false
                seen.add(key)
                item.url = key
                return true
              } catch {
                return false
              }
            })
            .slice(0, maxResults)

          if (results.length === 0 && response.pageText.trim().length < 100) {
            throw new Error('搜索页面未返回有效内容，可能是网络异常或页面结构已变化')
          }
          succeed(results)
        } catch (error) {
          fail(error)
        }
      })

      win.webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
          if (settled || !isMainFrame || errorCode === -3) return
          fail(new Error(`搜索页面加载失败: ${errorDescription} (代码: ${errorCode})`))
        }
      )

      const searchUrl = new URL('https://www.bing.com/search')
      searchUrl.searchParams.set('q', normalizedQuery)
      searchUrl.searchParams.set('form', 'QBLH')

      // 不添加 count/mkt/setlang 等额外参数，避免 Bing 返回只搜索首个汉字的降级结果。
      win
        .loadURL('https://www.bing.com/')
        .then(() => {
          if (settled) return
          isSearchPage = true
          return win.loadURL(searchUrl.toString())
        })
        .catch(fail)
    })
  }

  public static async localFetch(url: string, options: BrowserOptions = {}): Promise<string> {
    const initialUrl = await this.assertSafeRemoteUrl(url)
    const timeoutMs = this.normalizeTimeout(options.timeoutMs)
    const win = await this.createHiddenWindow('fetch')

    return new Promise<string>((resolve, reject) => {
      let settled = false

      const cleanup = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.abortSignal?.removeEventListener('abort', onAbort)
        if (!win.isDestroyed()) win.destroy()
      }
      const fail = (error: unknown): void => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const succeed = (content: string): void => {
        cleanup()
        resolve(content)
      }
      const onAbort = (): void => fail(new Error('UserAborted'))
      const timer = setTimeout(
        () => fail(new Error(`网页抓取超时（${timeoutMs / 1000}秒）`)),
        timeoutMs
      )

      if (options.abortSignal?.aborted) return onAbort()
      options.abortSignal?.addEventListener('abort', onAbort, { once: true })

      win.webContents.on('did-finish-load', async () => {
        if (settled) return
        try {
          const markdownContent = (await win.webContents.executeJavaScript(`
            (async () => {
              const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
              let previousLength = 0;
              for (let i = 0; i < 4; i++) {
                const length = (document.body?.innerText || '').length;
                if (length > 200 && length === previousLength) break;
                previousLength = length;
                await sleep(350);
              }

              const root = document.querySelector('article') || document.querySelector('main') || document.body;
              if (!root) return '';
              const clonedRoot = root.cloneNode(true);
              const badSelectors = [
                'script', 'style', 'nav', 'footer', 'iframe', 'noscript', 'aside', 'form',
                '.ads', '#ads', '.sidebar', '.menu', '.navigation', '.footer',
                '.comment-list', '#comments', '.reply', '.related-posts', '[aria-hidden="true"]'
              ];
              badSelectors.forEach(selector => clonedRoot.querySelectorAll(selector).forEach(el => el.remove()));

              const escapeMarkdown = value => String(value || '').replace(/[<>]/g, '');
              function parseNode(node, listDepth = 0) {
                if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
                if (node.nodeType !== Node.ELEMENT_NODE) return '';
                const tagName = node.tagName.toUpperCase();
                let childText = '';
                node.childNodes.forEach(child => { childText += parseNode(child, listDepth); });
                const trimmed = childText.trim();
                switch (tagName) {
                  case 'H1': return '\\n\\n# ' + trimmed + '\\n\\n';
                  case 'H2': return '\\n\\n## ' + trimmed + '\\n\\n';
                  case 'H3': return '\\n\\n### ' + trimmed + '\\n\\n';
                  case 'H4': case 'H5': case 'H6': return '\\n\\n#### ' + trimmed + '\\n\\n';
                  case 'P': return trimmed ? '\\n\\n' + trimmed + '\\n\\n' : '';
                  case 'BR': return '\\n';
                  case 'LI': {
                    const parentTag = node.parentElement?.tagName?.toUpperCase();
                    const index = parentTag === 'OL' ? Array.from(node.parentElement.children).indexOf(node) + 1 : 0;
                    return '\\n' + '  '.repeat(listDepth) + (index ? index + '. ' : '- ') + trimmed;
                  }
                  case 'UL': case 'OL': {
                    let text = '';
                    node.childNodes.forEach(child => { text += parseNode(child, listDepth + 1); });
                    return '\\n' + text + '\\n';
                  }
                  case 'A': {
                    const href = node.getAttribute('href');
                    const label = trimmed;
                    if (!href || !label || label.length >= 160) return label;
                    try {
                      const absolute = new URL(href, document.baseURI);
                      return /^https?:$/.test(absolute.protocol) ? ' [' + label + '](' + absolute.href + ') ' : label;
                    } catch { return label; }
                  }
                  case 'IMG': {
                    const alt = escapeMarkdown(node.getAttribute('alt') || '');
                    return alt ? ' [' + alt + '] ' : '';
                  }
                  case 'PRE': return '\\n\\n\`\`\`\\n' + (node.innerText || node.textContent || '') + '\\n\`\`\`\\n\\n';
                  case 'CODE': return node.closest('pre') ? childText : ' \`' + trimmed + '\` ';
                  case 'BLOCKQUOTE': return '\\n\\n' + trimmed.split('\\n').map(line => '> ' + line).join('\\n') + '\\n\\n';
                  case 'TR': return '\\n| ' + Array.from(node.children).map(cell => (cell.innerText || '').trim().split('|').join('\\\\|')).join(' | ') + ' |';
                  case 'TABLE': return '\\n\\n' + childText.trim() + '\\n\\n';
                  case 'DIV': case 'SECTION': return childText;
                  default: return childText;
                }
              }

              const title = (document.querySelector('h1')?.textContent || document.title || location.hostname).trim();
              let markdown = parseNode(clonedRoot).replace(/\\n{3,}/g, '\\n\\n').trim();
              if (!markdown.startsWith('# ')) markdown = '# ' + title + '\\n\\n' + markdown;
              return markdown.slice(0, 1000000);
            })()
          `)) as string
          succeed(markdownContent)
        } catch (error) {
          fail(error)
        }
      })

      win.webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
          if (settled || !isMainFrame || errorCode === -3) return
          fail(new Error(`网页加载失败: ${errorDescription} (代码: ${errorCode})`))
        }
      )

      win.loadURL(initialUrl.toString()).catch(fail)
    })
  }

  /** A visible, agent-owned browser whose web content can be addressed by DOM. */
  public static getAutomationWindowLegacy(): BrowserWindow {
    if (this.automationWindow && !this.automationWindow.isDestroyed()) return this.automationWindow
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: 'AgentPet 浏览器',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    })
    win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    )
    win.on('closed', () => { if (this.automationWindow === win) this.automationWindow = null })
    this.automationWindow = win
    return win
  }

  public static async automationNavigateLegacy(url: string): Promise<{ title: string; url: string }> {
    const safeUrl = await this.assertSafeRemoteUrl(url)
    const win = this.getAutomationWindow()
    await win.loadURL(safeUrl.toString())
    win.show()
    win.focus()
    return {
      title: await win.webContents.executeJavaScript('document.title || ""') as string,
      url: win.webContents.getURL()
    }
  }

  public static async automationSearchLegacy(query: string): Promise<SearchResult[]> {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ')
    if (!normalizedQuery) throw new Error('搜索关键词不能为空')
    const searchUrl = new URL('https://www.bing.com/search')
    searchUrl.searchParams.set('q', normalizedQuery)
    searchUrl.searchParams.set('form', 'QBLH')
    await this.automationNavigate(searchUrl.toString())
    const win = this.getAutomationWindow()
    const results = await win.webContents.executeJavaScript(`
      (() => Array.from(document.querySelectorAll('#b_results .b_algo h2 a, main .b_algo h2 a'))
        .map(anchor => ({
          title: (anchor.innerText || anchor.textContent || '').trim(),
          url: anchor.href || '',
          snippet: (anchor.closest('.b_algo')?.querySelector('.b_caption p, p')?.innerText || '').trim()
        }))
        .filter(item => item.title && /^https?:/i.test(item.url)))()
    `) as SearchResult[]
    return results.slice(0, 12)
  }

  public static async automationSnapshotLegacy(): Promise<{ title: string; url: string; elements: Array<{ role: string; text: string; index: number }> }> {
    const win = this.getAutomationWindow()
    if (win.webContents.isLoading() || !win.webContents.getURL()) throw new Error('受管浏览器尚未打开页面')
    return win.webContents.executeJavaScript(`
      (() => {
        const visible = element => {
          const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const elements = Array.from(document.querySelectorAll('a[href], button, input, textarea, select'))
          .filter(visible).slice(0, 80).map((element, index) => ({
            role: element.matches('a') ? 'link' : element.matches('button') ? 'button' : element.tagName.toLowerCase(),
            text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.value || '').trim().slice(0, 120),
            index: index + 1
          }));
        return { title: document.title || '', url: location.href, elements };
      })()
    `) as Promise<{ title: string; url: string; elements: Array<{ role: string; text: string; index: number }> }>
  }

  public static async automationClickLegacy(input: { target: 'search_result' | 'link' | 'button'; index?: number; text?: string }): Promise<{ title: string; url: string; clickedText: string }> {
    const win = this.getAutomationWindow()
    if (win.webContents.isLoading() || !win.webContents.getURL()) throw new Error('受管浏览器尚未打开页面')
    const target = input.target
    const index = Math.max(1, Number(input.index) || 1)
    const text = String(input.text || '').trim().toLowerCase()
    const result = await win.webContents.executeJavaScript(`
      (() => {
        const target = ${JSON.stringify(target)};
        const index = ${JSON.stringify(index)};
        const wantedText = ${JSON.stringify(text)};
        const selector = target === 'search_result'
          ? '#b_results .b_algo h2 a, main .b_algo h2 a'
          : target === 'button' ? 'button' : 'a[href]';
        let candidates = Array.from(document.querySelectorAll(selector)).filter(element => {
          const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        });
        if (wantedText) candidates = candidates.filter(element => (element.innerText || element.textContent || '').trim().toLowerCase().includes(wantedText));
        const element = candidates[index - 1];
        if (!element) return { error: '目标 DOM 元素不存在' };
        const clickedText = (element.innerText || element.textContent || '').trim();
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        element.click();
        return { clickedText };
      })()
    `) as { error?: string; clickedText?: string }
    if (result.error) throw new Error(result.error)
    await new Promise(resolve => setTimeout(resolve, 350))
    return {
      title: await win.webContents.executeJavaScript('document.title || ""') as string,
      url: win.webContents.getURL(),
      clickedText: result.clickedText || ''
    }
  }

  /** A visible, agent-owned browser whose web content can be addressed by DOM. */
  private static getAutomationWindow(): BrowserWindow {
    if (this.automationWindow && !this.automationWindow.isDestroyed()) return this.automationWindow
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: 'AgentPet 浏览器',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    })
    win.setMenu(null)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    )
    win.on('closed', () => { if (this.automationWindow === win) this.automationWindow = null })
    this.automationWindow = win
    return win
  }

  public static async automationNavigate(url: string): Promise<{ title: string; url: string }> {
    const safeUrl = await this.assertSafeRemoteUrl(url)
    const win = this.getAutomationWindow()
    await win.loadURL(safeUrl.toString())
    win.show()
    win.focus()
    return {
      title: await win.webContents.executeJavaScript('document.title || ""') as string,
      url: win.webContents.getURL()
    }
  }

  public static async automationSearch(query: string): Promise<SearchResult[]> {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ')
    if (!normalizedQuery) throw new Error('搜索关键词不能为空')
    const searchUrl = new URL('https://www.bing.com/search')
    searchUrl.searchParams.set('q', normalizedQuery)
    searchUrl.searchParams.set('form', 'QBLH')
    await this.automationNavigate(searchUrl.toString())
    const win = this.getAutomationWindow()
    const results = await win.webContents.executeJavaScript(`
      (() => Array.from(document.querySelectorAll('#b_results .b_algo h2 a, main .b_algo h2 a'))
        .map(anchor => ({
          title: (anchor.innerText || anchor.textContent || '').trim(),
          url: anchor.href || '',
          snippet: (anchor.closest('.b_algo')?.querySelector('.b_caption p, p')?.innerText || '').trim()
        }))
        .filter(item => item.title && /^https?:/i.test(item.url)))()
    `) as SearchResult[]
    return results.slice(0, 12)
  }

  public static async automationSnapshot(): Promise<{ title: string; url: string; elements: Array<{ role: string; text: string; index: number }> }> {
    const win = this.getAutomationWindow()
    if (win.webContents.isLoading() || !win.webContents.getURL()) throw new Error('受管浏览器尚未打开页面')
    return win.webContents.executeJavaScript(`
      (() => {
        const visible = element => {
          const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const elements = Array.from(document.querySelectorAll('a[href], button, input, textarea, select'))
          .filter(visible).slice(0, 80).map((element, index) => ({
            role: element.matches('a') ? 'link' : element.matches('button') ? 'button' : element.tagName.toLowerCase(),
            text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.value || '').trim().slice(0, 120),
            index: index + 1
          }));
        return { title: document.title || '', url: location.href, elements };
      })()
    `) as Promise<{ title: string; url: string; elements: Array<{ role: string; text: string; index: number }> }>
  }

  public static async automationClick(input: { target: 'search_result' | 'link' | 'button'; index?: number; text?: string }): Promise<{ title: string; url: string; clickedText: string }> {
    const win = this.getAutomationWindow()
    if (win.webContents.isLoading() || !win.webContents.getURL()) throw new Error('受管浏览器尚未打开页面')
    const target = input.target
    const index = Math.max(1, Number(input.index) || 1)
    const text = String(input.text || '').trim().toLowerCase()
    const result = await win.webContents.executeJavaScript(`
      (() => {
        const target = ${JSON.stringify(target)};
        const index = ${JSON.stringify(index)};
        const wantedText = ${JSON.stringify(text)};
        const selector = target === 'search_result'
          ? '#b_results .b_algo h2 a, main .b_algo h2 a'
          : target === 'button' ? 'button' : 'a[href]';
        let candidates = Array.from(document.querySelectorAll(selector)).filter(element => {
          const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        });
        if (wantedText) candidates = candidates.filter(element => (element.innerText || element.textContent || '').trim().toLowerCase().includes(wantedText));
        const element = candidates[index - 1];
        if (!element) return { error: '目标 DOM 元素不存在' };
        const clickedText = (element.innerText || element.textContent || '').trim();
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        element.click();
        return { clickedText };
      })()
    `) as { error?: string; clickedText?: string }
    if (result.error) throw new Error(result.error)
    await new Promise(resolve => setTimeout(resolve, 350))
    return {
      title: await win.webContents.executeJavaScript('document.title || ""') as string,
      url: win.webContents.getURL(),
      clickedText: result.clickedText || ''
    }
  }
}

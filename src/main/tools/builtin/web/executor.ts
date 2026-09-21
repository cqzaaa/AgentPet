import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'
import { promises as dns } from 'dns'
import { isIP } from 'net'
import { BrowserWindow } from 'electron'
import { IToolExecutor, ToolContext, ToolResult, WebSource } from '../../core/types'
import { getActiveStorageDir } from '../../utils/paths'

type SearchResult = { title: string; url: string; snippet: string }
type ExtractedPage = { title: string; markdown: string }

const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 120_000

function normalizeTimeout(seconds: unknown): number {
  const value = Number(seconds) || DEFAULT_TIMEOUT_MS / 1000
  return Math.min(Math.max(value * 1000, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number)
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224
  }
  if (isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe80:') ||
      normalized.startsWith('ff') || normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.')
  }
  return false
}

/**
 * Clash/Mihomo commonly returns synthetic DNS addresses and translates them
 * back to the original hostname inside its proxy stack. They are not the
 * destination server and must not make every public hostname look like SSRF.
 * Keep these ranges blocked when the user supplies them as literal IPs; this
 * exception applies only to DNS answers for an ordinary public hostname.
 */
function isKnownProxyFakeIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number)
    return parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)
  }
  if (isIP(normalized) === 6) return normalized.startsWith('fdfe:dcba:9876:')
  return false
}

async function assertSafeRemoteUrl(value: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('无效的网页 URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅允许访问 http 或 https 网页')
  if (parsed.username || parsed.password) throw new Error('网页 URL 不得包含用户名或密码')

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // Literal reserved/fake addresses remain forbidden. Only a DNS response for
  // a normal hostname may use the known proxy Fake-IP exception below.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      isPrivateIp(host) || isKnownProxyFakeIp(host)) {
    throw new Error('为保护本机和内网，不允许访问本地或私网地址')
  }
  if (!isIP(host)) {
    let addresses: Array<{ address: string }>
    try {
      addresses = await dns.lookup(host, { all: true, verbatim: true })
    } catch {
      throw new Error(`无法解析网页域名：${host}`)
    }
    const unsafeAddresses = addresses.filter(item =>
      isPrivateIp(item.address) && !isKnownProxyFakeIp(item.address)
    )
    if (addresses.length === 0 || unsafeAddresses.length > 0) {
      throw new Error('为保护本机和内网，该域名解析到了私网或无效地址')
    }
  }
  return parsed
}

async function runInHiddenPage<T>(
  url: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  script: string
): Promise<T> {
  await assertSafeRemoteUrl(url)
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      images: false,
      partition: `agentpet-web-${randomUUID()}`
    }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  )
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  const safetyCache = new Map<string, boolean>()
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    void (async () => {
      try {
        const requested = new URL(details.url)
        if (!['http:', 'https:'].includes(requested.protocol)) return callback({ cancel: false })
        const key = `${requested.protocol}//${requested.hostname}`
        if (!safetyCache.has(key)) {
          await assertSafeRemoteUrl(requested.toString())
          safetyCache.set(key, true)
        }
        callback({ cancel: false })
      } catch {
        callback({ cancel: true })
      }
    })()
  })

  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    const operation = (async (): Promise<T> => {
      await win.loadURL(url)
      if (abortSignal?.aborted) throw new Error('UserAborted')
      return await win.webContents.executeJavaScript(script, true) as T
    })()
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`网页请求超时（${timeoutMs / 1000}秒）`)), timeoutMs)
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('UserAborted'))
      if (abortSignal?.aborted) onAbort()
      else abortSignal?.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([operation, timeout, aborted])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

const SEARCH_SCRIPT = String.raw`(() => {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const results = [];
  for (const item of document.querySelectorAll('#b_results .b_algo, main .b_algo, #b_results > li')) {
    const anchor = item.querySelector('h2 a, h3 a');
    if (!anchor) continue;
    const title = clean(anchor.textContent);
    const url = anchor.href || '';
    const snippet = clean(item.querySelector('.b_caption p, .b_algoSlug, p')?.textContent);
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet });
  }
  return results;
})()`

const FETCH_SCRIPT = String.raw`(() => {
  const clone = document.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template,svg,canvas,iframe,nav,footer,form').forEach(node => node.remove());
  const root = clone.querySelector('article, main, [role="main"]') || clone.body || clone.documentElement;
  const clean = value => String(value || '').replace(/[\t\r ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const lines = [];
  const push = value => { const text = clean(value); if (text && lines[lines.length - 1] !== text) lines.push(text); };
  const visit = node => {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      push('#'.repeat(Number(tag[1])) + ' ' + node.textContent);
      return;
    }
    if (tag === 'p' || tag === 'blockquote') {
      push((tag === 'blockquote' ? '> ' : '') + node.textContent);
      return;
    }
    if (tag === 'li') {
      push('- ' + node.textContent);
      return;
    }
    if (tag === 'pre') {
      const fence = String.fromCharCode(96).repeat(3);
      push(fence + '\n' + clean(node.textContent) + '\n' + fence);
      return;
    }
    if (tag === 'table') {
      for (const row of node.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll(':scope > th, :scope > td')].map(cell => clean(cell.textContent));
        if (cells.length) push('| ' + cells.join(' | ') + ' |');
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  if (!lines.length) push(root.innerText || root.textContent);
  return { title: clean(document.title), markdown: lines.join('\n\n') };
})()`

export class WebExecutor implements IToolExecutor {
  public async execute(api: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      if (api === 'web_search') return await this.search(args, context)
      if (api === 'web_fetch') return await this.fetch(args, context)
      return { content: `未知的网页操作：${api}`, success: false }
    } catch (error) {
      if (error instanceof Error && error.message === 'UserAborted') throw error
      const message = error instanceof Error ? error.message : String(error)
      return { content: `网页工具执行失败：${message}`, success: false, error: { message } }
    }
  }

  private async search(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = String(args.query || '').trim()
    if (!query) return { content: '错误：缺少必要参数 query', success: false }
    const maxResults = Math.min(Math.max(Number(args.max_results) || 8, 1), 15)
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`
    const results = (await runInHiddenPage<SearchResult[]>(
      searchUrl,
      normalizeTimeout(args.timeout_seconds),
      context.abortSignal,
      SEARCH_SCRIPT
    )).slice(0, maxResults)
    if (!results.length) return { content: `未找到与“${query}”相关的搜索结果。`, success: true }

    const fetchedAt = new Date().toISOString()
    const sources: WebSource[] = results.map((result, index) => ({
      id: `S${index + 1}`,
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      fetchedAt,
      sourceType: 'search'
    }))
    const content = sources.map(source =>
      `[${source.id}] 标题: ${source.title}\nURL: ${source.url}\n摘要: ${source.snippet || '无'}`
    ).join('\n\n')
    return {
      content: `<web_sources>\n${content}\n</web_sources>\n\n回答中对依赖网页的事实必须引用对应来源 ID。`,
      state: { sources },
      success: true
    }
  }

  private async fetch(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawUrl = String(args.url || '').trim()
    if (!rawUrl) return { content: '错误：缺少必要参数 url', success: false }
    const parsedUrl = await assertSafeRemoteUrl(rawUrl)
    parsedUrl.hash = ''
    const normalizedUrl = parsedUrl.toString()
    const cacheTtlMs = Math.min(Math.max(Number(args.cache_ttl_seconds ?? 1800), 0), 86400) * 1000
    const safeSessionId = context.sessionId
      ? context.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      : 'default_session'
    const cacheDir = path.join(getActiveStorageDir(), 'chat', safeSessionId, '.agentpet_cache')
    await fs.promises.mkdir(cacheDir, { recursive: true })
    const hash = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 20)
    const cacheFileName = `web_fetch_${hash}.md`
    const cacheFilePath = path.join(cacheDir, cacheFileName)
    let markdown = ''
    let cacheHit = false

    if (cacheTtlMs > 0) {
      try {
        const stat = await fs.promises.stat(cacheFilePath)
        if (Date.now() - stat.mtimeMs <= cacheTtlMs) {
          markdown = await fs.promises.readFile(cacheFilePath, 'utf8')
          cacheHit = Boolean(markdown.trim())
        }
      } catch {
        // A missing or expired cache is an ordinary network-fetch path.
      }
    }

    let title = parsedUrl.hostname
    if (!cacheHit) {
      const page = await runInHiddenPage<ExtractedPage>(
        normalizedUrl,
        normalizeTimeout(args.timeout_seconds),
        context.abortSignal,
        FETCH_SCRIPT
      )
      title = page.title || title
      markdown = `# ${title}\n\n${page.markdown}`.trim()
      if (!page.markdown.trim()) return { content: '成功加载网页，但未提取到正文文本。', success: false }
      await fs.promises.writeFile(cacheFilePath, markdown, 'utf8')
    } else {
      title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || title
    }

    const previewLength = 4000
    const preview = markdown.length > previewLength
      ? `${markdown.slice(0, previewLength)}\n\n...[以下省略 ${markdown.length - previewLength} 字符]`
      : markdown
    const relativePath = `.agentpet_cache/${cacheFileName}`
    const source: WebSource = {
      id: 'S1',
      title,
      url: normalizedUrl,
      snippet: markdown.replace(/^#.+\n*/, '').replace(/\s+/g, ' ').slice(0, 300),
      fetchedAt: new Date().toISOString(),
      sourceType: 'fetch'
    }
    return {
      content: `<web_sources>\n[S1] 标题: ${source.title}\nURL: ${source.url}\n摘要: ${source.snippet}\n</web_sources>\n` +
        `回答中对依赖本网页的事实必须引用 [S1]。\n\n` +
        `【网页${cacheHit ? '缓存复用' : '抓取成功'}】\n全文缓存：${cacheFilePath}\n\n${preview}\n\n` +
        `完整内容可用 read_file 读取：${relativePath}`,
      state: { sources: [source], cacheFilePath, cacheHit },
      success: true
    }
  }

  public getApiNames(): string[] {
    return ['web_search', 'web_fetch']
  }
}

export const webExecutor = new WebExecutor()

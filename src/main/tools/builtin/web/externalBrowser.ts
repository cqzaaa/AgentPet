import { Browser, BrowserContext, chromium, Frame, Locator, Page } from 'playwright-core'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import { basename, join } from 'path'

const execFileAsync = promisify(execFile)

export interface DomSearchResult {
  title: string
  url: string
  snippet: string
}

export interface DomElementSnapshot {
  ref: string
  depth: number
  parentRef?: string
  tag: string
  role: string
  roleIndex?: number
  text: string
  visible: boolean
  interactive: boolean
  attributes: Record<string, string>
  shadowRoot: boolean
}

export interface DomFrameSnapshot {
  index: number
  name: string
  url: string
  elements: DomElementSnapshot[]
  error?: string
}

export interface BrowserDomSnapshot {
  snapshotId: number
  title: string
  url: string
  totalElements: number
  truncated: boolean
  frames: DomFrameSnapshot[]
}

export interface BrowserTabSummary {
  id: string
  title: string
  url: string
  selected: boolean
}

export interface BrowserActionPreview {
  action: 'navigate' | 'interact' | 'external-state'
  currentUrl: string
  destinationUrl?: string
  label: string
  requiresConfirmation: boolean
  reason?: string
}

type BrowserActionGuard = (preview: BrowserActionPreview) => Promise<boolean>

interface BrowserLaunchTarget {
  executable: string
  processName: string
  label: string
}

/** Connects to the user's Edge/Chrome via CDP; never creates an Electron browser. */
export class ExternalBrowser {
  private static browser: Browser | null = null
  private static context: BrowserContext | null = null
  private static page: Page | null = null
  private static readonly endpoint = 'http://127.0.0.1:9222'
  private static snapshotSequence = 0
  private static readonly maxSnapshotElements = 2_000
  private static latestSnapshot: { id: number; page: Page; url: string } | null = null
  private static readonly pageIds = new WeakMap<Page, string>()
  private static pageSequence = 0

  private static automationProfilePath(): string {
    const base = process.env.LOCALAPPDATA || process.cwd()
    const profile = join(base, 'AgentPet', 'browser-automation-profile')
    mkdirSync(profile, { recursive: true })
    return profile
  }

  private static unwrapBingRedirect(url: string): string {
    try {
      const parsed = new URL(url)
      const encoded = parsed.searchParams.get('u') || ''
      if (/bing\.com$/i.test(parsed.hostname) && encoded.startsWith('a1')) {
        const decoded = Buffer.from(encoded.slice(2), 'base64').toString('utf8')
        if (/^https?:\/\//i.test(decoded)) return decoded
      }
    } catch {
      /* retain the original link */
    }
    return url
  }

  private static async previewAction(
    page: Page,
    element: Locator,
    href?: string | null
  ): Promise<BrowserActionPreview> {
    const details = await element.evaluate((node) => {
      const target = node as HTMLElement
      const form = target.closest('form') as HTMLFormElement | null
      return {
        tag: target.tagName.toLowerCase(),
        type: (target.getAttribute('type') || '').toLowerCase(),
        label: (
          target.innerText ||
          target.textContent ||
          target.getAttribute('aria-label') ||
          target.getAttribute('title') ||
          target.getAttribute('name') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim(),
        formMethod: (form?.method || '').toLowerCase()
      }
    })
    const label = details.label.slice(0, 160) || details.tag
    if (href) {
      const parsedHref = new URL(href, page.url())
      return {
        action: 'navigate',
        currentUrl: page.url(),
        destinationUrl: parsedHref.toString(),
        label,
        requiresConfirmation: false
      }
    }

    const riskyLabel =
      /(submit|send|post|publish|delete|remove|erase|buy|purchase|pay|checkout|order|book|reserve|subscribe|unsubscribe|upload|authorize|allow|grant|save password|sign in|log in|create account|提交|发送|发布|删除|移除|购买|支付|结算|下单|预约|预订|订阅|退订|上传|授权|允许|保存密码|登录|注册)/i.test(
        label
      )
    const formSubmission = details.type === 'submit' || details.formMethod === 'post'
    const externalState = riskyLabel || formSubmission
    return {
      action: externalState ? 'external-state' : 'interact',
      currentUrl: page.url(),
      label,
      requiresConfirmation: externalState,
      reason: externalState ? '该控件可能提交表单、发送数据，或改变网站/账户状态。' : undefined
    }
  }

  private static async authorizeAction(
    preview: BrowserActionPreview,
    guard?: BrowserActionGuard
  ): Promise<void> {
    if (!preview.requiresConfirmation) return
    if (!guard || !(await guard(preview))) throw new Error(`用户未批准浏览器操作：${preview.label}`)
  }

  private static async tryConnect(): Promise<boolean> {
    try {
      this.browser = await chromium.connectOverCDP(this.endpoint, { timeout: 2500 })
      return true
    } catch {
      return false
    }
  }

  private static executableFromCommand(command: string): string | null {
    const quoted = command.match(/"([^"\r\n]+?\.exe)"/i)?.[1]
    const unquoted = command.match(/^\s*([^\r\n]+?\.exe)(?:\s|$)/i)?.[1]
    const executable = (quoted || unquoted || '').trim()
    return executable && existsSync(executable) ? executable : null
  }

  private static async findDefaultBrowser(): Promise<BrowserLaunchTarget | null> {
    try {
      const { stdout: choice } = await execFileAsync(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
          '/v',
          'ProgId'
        ],
        { timeout: 5000 }
      )
      const progId = choice.match(/ProgId\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim()
      if (!progId) return null
      const { stdout: command } = await execFileAsync(
        'reg.exe',
        ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'],
        { timeout: 5000 }
      )
      const rawCommand = command.match(/REG_SZ\s+(.+)\s*$/m)?.[1] || ''
      const executable = this.executableFromCommand(rawCommand)
      if (!executable) return null
      const processName = basename(executable, '.exe')
      // Playwright's connectOverCDP can only drive Chromium-family browsers.
      if (!/(?:msedge|chrome|brave|opera|vivaldi|chromium)/i.test(processName)) return null
      return { executable, processName, label: processName }
    } catch {
      return null
    }
  }

  private static async findEdgeExecutable(): Promise<string | null> {
    const candidates = [
      process.env['ProgramFiles(x86)']
        ? `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
        : '',
      process.env.ProgramFiles
        ? `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
        : '',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean)
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    try {
      const { stdout } = await execFileAsync(
        'reg.exe',
        [
          'query',
          'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
          '/ve'
        ],
        { timeout: 5000 }
      )
      const match = stdout.match(/REG_SZ\s+(.+)\s*$/m)
      if (match && existsSync(match[1].trim())) return match[1].trim()
    } catch {
      /* no registry or PATH entry */
    }
    try {
      const { stdout } = await execFileAsync('where.exe', ['msedge.exe'], { timeout: 5000 })
      const candidate = stdout.trim().split(/\r?\n/).find(existsSync)
      if (candidate) return candidate
    } catch {
      /* Edge is not on PATH */
    }
    return null
  }

  private static async launchOrRestartDefaultBrowser(): Promise<void> {
    const defaultBrowser = await this.findDefaultBrowser()
    const fallbackEdge = defaultBrowser ? null : await this.findEdgeExecutable()
    const target: BrowserLaunchTarget | null =
      defaultBrowser ||
      (fallbackEdge
        ? { executable: fallbackEdge, processName: 'msedge', label: 'Microsoft Edge' }
        : null)
    if (!target) {
      throw new Error(
        'No CDP-compatible default browser was found. Set Edge, Chrome, Brave, Opera, or Vivaldi as the Windows default browser, then retry.'
      )
    }
    const selectedTarget = target
    // An isolated profile is required by current Chromium builds before they
    // expose a remote-debugging port. Never close or restart the user's normal
    // browser process to obtain automation access.
    const edge = selectedTarget.executable
    if (!edge) throw new Error('未找到 Microsoft Edge。')
    spawn(
      edge,
      [
        '--remote-debugging-port=9222',
        `--user-data-dir=${this.automationProfilePath()}`,
        '--no-first-run',
        '--no-default-browser-check'
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    ).unref()
  }

  private static async ensureConnection(): Promise<BrowserContext> {
    if (!this.browser || !this.browser.isConnected()) {
      if (!(await this.tryConnect())) {
        await this.launchOrRestartDefaultBrowser()
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 750))
          if (await this.tryConnect()) break
        }
        if (!this.browser || !this.browser.isConnected()) {
          throw new Error('Edge 已启动，但 CDP 调试端口尚未就绪。请稍后重试。')
        }
      }
    }
    const browser = this.browser
    if (!browser) throw new Error('浏览器连接未建立')
    this.context = browser.contexts()[0] || null
    if (!this.context) throw new Error('浏览器 CDP 已连接，但没有可用上下文')
    return this.context
  }

  private static pageId(page: Page): string {
    let id = this.pageIds.get(page)
    if (!id) {
      id = `tab-${++this.pageSequence}`
      this.pageIds.set(page, id)
    }
    return id
  }

  private static selectablePages(context: BrowserContext): Page[] {
    return context
      .pages()
      .filter((page) => !page.isClosed() && !page.url().startsWith('devtools://'))
  }

  public static async listTabs(): Promise<BrowserTabSummary[]> {
    const context = await this.ensureConnection()
    return Promise.all(
      this.selectablePages(context).map(async (page) => ({
        id: this.pageId(page),
        title: await page.title().catch(() => ''),
        url: page.url(),
        selected: page === this.page
      }))
    )
  }

  public static async selectTab(
    tabId: string
  ): Promise<{ title: string; url: string; tabId: string }> {
    const context = await this.ensureConnection()
    const normalizedId = String(tabId || '').trim()
    const matches = this.selectablePages(context).filter(
      (page) => this.pageId(page) === normalizedId
    )
    if (matches.length !== 1) {
      throw new Error(
        `浏览器标签页 ${normalizedId || '(empty)'} 不存在或已失效，请重新调用 browser_tabs。`
      )
    }
    this.page = matches[0]
    this.latestSnapshot = null
    await this.page.bringToFront()
    return {
      title: await this.page.title().catch(() => ''),
      url: this.page.url(),
      tabId: normalizedId
    }
  }

  public static async connect(): Promise<{ title: string; url: string; tabId: string }> {
    const context = await this.ensureConnection()
    if (!this.page || this.page.isClosed()) {
      const pages = this.selectablePages(context)
      if (pages.length === 0) {
        this.page = await context.newPage()
      } else if (pages.length === 1) {
        this.page = pages[0]
      } else {
        throw new Error(
          `检测到 ${pages.length} 个可操作标签页，无法安全地猜测目标。请先调用 browser_tabs，再用 browser_select_tab(tab_id) 明确选择。`
        )
      }
    }
    await this.page.bringToFront()
    return {
      title: await this.page.title().catch(() => ''),
      url: this.page.url(),
      tabId: this.pageId(this.page)
    }
  }

  private static async getPage(): Promise<Page> {
    await this.connect()
    if (!this.page) throw new Error('没有可操作的浏览器页面')
    return this.page
  }

  public static async navigate(url: string): Promise<{ title: string; url: string }> {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new Error('仅允许打开 http 或 https URL')
    const page = await this.getPage()
    this.latestSnapshot = null
    await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return { title: await page.title(), url: page.url() }
  }

  public static async search(query: string): Promise<DomSearchResult[]> {
    const normalized = String(query || '')
      .trim()
      .replace(/\s+/g, ' ')
    if (!normalized) throw new Error('搜索关键词不能为空')
    const page = await this.getPage()
    this.latestSnapshot = null
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(normalized)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    })
    await page
      .locator('#b_results .b_algo h2 a, main .b_algo h2 a')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
    return page.locator('#b_results .b_algo h2 a, main .b_algo h2 a').evaluateAll((anchors) =>
      anchors
        .slice(0, 12)
        .map((anchor) => ({
          title: (anchor.textContent || '').trim(),
          url: (anchor as HTMLAnchorElement).href,
          snippet: (
            anchor.closest('.b_algo')?.querySelector('.b_caption p, p')?.textContent || ''
          ).trim()
        }))
        .filter((item) => item.title && /^https?:/i.test(item.url))
    )
  }

  public static async click(
    input: { target: 'search_result' | 'link' | 'button'; index?: number; text?: string },
    guard?: BrowserActionGuard
  ): Promise<{ title: string; url: string; clickedText: string }> {
    const page = await this.getPage()
    const context = this.context
    if (!context) throw new Error('浏览器上下文不可用')
    if (
      /^https?:\/\/(?:www\.)?bing\.com\/search/i.test(page.url()) &&
      input.target !== 'search_result'
    ) {
      throw new Error(
        '当前是搜索结果页。为避免点击 Copilot、广告或导航栏，必须使用 browser_click(target="search_result", index=...)。'
      )
    }
    const selector =
      input.target === 'search_result'
        ? '#b_results .b_algo h2 a, main .b_algo h2 a'
        : input.target === 'button'
          ? 'button'
          : 'a[href]'
    let locator = page.locator(selector)
    if (input.text?.trim()) locator = locator.filter({ hasText: input.text.trim() })
    const element = locator.nth(Math.max(0, (Number(input.index) || 1) - 1))
    await element.waitFor({ state: 'visible', timeout: 10_000 })
    const clickedText = ((await element.textContent()) || '').trim()
    await element.scrollIntoViewIfNeeded()
    const href = input.target !== 'button' ? await element.getAttribute('href') : null
    await this.authorizeAction(await this.previewAction(page, element, href), guard)
    this.latestSnapshot = null
    // Links, including search results, always preserve the current page and
    // open their destination in a new real-browser tab. Buttons keep their
    // native same-page behavior for forms, dialogs, and toggles.
    if (input.target !== 'button') {
      if (!href) throw new Error(`链接没有可打开的 URL：${clickedText}`)
      const targetPage = await context.newPage()
      const parsedHref = new URL(href, page.url())
      if (!['http:', 'https:'].includes(parsedHref.protocol))
        throw new Error(`仅允许打开 http 或 https 链接：${clickedText}`)
      const absoluteHref = parsedHref.toString()
      await targetPage.goto(this.unwrapBingRedirect(absoluteHref), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
      this.page = targetPage
      await targetPage.bringToFront()
      return { title: await targetPage.title().catch(() => ''), url: targetPage.url(), clickedText }
    }
    const previousUrl = page.url()
    const navigation = page
      .waitForURL((url) => url.toString() !== previousUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 10_000
      })
      .then(() => page)
      .catch(() => null)
    const popup = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null)
    await element.click({ timeout: 10_000 })
    const settledPage = new Promise<Page>((resolve) => setTimeout(() => resolve(page), 800))
    const targetPage = (await Promise.race([navigation, popup, settledPage])) || page
    this.page = targetPage
    await targetPage
      .waitForLoadState('domcontentloaded', { timeout: 10_000 })
      .catch(() => undefined)
    return { title: await targetPage.title().catch(() => ''), url: targetPage.url(), clickedText }
  }

  private static async findRefLocator(
    page: Page,
    ref: string
  ): Promise<{ frame: Frame; locator: Locator } | null> {
    for (const frame of page.frames()) {
      const locator = frame.locator(`[data-agentpet-ref="${ref}"]`)
      if (await locator.count().catch(() => 0)) return { frame, locator: locator.first() }
    }
    return null
  }

  public static async clickByRef(
    ref: string,
    guard?: BrowserActionGuard
  ): Promise<{ title: string; url: string; clickedText: string }> {
    const page = await this.getPage()
    const context = this.context
    if (!context) throw new Error('Browser context is unavailable')
    const normalizedRef = String(ref || '').trim()
    if (!normalizedRef) throw new Error('DOM ref cannot be empty')
    const snapshotId = Number(normalizedRef.match(/^ap-(\d+)-/)?.[1])
    if (!snapshotId || !this.latestSnapshot || this.latestSnapshot.id !== snapshotId) {
      throw new Error(
        `DOM ref 已过期：${normalizedRef}。ref 只能用于最近一次 browser_snapshot，请重新获取快照。`
      )
    }
    if (this.latestSnapshot.page !== page || this.latestSnapshot.url !== page.url()) {
      this.latestSnapshot = null
      throw new Error('页面或 URL 已在快照后发生变化，请重新调用 browser_snapshot。')
    }
    const found = await this.findRefLocator(page, normalizedRef)
    if (!found)
      throw new Error(`DOM ref is stale or missing: ${normalizedRef}. Call browser_snapshot again.`)

    const element = found.locator
    await element.waitFor({ state: 'visible', timeout: 10_000 })
    await element.scrollIntoViewIfNeeded()
    const clickedText = (
      (await element.textContent()) ||
      (await element.getAttribute('aria-label')) ||
      (await element.getAttribute('title')) ||
      ''
    ).trim()
    const tagName = await element.evaluate((node) => node.tagName.toLowerCase())
    const href = tagName === 'a' ? await element.getAttribute('href') : null
    await this.authorizeAction(await this.previewAction(page, element, href), guard)
    this.latestSnapshot = null

    if (href) {
      const targetPage = await context.newPage()
      const parsedHref = new URL(href, found.frame.url())
      if (!['http:', 'https:'].includes(parsedHref.protocol))
        throw new Error(`仅允许打开 http 或 https 链接：${clickedText}`)
      const absoluteHref = parsedHref.toString()
      await targetPage.goto(this.unwrapBingRedirect(absoluteHref), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
      this.page = targetPage
      await targetPage.bringToFront()
      return { title: await targetPage.title().catch(() => ''), url: targetPage.url(), clickedText }
    }

    const previousUrl = page.url()
    const navigation = page
      .waitForURL((url) => url.toString() !== previousUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 3_000
      })
      .then(() => page)
      .catch(() => null)
    const popup = context.waitForEvent('page', { timeout: 3_000 }).catch(() => null)
    await element.click({ timeout: 10_000 })
    const settledPage = new Promise<Page>((resolve) => setTimeout(() => resolve(page), 800))
    const targetPage = (await Promise.race([navigation, popup, settledPage])) || page
    this.page = targetPage
    await targetPage.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined)
    return { title: await targetPage.title().catch(() => ''), url: targetPage.url(), clickedText }
  }

  public static async snapshotFull(): Promise<BrowserDomSnapshot> {
    const page = await this.getPage()
    const snapshotId = ++this.snapshotSequence
    const frames: DomFrameSnapshot[] = []
    let remainingElements = this.maxSnapshotElements
    let truncated = false

    for (const [frameIndex, frame] of page.frames().entries()) {
      try {
        if (remainingElements <= 0) {
          truncated = true
          frames.push({ index: frameIndex, name: frame.name(), url: frame.url(), elements: [] })
          continue
        }
        const frameResult = await frame.evaluate(
          ({ snapshotId, frameIndex, maxElements }) => {
            const result: DomElementSnapshot[] = []
            const roleCounts: Record<string, number> = {}
            let sequence = 0
            let truncated = false

            const isVisible = (element: Element): boolean => {
              const style = getComputedStyle(element)
              const rect = element.getBoundingClientRect()
              return (
                style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                Number(style.opacity || 1) !== 0 &&
                rect.width > 0 &&
                rect.height > 0
              )
            }
            const directText = (element: Element): string =>
              Array.from(element.childNodes)
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
            const inferredRole = (element: Element): string => {
              const explicit = element.getAttribute('role')
              if (explicit) return explicit
              const tag = element.tagName.toLowerCase()
              if (tag === 'a' && element.hasAttribute('href')) return 'link'
              if (tag === 'button') return 'button'
              if (tag === 'input') {
                const type = (element.getAttribute('type') || 'text').toLowerCase()
                return ['button', 'submit', 'reset'].includes(type) ? 'button' : 'input'
              }
              if (tag === 'textarea' || tag === 'select') return tag
              return tag
            }
            const isInteractive = (element: Element, role: string): boolean => {
              const tag = element.tagName.toLowerCase()
              return (
                ['a', 'button', 'input', 'textarea', 'select', 'option', 'summary'].includes(tag) ||
                [
                  'button',
                  'link',
                  'checkbox',
                  'radio',
                  'tab',
                  'menuitem',
                  'switch',
                  'textbox',
                  'combobox'
                ].includes(role) ||
                element.hasAttribute('tabindex') ||
                element.hasAttribute('onclick') ||
                getComputedStyle(element).cursor === 'pointer'
              )
            }
            const safeAttributes = (element: Element): Record<string, string> =>
              Object.fromEntries(
                Array.from(element.attributes)
                  .filter((attribute) => {
                    const name = attribute.name.toLowerCase()
                    return (
                      name === 'id' ||
                      name === 'class' ||
                      name === 'role' ||
                      name === 'type' ||
                      name === 'name' ||
                      name === 'href' ||
                      name === 'src' ||
                      name === 'alt' ||
                      name === 'title' ||
                      name === 'placeholder' ||
                      name === 'for' ||
                      name === 'action' ||
                      name === 'method' ||
                      name === 'target' ||
                      name === 'rel' ||
                      name === 'disabled' ||
                      name === 'checked' ||
                      name === 'selected' ||
                      name === 'tabindex' ||
                      name.startsWith('aria-') ||
                      name === 'data-testid' ||
                      name === 'data-test'
                    )
                  })
                  .map((attribute) => {
                    if (
                      attribute.name === 'href' ||
                      attribute.name === 'src' ||
                      attribute.name === 'action'
                    ) {
                      try {
                        const parsed = new URL(attribute.value, location.href)
                        parsed.username = ''
                        parsed.password = ''
                        parsed.search = parsed.search ? '?[redacted]' : ''
                        parsed.hash = ''
                        return [attribute.name, parsed.toString()]
                      } catch {
                        return [attribute.name, '[invalid-url]']
                      }
                    }
                    return [attribute.name, attribute.value.slice(0, 500)]
                  })
              )
            const walk = (
              element: Element,
              depth: number,
              parentRef?: string,
              inShadowRoot = false
            ): void => {
              if (result.length >= maxElements) {
                truncated = true
                return
              }
              const role = inferredRole(element)
              const interactive = isInteractive(element, role)
              const tag = element.tagName.toLowerCase()
              const visible = isVisible(element)
              const inputType =
                tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : ''
              const sensitiveInput = tag === 'input' && ['hidden', 'password'].includes(inputType)
              const structural = [
                'html',
                'body',
                'main',
                'nav',
                'form',
                'section',
                'article',
                'header',
                'footer',
                'dialog'
              ].includes(tag)
              const include = !sensitiveInput && (visible || interactive || structural)
              const ref = include ? `ap-${snapshotId}-${frameIndex}-${++sequence}` : parentRef
              if (include) element.setAttribute('data-agentpet-ref', ref!)
              const roleIndex = interactive
                ? (roleCounts[role] = (roleCounts[role] || 0) + 1)
                : undefined
              const fallbackText =
                element.getAttribute('aria-label') ||
                element.getAttribute('placeholder') ||
                element.getAttribute('title')
              if (include) {
                result.push({
                  ref: ref!,
                  depth,
                  parentRef,
                  tag,
                  role,
                  roleIndex,
                  text: (directText(element) || fallbackText || '').slice(0, 500),
                  visible,
                  interactive,
                  attributes: safeAttributes(element),
                  shadowRoot: inShadowRoot
                })
              }
              const childParentRef = include ? ref : parentRef
              for (const child of Array.from(element.children))
                walk(child, include ? depth + 1 : depth, childParentRef, inShadowRoot)
              if (element.shadowRoot) {
                for (const child of Array.from(element.shadowRoot.children))
                  walk(child, include ? depth + 1 : depth, childParentRef, true)
              }
              if (element instanceof HTMLTemplateElement) {
                for (const child of Array.from(element.content.children))
                  walk(child, include ? depth + 1 : depth, childParentRef, inShadowRoot)
              }
            }

            if (document.documentElement) walk(document.documentElement, 0)
            return { elements: result, truncated }
          },
          { snapshotId, frameIndex, maxElements: remainingElements }
        )
        const elements = frameResult.elements
        remainingElements -= elements.length
        truncated ||= frameResult.truncated
        frames.push({ index: frameIndex, name: frame.name(), url: frame.url(), elements })
      } catch (error) {
        frames.push({
          index: frameIndex,
          name: frame.name(),
          url: frame.url(),
          elements: [],
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const snapshot = {
      snapshotId,
      title: await page.title().catch(() => ''),
      url: page.url(),
      totalElements: frames.reduce((total, frame) => total + frame.elements.length, 0),
      truncated,
      frames
    }
    this.latestSnapshot = { id: snapshotId, page, url: snapshot.url }
    return snapshot
  }

  public static async snapshot(): Promise<{
    title: string
    url: string
    elements: Array<{ role: string; text: string; index: number }>
  }> {
    const page = await this.getPage()
    return page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0
        )
      }
      const elements = Array.from(
        document.querySelectorAll('a[href], button, input, textarea, select')
      )
        .filter(visible)
        .slice(0, 80)
        .map((element, index) => ({
          role: element.matches('a')
            ? 'link'
            : element.matches('button')
              ? 'button'
              : element.tagName.toLowerCase(),
          text: (
            element.textContent ||
            element.getAttribute('aria-label') ||
            element.getAttribute('placeholder') ||
            (element as HTMLInputElement).value ||
            ''
          )
            .trim()
            .slice(0, 120),
          index: index + 1
        }))
      return { title: document.title, url: location.href, elements }
    })
  }
}

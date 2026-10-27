type ResearchResult = {
  toolName: string
  toolArgs: Record<string, unknown>
  toolSuccess: boolean
  toolState?: { researchStatus?: string; sources?: Array<{ url: string }>; links?: Array<{ url: string }> }
  displayResult: string
}

function isNetworkScript(name: string, args: Record<string, unknown>): boolean {
  if (!['run_python', 'run_terminal_command', 'run_command'].includes(name)) return false
  const script = String(args.code || args.command || '')
  return /https?:\/\//i.test(script) && /urllib|requests\.|httpx\.|fetch\s*\(|Invoke-WebRequest|Invoke-RestMethod|curl(?:\.exe)?\b|wget\b/i.test(script)
}

const RECOVERY = '[网页检索纠偏] 连续尝试未获得可靠进展。停止猜测下载地址、仓库路径或论文编号。请改写关键词并用 web_search 获取真实候选，随后 web_fetch 打开来源页和链接；也可读取已下载文件核验真实标题与正文。受限页面使用 desktop-control，403/429 不要反复重试。未核验的下载不能计为完成。'
const WEB_FETCH_REQUIRED = '[网页研究路由保护] web_search 已返回候选来源，但尚未打开任何来源正文。当前必须先调用 web_fetch 打开最相关的候选 URL；不要改用 Python、终端、curl、PowerShell、重复搜索或直接下载来绕过正文核验。若 web_fetch 无法读取该来源，再更换候选、搜索方式或使用 desktop-control。'

function literalUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s"'<>`\\)\]]+/g) || []).flatMap(value => {
    // Dynamic URLs must be checked through their actual returned source, not guessed by a regex.
    if (/[{}$]/.test(value)) return []
    try { const url = new URL(value); url.hash = ''; return [url.href] } catch { return [] }
  })
}

/** Scoped to a research workflow; does not interfere with ordinary coding scripts. */
export class WebResearchProgress {
  private active = false
  private failedScripts = 0
  private searchesWithoutPage = 0
  private awaitingCandidatePage = false
  private knownUrls = new Set<string>()

  constructor(sourceHistory: string[] = []) {
    for (const text of sourceHistory) this.rememberUrls(text)
  }

  private rememberUrls(text: string): void {
    for (const url of literalUrls(text)) this.knownUrls.add(url)
  }

  beforeCall(name: string, args: Record<string, unknown>): string | undefined {
    if (name === 'web_download' && typeof args.url === 'string') {
      this.rememberUrls(args.url)
    }
    if (this.awaitingCandidatePage && (name === 'web_search' || name === 'web_download' || isNetworkScript(name, args))) {
      return WEB_FETCH_REQUIRED
    }
    if (this.active && this.failedScripts >= 3 && isNetworkScript(name, args)) return RECOVERY
    if (this.active && isNetworkScript(name, args)) {
      const unknown = literalUrls(String(args.code || args.command || '')).filter(url => {
        const parsed = new URL(url)
        const document = /\.(?:pdf|docx?|xlsx?|pptx?|zip)$/i.test(parsed.pathname) || parsed.hostname === 'raw.githubusercontent.com'
        return document && !this.knownUrls.has(url)
      })
      if (unknown.length) return `[资料来源校验] 此脚本包含尚未从用户消息或工具返回的来源中确认的文档链接：\n${unknown.slice(0, 5).join('\n')}\n请先用 web_search/web_fetch 找到真实来源与下载链接，或通过公开 API 获取实际路径；不要填写猜测的论文编号或文件路径。`
    }
    return undefined
  }

  observe(result: ResearchResult): string | undefined {
    for (const source of [...(result.toolState?.sources || []), ...(result.toolState?.links || [])]) this.rememberUrls(source.url)
    if (result.toolSuccess && (isNetworkScript(result.toolName, result.toolArgs) || ['read_file', 'run_office_skill', 'web_download'].includes(result.toolName))) {
      this.rememberUrls(result.displayResult)
    }
    if (result.toolName === 'web_search') {
      this.active = true
      this.searchesWithoutPage++
      if (result.toolSuccess && result.toolState?.researchStatus === 'candidates' && result.toolState.sources?.length) {
        this.awaitingCandidatePage = true
      }
      if (!result.toolSuccess || this.searchesWithoutPage >= 3) return RECOVERY
    }
    if (result.toolName === 'web_fetch') {
      this.active = true
      // A real fetch attempt satisfies the search -> open-page routing step. If
      // it fails, recovery may search again or try another candidate/source.
      this.awaitingCandidatePage = false
      if (result.toolSuccess && result.toolState?.researchStatus === 'page_read') {
        this.failedScripts = 0
        this.searchesWithoutPage = 0
      } else return RECOVERY
    }
    if (result.toolName === 'web_download') {
      this.active = true
      if (typeof result.toolArgs.url === 'string') this.rememberUrls(result.toolArgs.url)
      if (result.toolSuccess) {
        this.failedScripts = 0
        this.searchesWithoutPage = 0
        return '[资料核验] 文件下载成功。请使用 read_file 或 run_office_skill 读取该文件核验真实标题、摘要与正文，确保与需求主题一致后再交付。'
      }
    }
    if (!this.active) return undefined
    // Local inspection offers a recovery route even when websites are unavailable.
    if (result.toolSuccess && (result.toolName === 'read_file' ||
        (result.toolName === 'run_office_skill' && /inspect|extract/i.test(JSON.stringify(result.toolArgs))))) {
      this.failedScripts = 0
    }
    if (isNetworkScript(result.toolName, result.toolArgs)) {
      const text = String(result.displayResult)
      const failure = !result.toolSuccess || /HTTP(?: Error)?\s*[45]\d{2}|rate limit exceeded|timed? out|超时|SSL:|0 (?:links|files)|(?:found|downloaded)[^\n]{0,80}:\s*\[\]/i.test(text)
      if (failure) this.failedScripts++
      // Exit code 0 or "downloaded" text is not evidence of topic correctness.
      if (this.failedScripts >= 2) return RECOVERY
      return '[资料核验] 这只是脚本执行结果。请读取真实来源或下载文件的标题、摘要/正文核对主题；保留实际标题、来源 URL 与文件对应关系，不得按任务主题自行命名无关论文。'
    }
    return undefined
  }
}

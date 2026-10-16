export type SearchResult = { title: string; url: string; snippet: string }

const STOP_WORDS = new Set(['or', 'and', 'not', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'with', 'how', 'what', 'is', 'are', 'pdf', 'doc', 'docx', 'filetype', 'site'])

/** Ignore query operators; Chinese bigrams tolerate titles that use shorter topic phrases. */
export function queryTerms(query: string): string[] {
  const text = query.toLowerCase().replace(/\b(?:site|filetype|ext):(?:"[^"]*"|\S+)/g, ' ').replace(/\b(?:inurl|intitle):/g, ' ').replace(/(?:^|\s)-\S+/g, ' ')
  const terms = new Set<string>()
  for (const part of text.match(/[\u3400-\u9fff]+|[a-z0-9][a-z0-9+#.-]*/g) || []) {
    if (/[\u3400-\u9fff]/.test(part)) {
      if (part.length === 1) terms.add(part)
      for (let i = 0; i < part.length - 1; i++) terms.add(part.slice(i, i + 2))
    } else if (!STOP_WORDS.has(part)) terms.add(part)
  }
  return [...terms]
}

export function relevantSearchResults(query: string, results: SearchResult[]): SearchResult[] {
  const terms = queryTerms(query)
  if (!terms.length) return results
  const ranked = results.map(result => {
    // Do not count a search redirect's query string as evidence of relevance.
    const text = `${result.title} ${result.snippet}`.toLowerCase()
    const words = new Set(text.match(/[a-z0-9][a-z0-9+#.-]*/g) || [])
    const score = terms.filter(term => /[\u3400-\u9fff]/.test(term) ? text.includes(term) : words.has(term)).length
    return { result, score }
  })
  const minimum = terms.length >= 4 ? 2 : 1
  return ranked.filter(item => item.score >= minimum)
    .sort((a, b) => b.score - a.score).map(item => item.result)
}

export type PageLink = { id: string; text: string; url: string; kind: 'document' | 'page' }
export type ExtractedPage = {
  title: string
  url: string
  markdown: string
  links: PageLink[]
  controls: string[]
  linksTruncated: boolean
  blocked: boolean
}

export function formatPageLinks(page: ExtractedPage, offset: number, limit: number): string {
  const docLinks = page.links.filter(link => link.kind === 'document')
  const pageLinks = page.links.filter(link => link.kind !== 'document')

  let docSection = ''
  if (docLinks.length > 0) {
    const docItems = docLinks.slice(0, 30).map(link => {
      let directUrl = link.url
      // If it's a github blob, also provide raw hint
      if (link.url.includes('github.com') && link.url.includes('/blob/')) {
        directUrl = link.url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
      }
      return `[${link.id}] 📄 文档/资源: ${link.text}\nURL: ${link.url}${directUrl !== link.url ? `\n直链(Raw): ${directUrl}` : ''}`
    }).join('\n\n')

    docSection = `【🎯 本页发现的文档/下载直链（共 ${docLinks.length} 个${docLinks.length > 30 ? '，前 30 个' : ''}）】\n` +
      `可直接复制上述直链调用 web_download 下载到本地目标目录，无需在缓存中搜索：\n\n` +
      docItems + '\n\n'
  }

  const paged = pageLinks.slice(offset, offset + limit)
  const next = offset + paged.length

  const pageSection = `【🔗 页面普通链接（共 ${pageLinks.length} 个${page.linksTruncated ? '，列表已达上限' : ''}，本次从 ${offset} 开始）：】\n` +
    (paged.length > 0
      ? paged.map(link => `[${link.id}] 网页: ${link.text}\nURL: ${link.url}`).join('\n\n')
      : '（无更多普通页面链接）') +
    (next < pageLinks.length ? `\n\n继续列出普通链接：web_fetch(url=${JSON.stringify(page.url)}, link_offset=${next})。` : '') +
    '\n打开详情或下载来源页：再次调用 web_fetch，url 使用上述完整 URL；也可使用当前页面 URL 与 link_id 打开指定链接。'

  return docSection + pageSection
}

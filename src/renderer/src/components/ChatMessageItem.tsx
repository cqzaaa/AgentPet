import React, { useState, useEffect, useMemo } from 'react'
import { setInternalClipboard } from '../hooks/useAppStore'
import iconSvg from '../assets/icon_from_image.svg'

// 计算文本的 token 数（使用降级策略的估算方式：字符数 × 0.5）
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.round(text.length * 0.5))
}

// 格式化 token 数显示
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K tokens`
  return `${(tokens / 1000000).toFixed(2)}M tokens`
}

// ── 复制代码块的高级代码面板组件 ─────────────────────────────────
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    if (window.api && typeof window.api.copyText === 'function') {
      window.api.copyText(code)
    } else {
      navigator.clipboard.writeText(code)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="modern-code-container">
      <div className="code-header">
        <span className="code-lang">{lang || 'code'}</span>
        <button className="code-copy-btn" onClick={handleCopy}>
          {copied ? '✓ 已复制' : '📋 复制'}
        </button>
      </div>
      <pre className="code-body">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function parseInlineMarkdown(text: string): string {
  let html = escapeHtml(text)
  // 1. 粗体 **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  // 2. 内联代码 `code`
  html = html.replace(/`(.*?)`/g, '<code class="inline-code">$1</code>')
  // 3. 链接 [text](url)
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="markdown-link">$1</a>')
  return html
}

function parseMarkdownToHtml(markdown: string): string {
  if (!markdown) return ''
  const lines = markdown.split('\n')
  let html = ''

  let inUl = false
  let inOl = false
  let inTable = false
  let inP = false
  let pContent = ''

  const closePending = () => {
    if (inUl) {
      html += '</ul>'
      inUl = false
    }
    if (inOl) {
      html += '</ol>'
      inOl = false
    }
    if (inTable) {
      html += '</tbody></table>'
      inTable = false
    }
    if (inP) {
      html += `<p>${pContent}</p>`
      inP = false
      pContent = ''
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 1. 空行
    if (trimmed === '') {
      closePending()
      continue
    }

    // 2. 分割线
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      closePending()
      html += '<hr />'
      continue
    }

    // 3. 标题 (# Header)
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headerMatch) {
      closePending()
      const level = headerMatch[1].length
      const titleContent = headerMatch[2]
      html += `<h${level}>${parseInlineMarkdown(titleContent)}</h${level}>`
      continue
    }

    // 4. 表格行 (| col1 | col2 |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const isSeparator = /^\|[\s-|-|:|.]+$/.test(trimmed)
      if (isSeparator) {
        continue
      }

      const cells = line
        .split('|')
        .map(s => s.trim())
        .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)

      if (!inTable) {
        closePending()
        inTable = true
        html += '<table class="markdown-table"><thead><tr>'
        html += cells.map(c => `<th>${parseInlineMarkdown(c)}</th>`).join('')
        html += '</tr></thead><tbody>'
      } else {
        html += '<tr>'
        html += cells.map(c => `<td>${parseInlineMarkdown(c)}</td>`).join('')
        html += '</tr>'
      }
      continue
    }

    // 5. 无序列表 (- item)
    const ulMatch = line.match(/^([-\*])\s+(.*)$/)
    if (ulMatch) {
      if (!inUl) {
        closePending()
        inUl = true
        html += '<ul class="markdown-list">'
      }
      html += `<li>${parseInlineMarkdown(ulMatch[2])}</li>`
      continue
    }

    // 6. 有序列表 (1. item)
    const olMatch = line.match(/^(\d+)\.\s+(.*)$/)
    if (olMatch) {
      if (!inOl) {
        closePending()
        inOl = true
        html += '<ol class="markdown-list">'
      }
      html += `<li>${parseInlineMarkdown(olMatch[2])}</li>`
      continue
    }

    // 7. 普通文本行
    if (inTable || inUl || inOl) {
      closePending()
    }

    if (!inP) {
      inP = true
      pContent = parseInlineMarkdown(line)
    } else {
      pContent += '<br />' + parseInlineMarkdown(line)
    }
  }

  closePending()
  return html
}

// ── 带右键复制菜单的图片包装组件 ─────────────────────────────────
export function ChatImage({ src, alt }: { src: string; alt: string }) {
  const [hasError, setHasError] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (window.api && typeof window.api.showImageContextMenu === 'function') {
      window.api.showImageContextMenu(src)
    }
  }

  if (hasError) {
    return (
      <div
        className="image-error-tip"
        style={{
          color: '#888',
          fontSize: '12px',
          border: '1px dashed #ccc',
          padding: '8px',
          borderRadius: '6px',
          margin: '4px 0',
          display: 'inline-block',
          backgroundColor: 'rgba(0,0,0,0.02)'
        }}
      >
        ⚠️ 已被删除 ({alt || '微信图片'})
      </div>
    )
  }

  return (
    <>
      <img
        src={src}
        alt={alt}
        className="chat-inline-image"
        style={{
          maxWidth: '100%',
          maxHeight: '200px',
          borderRadius: '8px',
          margin: '4px 0',
          display: 'block',
          cursor: 'zoom-in'
        }}
        onClick={() => setPreviewSrc(src)}
        onContextMenu={handleContextMenu}
        onError={() => setHasError(true)}
      />
      {previewSrc && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
          onClick={() => setPreviewSrc(null)}
        >
          <img src={previewSrc} style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </>
  )
}

// 渲染包含图片和链接的普通文本部分
export function renderPlainOrImageText(text: string, keyIdxStart: { val: number }): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // 匹配四种模式：
  //   1. ![alt](url)  — 显式图片
  //   2. [text](url)  — markdown 链接
  //   3. https://... 或 local-file://... 或 file:///... — 裸 URL
  //   4. C:\... 等裸露的 Windows 本地绝对路径
  const linkOrImgRegex = /(!?\[.*?\]\(.*?\))|((?:https?:\/\/|file:\/\/\/|local-file:\/\/|[a-zA-Z]:[\\/])[^\s\])<>"'，。！？；：（）]+)/g
  let match
  let lastIndex = 0

  const normalizeLocalSrc = (url: string): string => {
    if (!url) return url
    // 1. 将 file:/// 替换为 local-file:///
    if (url.startsWith('file:///')) {
      return url.replace('file:///', 'local-file:///')
    }
    // 2. 如果是 Windows 盘符绝对路径 (例如 C:\ 或 D:/)
    if (/^[A-Za-z]:[/\\]/.test(url)) {
      // 统一转换为 local-file:/// 协议，并将反斜杠替换为正斜杠
      const cleanPath = url.replace(/\\/g, '/')
      return `local-file:///${cleanPath}`
    }
    return url
  }

  const isImageSrc = (url: string) => {
    if (!url) return false
    const lowerUrl = url.toLowerCase()

    // 1. base64图片数据
    if (lowerUrl.startsWith('data:image/')) {
      return true
    }

    // 2. 获取去掉参数和锚点后的干净路径
    const cleanUrl = lowerUrl.split('?')[0].split('#')[0]

    // 3. 检查常见图片后缀
    const isCommonImageExt =
      cleanUrl.endsWith('.png') ||
      cleanUrl.endsWith('.jpg') ||
      cleanUrl.endsWith('.jpeg') ||
      cleanUrl.endsWith('.gif') ||
      cleanUrl.endsWith('.webp') ||
      cleanUrl.endsWith('.bmp') ||
      cleanUrl.endsWith('.svg') ||
      cleanUrl.endsWith('.jfif') ||
      cleanUrl.endsWith('.tiff')

    if (isCommonImageExt) {
      return true
    }

    // 4. 特殊本地图片协议处理：如果是以 local-file:// 或 wechat-file:// 开头
    if (lowerUrl.startsWith('local-file://') || lowerUrl.startsWith('wechat-file://')) {
      // 排除一些明显的非图片格式后缀，其余默认当做图片预览
      const isNonImageExt =
        cleanUrl.endsWith('.txt') ||
        cleanUrl.endsWith('.json') ||
        cleanUrl.endsWith('.md') ||
        cleanUrl.endsWith('.zip') ||
        cleanUrl.endsWith('.rar') ||
        cleanUrl.endsWith('.pdf') ||
        cleanUrl.endsWith('.doc') ||
        cleanUrl.endsWith('.docx') ||
        cleanUrl.endsWith('.xls') ||
        cleanUrl.endsWith('.xlsx') ||
        cleanUrl.endsWith('.ppt') ||
        cleanUrl.endsWith('.pptx') ||
        cleanUrl.endsWith('.mp3') ||
        cleanUrl.endsWith('.mp4') ||
        cleanUrl.endsWith('.js') ||
        cleanUrl.endsWith('.ts')

      if (!isNonImageExt) {
        return true
      }
    }

    // 5. 针对特殊远程图床或链接特征的匹配 (例如蚂蚁金服 afts 图床等)
    if (
      lowerUrl.includes('alipayobjects.com') ||
      lowerUrl.includes('/afts/img/') ||
      (lowerUrl.includes('original') && (lowerUrl.includes('img') || lowerUrl.includes('image') || lowerUrl.includes('chart')))
    ) {
      return true
    }

    return false
  }

  while ((match = linkOrImgRegex.exec(text)) !== null) {
    const textBefore = text.substring(lastIndex, match.index)
    if (textBefore.trim()) {
      parts.push(<MarkdownText key={`text-${keyIdxStart.val++}`} rawText={textBefore} />)
    }

    if (match[1]) {
      // 分支1：匹配到 markdown 格式 ![alt](url) 或 [text](url)
      const mdMatch = match[1].match(/^(!?)\[(.*?)\]\((.*?)\)$/)
      if (mdMatch) {
        const isExplicitImg = mdMatch[1] === '!'
        const alt = mdMatch[2]
        const rawSrc = mdMatch[3]
        const src = normalizeLocalSrc(rawSrc)

        if (isExplicitImg || isImageSrc(src)) {
          parts.push(
            <ChatImage key={`img-${keyIdxStart.val++}`} src={src} alt={alt} />
          )
        } else {
          const isLocal = src.startsWith('local-file://') || src.startsWith('wechat-file://')
          const handleLocalClick = async (e: React.MouseEvent) => {
            if (isLocal) {
              e.preventDefault()
              if (window.api && typeof window.api.openLocalFile === 'function') {
                const res = await window.api.openLocalFile(src)
                if (res && !res.success) {
                  alert(res.error || '无法打开此本地文件')
                }
              } else {
                alert('当前环境不支持直接打开本地文件')
              }
            }
          }
          parts.push(
            <a
              key={`link-${keyIdxStart.val++}`}
              href={src}
              target={isLocal ? undefined : "_blank"}
              rel="noreferrer"
              className="markdown-link"
              onClick={handleLocalClick}
            >
              {alt}
            </a>
          )
        }
      }
    } else if (match[2]) {
      // 分支2：匹配到裸 URL
      const rawUrl = match[2]
      const src = normalizeLocalSrc(rawUrl)

      if (isImageSrc(src)) {
        parts.push(
          <ChatImage key={`img-${keyIdxStart.val++}`} src={src} alt="image" />
        )
      } else {
        const isLocal = src.startsWith('local-file://') || src.startsWith('wechat-file://')
        const handleLocalClick = async (e: React.MouseEvent) => {
          if (isLocal) {
            e.preventDefault()
            if (window.api && typeof window.api.openLocalFile === 'function') {
              const res = await window.api.openLocalFile(src)
              if (res && !res.success) {
                alert(res.error || '无法打开此本地文件')
              }
            } else {
              alert('当前环境不支持直接打开本地文件')
            }
          }
        }
        parts.push(
          <a
            key={`link-${keyIdxStart.val++}`}
            href={src}
            target={isLocal ? undefined : "_blank"}
            rel="noreferrer"
            className="markdown-link"
            onClick={handleLocalClick}
          >
            {rawUrl}
          </a>
        )
      }
    }

    lastIndex = linkOrImgRegex.lastIndex
  }

  const textAfter = text.substring(lastIndex)
  if (textAfter.trim()) {
    parts.push(<MarkdownText key={`text-${keyIdxStart.val++}`} rawText={textAfter} />)
  }

  return parts
}

export function MarkdownText({ rawText }: { rawText: string }): React.JSX.Element {
  const html = React.useMemo(() => parseMarkdownToHtml(rawText), [rawText])
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
}

export function renderAdvancedMessage(text: string): React.ReactNode {
  if (!text) return ''
  const parts: React.ReactNode[] = []
  const keyIdx = { val: 0 }

  const codeRegex = /```(\w*)\n([\s\S]*?)```/g
  let match
  let lastIndex = 0

  while ((match = codeRegex.exec(text)) !== null) {
    const textBefore = text.substring(lastIndex, match.index)
    if (textBefore.trim()) {
      parts.push(...renderPlainOrImageText(textBefore, keyIdx))
    }

    const lang = match[1] || 'code'
    const codeContent = match[2]
    parts.push(
      <CodeBlock key={`code-${keyIdx.val++}`} code={codeContent} lang={lang} />
    )

    lastIndex = codeRegex.lastIndex
  }

  const textAfter = text.substring(lastIndex)
  if (textAfter.trim()) {
    parts.push(...renderPlainOrImageText(textAfter, keyIdx))
  }

  return parts.length > 0 ? <>{parts}</> : <>{renderPlainOrImageText(text, keyIdx)}</>
}

// ── 可独立折叠的工具调用子组件 ─────────────────────────────────
export function ToolCallItem({ step, isThinking, isWaiting }: { step: any; isThinking: boolean; isWaiting?: boolean }) {
  const [isItemCollapsed, setIsItemCollapsed] = useState(true)

  useEffect(() => {
    if (!isThinking) setIsItemCollapsed(true)
  }, [isThinking])

  const displayCmd = typeof step.detail === 'object' && step.detail !== null
    ? (step.detail.command || JSON.stringify(step.detail))
    : String(step.detail)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12.5px', userSelect: 'none' }}
        onClick={() => setIsItemCollapsed(!isItemCollapsed)}
        title="点击展开/收起详情"
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', border: '1px solid var(--border-card)', borderRadius: '6px', color: isWaiting ? '#60a5fa' : '#10b981', fontSize: '12px', backgroundColor: 'var(--bg-card)' }}>
          {isWaiting ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ width: '12px', height: '12px', animation: 'tool-spin 1s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
              <style>{`@keyframes tool-spin { 100% { transform: rotate(360deg); } }`}</style>
            </svg>
          ) : '✓'}
        </span>
        <span>调用系统工具: {step.name}</span>
        <span style={{ fontSize: '10px', opacity: 0.7 }}>{isItemCollapsed ? '▶' : '▼'}</span>
      </div>
      {!isItemCollapsed && (
        <div style={{ paddingLeft: '28px' }}>
          <div style={{ padding: '8px 12px', background: 'rgba(128,128,128,0.06)', borderRadius: '6px', fontSize: '11.5px', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', border: '1px solid rgba(128,128,128,0.1)' }}>
            {displayCmd}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 深度思考过程展示子组件 ─────────────────────────────────
export function ToolThinkItem({ step, isThinking }: { step: any; isThinking: boolean }) {
  const [isItemCollapsed, setIsItemCollapsed] = useState(false)

  useEffect(() => {
    if (!isThinking) setIsItemCollapsed(true)
  }, [isThinking])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12.5px', userSelect: 'none' }}
        onClick={() => setIsItemCollapsed(!isItemCollapsed)}
        title="点击展开/收起思考详情"
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', border: '1px solid var(--border-card)', borderRadius: '6px', color: 'var(--text-muted)', fontSize: '12px', backgroundColor: 'var(--bg-card)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" /></svg>
        </span>
        <span>已深度思考</span>
        <span style={{ fontSize: '10px', opacity: 0.7 }}>{isItemCollapsed ? '▶' : '▼'}</span>
      </div>
      {!isItemCollapsed && (
        <div style={{ paddingLeft: '28px' }}>
          <div style={{ padding: '8px 12px', background: 'rgba(128,128,128,0.04)', borderLeft: '3px solid rgba(128,128,128,0.3)', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
            {step.detail}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 可独立折叠的工具具体执行结果子组件 ─────────────────────────────────
export function ToolResultItem({ step, isThinking }: { step: any; isThinking: boolean }) {
  const [isItemCollapsed, setIsItemCollapsed] = useState(true)

  useEffect(() => {
    if (!isThinking) setIsItemCollapsed(true)
  }, [isThinking])

  const displayResult = typeof step.detail === 'string'
    ? step.detail
    : JSON.stringify(step.detail, null, 2)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12.5px', userSelect: 'none' }}
        onClick={() => setIsItemCollapsed(!isItemCollapsed)}
        title="点击展开/收起详情"
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', border: '1px solid var(--border-card)', borderRadius: '6px', color: '#10b981', fontSize: '12px', backgroundColor: 'var(--bg-card)' }}>✓</span>
        <span>工具返回结果: {step.name}</span>
        <span style={{ fontSize: '10px', opacity: 0.7 }}>{isItemCollapsed ? '▶' : '▼'}</span>
      </div>
      {!isItemCollapsed && (
        <div style={{ paddingLeft: '28px' }}>
          <div style={{ padding: '8px 12px', background: 'rgba(128,128,128,0.06)', borderRadius: '6px', fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: '200px', overflowY: 'auto', border: '1px solid rgba(128,128,128,0.1)' }}>
            {displayResult}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 统一排版与折叠日志状态的消息项组件 ──────────────────────────────
// 绘制召回的 SVG 拓扑图
function renderSvgGraph(debug: any) {
  if (!debug) {
    return (
      <div style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--color-text-muted, #999)', backgroundColor: 'rgba(0,0,0,0.02)', borderRadius: '8px', border: '1px dashed rgba(0,0,0,0.1)' }}>
        <div style={{ fontSize: '24px', marginBottom: '8px' }}>🌌</div>
        <div style={{ fontSize: '12px' }}>未触发避坑经验库的检索召回（如闲聊、问候等）</div>
      </div>
    )
  }

  const firstOrder = debug.firstOrderActive || []
  const secondOrder = debug.secondOrderActive || []
  const recalledFacts = (debug.allScored || []).filter((c: any, idx: number) => idx < 2 && c.score > 0.05)

  if (firstOrder.length === 0 && secondOrder.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--color-text-muted, #999)', backgroundColor: 'rgba(0,0,0,0.02)', borderRadius: '8px', border: '1px dashed rgba(0,0,0,0.1)' }}>
        <div style={{ fontSize: '24px', marginBottom: '8px' }}>🔍</div>
        <div style={{ fontSize: '12px' }}>当前输入未提取到匹配的图谱实体词，未触发实体联想。</div>
      </div>
    )
  }

  // 限制绘制数量防重叠
  const drawFirst = firstOrder.slice(0, 3)
  const drawSecond = secondOrder.slice(0, 3)

  const w = 700
  const h = 180

  // 计算坐标
  const centerNode = { x: 55, y: h / 2 }

  const firstNodes = drawFirst.map((name: string, i: number) => ({
    name,
    x: 180,
    y: drawFirst.length === 1 ? h / 2 : 30 + (i * (h - 60)) / (drawFirst.length - 1)
  }))

  const secondNodes = drawSecond.map((name: string, i: number) => ({
    name,
    x: 340,
    y: drawSecond.length === 1 ? h / 2 : 30 + (i * (h - 60)) / (drawSecond.length - 1)
  }))

  const factNodes = recalledFacts.map((c: any, i: number) => ({
    fact: c.fact.length > 25 ? c.fact.substring(0, 25) + '...' : c.fact,
    fullFact: c.fact,
    x: 480,
    y: recalledFacts.length === 1 ? h / 2 : 40 + (i * (h - 80)) / (recalledFacts.length - 1)
  }))

  return (
    <div style={{ position: 'relative', width: '100%', overflowX: 'auto', backgroundColor: '#1e1b29', borderRadius: '10px', padding: '12px 10px', boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5)', marginBottom: '16px' }}>
      <style dangerouslySetInnerHTML={{
        __html: `
        @keyframes dash {
          to {
            stroke-dashoffset: -20;
          }
        }
        .flowing-line {
          stroke-dasharray: 6, 4;
          animation: dash 1.2s linear infinite;
        }
        .node-glow-purple { filter: drop-shadow(0 0 6px #8b5cf6); }
        .node-glow-green { filter: drop-shadow(0 0 6px #10b981); }
        .node-glow-blue { filter: drop-shadow(0 0 6px #3b82f6); }
      `}} />
      <svg width={w} height={h} style={{ display: 'block', margin: '0 auto' }}>
        {/* 绘制连线 */}
        {/* 中心 -> 一阶 */}
        {firstNodes.map((fn, idx) => (
          <line
            key={`line-c-f-${idx}`}
            x1={centerNode.x}
            y1={centerNode.y}
            x2={fn.x}
            y2={fn.y}
            stroke="#8b5cf6"
            strokeWidth="1.5"
            className="flowing-line"
            opacity="0.7"
          />
        ))}

        {/* 一阶 -> 二阶 (全连或者配对连) */}
        {firstNodes.flatMap((fn, fidx) =>
          secondNodes.map((sn, sidx) => (
            <line
              key={`line-f-s-${fidx}-${sidx}`}
              x1={fn.x}
              y1={fn.y}
              x2={sn.x}
              y2={sn.y}
              stroke="#10b981"
              strokeWidth="1.2"
              strokeDasharray="4,4"
              opacity="0.5"
            />
          ))
        )}

        {/* 二阶 -> 事实 */}
        {secondNodes.flatMap((sn, sidx) =>
          factNodes.map((fact, fidx) => (
            <line
              key={`line-s-fact-${sidx}-${fidx}`}
              x1={sn.x}
              y1={sn.y}
              x2={fact.x}
              y2={fact.y}
              stroke="#3b82f6"
              strokeWidth="1.2"
              className="flowing-line"
              opacity="0.6"
            />
          ))
        )}

        {/* 绘制节点 */}
        {/* 中心节点 */}
        <circle cx={centerNode.x} cy={centerNode.y} r="18" fill="#8b5cf6" className="node-glow-purple" />
        <text x={centerNode.x} y={centerNode.y + 4} fill="#fff" fontSize="10" textAnchor="middle" fontWeight="bold">提问</text>

        {/* 一阶节点 */}
        {firstNodes.map((fn, idx) => (
          <g key={`gn-first-${idx}`}>
            <circle cx={fn.x} cy={fn.y} r="14" fill="#10b981" className="node-glow-green" />
            <text x={fn.x} y={fn.y + 4} fill="#fff" fontSize="9" textAnchor="middle" fontWeight="bold">一阶</text>
            <rect x={fn.x - 45} y={fn.y - 30} width="90" height="14" rx="3" fill="rgba(16,185,129,0.95)" />
            <text x={fn.x} y={fn.y - 20} fill="#fff" fontSize="9" textAnchor="middle">
              <title>{fn.name}</title>
              {fn.name.length > 8 ? fn.name.substring(0, 7) + '..' : fn.name}
            </text>
          </g>
        ))}

        {/* 二阶节点 */}
        {secondNodes.map((sn, idx) => (
          <g key={`gn-second-${idx}`}>
            <circle cx={sn.x} cy={sn.y} r="14" fill="#3b82f6" className="node-glow-blue" />
            <text x={sn.x} y={sn.y + 4} fill="#fff" fontSize="9" textAnchor="middle" fontWeight="bold">二阶</text>
            <rect x={sn.x - 45} y={sn.y - 30} width="90" height="14" rx="3" fill="rgba(59,130,246,0.95)" />
            <text x={sn.x} y={sn.y - 20} fill="#fff" fontSize="9" textAnchor="middle">
              <title>{sn.name}</title>
              {sn.name.length > 8 ? sn.name.substring(0, 7) + '..' : sn.name}
            </text>
          </g>
        ))}

        {/* 事实卡片 */}
        {factNodes.map((fn, idx) => (
          <g key={`gn-fact-${idx}`}>
            <rect x={fn.x} y={fn.y - 18} width="200" height="36" rx="6" fill="#2d2a45" stroke="#8b5cf6" strokeWidth="1" className="node-glow-purple" />
            <text x={fn.x + 8} y={fn.y - 4} fill="#10b981" fontSize="9" fontWeight="bold">[已召回避坑事实]</text>
            <text x={fn.x + 8} y={fn.y + 10} fill="#ddd" fontSize="9">
              <title>{fn.fullFact}</title>
              {fn.fact}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

function translateToolName(name: string): string {
  const map: Record<string, string> = {
    'run_terminal_command': '运行了命令',
    'get_system_status': '获取了系统状态',
    'manage_cron_task': '管理了定时任务',
    'get_location': '获取了地理位置',
    'generate_file': '生成了文件',
    'modify_docx_file': '修改了 Word 文档',
    'modify_xlsx_file': '修改了 Excel 表格',
    'read_file': '读取了文件内容',
    'search_web': '搜索了网络',
    'read_url_content': '获取了网页',
    'ask_question': '提问了用户',
    'get-current-date': '获取了当前日期',
    'get-station-code-of-citys': '获取了车站代码',
    'get-tickets': '查询了车票',
    'list_dir': '列出了目录',
    'view_file': '查看了文件',
    'write_to_file': '写入了新文件',
    'replace_file_content': '修改了文件',
    'multi_replace_file_content': '批量修改了文件',
  }

  if (map[name]) return map[name]

  const cleanName = name.replace(/[_-]/g, ' ')
  if (name.startsWith('get_') || name.startsWith('get-')) {
    return `获取了${cleanName.substring(4)}`
  }
  if (name.startsWith('list_') || name.startsWith('list-')) {
    return `列出了${cleanName.substring(5)}`
  }
  if (name.startsWith('run_') || name.startsWith('run-')) {
    return `运行了${cleanName.substring(4)}`
  }
  if (name.startsWith('search_') || name.startsWith('search-')) {
    return `搜索了${cleanName.substring(7)}`
  }

  return `启用了工具 ${name}`
}

function combineToolSteps(toolSteps: any[], isThinking: boolean): any[] {
  const combined: any[] = []

  toolSteps.forEach((step: any) => {
    if (step.type === 'think') {
      combined.push({
        id: step.id,
        type: 'think',
        name: step.name,
        detail: step.detail
      })
    } else if (step.type === 'call') {
      combined.push({
        id: step.id,
        type: 'tool',
        name: step.name,
        callDetail: step.detail,
        isWaiting: false
      })
    } else if (step.type === 'result') {
      let matched = false
      for (let i = combined.length - 1; i >= 0; i--) {
        const item = combined[i]
        if (item.type === 'tool' && item.name === step.name && !item.resultDetail) {
          item.resultDetail = step.detail
          matched = true
          break
        }
      }
      if (!matched) {
        combined.push({
          id: step.id,
          type: 'tool',
          name: step.name,
          resultDetail: step.detail,
          isWaiting: false
        })
      }
    }
  })

  combined.forEach((item) => {
    if (item.type === 'tool' && !item.resultDetail && isThinking) {
      item.isWaiting = true
    }
  })

  return combined
}

export function ToolStepItem({ step, isThinking }: { step: any; isThinking: boolean }) {
  const [isItemCollapsed, setIsItemCollapsed] = useState(true)
  const [isReqCollapsed, setIsReqCollapsed] = useState(true)

  useEffect(() => {
    if (!isThinking) {
      setIsItemCollapsed(true)
      setIsReqCollapsed(true)
    }
  }, [isThinking])

  const toolDisplayName = translateToolName(step.name || '')

  const displayCmd = typeof step.callDetail === 'object' && step.callDetail !== null
    ? (step.callDetail.command || JSON.stringify(step.callDetail, null, 2))
    : String(step.callDetail)

  const displayResult = typeof step.resultDetail === 'string'
    ? step.resultDetail
    : JSON.stringify(step.resultDetail, null, 2)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12.5px', userSelect: 'none' }}
        onClick={() => setIsItemCollapsed(!isItemCollapsed)}
        title="点击展开/收起详情"
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', border: '1px solid var(--border-card)', borderRadius: '6px', color: step.isWaiting ? '#60a5fa' : '#10b981', fontSize: '12px', backgroundColor: 'var(--bg-card)' }}>
          {step.isWaiting ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ width: '12px', height: '12px', animation: 'tool-spin-item 1s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
              <style>{`@keyframes tool-spin-item { 100% { transform: rotate(360deg); } }`}</style>
            </svg>
          ) : '✓'}
        </span>
        <span>调用 {toolDisplayName} 工具</span>
        <span style={{ fontSize: '10px', opacity: 0.7 }}>{isItemCollapsed ? '▶' : '▼'}</span>
      </div>
      {!isItemCollapsed && (
        <div style={{ paddingLeft: '28px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {step.callDetail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}
                onClick={() => setIsReqCollapsed(!isReqCollapsed)}
                title="点击展开/折叠参数"
              >
                <span>📥 请求参数 / 命令:</span>
                <span style={{ fontSize: '9px', opacity: 0.7 }}>{isReqCollapsed ? '▶' : '▼'}</span>
              </div>
              {!isReqCollapsed && (
                <div style={{ padding: '8px 12px', background: 'rgba(128,128,128,0.06)', borderRadius: '6px', fontSize: '11.5px', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', border: '1px solid rgba(128,128,128,0.1)' }}>
                  {displayCmd}
                </div>
              )}
            </div>
          )}
          {step.resultDetail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>📤 返回结果:</div>
              <div style={{ padding: '8px 12px', background: 'rgba(128,128,128,0.06)', borderRadius: '6px', fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: '160px', overflowY: 'auto', border: '1px solid rgba(128,128,128,0.1)' }}>
                {displayResult}
              </div>
            </div>
          )}
          {step.isWaiting && (
            <div style={{ fontSize: '11px', color: '#60a5fa', fontStyle: 'italic', paddingLeft: '4px' }}>
              ⏳ 正在等待工具返回结果...
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface MessageItemProps {
  msg: any
  currentAvatarName: string
  highlightedMessageId?: number | null
}

export function ChatMessageItem({ msg, currentAvatarName, highlightedMessageId = null }: MessageItemProps) {
  // 处理系统提示与分割消息
  if (msg.sender === 'system') {
    return (
      <div id={`msg-${msg.id}`} className="system-message-divider">
        <span className="system-message-badge">
          {msg.text}
        </span>
      </div>
    )
  }

  // 使用 userCollapsed 状态，绝对且强制在思考状态变化时更新折叠展示
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const [showPromptModal, setShowPromptModal] = useState(false)
  const [activePromptTab, setActivePromptTab] = useState<'recall' | 'context' | 'tools'>('recall')

  // 缓存消息文本渲染结果，避免重渲染导致 DOM 替换丢失选区
  const renderedText = useMemo(() => {
    if (!msg.text) return null
    const displayText = msg.text === '__WELCOME_MSG__'
      ? `欢迎来到 agentself 终端！我是您的智能助理 ${currentAvatarName}。有什么我可以帮您的吗？`
      : msg.text === '__SYSTEM_INIT_MSG__'
        ? `系统：已成功加载 ${currentAvatarName} 神经网络内核 V2.1.0。内核状态 [正常]。`
        : msg.text
    return renderAdvancedMessage(displayText)
  }, [msg.text, currentAvatarName])
  const handleImageContextMenu = (e: React.MouseEvent, imgSrc: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (window.api && typeof window.api.showImageContextMenu === 'function') {
      window.api.showImageContextMenu(imgSrc)
    }
  }

  const handleCopy = async () => {
    if (!msg.text && !msg.fileInfo && !msg.fileInfos) return
    const textToCopy = msg.text === '__WELCOME_MSG__'
      ? `欢迎来到 agentself 终端！我是您的智能助理 ${currentAvatarName}。有什么我可以帮您的吗？`
      : msg.text === '__SYSTEM_INIT_MSG__'
        ? `系统：已成功加载 ${currentAvatarName} 神经网络内核 V2.1.0。内核状态 [正常]。`
        : (msg.text || '')
    // 收集文件信息
    const files: { name: string; path: string; content?: string }[] = []
    if (msg.fileInfos && Array.isArray(msg.fileInfos)) {
      for (const f of msg.fileInfos) {
        if (f.path) files.push({ name: f.name, path: f.path, content: f.content })
      }
    } else if (msg.fileInfo?.path) {
      files.push({ name: msg.fileInfo.name, path: msg.fileInfo.path, content: msg.fileInfo.content })
    }
    if (files.length > 0) {
      // 存入内部剪贴板（粘贴到输入框时可作为附件 + 文本）
      setInternalClipboard(files, textToCopy)
      // 同时写入系统剪贴板（支持粘贴到资源管理器和文本框）
      const filePaths = files.map(f => f.path)
      if (window.api && typeof window.api.copyFiles === 'function') {
        await window.api.copyFiles(filePaths, textToCopy)
      } else {
        if (window.api && typeof window.api.copyText === 'function') {
          window.api.copyText(textToCopy)
        } else {
          navigator.clipboard.writeText(textToCopy)
        }
      }
    } else {
      // 无文件，纯文本复制
      if (window.api && typeof window.api.copyText === 'function') {
        window.api.copyText(textToCopy)
      } else {
        navigator.clipboard.writeText(textToCopy)
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => {
    if (!msg.isThinking) {
      setUserCollapsed(true) // 思考结束，强制收拢
    } else {
      setUserCollapsed(false) // 正在思考，强制展开
    }
  }, [msg.isThinking])

  const currentCollapsed = userCollapsed !== null ? userCollapsed : !msg.isThinking

  const toolSteps = msg.toolSteps || []
  const hasThink = toolSteps.some((s: any) => s.type === 'think' && s.detail?.trim())
  const shouldShowToolSteps = toolSteps.some((s: any) => s.type === 'call' || s.type === 'result' || (s.type === 'think' && s.detail?.trim()))

  const callSteps = toolSteps.filter((s: any) => s.type === 'call')
  let summaryText = ''
  if (callSteps.length > 0) {
    const names = Array.from(new Set(callSteps.map((s: any) => translateToolName(s.name))))
    summaryText = names.join(', ')
  } else if (hasThink) {
    summaryText = '已深度思考'
  } else {
    summaryText = '运行过程'
  }

  let timeSuffix = ''
  if (!msg.isThinking) {
    const timestamps = toolSteps
      .map((s: any) => {
        const match = String(s.id || '').match(/step-(\d+)-/)
        return match ? parseInt(match[1], 10) : null
      })
      .filter((t: any) => t !== null) as number[]
    const lastTime = timestamps.length > 0 ? Math.max(...timestamps) : msg.id
    const durationMs = lastTime - msg.id
    const durationSec = Math.max(1, Math.round(durationMs / 1000))
    if (durationSec > 0) {
      if (durationSec >= 60) {
        const mins = Math.floor(durationSec / 60)
        const secs = durationSec % 60
        timeSuffix = secs > 0 ? ` ${mins}m ${secs}s` : ` ${mins}m`
      } else {
        timeSuffix = ` ${durationSec}s`
      }
    }
  }

  const headerText = `${summaryText}${timeSuffix}`
  const collapseText = `${summaryText}`

  const senderName = msg.sender === 'user' ? '我' : currentAvatarName

  return (
    <div id={`msg-${msg.id}`} className={`message-row ${msg.sender} ${highlightedMessageId === msg.id ? 'highlight-pulse' : ''}`}>
      <div className="message-header-row">
        {msg.sender !== 'user' && (
          <span className="msg-sender-avatar">
            <img src={iconSvg} alt="avatar" className="msg-sender-avatar-img" />
          </span>
        )}
        <span className="msg-sender-name">{senderName}</span>
        <span className="msg-send-time">{msg.time}</span>
      </div>

      <div className="message-bubble" style={{ maxWidth: msg.isThinking ? '100%' : undefined }}>
        {msg.fileInfo && !msg.fileInfos && (() => {
          const f = msg.fileInfo
          const isImage = f.name && f.name.match(/\.(jpg|jpeg|png|gif|webp)$/i)
          return isImage ? (
            <div className="message-file-badges" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
              <img
                src={f.path ? `local-file:///${f.path.replace(/\\/g, '/')}` : (f.objectUrl || '')}
                alt={f.name}
                style={{ width: '120px', height: '120px', objectFit: 'cover', borderRadius: '8px', cursor: 'zoom-in', border: '1px solid var(--color-border)' }}
                onClick={(e) => setPreviewImageSrc((e.target as HTMLImageElement).src)}
                onContextMenu={(e) => handleImageContextMenu(e, (e.target as HTMLImageElement).src)}
                onError={(e) => {
                  // 最终底座：如果 local-file 协议失败，尝试 objectUrl（当环会话天生效）
                  if (f.objectUrl) {
                    const target = e.target as HTMLImageElement
                    if (target.src !== f.objectUrl) {
                      target.src = f.objectUrl
                    }
                  }
                }}
              />
            </div>
          ) : (
            <div className="message-file-badge" style={{ marginBottom: '8px' }}>
              <span className="file-badge-icon">📄</span>
              <div className="file-badge-info">
                <span className="file-badge-name" title={f.name}>{f.name}</span>
              </div>
            </div>
          )
        })()}

        {msg.fileInfos && msg.fileInfos.length > 0 && (
          <div className="message-file-badges" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            {msg.fileInfos.map((f: any, i: number) => {
              const isImage = f.name && f.name.match(/\.(jpg|jpeg|png|gif|webp)$/i)
              return isImage ? (
                <img
                  key={i}
                  src={f.path ? `local-file:///${f.path.replace(/\\/g, '/')}` : (f.objectUrl || '')}
                  alt={f.name}
                  style={{ width: '120px', height: '120px', objectFit: 'cover', borderRadius: '8px', cursor: 'zoom-in', border: '1px solid var(--color-border)' }}
                  onClick={(e) => setPreviewImageSrc((e.target as HTMLImageElement).src)}
                  onContextMenu={(e) => handleImageContextMenu(e, (e.target as HTMLImageElement).src)}
                  onError={(e) => {
                    // 最终底座：如果 local-file 协议失败，尝试 objectUrl（当环会话生效）
                    if (f.objectUrl) {
                      const target = e.target as HTMLImageElement
                      if (target.src !== f.objectUrl) {
                        target.src = f.objectUrl
                      }
                    }
                  }}
                />
              ) : (
                <div key={i} className="message-file-badge" style={{ margin: 0, backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}>
                  <span className="file-badge-icon">📄</span>
                  <div className="file-badge-info">
                    <span className="file-badge-name" title={f.name}>{f.name}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* 工具调用流（现代内联样式） */}
        {shouldShowToolSteps && (
          <div className="modern-tool-steps-container" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            {currentCollapsed ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  fontSize: '12.5px',
                  userSelect: 'none',
                  backgroundColor: 'rgba(128, 128, 128, 0.05)',
                  padding: '6px 12px',
                  borderRadius: '8px',
                  width: '100%',
                  boxSizing: 'border-box'
                }}
                onClick={() => setUserCollapsed(false)}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', border: '1px solid var(--border-card)', borderRadius: '6px', color: '#10b981', fontSize: '12px', backgroundColor: 'var(--bg-card)' }}>✓</span>
                <span style={{ flex: 1 }}>{headerText}</span>
                <span style={{ fontSize: '10px', opacity: 0.7 }}>▶</span>
              </div>
            ) : (
              <>
                {!msg.isThinking && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      cursor: 'pointer',
                      color: 'var(--text-muted)',
                      fontSize: '12.5px',
                      userSelect: 'none',
                      backgroundColor: 'rgba(128, 128, 128, 0.05)',
                      padding: '6px 12px',
                      borderRadius: '8px',
                      width: '100%',
                      boxSizing: 'border-box',
                      marginBottom: '4px'
                    }}
                    onClick={() => setUserCollapsed(true)}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', border: '1px solid var(--border-card)', borderRadius: '6px', color: '#10b981', fontSize: '12px', backgroundColor: 'var(--bg-card)' }}>✓</span>
                    <span style={{ flex: 1 }}>{collapseText}</span>
                    <span style={{ fontSize: '10px', opacity: 0.7 }}>▼</span>
                  </div>
                )}
                <div
                  className="tool-steps-scroll-area"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    maxHeight: '200px',
                    overflowY: 'auto',
                    paddingLeft: '12px',
                    paddingRight: '6px'
                  }}
                >
                  {combineToolSteps(toolSteps, msg.isThinking).map((step: any) => {
                    if (step.type === 'tool') {
                      return (
                        <ToolStepItem key={step.id} step={step} isThinking={msg.isThinking} />
                      )
                    } else {
                      return (
                        <ToolThinkItem key={step.id} step={step} isThinking={msg.isThinking} />
                      )
                    }
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* 思考中 Loading 跳起小点动画 */}
        {msg.isThinking && msg.text === '' && (
          <div className="thinking-loading-wave">
            <span className="loading-dot"></span>
            <span className="loading-dot"></span>
            <span className="loading-dot"></span>
          </div>
        )}

        {/* 最终大模型回复文本渲染 */}
        {renderedText && (
          <div
            className="message-text"
            onContextMenu={(e) => {
              const selection = window.getSelection()
              const selectedText = selection?.toString().trim()
              if (selectedText && window.api?.showTextContextMenu) {
                e.preventDefault()
                window.api.showTextContextMenu(selectedText)
              }
            }}
          >
            {renderedText}
          </div>
        )}
      </div>

      {(msg.text || msg.fileInfo || msg.fileInfos) && !msg.isThinking && (
        <div className="message-action-row">
          <button className="msg-copy-btn" onClick={handleCopy} title="复制消息内容">
            {copied ? '✓' : '📋'}
          </button>
          {msg.sender === 'user' && msg.promptInfo && (
            <button
              className="msg-prompt-btn"
              onClick={() => setShowPromptModal(true)}
              title="查看传给 Agent 的完整内容"
            >
              🔍
            </button>
          )}
        </div>
      )}

      {/* 提示词弹框 */}
      {showPromptModal && msg.promptInfo && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0,0,0,0.7)',
            zIndex: 99998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer'
          }}
          onClick={() => setShowPromptModal(false)}
        >
          <div
            style={{
              width: '85vw',
              maxWidth: '960px',
              height: '80vh',
              backgroundColor: 'var(--color-bg-primary, #fff)',
              borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              cursor: 'default'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹框头部 */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '16px 20px',
                borderBottom: '1px solid var(--color-border, #e0e0e0)',
                backgroundColor: 'var(--color-bg-secondary, #f5f5f5)'
              }}
            >
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                🔍 Agent 提问参数与调试分析面板
              </h3>
              <button
                onClick={() => setShowPromptModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '20px',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  color: 'var(--color-text-primary, #333)'
                }}
              >
                ✕
              </button>
            </div>

            {/* Tab 导航 */}
            <div
              style={{
                display: 'flex',
                borderBottom: '1px solid var(--color-border, #e0e0e0)',
                backgroundColor: 'var(--color-bg-secondary, #fafafa)',
                padding: '0 16px'
              }}
            >
              {[
                { id: 'recall', label: '🧠 知识召回与图谱可视化' },
                { id: 'context', label: '💬 系统提示词 (System Prompt)' },
                { id: 'tools', label: '🛠️ 模型参数与工具集' }
              ].map(tab => {
                const isActive = activePromptTab === tab.id
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActivePromptTab(tab.id as any)}
                    style={{
                      padding: '12px 16px',
                      background: 'none',
                      border: 'none',
                      borderBottom: isActive ? '3px solid #8b5cf6' : '3px solid transparent',
                      color: isActive ? '#8b5cf6' : 'var(--color-text-secondary, #666)',
                      fontWeight: isActive ? 600 : 500,
                      fontSize: '13px',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      marginBottom: '-1px'
                    }}
                  >
                    {tab.label}
                  </button>
                )
              })}
            </div>

            {/* 弹框内容 */}
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '20px'
              }}
            >
              {/* Tab 1: 知识召回与图谱可视化 */}
              {activePromptTab === 'recall' && (() => {
                const debug = msg.promptInfo.recallDebug
                const candidates = debug?.allScored || []
                return (
                  <div>
                    <div
                      style={{
                        marginBottom: '16px',
                        padding: '10px 14px',
                        backgroundColor: 'rgba(139, 92, 246, 0.05)',
                        border: '1px solid rgba(139, 92, 246, 0.15)',
                        borderRadius: '8px',
                        fontSize: '12px',
                        color: '#8b5cf6'
                      }}
                    >
                      💡 本面板展示基于仿 SAG 机制的本地关系图谱与多路混合检索打分结果。最终排名前三且总分大于 0.05 的经验事实将被召回并注入系统提示词尾部。
                    </div>

                    {/* SVG 拓扑网络图 */}
                    <div style={{ marginBottom: '20px' }}>
                      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: 'var(--color-text-primary, #333)' }}>🕸️ 动态图谱实体联想路径：</div>
                      {renderSvgGraph(debug)}
                    </div>

                    {/* 评分进度条候选列表 */}
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '10px', color: 'var(--color-text-primary, #333)' }}>📝 候选避坑经验打分细节：</div>
                      {candidates.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {candidates.slice(0, 5).map((c: any, idx: number) => {
                            const isRecalled = idx < 3 && c.score > 0.05
                            return (
                              <div
                                key={c.id || idx}
                                style={{
                                  border: isRecalled ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid var(--color-border, #e0e0e0)',
                                  borderRadius: '8px',
                                  padding: '12px',
                                  backgroundColor: isRecalled ? 'rgba(16, 185, 129, 0.02)' : 'var(--color-bg-secondary, #fafafa)',
                                  transition: 'all 0.2s ease'
                                }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                                  <div style={{ fontWeight: 500, fontSize: '13px', color: isRecalled ? 'var(--color-text-primary, #111)' : 'var(--color-text-muted, #777)', flex: 1, paddingRight: '12px', wordBreak: 'break-all' }}>
                                    {isRecalled && (
                                      <span style={{
                                        marginRight: '6px',
                                        backgroundColor: '#10b981',
                                        color: '#fff',
                                        padding: '1px 6px',
                                        borderRadius: '4px',
                                        fontSize: '10px',
                                        fontWeight: 'bold',
                                        verticalAlign: 'middle'
                                      }}>
                                        ✓ 召回注入
                                      </span>
                                    )}
                                    {c.fact}
                                  </div>
                                  <div style={{ textAlign: 'right', minWidth: '50px' }}>
                                    <div style={{ fontSize: '10px', color: 'var(--color-text-secondary, #888)' }}>最终总分</div>
                                    <div style={{ fontSize: '15px', fontWeight: 'bold', color: isRecalled ? '#8b5cf6' : '#999' }}>
                                      {c.score.toFixed(3)}
                                    </div>
                                  </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: '11px', color: 'var(--color-text-secondary, #666)' }}>
                                  <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                      <span>🧬 向量分 (40%):</span>
                                      <span style={{ fontWeight: 600 }}>{c.vectorScore.toFixed(3)}</span>
                                    </div>
                                    <div style={{ height: '5px', backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                                      <div style={{ height: '100%', width: `${c.vectorScore * 100}%`, background: 'linear-gradient(90deg, #06b6d4, #3b82f6)', borderRadius: '3px' }} />
                                    </div>
                                  </div>
                                  <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                      <span>🕸️ 图谱分 (30%):</span>
                                      <span style={{ fontWeight: 600 }}>{c.graphScore.toFixed(2)}</span>
                                    </div>
                                    <div style={{ height: '5px', backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                                      <div style={{ height: '100%', width: `${Math.min(1, c.graphScore) * 100}%`, background: 'linear-gradient(90deg, #8b5cf6, #d946ef)', borderRadius: '3px' }} />
                                    </div>
                                  </div>
                                  <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                      <span>📝 文本分 (20%):</span>
                                      <span style={{ fontWeight: 600 }}>{c.jaccardScore.toFixed(3)}</span>
                                    </div>
                                    <div style={{ height: '5px', backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                                      <div style={{ height: '100%', width: `${c.jaccardScore * 100}%`, background: 'linear-gradient(90deg, #ec4899, #f43f5e)', borderRadius: '3px' }} />
                                    </div>
                                  </div>
                                  <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                                      <span>⏳ 遗忘强度 (10%):</span>
                                      <span style={{ fontWeight: 600 }}>{c.sNow.toFixed(2)}</span>
                                    </div>
                                    <div style={{ height: '5px', backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                                      <div style={{ height: '100%', width: `${Math.min(1, c.sNow) * 100}%`, background: 'linear-gradient(90deg, #f59e0b, #ef4444)', borderRadius: '3px' }} />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #999)', fontStyle: 'italic', padding: '12px 0', textAlign: 'center', border: '1px dashed var(--color-border)', borderRadius: '6px' }}>
                          避坑经验库为空，或者本次提问未触发任何候选匹配。
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* Tab 2: 系统提示词 (System Prompt) */}
              {activePromptTab === 'context' && (
                <div>
                  <div
                    style={{
                      marginBottom: '16px',
                      padding: '10px 14px',
                      backgroundColor: 'rgba(59, 130, 246, 0.05)',
                      border: '1px solid rgba(59, 130, 246, 0.15)',
                      borderRadius: '8px',
                      fontSize: '12px',
                      color: '#3b82f6'
                    }}
                  >
                    💡 本面板展示大模型系统提示词（System Prompt）。避坑经验与全局画像已被拼装在系统人设最末尾，以实现首尾增强引用效果。
                  </div>

                  <div style={{ border: '1px solid var(--color-border, #e0e0e0)', borderRadius: '8px', overflow: 'hidden' }}>
                    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border, #e0e0e0)', backgroundColor: 'var(--color-bg-secondary, #f5f5f5)', fontWeight: 600, fontSize: '12px' }}>
                      🖥️ System Prompt 拼接详情
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        padding: '16px',
                        fontSize: '12.5px',
                        whiteSpace: 'pre-wrap',
                        maxHeight: '45vh',
                        overflow: 'auto',
                        backgroundColor: 'var(--color-bg-tertiary, #fafafa)',
                        lineHeight: '1.6',
                        fontFamily: 'Courier New, Courier, monospace',
                        color: 'var(--color-text-primary, #333)'
                      }}
                    >
                      {msg.promptInfo.systemPrompt}
                    </pre>
                  </div>
                </div>
              )}

              {/* Tab 3: 模型参数与工具集 */}
              {activePromptTab === 'tools' && (
                <div>
                  {/* 网格卡片 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                    {/* 模型配置卡 */}
                    <div
                      style={{
                        padding: '16px',
                        backgroundColor: 'var(--color-bg-secondary, #fafafa)',
                        border: '1px solid var(--color-border, #e0e0e0)',
                        borderRadius: '8px',
                        fontSize: '13px'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '10px', fontSize: '14px', borderBottom: '1px solid var(--color-border)', paddingBottom: '6px' }}>📊 模型配置参数</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div><strong>模型:</strong> {msg.promptInfo.model || '未知'}</div>
                        <div><strong>服务商:</strong> {msg.promptInfo.provider || '未知'}</div>
                        <div><strong>采样温度:</strong> {msg.promptInfo.temperature ?? '默认 (1.0)'}</div>
                        <div><strong>最大生成 Token:</strong> {msg.promptInfo.maxTokens ?? '默认 (不限)'}</div>
                      </div>
                    </div>

                    {/* Token 估算卡 */}
                    <div
                      style={{
                        padding: '16px',
                        backgroundColor: 'rgba(16, 185, 129, 0.02)',
                        border: '1px solid rgba(16, 185, 129, 0.2)',
                        borderRadius: '8px',
                        fontSize: '13px'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '10px', fontSize: '14px', color: '#10b981', borderBottom: '1px solid rgba(16,185,129,0.15)', paddingBottom: '6px' }}>📏 Token 估算与占比</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div><strong>系统预设:</strong> ~{formatTokens(estimateTokens(msg.promptInfo.systemPrompt || ''))}</div>
                        <div><strong>历史上下文:</strong> ~{formatTokens(estimateTokens(JSON.stringify(msg.promptInfo.chatMessages.slice(1))))}</div>
                        <div><strong>工具定义:</strong> ~{formatTokens(estimateTokens(JSON.stringify(msg.promptInfo.toolsDefinition || [])))}</div>
                        <div style={{ borderTop: '1px dashed rgba(16,185,129,0.2)', paddingTop: '4px', marginTop: '4px', fontWeight: 'bold' }}>
                          总计输入估算: ~{formatTokens(
                            estimateTokens(msg.promptInfo.systemPrompt || '') +
                            estimateTokens(JSON.stringify(msg.promptInfo.chatMessages.slice(1))) +
                            estimateTokens(JSON.stringify(msg.promptInfo.toolsDefinition || []))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 携带的工具定义 */}
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '13px', color: 'var(--color-text-primary, #333)' }}>🛠️ 注入模型工具库 (Tools Schema)</div>
                    {msg.promptInfo.toolsDefinition && msg.promptInfo.toolsDefinition.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {msg.promptInfo.toolsDefinition.map((tool: any, idx: number) => {
                          const func = tool.function || tool
                          return (
                            <div key={idx} style={{ padding: '12px', border: '1px solid var(--color-border, #e0e0e0)', borderRadius: '8px', backgroundColor: 'var(--color-bg-secondary, #fafafa)' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                <span style={{ fontWeight: 'bold', color: '#8b5cf6', fontFamily: 'monospace', fontSize: '12px' }}>
                                  {func.name}
                                </span>
                                <span style={{ fontSize: '10px', color: '#999', backgroundColor: 'rgba(0,0,0,0.05)', padding: '1px 6px', borderRadius: '4px' }}>
                                  {tool.type || 'function'}
                                </span>
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--color-text-secondary, #666)', lineHeight: '1.4' }}>
                                {func.description}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div style={{ fontStyle: 'italic', fontSize: '11px', color: '#999', padding: '12px 0', textAlign: 'right', border: '1px dashed var(--color-border)', borderRadius: '6px' }}>
                        本次调用未携带任何工具定义。
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {previewImageSrc && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
          onClick={() => setPreviewImageSrc(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            if (window.api && typeof window.api.showImageContextMenu === 'function') {
              window.api.showImageContextMenu(previewImageSrc)
            }
          }}
        >
          <img src={previewImageSrc} style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </div>
  )
}

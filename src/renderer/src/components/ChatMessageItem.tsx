import React, { useState, useEffect, useMemo } from 'react'
import { setInternalClipboard } from '../hooks/useAppStore'

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
  // 匹配三种模式：
  //   1. ![alt](url)  — 显式图片
  //   2. [text](url)  — markdown 链接
  //   3. https://...   — 裸 URL（不在 markdown 语法内的独立 URL）
  const linkOrImgRegex = /(!?\[.*?\]\(.*?\))|((?:https?:\/\/)[^\s\])<>"]+)/g
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
          parts.push(
            <a key={`link-${keyIdxStart.val++}`} href={src} target="_blank" rel="noreferrer" className="markdown-link">
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
        parts.push(
          <a key={`link-${keyIdxStart.val++}`} href={src} target="_blank" rel="noreferrer" className="markdown-link">
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
export function ToolCallItem({ step, isThinking }: { step: any; isThinking: boolean }) {
  const [isItemCollapsed, setIsItemCollapsed] = useState(true) // 默认是折叠的

  useEffect(() => {
    if (!isThinking) {
      setIsItemCollapsed(true)
    }
  }, [isThinking])

  const displayCmd = typeof step.detail === 'object' && step.detail !== null
    ? (step.detail.command || JSON.stringify(step.detail))
    : String(step.detail)

  return (
    <div className="tool-step-item call">
      <div
        className="step-call-header"
        onClick={() => setIsItemCollapsed(!isItemCollapsed)}
        title="点击展开/收起调用详情"
      >
        <div className="step-call-title-area">
          <span className="step-title">深度思考</span>
          <span className="step-call-info">
            正在调用系统工具: <span className="highlight-tool">{step.name}</span>
          </span>
        </div>
        <span className="step-call-arrow">{isItemCollapsed ? ' ∨' : ' ∧'}</span>
      </div>

      {!isItemCollapsed && (
        <div className="step-call-cmd">
          <code>&gt;_ {displayCmd}</code>
        </div>
      )}
    </div>
  )
}

// ── 可独立折叠的工具具体执行结果子组件 ─────────────────────────────────
export function ToolResultItem({ step, isThinking }: { step: any; isThinking: boolean }) {
  const [isItemCollapsed, setIsItemCollapsed] = useState(true) // 默认是折叠的

  useEffect(() => {
    if (!isThinking) {
      setIsItemCollapsed(true)
    }
  }, [isThinking])

  const displayResult = typeof step.detail === 'string'
    ? step.detail
    : JSON.stringify(step.detail, null, 2)

  return (
    <div className="tool-step-item result">
      <div
        className="step-result-header"
        onClick={() => setIsItemCollapsed(!isItemCollapsed)}
        title="点击展开/收起具体内容"
      >
        <span className="step-result-title">
          📝 {step.name === 'run_terminal_command' ? 'PowerShell 终端指令执行结果' : `${step.name} 工具返回结果`}
        </span>
        <span className="step-result-arrow">{isItemCollapsed ? ' ∨' : ' ∧'}</span>
      </div>

      {!isItemCollapsed && (
        <pre className="step-result-code">
          <code>{displayResult}</code>
        </pre>
      )}
    </div>
  )
}

// ── 统一排版与折叠日志状态的消息项组件 ──────────────────────────────
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
        window.api?.copyText?.(textToCopy) || navigator.clipboard.writeText(textToCopy)
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
  const callsCount = toolSteps.filter((s: any) => s.type === 'call').length
  const msgsCount = toolSteps.length

  const senderName = msg.sender === 'user' ? '我' : currentAvatarName
  const avatarText = msg.sender === 'user' ? '👤' : '🐱'

  return (
    <div id={`msg-${msg.id}`} className={`message-row ${msg.sender} ${highlightedMessageId === msg.id ? 'highlight-pulse' : ''}`}>
      <div className="message-header-row">
        {msg.sender !== 'user' && <span className="msg-sender-avatar">{avatarText}</span>}
        <span className="msg-sender-name">{senderName}</span>
        <span className="msg-send-time">{msg.time}</span>
      </div>

      <div className="message-bubble">
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

        {/* 思考中且有系统工具调用时展示折叠区 */}
        {toolSteps.length > 0 && (
          <div className={`tool-steps-panel ${currentCollapsed ? 'collapsed' : 'expanded'}`}>
            <div className="tool-steps-summary" onClick={() => setUserCollapsed(!currentCollapsed)}>
              <span className="summary-arrow">{currentCollapsed ? '▶' : '▼'}</span>
              <span className="summary-text">
                工具调用 {callsCount} · 过程消息 {msgsCount}
              </span>
            </div>

            {!currentCollapsed && (
              <div className="tool-steps-list">
                {toolSteps.map((step: any) => {
                  if (step.type === 'call') {
                    return (
                      <ToolCallItem key={step.id} step={step} isThinking={msg.isThinking} />
                    )
                  } else {
                    return (
                      <ToolResultItem key={step.id} step={step} isThinking={msg.isThinking} />
                    )
                  }
                })}
              </div>
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
              width: '80vw',
              maxWidth: '900px',
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
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                🔍 本次提问传给 Agent 的完整内容
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

            {/* 弹框内容 */}
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '20px'
              }}
            >
              {/* 说明信息 */}
              <div
                style={{
                  marginBottom: '16px',
                  padding: '12px 16px',
                  backgroundColor: 'rgba(96, 165, 250, 0.08)',
                  border: '1px solid rgba(96, 165, 250, 0.2)',
                  borderRadius: '8px',
                  fontSize: '13px',
                  color: '#3b82f6'
                }}
              >
                💡 以下是本次提问调用 <code>callLLM()</code> 时传入的完整参数，包括系统提示词、历史对话上下文、工具定义和模型配置。
              </div>

              {/* 模型配置信息 */}
              <div
                style={{
                  marginBottom: '20px',
                  padding: '12px 16px',
                  backgroundColor: 'var(--color-bg-tertiary, #f0f0f0)',
                  borderRadius: '8px',
                  fontSize: '13px'
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '8px' }}>📊 模型配置</div>
                <div>模型: {msg.promptInfo.model || '未知'}</div>
                <div>提供商: {msg.promptInfo.provider || '未知'}</div>
                <div>温度: {msg.promptInfo.temperature ?? '默认'}</div>
                <div>最大 Token: {msg.promptInfo.maxTokens ?? '默认'}</div>
              </div>

              {/* Token 估算统计 */}
              <div
                style={{
                  marginBottom: '20px',
                  padding: '12px 16px',
                  backgroundColor: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                  borderRadius: '8px',
                  fontSize: '13px'
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '8px', color: '#10b981' }}>📏 Token 估算统计</div>
                <div>系统提示词: ~{formatTokens(estimateTokens(msg.promptInfo.systemPrompt || ''))}</div>
                <div>历史对话 ({msg.promptInfo.chatMessages.length - 1} 条): ~{formatTokens(estimateTokens(JSON.stringify(msg.promptInfo.chatMessages.slice(1))))}</div>
                <div>工具定义 ({msg.promptInfo.toolsDefinition?.length || 0} 个): ~{formatTokens(estimateTokens(JSON.stringify(msg.promptInfo.toolsDefinition || [])))}</div>
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(16, 185, 129, 0.2)', fontWeight: 600 }}>
                  总计估算: ~{formatTokens(
                    estimateTokens(msg.promptInfo.systemPrompt || '') +
                    estimateTokens(JSON.stringify(msg.promptInfo.chatMessages.slice(1))) +
                    estimateTokens(JSON.stringify(msg.promptInfo.toolsDefinition || []))
                  )}
                </div>
                <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                  💡 估算方式：字符数 × 0.5（与日志中 Prompt 输入的降级估算策略一致）
                </div>
              </div>

              {/* 完整 chatMessages 数组 */}
              <div>
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: '8px',
                    fontSize: '14px',
                    color: 'var(--color-text-primary, #333)'
                  }}
                >
                  📦 完整 chatMessages 数组 (共 {msg.promptInfo.chatMessages.length} 条消息)
                </div>
                <div
                  style={{
                    border: '1px solid var(--color-border, #e0e0e0)',
                    borderRadius: '8px',
                    overflow: 'hidden'
                  }}
                >
                  {msg.promptInfo.chatMessages.map((m: any, idx: number) => (
                    <div
                      key={idx}
                      style={{
                        padding: '12px 16px',
                        borderBottom: idx < msg.promptInfo.chatMessages.length - 1 ? '1px solid var(--color-border, #e0e0e0)' : 'none',
                        backgroundColor: m.role === 'system'
                          ? 'var(--color-bg-system, #fff3cd)'
                          : m.role === 'user'
                            ? 'var(--color-bg-user, #e3f2fd)'
                            : 'var(--color-bg-assistant, #f3e5f5)'
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: '12px',
                          marginBottom: '4px',
                          color: 'var(--color-text-secondary, #666)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                      >
                        {m.role === 'system' ? '⚙️ 系统' : m.role === 'user' ? '👤 用户' : '🤖 助手'}
                        <span style={{ fontSize: '11px', color: '#999' }}>
                          (#{idx + 1} · ~{formatTokens(estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))})
                        </span>
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          fontSize: '12px',
                          lineHeight: '1.6',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontFamily: 'inherit',
                          maxHeight: '200px',
                          overflow: 'auto'
                        }}
                      >
                        {typeof m.content === 'string'
                          ? m.content
                          : JSON.stringify(m.content, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
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

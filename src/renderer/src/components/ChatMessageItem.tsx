import React, { useState, useEffect } from 'react'

// ── 复制代码块的高级代码面板组件 ─────────────────────────────────
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(code)
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

export function ChatImage({ src, alt }: { src: string; alt: string }) {
  const [hasError, setHasError] = useState(false)

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
        cursor: 'pointer'
      }}
      onClick={() => window.open(src)}
      onError={() => setHasError(true)}
    />
  )
}

// 渲染包含图片的普通文本部分
export function renderPlainOrImageText(text: string, keyIdxStart: { val: number }): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const imgRegex = /!\[(.*?)\]\((.*?)\)/g
  let match
  let lastIndex = 0

  while ((match = imgRegex.exec(text)) !== null) {
    const textBefore = text.substring(lastIndex, match.index)
    if (textBefore.trim()) {
      parts.push(<MarkdownText key={`text-${keyIdxStart.val++}`} rawText={textBefore} />)
    }

    const alt = match[1]
    const src = match[2]
    parts.push(
      <ChatImage key={`img-${keyIdxStart.val++}`} src={src} alt={alt} />
    )

    lastIndex = imgRegex.lastIndex
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

  const handleCopy = () => {
    if (!msg.text) return
    const textToCopy = msg.text === '__WELCOME_MSG__'
      ? `欢迎来到 agentself 终端！我是您的智能助理 ${currentAvatarName}。有什么我可以帮您的吗？`
      : msg.text === '__SYSTEM_INIT_MSG__'
        ? `系统：已成功加载 ${currentAvatarName} 神经网络内核 V2.1.0。内核状态 [正常]。`
        : msg.text
    navigator.clipboard.writeText(textToCopy)
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
        {/* 如果附带了文件 */}
        {msg.fileInfo && (
          <div className="message-file-badge">
            <span className="file-badge-icon">📄</span>
            <div className="file-badge-info">
              <span className="file-badge-name" title={msg.fileInfo.name}>{msg.fileInfo.name}</span>
              <span className="file-badge-size">{msg.fileInfo.content.length} 字符</span>
            </div>
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
        {msg.text && (
          <div className="message-text">
            {renderAdvancedMessage(
              msg.text === '__WELCOME_MSG__'
                ? `欢迎来到 agentself 终端！我是您的智能助理 ${currentAvatarName}。有什么我可以帮您的吗？`
                : msg.text === '__SYSTEM_INIT_MSG__'
                  ? `系统：已成功加载 ${currentAvatarName} 神经网络内核 V2.1.0。内核状态 [正常]。`
                  : msg.text
            )}
          </div>
        )}
      </div>

      {msg.text && !msg.isThinking && (
        <div className="message-action-row">
          <button className="msg-copy-btn" onClick={handleCopy} title="复制消息内容">
            {copied ? '✓' : '📋'}
          </button>
        </div>
      )}
    </div>
  )
}

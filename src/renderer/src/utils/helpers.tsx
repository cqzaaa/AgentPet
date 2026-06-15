import React from 'react'

// ── 默认模型常量 ─────────────────────────────────────────────
export const DEFAULT_MODELS: Record<string, string> = {
  gemini: 'gemini-1.5-flash',
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
  ollama: 'llama3',
  custom: ''
}

// ── 格式化年月日时间 ──────────────────────────────────────────
export function formatDateTime(date: Date = new Date()): string {
  const yyyy = date.getFullYear()
  const MM = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const HH = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`
}


// ── 字节格式化 ───────────────────────────────────────────────
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// ── 秒数格式化 ───────────────────────────────────────────────
export const formatSeconds = (sec: number): string => {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return `${h > 0 ? h + '时' : ''}${m}分${s}秒`
}

// ── 简单 Markdown 渲染（仅支持代码块）───────────────────────
export function renderMessageText(text: string): React.ReactNode {
  if (!text) return ''
  const parts: React.ReactNode[] = []
  let keyIdx = 0

  const codeRegex = /```([\s\S]*?)```/g
  let match
  let lastIndex = 0

  while ((match = codeRegex.exec(text)) !== null) {
    const textBefore = text.substring(lastIndex, match.index)
    if (textBefore) {
      parts.push(<span key={`t-${keyIdx++}`}>{textBefore}</span>)
    }

    const codeContent = match[1]
    const firstLineBreak = codeContent.indexOf('\n')
    let displayCode = codeContent
    if (firstLineBreak !== -1) {
      const maybeLang = codeContent.substring(0, firstLineBreak).trim()
      if (maybeLang.length < 10) {
        displayCode = codeContent.substring(firstLineBreak + 1)
      }
    }

    parts.push(
      <pre key={`c-${keyIdx++}`}>
        <code>{displayCode}</code>
      </pre>
    )

    lastIndex = codeRegex.lastIndex
  }

  const textAfter = text.substring(lastIndex)
  if (textAfter) {
    parts.push(<span key={`t-${keyIdx++}`}>{textAfter}</span>)
  }

  return parts.length > 0 ? <>{parts}</> : text
}

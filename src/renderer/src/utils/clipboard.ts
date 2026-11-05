import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * 统一复制文本到剪贴板
 * 按优先级尝试：
 * 1. window.api.copyText（Electron 主进程 IPC，无视渲染窗口焦点与安全域限制）
 * 2. navigator.clipboard.writeText（现代 Web 标准 API）
 * 3. 临时 textarea + document.execCommand('copy')（传统降级方案）
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false

  // 1. Electron 原生主进程剪贴板通道
  if (window.api && typeof window.api.copyText === 'function') {
    try {
      window.api.copyText(text)
      return true
    } catch (_) {}
  }

  // 2. 现代 Web 标准 API
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_) {}
  }

  // 3. 兼容降级
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const successful = document.execCommand('copy')
    document.body.removeChild(textarea)
    return successful
  } catch (err) {
    console.warn('[clipboard] copy failed:', err)
    return false
  }
}

/**
 * 统一复制文件和附带文本到系统剪贴板（如从消息复制文件）
 */
export async function copyFilesToClipboard(filePaths: string[], text?: string): Promise<boolean> {
  if (filePaths.length > 0 && window.api && typeof window.api.copyFiles === 'function') {
    try {
      const res = await window.api.copyFiles(filePaths, text)
      if (res?.success) return true
    } catch (_) {}
  }

  if (text) {
    return copyTextToClipboard(text)
  }
  return false
}

/**
 * 复制反馈 Hook，统一管理 copied 视觉状态与防抖恢复计时器
 */
export function useCopyFeedback(timeoutMs = 2000): {
  copied: boolean
  copy: (text: string) => Promise<boolean>
} {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  const copy = useCallback(
    async (text: string) => {
      const success = await copyTextToClipboard(text)
      if (success) {
        setCopied(true)
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => {
          setCopied(false)
          timerRef.current = null
        }, timeoutMs)
      }
      return success
    },
    [timeoutMs]
  )

  return { copied, copy }
}

/**
 * 统一解析剪贴板事件数据（文本、文件、图片标记等）
 */
export interface ExtractedClipboardData {
  text: string
  files: File[]
  hasImage: boolean
  imageFiles: File[]
}

export function extractClipboardData(
  event: React.ClipboardEvent | ClipboardEvent
): ExtractedClipboardData {
  const clipboardData = event.clipboardData
  if (!clipboardData) {
    return { text: '', files: [], hasImage: false, imageFiles: [] }
  }
  const text = clipboardData.getData('text/plain') || ''
  const files = Array.from(clipboardData.files || [])
  const items = Array.from(clipboardData.items || [])
  const hasImage = items.some((item) => item.type.startsWith('image/'))
  const imageFiles = files.filter((f) => f.type.startsWith('image/'))
  return { text, files, hasImage, imageFiles }
}

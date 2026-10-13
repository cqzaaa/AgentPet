import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Copy, Check, X, FileText, Loader2 } from 'lucide-react'

export interface PastedTextModalProps {
  title: string
  content?: string
  path?: string
  onClose: () => void
}

/** 剔除任何历史附带的附件预读截断提示，确保纯净展示真实文本 */
function stripTruncationNotice(raw: string): string {
  if (!raw) return ''
  return raw.replace(/\n*\[附件文本预读已截断[\s\S]*?\]/g, '').trimEnd()
}

/** 检测文本是否含有历史截断标记 */
function hasTruncationNotice(raw?: string): boolean {
  if (!raw) return false
  return /\[附件文本预读已截断/i.test(raw)
}

export const PastedTextModal: React.FC<PastedTextModalProps> = ({
  title,
  content: initialContent,
  path,
  onClose
}) => {
  const sanitizedInitial = useMemo(() => stripTruncationNotice(initialContent || ''), [initialContent])
  const needFetchFull = Boolean(path) && (!initialContent || hasTruncationNotice(initialContent))

  const [text, setText] = useState<string>(sanitizedInitial)
  const [loading, setLoading] = useState<boolean>(needFetchFull && !sanitizedInitial)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState<boolean>(false)

  // 完整文本懒加载（优先读取磁盘真实完整文件，彻底规避 8000 字限制）
  useEffect(() => {
    // 如果已有无截断的初始内容且不需要从磁盘拉取完整文本，直接同步
    if (sanitizedInitial && !needFetchFull) {
      setText(sanitizedInitial)
      setLoading(false)
      return
    }

    if (!path) {
      setText(sanitizedInitial)
      setLoading(false)
      return
    }

    let isMounted = true
    // 如果还没有任何初始内容，则展示加载骨架；若已有前段预览内容，则后台静默补全完整文本
    if (!sanitizedInitial) {
      setLoading(true)
    }
    setLoadError(null)

    const fetchFullContent = async (): Promise<void> => {
      try {
        let fullText = ''
        if (window.api?.readTextFile) {
          // 走全新无截断纯文本读取通道
          fullText = await window.api.readTextFile(path)
        } else if (window.api?.parseFileContent) {
          // 降级回退
          fullText = await window.api.parseFileContent(path)
        } else {
          throw new Error('未提供文件读取接口')
        }

        if (isMounted) {
          const cleanText = stripTruncationNotice(fullText || '')
          setText(cleanText)
          setLoading(false)
        }
      } catch (err: any) {
        if (isMounted) {
          // 如果读取失败但已有初始前段内容，保留初始内容而不打断用户视线
          if (!sanitizedInitial) {
            setLoadError(err?.message || '读取完整文本内容失败')
          }
          setLoading(false)
        }
      }
    }

    void fetchFullContent()

    return () => {
      isMounted = false
    }
  }, [sanitizedInitial, path, needFetchFull])

  // 键盘 Esc 关闭监听
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // 统计字符数和行数（基于真实完整文本）
  const stats = useMemo(() => {
    if (!text) return { chars: 0, lines: 0 }
    const chars = text.length
    const lines = text.split(/\r?\n/).length
    return { chars, lines }
  }, [text])

  const handleCopy = useCallback(async () => {
    if (!text || copied) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 复制失败静默处理 */
    }
  }, [text, copied])

  return (
    <div
      className="pasted-text-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="查看粘贴的文本"
    >
      <div
        className="pasted-text-modal-container"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏（Taste 风格微排版） */}
        <div className="pasted-text-modal-header">
          <div className="pasted-text-modal-header-left">
            <div className="pasted-text-modal-avatar-badge" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M7 4H5.6C4.71634 4 4 4.71634 4 5.6V7M13 4H14.4C15.2837 4 16 4.71634 16 5.6V7M4 13V14.4C4 15.2837 4.71634 16 5.6 16H7M16 13V14.4C16 15.2837 15.2837 16 14.4 16H13M8 8.75H11M8 11.25H12.2"
                  stroke="currentColor"
                  strokeWidth="1.65"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="pasted-text-modal-meta">
              <div className="pasted-text-modal-title" title={title}>
                {title || '粘贴的文本'}
              </div>
              <div className="pasted-text-modal-pills">
                <span className="pasted-text-modal-pill">粘贴文本</span>
                {!loading && !loadError && (
                  <span className="pasted-text-modal-stat">
                    {stats.chars.toLocaleString()} 字符 · {stats.lines} 行
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="pasted-text-modal-header-right">
            <button
              type="button"
              className={`pasted-text-action-btn ${copied ? 'is-copied' : ''}`}
              onClick={() => void handleCopy()}
              disabled={loading || Boolean(loadError) || !text}
              title="复制全部内容"
              aria-label="复制全部内容"
            >
              {copied ? (
                <>
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  <span>已复制</span>
                </>
              ) : (
                <>
                  <Copy size={13} strokeWidth={2} aria-hidden="true" />
                  <span>复制文本</span>
                </>
              )}
            </button>

            <button
              type="button"
              className="pasted-text-modal-close-btn"
              onClick={onClose}
              title="关闭 (Esc)"
              aria-label="关闭预览"
            >
              <X size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* 文本内容区域（完整加载，支持滚动浏览） */}
        <div className="pasted-text-modal-body">
          {loading ? (
            <div className="pasted-text-skeleton-wrapper">
              <div className="pasted-text-skeleton-notice">
                <Loader2 size={15} className="pasted-text-spin-icon" aria-hidden="true" />
                <span>正在加载全部文本内容...</span>
              </div>
              <div className="pasted-text-skeleton-line w-85" />
              <div className="pasted-text-skeleton-line w-95" />
              <div className="pasted-text-skeleton-line w-70" />
              <div className="pasted-text-skeleton-line w-90" />
              <div className="pasted-text-skeleton-line w-60" />
              <div className="pasted-text-skeleton-line w-80" />
            </div>
          ) : loadError ? (
            <div className="pasted-text-error-notice">
              <FileText size={20} strokeWidth={1.75} aria-hidden="true" />
              <p>{loadError}</p>
            </div>
          ) : (
            <div className="pasted-text-content-scroll">
              <pre className="pasted-text-pre-view">{text}</pre>
            </div>
          )}
        </div>

        {/* 底部微操作状态栏 */}
        <div className="pasted-text-modal-footer">
          <span className="pasted-text-footer-tip">按 Esc 或点击遮罩可随时关闭</span>
          {Boolean(path) && (
            <span className="pasted-text-footer-path" title={path}>
              已完整保存至本地会话
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default PastedTextModal

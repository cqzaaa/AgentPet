import { useEffect, useRef, useState } from 'react'
import { createViewer } from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import { createFileViewerPlugins, localFilePreviewUrl } from './fileViewerPlugins'
import type { WikiEntityEvidence, WikiEvidenceLocation } from '../../../preload/wiki-types'
import { findPreviewQuote, rotateEvidenceRegion } from './previewEvidence'

export function EmbeddedFileViewer({
  path,
  name,
  itemId,
  evidence,
  onShowText
}: {
  path: string
  name: string
  itemId?: string
  evidence?: WikiEntityEvidence
  onShowText: () => void
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ReturnType<typeof createViewer> | null>(null)
  const ready = useRef(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [locationStatus, setLocationStatus] = useState('')
  const [rotation, setRotation] = useState(0)
  const [location, setLocation] = useState<{
    itemId: string
    nodeId: string
    data: WikiEvidenceLocation
  } | null>(null)
  const evidenceLocation =
    location?.itemId === itemId && location?.nodeId === evidence?.nodeId
      ? location?.data
      : undefined

  useEffect(() => {
    const nodeId = evidence?.nodeId
    if (!itemId || !nodeId) return
    let active = true
    void window.api
      .wikiGetEvidenceLocation(itemId, nodeId)
      .then((data) => {
        if (active) setLocation({ itemId, nodeId, data })
      })
      .catch(() => {
        if (active)
          setLocation({
            itemId,
            nodeId,
            data: { regions: [], reason: '原页坐标读取失败，请重新打开文档重试。' }
          })
      })
    return () => {
      active = false
    }
  }, [itemId, evidence?.nodeId])

  useEffect(() => {
    if (!container.current) return
    let active = true
    let viewer: ReturnType<typeof createViewer> | undefined
    ready.current = false
    setLoading(true)
    setError('')
    const fail = (reason: unknown): void => {
      if (!active) return
      setLoading(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
    try {
      viewer = createViewer({
        container: container.current,
        file: localFilePreviewUrl(path),
        fileName: name,
        width: '100%',
        height: '100%',
        fit: 'width',
        locale: 'zh-CN',
        toolbar: {
          zoom: true,
          rotate: true,
          download: true,
          fullscreen: true,
          print: true,
          search: false
        },
        plugins: createFileViewerPlugins({ onPdfRotationChange: setRotation }),
        onLoad: () => {
          if (active) {
            ready.current = true
            setLoading(false)
          }
        },
        onError: fail
      })
      viewerRef.current = viewer
    } catch (reason) {
      fail(reason)
    }
    return () => {
      active = false
      ready.current = false
      viewerRef.current = null
      viewer?.destroy()
    }
  }, [path, name, attempt])

  useEffect(() => {
    const root = container.current
    const viewer = viewerRef.current
    if (!root || !viewer || !ready.current || loading || error || !evidence) return
    let active = true
    let frame = 0
    let located = false
    const page =
      evidence.pageStart && Number.isInteger(evidence.pageStart) && evidence.pageStart > 0
        ? evidence.pageStart
        : null
    const pageSelector =
      '.ofv-pdf-page-wrapper, .ofv-docx-page-frame, .ofv-docx-textbox-page, .ofv-wordml-page, .ofv-msdoc-page, .ofv-slide, .ofv-ppt-binary-slide'
    const pages = root.querySelectorAll<HTMLElement>(pageSelector)
    const missingPage = Boolean(page && pages.length && page > pages.length)
    const pageLocated = Boolean(page && !missingPage && viewer.goToPage(page))
    const pageStatus = pageLocated
      ? `证据位于第 ${page} 页`
      : missingPage
        ? `原文件中没有第 ${page} 页`
        : '已打开原文件'
    const highlights = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null
    const highlightName = 'wiki-source-evidence'
    const boxes = new Set<HTMLElement>()
    const clearBoxes = (): void => {
      boxes.forEach((box) => box.remove())
      boxes.clear()
    }
    const drawSourceBoxes = (): HTMLElement | undefined => {
      boxes.forEach((box) => {
        if (!box.isConnected) boxes.delete(box)
      })
      let first: HTMLElement | undefined
      for (const [index, source] of (evidenceLocation?.regions || []).entries()) {
        const wrapper = root.querySelector<HTMLElement>(
          `.ofv-pdf-page-wrapper[data-page-index="${source.page - 1}"]`
        )
        if (!wrapper) continue
        let box = wrapper.querySelector<HTMLElement>(
          `.wiki-evidence-region[data-region-index="${index}"]`
        )
        if (!box) {
          const rect = rotateEvidenceRegion(source, rotation)
          box = document.createElement('div')
          box.className = 'wiki-evidence-region'
          box.dataset.regionIndex = String(index)
          box.setAttribute('aria-hidden', 'true')
          Object.assign(box.style, {
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`
          })
          wrapper.append(box)
          boxes.add(box)
        }
        if (!first || source.page === page) first = box
      }
      return first
    }
    const locate = (): void => {
      if (!active) return
      // Scope paginated text to the evidence page, including after a zoom re-renders it.
      const targetPage = page ? root.querySelectorAll<HTMLElement>(pageSelector)[page - 1] : null
      const scope =
        page && (pages.length || pageLocated)
          ? targetPage?.matches('.ofv-pdf-page-wrapper')
            ? targetPage.querySelector<HTMLElement>('.ofv-pdf-text-layer')
            : targetPage
          : root.querySelector<HTMLElement>('.ofv-viewport')
      const range = scope ? findPreviewQuote(scope, evidence.quote) : null
      if (!range) {
        highlights?.delete(highlightName)
        const box = drawSourceBoxes()
        if (box) {
          if (!located) box.scrollIntoView({ block: 'center', behavior: 'instant' })
          located = true
          setLocationStatus(`${pageStatus} · 已框选原文段落范围（非逐句高亮）`)
        }
        return
      }
      if (boxes.size) clearBoxes()
      if (highlights && typeof Highlight !== 'undefined')
        highlights.set(highlightName, new Highlight(range))
      if (!located)
        range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'instant' })
      located = true
      setLocationStatus(`${pageStatus} · ${highlights ? '已高亮原文证据' : '已找到原文证据'}`)
    }
    const observer = new MutationObserver((mutations) => {
      // Page virtualization also mutates unrelated pages and the page counter.
      // Only re-match when the evidence page (or its replacement) changes.
      if (page) {
        const currentPages = root.querySelectorAll<HTMLElement>(pageSelector)
        const evidencePages = new Set([
          page,
          ...(evidenceLocation?.regions.map((region) => region.page) || [])
        ])
        const targets = Array.from(evidencePages, (number) => currentPages[number - 1]).filter(
          Boolean
        )
        const affectsEvidence = mutations.some((mutation) => {
          const target = mutation.target
          if (target instanceof Element && target.closest('.wiki-evidence-region')) return false
          const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
          if (
            changedNodes.length &&
            changedNodes.every(
              (node) => node instanceof Element && node.matches('.wiki-evidence-region')
            )
          )
            return false
          return (
            !targets.length ||
            targets.some((element) => element === target || element.contains(target)) ||
            changedNodes.some(
              (node) =>
                node instanceof Element &&
                (node.matches(pageSelector) || Boolean(node.querySelector(pageSelector)))
            )
          )
        })
        if (!affectsEvidence) return
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(locate)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    frame = requestAnimationFrame(() => {
      setLocationStatus(`${pageStatus} · 正在匹配原文证据…`)
      locate()
    })
    const timeout = window.setTimeout(() => {
      if (!located)
        setLocationStatus(
          `${pageStatus} · ${evidenceLocation?.reason || '未匹配到可高亮的文字，可直接阅读原文。'}`
        )
    }, 8000)
    return () => {
      active = false
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
      clearBoxes()
      highlights?.delete(highlightName)
    }
  }, [evidence, evidenceLocation, rotation, loading, error, path, attempt])

  return (
    <div className="wiki-file-preview" aria-label={`预览 ${name}`} aria-busy={loading}>
      {evidence && !loading && !error && (
        <div className="wiki-file-preview-location" role="status">
          {locationStatus || '正在定位原文证据…'}
        </div>
      )}
      <div className="wiki-file-preview-canvas" ref={container} />
      {loading && (
        <div className="wiki-file-preview-status" role="status">
          正在加载原文…
        </div>
      )}
      {error && (
        <div className="wiki-file-preview-status" role="alert">
          <strong>无法预览此文件</strong>
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </button>
          <button type="button" onClick={onShowText}>
            查看解析文本
          </button>
        </div>
      )}
    </div>
  )
}

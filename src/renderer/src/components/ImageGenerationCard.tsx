import React, { useState, useEffect, useMemo } from 'react'
import {
  Download,
  Copy,
  Check,
  Maximize2,
  RefreshCw,
  AlertCircle,
  Sparkles
} from 'lucide-react'
import { Tooltip } from './Tooltip'
import { ImagePreviewModal } from './ImagePreviewModal'

export interface ImageGenState {
  status: 'generating' | 'success' | 'error'
  prompt: string
  referenceImagePath?: string
  imagePath?: string
  dataUrl?: string
  progress?: number
  error?: string
  revisedPrompt?: string
}

interface ImageGenerationCardProps {
  imageGen: ImageGenState
  onRetry?: () => void
  onUseAsReference?: (imagePath: string) => void
}

export const ImageGenerationCard: React.FC<ImageGenerationCardProps> = ({
  imageGen,
  onRetry,
  onUseAsReference
}) => {
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [animatedProgress, setAnimatedProgress] = useState(imageGen.progress ?? 11)

  // 进度条平滑递增动效（从 11% 逐步拟真递增到 96%，完成后跳至 100%）
  useEffect(() => {
    if (imageGen.status === 'generating') {
      const timer = setInterval(() => {
        setAnimatedProgress((prev) => {
          if (prev >= 95) return prev
          const step = Math.max(1, Math.floor((95 - prev) * 0.12))
          return Math.min(95, prev + step)
        })
      }, 600)
      return (): void => clearInterval(timer)
    } else if (imageGen.status === 'success') {
      setAnimatedProgress(100)
    }
    return undefined
  }, [imageGen.status])

  // 生成一个 17x17 点阵网格（Dot Matrix），越靠近中心点颜色越深，越向外越淡
  const dotGrid = useMemo(() => {
    const size = 17
    const center = (size - 1) / 2
    const maxDist = Math.sqrt(center * center + center * center)
    const dots: { x: number; y: number; factor: number; key: string }[] = []

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const dist = Math.sqrt(Math.pow(r - center, 2) + Math.pow(c - center, 2))
        const factor = Math.max(0, 1 - dist / maxDist) // 中心为 1，最远为 0
        dots.push({ x: c, y: r, factor, key: `${r}-${c}` })
      }
    }
    return dots
  }, [])

  // 复制图片到剪贴板
  const handleCopyImage = async (): Promise<void> => {
    const targetUrl = imageGen.dataUrl || imageGen.imagePath
    if (!targetUrl) return
    try {
      if (imageGen.dataUrl) {
        const res = await fetch(imageGen.dataUrl)
        const blob = await res.blob()
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      } else if (window.api?.copyText) {
        window.api.copyText(targetUrl)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      console.error('复制图片失败', e)
    }
  }

  // 保存图片
  const handleSaveImage = (): void => {
    const target = imageGen.dataUrl || imageGen.imagePath
    if (!target) return
    try {
      const a = document.createElement('a')
      a.href = target
      a.download = `agentpet-generated-${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error('保存图片失败', e)
    }
  }

  // 动态阶段文案：正在构思画面 -> 正在勾勒草图 -> 正在细化光影 -> 正在渲染细节
  const stageText = useMemo(() => {
    if (animatedProgress < 25) return '正在构思画面'
    if (animatedProgress < 55) return '正在勾勒草图'
    if (animatedProgress < 82) return '正在细化光影'
    return '正在渲染细节'
  }, [animatedProgress])

  return (
    <div className="image-gen-card">
      <div className="image-gen-header">
        <span className="image-gen-title">
          {imageGen.status === 'generating' ? (
            stageText
          ) : imageGen.status === 'success' ? (
            <>
              <Sparkles size={14} className="ui-icon-leading" style={{ color: '#3b82f6' }} />
              图像创建完成
            </>
          ) : (
            '图像创建失败'
          )}
        </span>
      </div>

      {imageGen.status === 'generating' && (
        <div className="image-gen-canvas" aria-label="图像创建点阵画布">
          <div className="image-gen-dot-matrix">
            {dotGrid.map((dot) => {
              // 离中心越近，蓝色越深（从 #bfdbfe 到 #2563eb），动态波纹延时交错
              const opacity = 0.14 + dot.factor * 0.82
              const size = 1.8 + dot.factor * 2.2
              const isCenterCore = dot.factor > 0.62
              // 计算基于距离中心的动画延时，形成由中心向外扩散或环状呼吸的流动波动
              const delay = ((1 - dot.factor) * 1.6).toFixed(2)
              return (
                <span
                  key={dot.key}
                  className={`image-gen-dot ${isCenterCore ? 'core' : ''}`}
                  style={{
                    width: `${size}px`,
                    height: `${size}px`,
                    backgroundColor: isCenterCore ? '#2563eb' : '#60a5fa',
                    opacity,
                    animationDelay: `${delay}s`
                  }}
                />
              )
            })}
          </div>

          {/* 右下角百分比药丸徽标（对应图3） */}
          <div className="image-gen-progress-pill">
            <span>{animatedProgress}%</span>
          </div>
        </div>
      )}

      {imageGen.status === 'success' && (
        <div className="image-gen-result-container">
          <div
            className="image-gen-image-wrapper"
            onClick={() => setPreviewSrc(imageGen.dataUrl || imageGen.imagePath || null)}
          >
            <img
              src={imageGen.dataUrl || imageGen.imagePath}
              alt={imageGen.prompt || '已创建的图像'}
              className="image-gen-result-img"
            />
            <div className="image-gen-overlay-hint">
              <Maximize2 size={16} /> 点击放大预览
            </div>
          </div>

          <div className="image-gen-actions-bar">
            <Tooltip content="放大预览" placement="top">
              <button
                type="button"
                className="image-gen-action-btn"
                onClick={() => setPreviewSrc(imageGen.dataUrl || imageGen.imagePath || null)}
              >
                <Maximize2 size={13} />
                <span>放大</span>
              </button>
            </Tooltip>
            <Tooltip content={copied ? '已复制' : '复制图像'} placement="top">
              <button type="button" className="image-gen-action-btn" onClick={handleCopyImage}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
            </Tooltip>
            <Tooltip content={saved ? '已下载' : '保存图片'} placement="top">
              <button type="button" className="image-gen-action-btn" onClick={handleSaveImage}>
                {saved ? <Check size={13} /> : <Download size={13} />}
                <span>{saved ? '已保存' : '下载'}</span>
              </button>
            </Tooltip>
            {onUseAsReference && imageGen.imagePath && (
              <Tooltip content="以此图作为参考图继续修改" placement="top">
                <button
                  type="button"
                  className="image-gen-action-btn"
                  onClick={() => onUseAsReference(imageGen.imagePath!)}
                >
                  <RefreshCw size={13} />
                  <span>作为参考图修改</span>
                </button>
              </Tooltip>
            )}
          </div>

          {imageGen.revisedPrompt && (
            <div className="image-gen-revised-prompt">
              <span className="image-gen-revised-label">模型优化提示词:</span>
              <p>{imageGen.revisedPrompt}</p>
            </div>
          )}
        </div>
      )}

      {imageGen.status === 'error' && (
        <div className="image-gen-error-container">
          <div className="image-gen-error-content">
            <AlertCircle size={18} className="image-gen-error-icon" />
            <div className="image-gen-error-text">
              <strong>生成未成功</strong>
              <p>{imageGen.error || '大模型生图接口未响应或服务报错，请检查 API Key 与生图模型配置。'}</p>
            </div>
          </div>
          {onRetry && (
            <button type="button" className="image-gen-retry-btn" onClick={onRetry}>
              <RefreshCw size={13} /> 重新尝试
            </button>
          )}
        </div>
      )}

      {previewSrc && (
        <ImagePreviewModal
          src={previewSrc}
          alt={imageGen.prompt || '图像预览'}
          onClose={() => setPreviewSrc(null)}
        />
      )}
    </div>
  )
}

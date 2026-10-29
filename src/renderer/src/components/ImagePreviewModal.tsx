import React, { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './ImagePreviewModal.css'

export interface ImagePreviewModalProps {
  src: string | null
  alt?: string
  onClose: () => void
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({
  src,
  alt = '图片预览',
  onClose
}) => {
  // 监听键盘按键 Esc 关闭
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  useEffect(() => {
    if (!src) return
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [src, handleKeyDown])

  if (!src) return null

  // 右键唤起系统级图片菜单（在图片上直接右键依然保留原生能力）
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (window.api && typeof window.api.showImageContextMenu === 'function') {
      window.api.showImageContextMenu(src)
    }
  }

  return createPortal(
    <div
      className="image-preview-portal"
      role="dialog"
      aria-modal="true"
      aria-label="查看照片"
    >
      {/* 极简通透毛玻璃遮罩 */}
      <div className="image-preview-backdrop" onClick={onClose} />

      {/* 右上角极简圆形关闭按钮 */}
      <button
        type="button"
        className="image-preview-close-btn"
        title="关闭 (Esc)"
        onClick={onClose}
        aria-label="关闭"
      >
        <X size={17} strokeWidth={2} />
      </button>

      {/* 核心舞台区域 */}
      <div className="image-preview-stage" onClick={onClose}>
        <div className="image-preview-card" onClick={(e) => e.stopPropagation()}>
          <img
            src={src}
            alt={alt}
            className="image-preview-img"
            onContextMenu={handleContextMenu}
          />
        </div>
      </div>

      {/* 底部微提示 */}
      <div className="image-preview-footer-hint">
        <span>按 Esc 或点击任意空白处关闭</span>
      </div>
    </div>,
    document.body
  )
}

export default ImagePreviewModal

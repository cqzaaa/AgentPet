import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardList, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStoreRaw } from '../hooks/useAppStore'
import { ChatMessageItem } from './ChatMessageItem'

interface CronLogDetailModalProps {
  currentAvatarName: string
  handlePreviewFile: (file: { name: string; path: string; size: number }) => void
}

export function CronLogDetailModal({ currentAvatarName, handlePreviewFile }: CronLogDetailModalProps): React.JSX.Element | null {
  const {
    selectedCronLogDetails,
    setSelectedCronLogDetails,
    setSelectedTaskForLog,
    setShowFilePanel,
    setActiveTab
  } = useAppStoreRaw(useShallow(state => ({
    selectedCronLogDetails: state.selectedCronLogDetails,
    setSelectedCronLogDetails: state.setSelectedCronLogDetails,
    setSelectedTaskForLog: state.setSelectedTaskForLog,
    setShowFilePanel: state.setShowFilePanel,
    setActiveTab: state.setActiveTab
  })))

  useEffect(() => {
    if (!selectedCronLogDetails) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedCronLogDetails(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedCronLogDetails, setSelectedCronLogDetails])

  if (!selectedCronLogDetails) return null

  const portalTarget =
    typeof document !== 'undefined'
      ? document.querySelector<HTMLElement>('.agent-window-container') || document.body
      : null

  if (!portalTarget) return null

  return createPortal(
    <div
      className="cron-modal-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10001
      }}
      onClick={() => setSelectedCronLogDetails(null)}
    >
      <div
        className="cron-modal-content"
        style={{
          width: '650px',
          height: '80%',
          maxHeight: '650px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-card)',
          borderRadius: '12px',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          animation: 'modalFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
            borderBottom: '1px solid var(--border-card)',
            paddingBottom: '12px'
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: '15px',
              fontWeight: '600',
              color: 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <ClipboardList size={17} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
            任务执行详情 ({selectedCronLogDetails.time})
          </h3>
          <button
            type="button"
            onClick={() => setSelectedCronLogDetails(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '18px',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            aria-label="关闭详情"
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* Chat Content Body */}
        <div
          className="chat-messages-box"
          style={{
            flex: 1,
            overflowY: 'auto',
            marginBottom: '20px',
            paddingRight: '4px',
            background: 'var(--bg-content)',
            borderRadius: '8px',
            padding: '16px'
          }}
        >
          {selectedCronLogDetails.messages &&
            selectedCronLogDetails.messages.map((msg: any) => (
              <ChatMessageItem
                key={msg.id}
                msg={msg}
                currentAvatarName={currentAvatarName}
                onPreviewFile={(f) => {
                  if (typeof handlePreviewFile === 'function') handlePreviewFile(f)
                  if (typeof setShowFilePanel === 'function') setShowFilePanel(true)
                  if (typeof setActiveTab === 'function') setActiveTab('chat')
                  setSelectedCronLogDetails(null)
                  if (typeof setSelectedTaskForLog === 'function') setSelectedTaskForLog(null)
                }}
              />
            ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            borderTop: '1px solid var(--border-card)',
            paddingTop: '16px'
          }}
        >
          <button
            type="button"
            className="btn-primary"
            style={{
              padding: '6px 20px',
              borderRadius: '6px',
              fontSize: '12.5px',
              cursor: 'pointer',
              fontWeight: 500
            }}
            onClick={() => setSelectedCronLogDetails(null)}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    portalTarget
  )
}

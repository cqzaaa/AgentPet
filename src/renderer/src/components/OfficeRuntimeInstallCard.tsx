import { useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Download, PackageOpen, XCircle } from 'lucide-react'

interface OfficeRuntimeStep {
  requestId: number
  status?: 'waiting' | 'installing' | 'complete' | 'error'
  progress?: number
  detail?: string
  request: {
    title: string
    description: string
    downloadSize: string
    installPath: string
  }
}

export function OfficeRuntimeInstallCard({
  step
}: {
  step: OfficeRuntimeStep
}): React.JSX.Element | null {
  const [responded, setResponded] = useState(false)
  const portalTarget = document.querySelector('.chat-control-card')
  if (!portalTarget) return null

  const status = String(step.status || 'waiting')
  const installing = status === 'installing'
  const complete = status === 'complete'
  const failed = status === 'error'
  const progress = Math.max(0, Math.min(100, Number(step.progress) || 0))

  const respond = (approved: boolean): void => {
    if (responded) return
    setResponded(true)
    window.api.respondOfficeRuntimeInstall(step.requestId, approved)
  }

  return createPortal(
    <section className="clarification-popover" aria-label="Office components installation">
      <div className="clarification-popover__handle" />
      <header className="clarification-popover__header">
        <div>
          <div className="clarification-popover__eyebrow">
            <PackageOpen size={14} /> Office 组件包
          </div>
          <div style={{ marginTop: 6, fontSize: 15, fontWeight: 650 }}>
            {complete ? 'Office 组件包安装完成' : failed ? 'Office 组件包安装失败' : step.request.title}
          </div>
        </div>
        {!installing && !complete && !failed && (
          <button type="button" className="clarification-popover__skip" onClick={() => respond(false)}>
            取消转换
          </button>
        )}
      </header>

      <div className="clarification-popover__questions">
        <div className="clarification-question">
          <div style={{ fontSize: 12, lineHeight: 1.65, color: 'var(--text-muted)' }}>
            {step.request.description}
          </div>
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <div><strong>下载与占用：</strong>{step.request.downloadSize}</div>
            <div style={{ marginTop: 5, wordBreak: 'break-all' }}>
              <strong>安装目录：</strong>{step.request.installPath}
            </div>
          </div>

          {(installing || complete || failed) && (
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  height: 7,
                  overflow: 'hidden',
                  borderRadius: 999,
                  background: 'var(--color-bg-secondary)'
                }}
              >
                <div
                  style={{
                    width: `${failed ? 100 : progress}%`,
                    height: '100%',
                    borderRadius: 999,
                    background: failed ? '#ef4444' : complete ? '#22c55e' : 'var(--color-primary)',
                    transition: 'width 180ms ease'
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 8,
                  fontSize: 11,
                  color: failed ? '#ef4444' : 'var(--text-muted)'
                }}
              >
                {complete ? <CheckCircle2 size={13} /> : failed ? <XCircle size={13} /> : <Download size={13} />}
                <span>{step.detail || (complete ? '安装完成，正在继续转换' : `正在安装（${progress}%）`)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {!responded && status === 'waiting' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 18px 18px' }}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => respond(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Download size={14} /> 一键安装并继续
          </button>
        </div>
      )}
    </section>,
    portalTarget
  )
}

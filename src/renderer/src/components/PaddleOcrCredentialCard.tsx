import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, KeyRound } from 'lucide-react'

export function PaddleOcrCredentialCard({
  step
}: {
  step: {
    requestId: number
    request: {
      title: string
      description: string
      guideUrl: string
      fieldLabel: string
      placeholder?: string
    }
  }
}): React.JSX.Element | null {
  const [token, setToken] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const portalTarget = document.querySelector('.chat-control-card')

  if (!portalTarget || submitted) return null

  const respond = (cancelled: boolean): void => {
    if (submitted) return
    window.api.respondCredential(step.requestId, cancelled ? '' : token, cancelled)
    setSubmitted(true)
  }

  return createPortal(
    <section className="clarification-popover" aria-label="PaddleOCR credential required">
      <div className="clarification-popover__handle" />
      <header className="clarification-popover__header">
        <div>
          <div className="clarification-popover__eyebrow">
            <KeyRound size={14} /> 需要配置解析服务
          </div>
          <div style={{ marginTop: 6, fontSize: 15, fontWeight: 650 }}>{step.request.title}</div>
        </div>
        <button type="button" className="clarification-popover__skip" onClick={() => respond(true)}>
          取消转换
        </button>
      </header>

      <div className="clarification-popover__questions">
        <div className="clarification-question">
          <div style={{ fontSize: 12, lineHeight: 1.65, color: 'var(--text-muted)' }}>
            {step.request.description}
          </div>
          <a
            href={step.request.guideUrl}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, fontSize: 12 }}
          >
            获取 AI Studio Access Token <ExternalLink size={12} />
          </a>
          <label style={{ display: 'block', marginTop: 14, fontSize: 12, fontWeight: 600 }}>
            {step.request.fieldLabel}
          </label>
          <input
            autoFocus
            type="password"
            value={token}
            placeholder={step.request.placeholder || '粘贴 Token'}
            onChange={event => setToken(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && token.trim()) respond(false)
            }}
            className="mcp-input-fancy"
            style={{ width: '100%', marginTop: 7 }}
          />
          <div style={{ marginTop: 7, fontSize: 11, color: 'var(--text-muted)' }}>
            Token 将由系统加密保存，不会写入聊天记录或发送给大模型。
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 18px 18px' }}>
        <button
          type="button"
          className="btn-primary"
          disabled={!token.trim()}
          onClick={() => respond(false)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <KeyRound size={14} /> 保存并继续转换
        </button>
      </div>
    </section>,
    portalTarget
  )
}

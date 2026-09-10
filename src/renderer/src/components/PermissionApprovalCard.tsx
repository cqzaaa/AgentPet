import { FormEvent, useMemo, useState } from 'react'
import { ChevronDown, MessageSquareText, ShieldAlert, TriangleAlert } from 'lucide-react'
import './PermissionApprovalCard.css'

type PermissionRequest = {
  requestId?: number
  command?: string
  execCwd?: string
  warning?: string
}
type Props = {
  request: PermissionRequest
  onRespond: (approved: boolean, scope?: 'once' | 'turn', reason?: string) => void
}

function getApprovalTitle(command: string, warning: string): string {
  const context = `${command}\n${warning}`
  if (/删除|rm\b|del\b|remove-item|delete/i.test(context)) return '请求执行删除操作'
  if (/run_(terminal_)?command|powershell|cmd\.exe|bash\b|zsh\b/i.test(command))
    return '请求执行终端命令'
  if (/office|docx|xlsx|pptx|pdf/i.test(context)) return '请求修改文档'
  if (/rpa_/i.test(command)) return '请求运行自动化'
  return '请求执行受保护操作'
}

export function PermissionApprovalCard({ request, onRespond }: Props): React.JSX.Element {
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [rejectFormOpen, setRejectFormOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const command = request.command || '内置 API 调用'
  const warning = request.warning || '这项操作需要你确认后才会继续执行。'
  const isDangerous = /删除|高危|rm\b|del\b|remove-item|delete/i.test(`${command}\n${warning}`)
  const title = useMemo(() => getApprovalTitle(command, warning), [command, warning])

  const submitRejection = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const reason = rejectReason.trim()
    if (reason) onRespond(false, 'once', reason)
  }

  return (
    <section
      className={`consent-card ${isDangerous ? 'is-danger' : ''}`}
      aria-labelledby="consent-card-title"
    >
      <header className="consent-heading">
        <span className="consent-shield" aria-hidden="true">
          <ShieldAlert size={19} strokeWidth={1.8} />
        </span>
        <div className="consent-heading-copy">
          <h2 id="consent-card-title">{title}</h2>
          <p>{warning}</p>
        </div>
      </header>

      <div className="consent-command">
        <button
          type="button"
          className="consent-command-summary"
          aria-expanded={detailsExpanded}
          aria-controls="consent-command-details"
          onClick={() => setDetailsExpanded((value) => !value)}
        >
          <span className="consent-prompt" aria-hidden="true">
            $
          </span>
          <code>{command}</code>
          <ChevronDown
            className={detailsExpanded ? 'is-expanded' : ''}
            size={18}
            strokeWidth={2}
            aria-hidden="true"
          />
        </button>
        {detailsExpanded && (
          <div id="consent-command-details" className="consent-command-details">
            <pre>{command}</pre>
            {request.execCwd && (
              <p>
                <span>工作目录</span>
                <code>{request.execCwd}</code>
              </p>
            )}
          </div>
        )}
      </div>

      <p className="consent-risk-note">
        <TriangleAlert size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>
          {isDangerous
            ? '请核对目标和影响范围。高风险操作每次执行都需要单独确认。'
            : '本次授权只适用于上方操作，后续变更仍会再次询问。'}
        </span>
      </p>

      {rejectFormOpen ? (
        <form className="consent-reject-form" noValidate onSubmit={submitRejection}>
          <label htmlFor="consent-reject-reason">告诉 Agent 应该如何调整</label>
          <textarea
            id="consent-reject-reason"
            className="resize-none"
            autoFocus
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="例如：不要删除原文件，请先复制一份备份。"
            rows={2}
          />
          <div>
            <button type="button" onClick={() => setRejectFormOpen(false)}>
              取消
            </button>
            <button type="submit" disabled={!rejectReason.trim()}>
              拒绝并提交说明
            </button>
          </div>
        </form>
      ) : (
        <footer className="consent-actions">
          <button
            type="button"
            className="consent-button secondary"
            onClick={() => onRespond(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="consent-button secondary"
            onClick={() => setRejectFormOpen(true)}
          >
            <MessageSquareText size={16} strokeWidth={1.9} aria-hidden="true" />
            拒绝并说明
          </button>
          <button type="button" className="consent-button primary" onClick={() => onRespond(true)}>
            本次允许
          </button>
        </footer>
      )}
    </section>
  )
}

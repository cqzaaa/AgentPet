import React from 'react'
import { AlertTriangle, HelpCircle, Loader2, Trash2 } from 'lucide-react'
import {
  registerConfirmationHost,
  type ConfirmDialogOptions,
  type PendingConfirmation
} from './confirmService'

interface ConfirmDialogProps extends ConfirmDialogOptions {
  open: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  busy = false,
  title,
  description,
  note,
  eyebrow = '请确认操作',
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  onCancel,
  onConfirm
}: ConfirmDialogProps): React.JSX.Element | null {
  const dialogRef = React.useRef<HTMLElement>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const titleId = React.useId()
  const descriptionId = React.useId()

  React.useEffect(() => {
    if (!open) return undefined
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
      returnFocusRef.current = null
    }
  }, [busy, onCancel, open])

  if (!open) return null
  const Icon = tone === 'danger' ? Trash2 : tone === 'warning' ? AlertTriangle : HelpCircle

  return (
    <div className="confirm-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className={`confirm-dialog is-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header>
          <span className="confirm-dialog-icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <span>
            <small>{eyebrow}</small>
            <h2 id={titleId}>{title}</h2>
          </span>
        </header>
        {(description || note) && (
          <div className="confirm-dialog-body">
            {description && <p id={descriptionId}>{description}</p>}
            {note && <p className="confirm-dialog-note">{note}</p>}
          </div>
        )}
        <footer>
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="confirm" type="button" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 size={14} className="spin" />}
            {busy ? '处理中…' : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function GlobalConfirmDialog(): React.JSX.Element {
  const [request, setRequest] = React.useState<PendingConfirmation | null>(null)

  React.useEffect(() => {
    registerConfirmationHost((nextRequest) => setRequest(nextRequest))
    return () => registerConfirmationHost(null)
  }, [])

  const finish = React.useCallback((confirmed: boolean): void => {
    setRequest((current) => {
      current?.resolve(confirmed)
      return null
    })
  }, [])

  return (
    <ConfirmDialog
      open={Boolean(request)}
      title={request?.title || ''}
      description={request?.description}
      note={request?.note}
      eyebrow={request?.eyebrow}
      confirmLabel={request?.confirmLabel}
      cancelLabel={request?.cancelLabel}
      tone={request?.tone}
      onCancel={() => finish(false)}
      onConfirm={() => finish(true)}
    />
  )
}

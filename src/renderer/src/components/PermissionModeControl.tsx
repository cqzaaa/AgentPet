import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Hand, PenLine, ShieldAlert } from 'lucide-react'
import { useAppStoreRaw } from '../hooks/useAppStore'
import './PermissionModeControl.css'

type PermissionMode = 'default' | 'assist' | 'full'

const MODE_OPTIONS: Array<{
  value: PermissionMode
  label: string
  description: string
  icon: typeof Hand
}> = [
  {
    value: 'default',
    label: '默认权限',
    description: '按当前安全规则逐项确认',
    icon: Hand
  },
  {
    value: 'assist',
    label: '帮我审批',
    description: '普通操作自动允许，删除和高敏感操作仍询问',
    icon: PenLine
  },
  {
    value: 'full',
    label: '完全访问权限',
    description: '包括删除等敏感操作也不再询问',
    icon: ShieldAlert
  }
]

export function PermissionModeControl(): React.JSX.Element | null {
  const sandboxMode = useAppStoreRaw((state) => state.sandboxMode)
  const setSandboxMode = useAppStoreRaw((state) => state.setSandboxMode)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const mode: PermissionMode =
    sandboxMode === false ? 'full' : sandboxMode === 'assist' ? 'assist' : 'default'
  const selected = MODE_OPTIONS.find((option) => option.value === mode) || MODE_OPTIONS[0]
  const SelectedIcon = selected.icon

  useEffect(() => {
    const locate = (): void => {
      setPortalTarget(document.querySelector<HTMLElement>('.chat-control-card .toolbar-group-left'))
    }
    locate()
    const observer = new MutationObserver(locate)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOnPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      rootRef.current?.querySelector<HTMLButtonElement>('.permission-mode-trigger')?.focus()
    }
    document.addEventListener('pointerdown', closeOnPointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const chooseMode = async (nextMode: PermissionMode): Promise<void> => {
    const requested: boolean | 'assist' =
      nextMode === 'full' ? false : nextMode === 'assist' ? 'assist' : true
    setChanging(true)
    setError('')
    try {
      const actual = await window.api.setSandboxMode(requested)
      setSandboxMode(actual)
      setOpen(false)
    } catch (cause) {
      console.error('[PermissionModeControl] Failed to change permission mode:', cause)
      setError('权限模式切换失败，请重试。')
    } finally {
      setChanging(false)
    }
  }

  if (!portalTarget) return null
  return createPortal(
    <div className="permission-mode-control" ref={rootRef}>
      <button
        type="button"
        className={`permission-mode-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={selected.description}
        onClick={() => {
          setError('')
          setOpen((value) => !value)
        }}
      >
        <SelectedIcon size={17} strokeWidth={1.9} aria-hidden="true" />
        <span>{selected.label}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="permission-mode-menu"
          role="menu"
          aria-label="权限模式"
          aria-busy={changing}
        >
          {MODE_OPTIONS.map((option) => {
            const Icon = option.icon
            const checked = option.value === mode
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={`permission-mode-option ${checked ? 'is-selected' : ''} ${option.value === 'full' ? 'is-sensitive' : ''}`}
                title={option.description}
                disabled={changing}
                onClick={() => void chooseMode(option.value)}
              >
                <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>{option.label}</span>
                {checked && <Check size={17} strokeWidth={2.2} aria-hidden="true" />}
              </button>
            )
          })}
          {error && (
            <p className="permission-mode-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>,
    portalTarget
  )
}

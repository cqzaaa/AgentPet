export type ConfirmDialogTone = 'default' | 'warning' | 'danger'

export interface ConfirmDialogOptions {
  title: string
  description?: string
  note?: string
  eyebrow?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmDialogTone
}

export type PendingConfirmation = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void
}

let openGlobalConfirmation: ((request: PendingConfirmation) => void) | null = null

export function registerConfirmationHost(
  host: ((request: PendingConfirmation) => void) | null
): void {
  openGlobalConfirmation = host
}

export function requestConfirmation(options: ConfirmDialogOptions): Promise<boolean> {
  if (!openGlobalConfirmation) return Promise.resolve(window.confirm(options.description || options.title))
  return new Promise<boolean>((resolve) => openGlobalConfirmation?.({ ...options, resolve }))
}

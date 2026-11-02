import { useCallback, useState } from 'react'

const disclosureState = new Map<string, boolean>()
const MAX_DISCLOSURE_ENTRIES = 2000

function rememberDisclosure(key: string | undefined, open: boolean): void {
  if (!key) return
  disclosureState.delete(key)
  disclosureState.set(key, open)
  if (disclosureState.size > MAX_DISCLOSURE_ENTRIES) {
    disclosureState.delete(disclosureState.keys().next().value as string)
  }
}

export function hasOpenDisclosureDescendant(key: string | undefined): boolean {
  if (!key) return false
  const prefix = `${key}/`
  return [...disclosureState].some(([candidate, open]) => open && candidate.startsWith(prefix))
}

export function usePersistentDisclosure(
  key: string | undefined,
  defaultOpen = false
): readonly [boolean, (open: boolean) => void] {
  const [isOpen, setIsOpenState] = useState(() =>
    key && disclosureState.has(key) ? disclosureState.get(key)! : defaultOpen
  )

  const setIsOpen = useCallback(
    (open: boolean) => {
      setIsOpenState(open)
      rememberDisclosure(key, open)
    },
    [key]
  )

  return [isOpen, setIsOpen] as const
}

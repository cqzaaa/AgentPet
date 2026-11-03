import { useCallback, useEffect, useState } from 'react'

const disclosureState = new Map<string, boolean>()
const listeners = new Map<string, Set<(open: boolean) => void>>()
const MAX_DISCLOSURE_ENTRIES = 2000

function notifyListeners(key: string, open: boolean): void {
  const keyListeners = listeners.get(key)
  if (keyListeners) {
    keyListeners.forEach((fn) => {
      try {
        fn(open)
      } catch (e) {
        console.error(e)
      }
    })
  }
}

function rememberDisclosure(key: string | undefined, open: boolean): void {
  if (!key) return
  disclosureState.delete(key)
  disclosureState.set(key, open)
  if (disclosureState.size > MAX_DISCLOSURE_ENTRIES) {
    disclosureState.delete(disclosureState.keys().next().value as string)
  }
  notifyListeners(key, open)
}

export function hasOpenDisclosureDescendant(key: string | undefined): boolean {
  if (!key) return false
  const prefix = `${key}/`
  return [...disclosureState].some(([candidate, open]) => open && candidate.startsWith(prefix))
}

/**
 * 自动收缩匹配前缀的所有已展开项（如当正文开始生成时，折叠该消息对应的工具链及其子项）
 */
export function collapseOpenDisclosuresByPrefix(prefix: string | undefined): void {
  if (!prefix) return
  const matchedKeys: string[] = []
  for (const [key, open] of disclosureState.entries()) {
    if (open && (key === prefix || key.startsWith(`${prefix}/`))) {
      matchedKeys.push(key)
    }
  }
  for (const key of matchedKeys) {
    rememberDisclosure(key, false)
  }
}

export function usePersistentDisclosure(
  key: string | undefined,
  defaultOpen = false
): readonly [boolean, (open: boolean) => void] {
  const [isOpen, setIsOpenState] = useState(() =>
    key && disclosureState.has(key) ? disclosureState.get(key)! : defaultOpen
  )

  useEffect(() => {
    if (!key) return
    let keyListeners = listeners.get(key)
    if (!keyListeners) {
      keyListeners = new Set()
      listeners.set(key, keyListeners)
    }
    const update = (open: boolean): void => setIsOpenState(open)
    keyListeners.add(update)
    return () => {
      keyListeners?.delete(update)
      if (keyListeners && keyListeners.size === 0) {
        listeners.delete(key)
      }
    }
  }, [key])

  const setIsOpen = useCallback(
    (open: boolean) => {
      setIsOpenState(open)
      rememberDisclosure(key, open)
    },
    [key]
  )

  return [isOpen, setIsOpen] as const
}

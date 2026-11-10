import { useEffect, useState } from 'react'
import { MessageCircle, X } from 'lucide-react'
import { useAppStoreRaw } from '../hooks/useAppStore'

export function SessionReferenceLink({ url, onRemove }: { url: string; onRemove?: () => void }): React.JSX.Element {
  const [reference, setReference] = useState<{ id: string; name: string } | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const currentName = useAppStoreRaw(state => state.sessions.find(session => session.id === reference?.id)?.name)
  useEffect(() => {
    let cancelled = false
    setReference(undefined)
    setFailed(false)
    window.api.getSessionReference(url).then(result => {
      if (!cancelled) setReference(result)
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [url])
  const label = failed ? '会话读取失败' : reference === null ? '会话已删除或不可用'
    : reference === undefined ? '正在读取会话…' : currentName || reference.name || '未命名会话'
  const open = async (): Promise<void> => {
    try {
      const target = await window.api.getSessionReference(url)
      const state = useAppStoreRaw.getState()
      if (!target || !state.sessions.some(session => session.id === target.id)) {
        state.setToast({ message: '引用会话不存在或不在当前资料库中', type: 'error' })
        return
      }
      state.setActiveSessionId(target.id)
      state.setActiveTab('chat')
    } catch {
      useAppStoreRaw.getState().setToast({ message: '无法打开引用会话，请重试', type: 'error' })
    }
  }
  return <span className="session-reference">
    <button type="button" className="session-reference-link" title={`${label}\n${url}\n引用完整已保存会话，仅限当前本地资料库`} onClick={() => void open()}>
      <MessageCircle size={15} aria-hidden="true" /><span>{label}</span>
    </button>
    {onRemove && <button type="button" className="session-reference-remove" aria-label={`移除引用：${label}`} onClick={onRemove}><X size={12} /></button>}
  </span>
}

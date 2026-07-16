/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'

interface StreamUpdate {
  sessionId: string
  messageId: number
  content: string
}

interface UseChatStreamEventsOptions {
  setSessions: (updater: (sessions: any[]) => any[]) => void
  abortedReplyIdsRef: MutableRefObject<Set<number>>
}

/** Batches high-frequency LLM text IPC events to one React update per frame. */
export function useChatStreamEvents({ setSessions, abortedReplyIdsRef }: UseChatStreamEventsOptions): void {
  useEffect(() => {
    if (!window.api.onLlmTextDelta) return

    const pendingByMessage = new Map<string, StreamUpdate>()
    let frameId: number | null = null

    const flush = () => {
      frameId = null
      if (pendingByMessage.size === 0) return
      const updatesBySession = new Map<string, Map<number, string>>()
      for (const update of pendingByMessage.values()) {
        const updates = updatesBySession.get(update.sessionId) || new Map<number, string>()
        updates.set(update.messageId, (updates.get(update.messageId) || '') + update.content)
        updatesBySession.set(update.sessionId, updates)
      }
      pendingByMessage.clear()

      setSessions(previous => {
        let changed = false
        const next = previous.map(session => {
          const updates = updatesBySession.get(session.id)
          if (!updates) return session
          let messages: any[] | null = null
          for (let index = 0; index < session.messages.length; index++) {
            const message = session.messages[index]
            const content = updates.get(message.id)
            if (!content || !message.isThinking || abortedReplyIdsRef.current.has(message.id)) continue
            if (!messages) messages = [...session.messages]
            messages[index] = { ...message, text: (message.text || '') + content }
          }
          if (!messages) return session
          changed = true
          return { ...session, messages }
        })
        return changed ? next : previous
      })
    }

    const unsubscribe = window.api.onLlmTextDelta(({ content, sessionId, messageId }) => {
      if (!content || !sessionId || !messageId) return
      const key = `${sessionId}:${messageId}`
      const pending = pendingByMessage.get(key)
      if (pending) pending.content += content
      else pendingByMessage.set(key, { sessionId, messageId, content })
      if (frameId === null) frameId = requestAnimationFrame(flush)
    })

    return () => {
      unsubscribe()
      if (frameId !== null) cancelAnimationFrame(frameId)
      flush()
    }
  }, [setSessions, abortedReplyIdsRef])
}

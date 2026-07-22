/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'

interface StreamUpdate {
  sessionId: string
  messageId: number
  content: string
}

interface UseChatStreamEventsOptions {
  updateSessionMessages: (sessionId: string, updater: (messages: any[]) => any[]) => void
  abortedReplyIdsRef: MutableRefObject<Set<number>>
}

/** Batches high-frequency LLM text IPC events to one React update per frame. */
export function useChatStreamEvents({ updateSessionMessages, abortedReplyIdsRef }: UseChatStreamEventsOptions): void {
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

      for (const [sessionId, updates] of updatesBySession) {
        updateSessionMessages(sessionId, previous => {
          let messages: any[] | null = null
          for (let index = 0; index < previous.length; index++) {
            const message = previous[index]
            const content = updates.get(message.id)
            if (!content || !message.isThinking || abortedReplyIdsRef.current.has(message.id)) continue
            if (!messages) messages = [...previous]
            messages[index] = { ...message, text: (message.text || '') + content }
          }
          return messages || previous
        })
      }
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
  }, [updateSessionMessages, abortedReplyIdsRef])
}

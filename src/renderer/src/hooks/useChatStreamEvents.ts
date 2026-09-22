/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { ChatStreamUpdate } from '../../../preload/chat-stream'
import { applyChatStreamUpdate } from './chat-stream-state'

interface UseChatStreamEventsOptions {
  updateSessionMessages: (sessionId: string, updater: (messages: any[]) => any[]) => void
  abortedReplyIdsRef: MutableRefObject<Set<number>>
}

/** Batches high-frequency LLM text IPC events to one React update per frame. */
export function useChatStreamEvents({ updateSessionMessages, abortedReplyIdsRef }: UseChatStreamEventsOptions): void {
  useEffect(() => {
    if (!window.api.onLlmTextDelta) return

    let pending: ChatStreamUpdate[] = []
    let frameId: number | null = null

    const flush = () => {
      frameId = null
      if (pending.length === 0) return
      const updatesBySession = new Map<string, ChatStreamUpdate[]>()
      for (const update of pending) {
        const updates = updatesBySession.get(update.sessionId!) || []
        updates.push(update)
        updatesBySession.set(update.sessionId!, updates)
      }
      pending = []

      for (const [sessionId, updates] of updatesBySession) {
        updateSessionMessages(sessionId, previous => {
          let messages: any[] | null = null
          for (let index = 0; index < previous.length; index++) {
            const message = previous[index]
            const relevant = updates.filter(update => update.messageId === message.id)
            if (!relevant.length || !message.isThinking || abortedReplyIdsRef.current.has(message.id)) continue
            if (!messages) messages = [...previous]
            messages[index] = relevant.reduce(applyChatStreamUpdate, message)
          }
          return messages || previous
        })
      }
    }

    const unsubscribe = window.api.onLlmTextDelta((update) => {
      if (!update.sessionId || update.messageId == null) return
      pending.push(update)
      // Commit boundaries immediately, before the invoke result finalizes/saves
      // the message; a pending animation frame would otherwise lose the tail.
      if (update.phase && update.phase !== 'delta') {
        if (frameId !== null) cancelAnimationFrame(frameId)
        flush()
        return
      }
      if (frameId === null) frameId = requestAnimationFrame(flush)
    })

    return () => {
      unsubscribe()
      if (frameId !== null) cancelAnimationFrame(frameId)
      flush()
    }
  }, [updateSessionMessages, abortedReplyIdsRef])
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useRef } from 'react'
import type { MutableRefObject } from 'react'

interface ReplyRuntimeOptions {
  setSessions: (updater: (sessions: any[]) => any[]) => void
  setSendingSessionIds: (updater: (sending: Record<string, boolean>) => Record<string, boolean>) => void
  discardPendingMessageSave: () => void
}

interface ChatReplyRuntime {
  abortedReplyIdsRef: MutableRefObject<Set<number>>
  finalizeReply: (replyId: number, fullText: string, sessionId: string, onComplete: () => void) => void
  failReply: (replyId: number, sessionId: string, error: unknown) => void
  abortReply: (sessionId: string, messages: any[], showToast: (message: string, type: 'info' | 'error') => void) => Promise<void>
}

export function useChatReplyRuntime({
  setSessions,
  setSendingSessionIds,
  discardPendingMessageSave
}: ReplyRuntimeOptions): ChatReplyRuntime {
  const abortedReplyIdsRef = useRef<Set<number>>(new Set())

  const finalizeReply = useCallback((replyId: number, fullText: string, sessionId: string, onComplete: () => void) => {
    discardPendingMessageSave()
    let savedMessage: any = null
    let wasAborted = false
    setSessions(previous => {
      const next = previous.map(session => {
        if (session.id !== sessionId) return session
        const messages = session.messages.map((message: any) => {
          if (message.id !== replyId) return message
          if (abortedReplyIdsRef.current.has(replyId) || !message.isThinking) {
            wasAborted = true
            return message
          }
          return { ...message, text: fullText, isThinking: false }
        })
        const target = messages.find((message: any) => message.id === replyId)
        if (target && !wasAborted) savedMessage = target
        return { ...session, messages }
      })
      if (savedMessage) window.api.saveMessage({ ...savedMessage, sessionId }).catch(console.error)
      return next
    })
    setSendingSessionIds(previous => ({ ...previous, [sessionId]: false }))
    if (savedMessage && !wasAborted) setTimeout(onComplete, 500)
    abortedReplyIdsRef.current.delete(replyId)
  }, [discardPendingMessageSave, setSendingSessionIds, setSessions])

  const failReply = useCallback((replyId: number, sessionId: string, error: unknown) => {
    discardPendingMessageSave()
    const message = error instanceof Error ? error.message : String(error)
    const isAbort = message.includes('UserAborted') || message.toLowerCase().includes('aborted')
    let savedMessage: any = null

    setSessions(previous => previous.map(session => {
      if (session.id !== sessionId) return session
      const messages = session.messages.map((item: any) => {
        if (item.id !== replyId) return item
        const currentText = item.text || ''
        if (isAbort && (!item.isThinking || currentText.includes('手动终止') || currentText.includes('手动中断'))) {
          return item
        }
        const suffix = isAbort
          ? '\n\n⚠️ 对话生成已被用户手动中断。'
          : `\n\n系统错误：调用智能代理接口失败（${message}）。请检查『设置 -> 模型配置』中的代理路径或 API Key。`
        savedMessage = {
          ...item,
          text: currentText + suffix,
          isThinking: false,
          isError: !isAbort
        }
        return savedMessage
      })
      return { ...session, messages }
    }))

    if (savedMessage) window.api.saveMessage({ ...savedMessage, sessionId }).catch(console.error)
    setSendingSessionIds(previous => ({ ...previous, [sessionId]: false }))
    abortedReplyIdsRef.current.delete(replyId)
  }, [discardPendingMessageSave, setSendingSessionIds, setSessions])

  const abortReply = useCallback(async (sessionId: string, messages: any[], showToast: (message: string, type: 'info' | 'error') => void) => {
    const replyIds = messages.filter(message => message.isThinking).map(message => message.id)
    replyIds.forEach(replyId => abortedReplyIdsRef.current.add(replyId))
    try {
      await window.api.abortLlm(sessionId)
      setSendingSessionIds(previous => ({ ...previous, [sessionId]: false }))
      const interrupted: any[] = []
      setSessions(previous => previous.map(session => {
        if (session.id !== sessionId) return session
        const nextMessages = session.messages.map((message: any) => {
          if (!replyIds.includes(message.id) || !message.isThinking) return message
          const updated = {
            ...message,
            text: message.text ? `${message.text}\n\n⚠️ 对话生成已被手动中断。` : '⚠️ 对话生成已被手动中断。',
            isThinking: false
          }
          interrupted.push(updated)
          return updated
        })
        return { ...session, messages: nextMessages }
      }))
      interrupted.forEach(message => window.api.saveMessage({ ...message, sessionId }).catch(console.error))
      showToast('已中断大模型生成', 'info')
    } catch (error: any) {
      replyIds.forEach(replyId => abortedReplyIdsRef.current.delete(replyId))
      console.error(error)
      showToast(`中断失败: ${error.message || error}`, 'error')
    }
  }, [setSendingSessionIds, setSessions])

  return { abortedReplyIdsRef, finalizeReply, failReply, abortReply }
}

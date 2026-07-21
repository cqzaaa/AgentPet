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

function withoutEphemeralInteractionSteps(message: any): any {
  if (!Array.isArray(message?.toolSteps)) return message
  return {
    ...message,
    toolSteps: message.toolSteps.filter(
      (step: any) =>
        step?.type !== 'clarification' &&
        step?.type !== 'credential' &&
        step?.type !== 'officeRuntime'
    )
  }
}

function shouldNotifyWhenReplySettles(): boolean {
  return typeof document !== 'undefined' && (document.hidden || !document.hasFocus())
}

function notificationSnippet(text: string): string {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '[图片]')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function notifyReplySettled(title: string, body: string): void {
  if (!shouldNotifyWhenReplySettles()) return
  const snippet = notificationSnippet(body)
  window.api.showNotification(title, snippet || '点击回到 AgentPet 查看详情').catch(console.error)
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
          return withoutEphemeralInteractionSteps({ ...message, text: fullText, isThinking: false })
        })
        const target = messages.find((message: any) => message.id === replyId)
        if (target && !wasAborted) savedMessage = target
        return { ...session, messages }
      })
      if (savedMessage) window.api.saveMessage({ ...savedMessage, sessionId }).catch(console.error)
      return next
    })
    setSendingSessionIds(previous => ({ ...previous, [sessionId]: false }))
    if (savedMessage && !wasAborted) {
      notifyReplySettled('AgentPet 已回复', fullText)
      setTimeout(onComplete, 500)
    }
    abortedReplyIdsRef.current.delete(replyId)
  }, [discardPendingMessageSave, setSendingSessionIds, setSessions])

  const failReply = useCallback((replyId: number, sessionId: string, error: unknown) => {
    discardPendingMessageSave()
    const message = error instanceof Error ? error.message : String(error)
    const isAbort = message.includes('UserAborted') || message.toLowerCase().includes('aborted')
    const isAuthError = /HTTP\s*(401|403)\b|api[_ -]?key|鉴权|unauthorized|forbidden/i.test(message)
    const isRateLimit = /HTTP\s*429\b|rate.?limit|限流/i.test(message)
    const isServerError = /HTTP\s*5\d\d\b|upstream|service unavailable/i.test(message)
    const isBadRequest = /HTTP\s*(400|415|422)\b/i.test(message)
    const failureText = isAuthError
      ? '模型服务鉴权失败，请检查『设置 -> 模型配置』中的 API Key 和代理路径。'
      : isRateLimit
        ? '模型服务当前请求过于频繁，请稍后重试。'
        : isBadRequest
          ? '当前模型服务未接受这次请求，可能不支持图片、工具调用或当前消息格式。已完成的文件操作仍会保留，请重试或切换兼容模型。'
          : isServerError
            ? '模型上游服务暂时不可用。已完成的文件操作仍会保留，请稍后重试。'
            : '本次回复未能继续完成。已完成的工具操作仍会保留，请重试；若持续失败，再检查模型配置。'
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
          : `\n\n⚠️ ${failureText}`
        savedMessage = withoutEphemeralInteractionSteps({
          ...item,
          text: currentText + suffix,
          isThinking: false,
          isError: !isAbort
        })
        return savedMessage
      })
      return { ...session, messages }
    }))

    if (savedMessage) window.api.saveMessage({ ...savedMessage, sessionId }).catch(console.error)
    if (savedMessage && !isAbort) notifyReplySettled('AgentPet 回复失败', message)
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
          const cleanedUpdated = withoutEphemeralInteractionSteps(updated)
          interrupted.push(cleanedUpdated)
          return cleanedUpdated
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

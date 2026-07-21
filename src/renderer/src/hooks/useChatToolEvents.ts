/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'

interface UseChatToolEventsOptions {
  setSessions: (updater: (sessions: any[]) => any[]) => void
  setCronTasks: (updater: (tasks: any[]) => any[]) => void
  activeSessionIdRef: MutableRefObject<string>
  cronRunningLogsRef: MutableRefObject<Record<string, any>>
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void
}

function appendToolSteps(existingSteps: any[] | undefined, events: any[]): any[] {
  const toolSteps = existingSteps ? [...existingSteps] : []
  for (const { type, name, args, result, detail, progress, sources, files, requestId, questions, request, timestamp: eventTimestamp } of events) {
    const timestamp = Number(eventTimestamp) || Date.now()
    const id = `step-${timestamp}-${Math.random()}`
    const sequence = toolSteps.length + 1
    if (type === 'tool_call') toolSteps.push({ id, sequence, timestamp, type: 'call', name, detail: args })
    else if (type === 'tool_result') toolSteps.push({ id, sequence, timestamp, type: 'result', name, detail: result })
    else if (type === 'think') toolSteps.push({ id, sequence, timestamp, type: 'think', name, detail })
    else if (type === 'tool_progress') {
      const progressDetail = detail || `${Number(progress) || 0}%`
      const existing = toolSteps.findLastIndex(step => step.type === 'think' && step.name === name)
      const progressStep = { id, sequence, timestamp, type: 'think', name, detail: progressDetail }
      if (existing >= 0) toolSteps[existing] = progressStep
      else toolSteps.push(progressStep)
    }
    else if (type === 'web_sources' && Array.isArray(sources)) toolSteps.push({ id, sequence, timestamp, type: 'sources', detail: sources })
    else if (type === 'clarification_request' && Array.isArray(questions)) toolSteps.push({ id, sequence, timestamp, type: 'clarification', requestId, questions })
    else if (type === 'credential_request' && request) toolSteps.push({ id, sequence, timestamp, type: 'credential', requestId, request })
    else if (type === 'generated_files' && Array.isArray(files)) {
      const existingPaths = new Set(
        toolSteps
          .filter(step => step.type === 'generatedFiles' && Array.isArray(step.files))
          .flatMap(step => step.files.map((file: any) => file.path))
      )
      const newFiles = files.filter((file: any) => file?.path && !existingPaths.has(file.path))
      if (newFiles.length > 0) {
        toolSteps.push({ id, sequence, timestamp, type: 'generatedFiles', files: newFiles })
      }
    }
    else if (type === 'office_runtime_request' && request) {
      toolSteps.push({ id, sequence, timestamp, type: 'officeRuntime', requestId, request, status: 'waiting', progress: 0 })
    }
    else if (type === 'office_runtime_progress' || type === 'office_runtime_complete' || type === 'office_runtime_error') {
      const existing = toolSteps.findIndex(step => step.type === 'officeRuntime' && step.requestId === requestId)
      if (existing >= 0) {
        toolSteps[existing] = {
          ...toolSteps[existing],
          timestamp,
          detail,
          progress: Number(progress) || 0,
          status: type === 'office_runtime_complete' ? 'complete' : type === 'office_runtime_error' ? 'error' : 'installing'
        }
      }
    }
  }
  return toolSteps
}

function withoutEphemeralToolSteps(message: any): any {
  if (!Array.isArray(message?.toolSteps)) return message
  return {
    ...message,
    toolSteps: message.toolSteps.filter((step: any) => step?.type !== 'clarification' && step?.type !== 'credential' && step?.type !== 'officeRuntime')
  }
}

function toolNoticeForEvent(event: any): { message: string; type: 'success' | 'error' | 'info' } | null {
  if (event?.type !== 'tool_result') return null
  const name = String(event.name || '')
  const result = String(event.result || '')
  const isError = /失败|错误|error|failed/i.test(result)
  if (name === 'type_text') {
    return { message: isError ? '输入文本失败，请检查当前焦点' : '文本已输入到当前焦点', type: isError ? 'error' : 'success' }
  }
  if (name === 'screenshot') {
    return { message: isError ? '截图失败' : '截图已完成，并传入视觉上下文', type: isError ? 'error' : 'success' }
  }
  if (name === 'mouse_click') {
    return { message: isError ? '点击操作失败' : '点击操作已完成', type: isError ? 'error' : 'success' }
  }
  if (name === 'focus_window') {
    return { message: isError ? '窗口切换失败' : '窗口已切换到前台', type: isError ? 'error' : 'success' }
  }
  return null
}

/** Batches tool IPC updates and persists only the latest affected chat message. */
export function useChatToolEvents({
  setSessions,
  setCronTasks,
  activeSessionIdRef,
  cronRunningLogsRef,
  showToast
}: UseChatToolEventsOptions): { discardPendingMessageSave: () => void } {
  const latestMessageRef = useRef<any>(null)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const discardPendingMessageSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = null
    latestMessageRef.current = null
  }, [])

  useEffect(() => {
    if (!window.api.onToolEvent) return

    let pendingEvents: any[] = []
    let throttleTimeout: ReturnType<typeof setTimeout> | null = null

    const saveLatestMessage = () => {
      saveTimeoutRef.current = null
      const message = latestMessageRef.current
      latestMessageRef.current = null
      if (message) window.api.saveMessage(withoutEphemeralToolSteps(message)).catch(console.error)
    }

    const scheduleSave = (message: any) => {
      latestMessageRef.current = message
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(saveLatestMessage, 500)
    }

    const flushEvents = () => {
      throttleTimeout = null
      if (pendingEvents.length === 0) return
      const events = pendingEvents
      pendingEvents = []

      const normalBySession = new Map<string, any[]>()
      const cronBySession = new Map<string, any[]>()
      for (const event of events) {
        const sessionId = event.sessionId || activeSessionIdRef.current
        const target = sessionId.startsWith('cron:') ? cronBySession : normalBySession
        const group = target.get(sessionId)
        if (group) group.push(event)
        else target.set(sessionId, [event])
      }

      if (normalBySession.size > 0) {
        setSessions(previous => {
          let savedMessage: any = null
          let changed = false
          const next = previous.map(session => {
            const sessionEvents = normalBySession.get(session.id)
            if (!sessionEvents) return session
            const eventMessageId = sessionEvents.findLast((event: any) => event.messageId != null)?.messageId
            const index = eventMessageId != null
              ? session.messages.findIndex((message: any) => message.id === eventMessageId)
              : session.messages.findLastIndex((message: any) => message.sender === 'agent')
            if (index < 0) return session

            const messages = [...session.messages]
            const message = { ...messages[index] }
            message.toolSteps = appendToolSteps(message.toolSteps, sessionEvents)
            messages[index] = message
            savedMessage = { ...message, sessionId: session.id }
            changed = true
            return { ...session, messages }
          })
          if (savedMessage) scheduleSave(savedMessage)
          return changed ? next : previous
        })
      }

      if (cronBySession.size > 0) {
        const taskIds = new Set<string>()
        for (const [sessionId, sessionEvents] of cronBySession) {
          const log = cronRunningLogsRef.current[sessionId]
          if (!log?.messages) continue
          const index = log.messages.findIndex((message: any) => message.sender === 'agent')
          if (index < 0) continue
          const messages = [...log.messages]
          messages[index] = { ...messages[index], toolSteps: appendToolSteps(messages[index].toolSteps, sessionEvents) }
          log.messages = messages
          taskIds.add(sessionId.split(':')[1])
        }
        if (taskIds.size > 0) {
          setCronTasks(previous => previous.map(task => {
            if (!taskIds.has(task.id)) return task
            const logs = (task.logs || []).map((log: any) => {
              const running = Object.values(cronRunningLogsRef.current).find((item: any) => item.id === log.id)
              return running ? { ...running } : log
            })
            return { ...task, logs }
          }))
        }
      }
    }

    const unsubscribe = window.api.onToolEvent((event: any) => {
      const notice = toolNoticeForEvent(event)
      if (notice && (!event.sessionId || event.sessionId === activeSessionIdRef.current)) {
        showToast?.(notice.message, notice.type)
      }
      pendingEvents.push(event)
      if (!throttleTimeout) throttleTimeout = setTimeout(flushEvents, 50)
    })

    return () => {
      unsubscribe()
      if (throttleTimeout) clearTimeout(throttleTimeout)
      flushEvents()
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      if (latestMessageRef.current) window.api.saveMessage(withoutEphemeralToolSteps(latestMessageRef.current)).catch(console.error)
      latestMessageRef.current = null
    }
  }, [activeSessionIdRef, cronRunningLogsRef, setCronTasks, setSessions, showToast])

  return { discardPendingMessageSave }
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'

interface UseChatToolEventsOptions {
  setSessions: (updater: (sessions: any[]) => any[]) => void
  setCronTasks: (updater: (tasks: any[]) => any[]) => void
  activeSessionIdRef: MutableRefObject<string>
  cronRunningLogsRef: MutableRefObject<Record<string, any>>
}

function appendToolSteps(existingSteps: any[] | undefined, events: any[]): any[] {
  const toolSteps = existingSteps ? [...existingSteps] : []
  for (const { type, name, args, result, detail } of events) {
    const id = `step-${Date.now()}-${Math.random()}`
    if (type === 'tool_call') toolSteps.push({ id, type: 'call', name, detail: args })
    else if (type === 'tool_result') toolSteps.push({ id, type: 'result', name, detail: result })
    else if (type === 'think') toolSteps.push({ id, type: 'think', name, detail })
  }
  return toolSteps
}

/** Batches tool IPC updates and persists only the latest affected chat message. */
export function useChatToolEvents({
  setSessions,
  setCronTasks,
  activeSessionIdRef,
  cronRunningLogsRef
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
      if (message) window.api.saveMessage(message).catch(console.error)
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
            const index = session.messages.findLastIndex((message: any) => message.sender === 'agent')
            if (index < 0 || session.messages[index].isThinking === false) return session

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
      pendingEvents.push(event)
      if (!throttleTimeout) throttleTimeout = setTimeout(flushEvents, 50)
    })

    return () => {
      unsubscribe()
      if (throttleTimeout) clearTimeout(throttleTimeout)
      flushEvents()
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      if (latestMessageRef.current) window.api.saveMessage(latestMessageRef.current).catch(console.error)
      latestMessageRef.current = null
    }
  }, [activeSessionIdRef, cronRunningLogsRef, setCronTasks, setSessions])

  return { discardPendingMessageSave }
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { computeDiffLines, type FileChangeItem } from '../components/FileDiffModal'

function mergeFileChanges(previous: FileChangeItem[] = [], incoming: FileChangeItem[] = []): FileChangeItem[] {
  const changes = new Map(previous.map(change => [change.filePath, change]))
  for (const change of incoming) {
    if (!change?.filePath) continue
    const earlier = changes.get(change.filePath)
    if (!earlier) {
      changes.set(change.filePath, change)
      continue
    }
    const originalContent = earlier.originalContent
    const currentContent = change.currentContent
    const lines = computeDiffLines(originalContent, currentContent)
    changes.set(change.filePath, {
      ...earlier, ...change, originalContent, currentContent,
      wasCreated: earlier.wasCreated || change.wasCreated,
      additions: lines.filter(line => line.type === 'add').length,
      deletions: lines.filter(line => line.type === 'del').length
    })
  }
  return [...changes.values()]
}

interface UseChatToolEventsOptions {
  updateSessionMessages: (sessionId: string, updater: (messages: any[]) => any[]) => void
  setCronTasks: (updater: (tasks: any[]) => any[]) => void
  activeSessionIdRef: MutableRefObject<string>
  cronRunningLogsRef: MutableRefObject<Record<string, any>>
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void
  onFinalArtifacts?: (files: any[], sessionId?: string) => void
}

function appendToolSteps(existingSteps: any[] | undefined, events: any[]): any[] {
  const toolSteps = existingSteps ? [...existingSteps] : []
  for (const { type, name, args, result, contextTokens, detail, progress, sources, files, changes, requestId, questions, request, status, beforeTokens, afterTokens, activeToolContextTokens, archivePath, removedMessages, timestamp: eventTimestamp } of events) {
    const timestamp = Number(eventTimestamp) || Date.now()
    const id = `step-${timestamp}-${Math.random()}`
    const sequence = toolSteps.length + 1
    if (type === 'context_usage') {
      const previous = toolSteps.findIndex(step => step.type === 'context_usage')
      const snapshot = { id, sequence, timestamp, type, contextTokens }
      if (previous >= 0) toolSteps[previous] = snapshot
      else toolSteps.push(snapshot)
    }
    else if (type === 'tool_call') toolSteps.push({ id, sequence, timestamp, type: 'call', name, detail: args })
    else if (type === 'tool_result') toolSteps.push({ id, sequence, timestamp, type: 'result', name, detail: result, contextTokens })
    else if (type === 'think') toolSteps.push({ id, sequence, timestamp, type: 'think', name, detail })
    else if (type === 'context_compaction') {
      const existing = toolSteps.findIndex(step => step.type === 'compaction')
      const compactionStep = {
        id: existing >= 0 ? toolSteps[existing].id : id,
        sequence: existing >= 0 ? toolSteps[existing].sequence : sequence,
        timestamp,
        type: 'compaction',
        name: '上下文压缩',
        status,
        beforeTokens,
        afterTokens,
        contextTokens: status === 'completed' ? Number(activeToolContextTokens) || 0 : undefined,
        archivePath,
        removedMessages,
        detail
      }
      if (status === 'completed') {
        for (const step of toolSteps) {
          if (step.type === 'result') step.contextTokens = 0
        }
      }
      if (existing >= 0) toolSteps[existing] = compactionStep
      else toolSteps.push(compactionStep)
    }
    else if (type === 'tool_progress') {
      const progressDetail = detail || `${Number(progress) || 0}%`
      const isTerminalOutput = name === 'run_terminal_command' || name === 'run_command'
      const existing = isTerminalOutput
        ? toolSteps.findLastIndex(step => step.type === 'call' && step.name === name)
        : toolSteps.findLastIndex(step => step.type === 'think' && step.isProgress && step.name === name)
      if (existing >= 0) {
        toolSteps[existing] = isTerminalOutput
          ? { ...toolSteps[existing], liveDetail: progressDetail, progress: Number(progress) || 0, timestamp }
          : { ...toolSteps[existing], detail: progressDetail, progress: Number(progress) || 0, timestamp }
      } else {
        toolSteps.push({ id, sequence, timestamp, type: 'think', name, detail: progressDetail, progress: Number(progress) || 0, isProgress: true })
      }
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
    else if (type === 'file_changes' && Array.isArray(changes)) {
      const existing = toolSteps.findIndex(step => step.type === 'fileChanges')
      if (existing >= 0) {
        toolSteps[existing] = { id, sequence: toolSteps[existing].sequence, timestamp, type: 'fileChanges', changes: mergeFileChanges(toolSteps[existing].changes, changes) }
      } else {
        toolSteps.push({ id, sequence, timestamp, type: 'fileChanges', changes })
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

/** Batches tool IPC updates and persists each affected chat message independently. */
export function useChatToolEvents({
  updateSessionMessages,
  setCronTasks,
  activeSessionIdRef,
  cronRunningLogsRef,
  showToast,
  onFinalArtifacts
}: UseChatToolEventsOptions): { discardPendingMessageSave: (sessionId: string, messageId: string | number) => void } {
  const pendingSavesRef = useRef(new Map<string, { message: any; timer: ReturnType<typeof setTimeout> }>())
  const messageKey = (sessionId: string, messageId: string | number): string => `${sessionId}\u0000${messageId}`

  const discardPendingMessageSave = useCallback((sessionId: string, messageId: string | number) => {
    const key = messageKey(sessionId, messageId)
    const pending = pendingSavesRef.current.get(key)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingSavesRef.current.delete(key)
  }, [])

  useEffect(() => {
    if (!window.api.onToolEvent) return

    let pendingEvents: any[] = []
    let throttleTimeout: ReturnType<typeof setTimeout> | null = null

    const savePendingMessage = (key: string) => {
      const pending = pendingSavesRef.current.get(key)
      if (!pending) return
      pendingSavesRef.current.delete(key)
      window.api.saveMessage(withoutEphemeralToolSteps(pending.message)).catch(console.error)
    }

    const scheduleSave = (message: any) => {
      const key = messageKey(message.sessionId, message.id)
      const pending = pendingSavesRef.current.get(key)
      if (pending) clearTimeout(pending.timer)
      const timer = setTimeout(() => savePendingMessage(key), 500)
      pendingSavesRef.current.set(key, { message, timer })
    }

    const flushEvents = () => {
      throttleTimeout = null
      if (pendingEvents.length === 0) return
      const events = pendingEvents
      pendingEvents = []

      const normalByMessage = new Map<string, { sessionId: string; messageId: string | number | undefined; events: any[] }>()
      const cronBySession = new Map<string, any[]>()
      for (const event of events) {
        const sessionId = String(event.sessionId || '')
        if (!sessionId) continue
        if (sessionId.startsWith('cron:')) {
          const group = cronBySession.get(sessionId)
          if (group) group.push(event)
          else cronBySession.set(sessionId, [event])
          continue
        }
        const key = messageKey(sessionId, event.messageId ?? '')
        const group = normalByMessage.get(key)
        if (group) group.events.push(event)
        else normalByMessage.set(key, { sessionId, messageId: event.messageId, events: [event] })
      }

      for (const { sessionId, messageId: eventMessageId, events: sessionEvents } of normalByMessage.values()) {
        let savedMessage: any = null
        updateSessionMessages(sessionId, previous => {
          const index = eventMessageId != null
            ? previous.findIndex((message: any) => String(message.id) === String(eventMessageId))
            : previous.findLastIndex((message: any) => message.sender === 'agent')
          if (index < 0) return previous
          const messages = [...previous]
          const message = { ...messages[index] }
          message.toolSteps = appendToolSteps(message.toolSteps, sessionEvents)
          if (sessionEvents.some((event: any) => event.type === 'file_changes')) {
            const collectedChanges = message.toolSteps.find((step: any) => step.type === 'fileChanges')?.changes
            message.fileChanges = mergeFileChanges(message.fileChanges, collectedChanges)
          }
          messages[index] = message
          savedMessage = { ...message, sessionId }
          return messages
        })
        if (savedMessage) scheduleSave(savedMessage)
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
      if (event.type === 'generated_files' && event.autoPreview && Array.isArray(event.files)) {
        onFinalArtifacts?.(event.files, event.sessionId)
      }
      pendingEvents.push(event)
      if (!throttleTimeout) throttleTimeout = setTimeout(flushEvents, 50)
    })

    return () => {
      unsubscribe()
      if (throttleTimeout) clearTimeout(throttleTimeout)
      flushEvents()
      for (const key of pendingSavesRef.current.keys()) {
        const pending = pendingSavesRef.current.get(key)
        if (pending) clearTimeout(pending.timer)
        savePendingMessage(key)
      }
    }
  }, [activeSessionIdRef, cronRunningLogsRef, onFinalArtifacts, setCronTasks, showToast, updateSessionMessages])

  return { discardPendingMessageSave }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react'

const MAX_TOKEN_LOGS = 1000
const EVENT_BATCH_DELAY_MS = 200
const PERSIST_DELAY_MS = 1000

export interface RuntimeTokenLog {
  id: string
  model: string
  provider: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  timestamp: number
  sessionId?: string
  messageId?: number
}

interface TokenUsageRuntimeOptions {
  setTokenLogs: (updater: (logs: RuntimeTokenLog[]) => RuntimeTokenLog[]) => void
}

/** Batches high-frequency token events and persists a bounded log at most once per second. */
export function useTokenUsageRuntime({ setTokenLogs }: TokenUsageRuntimeOptions): void {
  const pendingRef = useRef<RuntimeTokenLog[]>([])
  const latestLogsRef = useRef<RuntimeTokenLog[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!window.api.onTokenUsage) return undefined

    const persistLatest = () => {
      persistTimerRef.current = null
      localStorage.setItem('agentpet_token_logs', JSON.stringify(latestLogsRef.current))
    }

    const schedulePersist = () => {
      if (persistTimerRef.current) return
      persistTimerRef.current = setTimeout(persistLatest, PERSIST_DELAY_MS)
    }

    const flushPending = () => {
      flushTimerRef.current = null
      if (pendingRef.current.length === 0) return
      const batch = pendingRef.current
      pendingRef.current = []
      setTokenLogs(previous => {
        const next = [...previous, ...batch].slice(-MAX_TOKEN_LOGS)
        latestLogsRef.current = next
        schedulePersist()
        return next
      })
    }

    const unsubscribe = window.api.onTokenUsage((data: any) => {
      pendingRef.current.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        model: data.model || 'unknown',
        provider: data.provider || 'unknown',
        promptTokens: data.promptTokens || 0,
        completionTokens: data.completionTokens || 0,
        totalTokens: (data.promptTokens || 0) + (data.completionTokens || 0),
        timestamp: data.timestamp || Date.now(),
        sessionId: data.sessionId,
        messageId: data.messageId
      })
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushPending, EVENT_BATCH_DELAY_MS)
      }
    })

    return () => {
      unsubscribe()
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      flushPending()
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      if (latestLogsRef.current.length > 0) persistLatest()
    }
  }, [setTokenLogs])
}

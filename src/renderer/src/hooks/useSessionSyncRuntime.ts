import { useEffect, useRef } from 'react'
import type { Session } from './useAppStore'
import { applySessionMutation, type SessionMutation } from './sessionMutations'

interface SessionSyncRuntimeOptions {
  activeSessionId: string
  refreshSessions: () => Promise<void>
  setSessions: (updater: (sessions: Session[]) => Session[]) => void
}

/** Owns cross-window session notifications and active-session persistence. */
export function useSessionSyncRuntime({
  activeSessionId,
  refreshSessions,
  setSessions
}: SessionSyncRuntimeOptions): void {
  const refreshSessionsRef = useRef(refreshSessions)

  useEffect(() => {
    refreshSessionsRef.current = refreshSessions
  }, [refreshSessions])

  useEffect(() => {
    if (!window.api.onSessionsUpdated) return undefined
    const unsubscribe = window.api.onSessionsUpdated((mutation?: SessionMutation) => {
      if (!mutation || mutation.type === 'refresh') {
        void refreshSessionsRef.current()
        return
      }
      setSessions(previous => applySessionMutation(previous, mutation))
    })
    return () => unsubscribe()
  }, [setSessions])

  useEffect(() => {
    localStorage.setItem('agentself_active_session_id', activeSessionId)
  }, [activeSessionId])
}

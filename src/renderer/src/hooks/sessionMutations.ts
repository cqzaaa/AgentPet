import type { Session } from './useAppStore'

type SessionMessage = Session['messages'][number]

export type SessionMutation =
  | { type: 'session-upsert'; session: Session }
  | { type: 'session-update'; sessionId: string; updates: Partial<Session> }
  | { type: 'session-delete'; sessionId: string }
  | { type: 'message-upsert'; sessionId: string; message: SessionMessage; sessionTime?: string }
  | { type: 'messages-upsert'; messages: SessionMessage[] }
  | { type: 'message-delete'; messageId: string }
  | { type: 'refresh'; sessionId?: string }

function messageId(message: SessionMessage): string {
  return String(message?.id ?? '')
}

function sortMessages(messages: SessionMessage[]): SessionMessage[] {
  return [...messages].sort((left, right) => {
    const leftNumber = Number(left?.id)
    const rightNumber = Number(right?.id)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber
    }
    return messageId(left).localeCompare(messageId(right))
  })
}

function upsertMessage(messages: SessionMessage[], message: SessionMessage): SessionMessage[] {
  const targetId = messageId(message)
  const existingIndex = messages.findIndex(item => messageId(item) === targetId)
  if (existingIndex < 0) return sortMessages([...messages, message])

  const next = [...messages]
  next[existingIndex] = { ...next[existingIndex], ...message }
  return next
}

export function applySessionMutation(sessions: Session[], mutation: SessionMutation): Session[] {
  switch (mutation.type) {
    case 'session-upsert': {
      const existingIndex = sessions.findIndex(session => session.id === mutation.session.id)
      if (existingIndex < 0) return [...sessions, mutation.session]
      const next = [...sessions]
      next[existingIndex] = { ...next[existingIndex], ...mutation.session }
      return next
    }

    case 'session-update':
      return sessions.map(session => session.id === mutation.sessionId
        ? { ...session, ...mutation.updates }
        : session)

    case 'session-delete':
      return sessions.filter(session => session.id !== mutation.sessionId)

    case 'message-upsert':
      return sessions.map(session => session.id === mutation.sessionId
        ? {
            ...session,
            ...(mutation.sessionTime ? { time: mutation.sessionTime } : {}),
            messages: upsertMessage(session.messages || [], mutation.message)
          }
        : session)

    case 'messages-upsert': {
      const messagesBySession = new Map<string, SessionMessage[]>()
      for (const message of mutation.messages) {
        const sessionId = String(message?.sessionId || '')
        if (!sessionId) continue
        const grouped = messagesBySession.get(sessionId) || []
        grouped.push(message)
        messagesBySession.set(sessionId, grouped)
      }
      if (messagesBySession.size === 0) return sessions
      return sessions.map(session => {
        const messages = messagesBySession.get(session.id)
        if (!messages) return session
        return {
          ...session,
          messages: messages.reduce(
            (current, message) => upsertMessage(current, message),
            session.messages || []
          )
        }
      })
    }

    case 'message-delete':
      return sessions.map(session => {
        const messages = (session.messages || []).filter(message => messageId(message) !== String(mutation.messageId))
        return messages.length === session.messages.length ? session : { ...session, messages }
      })

    case 'refresh':
      return sessions
  }
}

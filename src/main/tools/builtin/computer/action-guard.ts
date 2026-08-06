export type DesktopActionGuardDecision = {
  blocked: boolean
  reason?: string
}

type SessionState = {
  visualStateHash?: string
  clicks: Map<string, number>
}

/** Prevent accidental replay of the same click while the observed UI is unchanged. */
export class DesktopActionGuard {
  private readonly sessions = new Map<string, SessionState>()

  public updateVisualState(sessionId: string | undefined, visualStateHash: string): boolean {
    const state = this.getState(sessionId)
    const changed = state.visualStateHash !== visualStateHash
    state.visualStateHash = visualStateHash
    if (changed) state.clicks.clear()
    return changed
  }

  public shouldBlockClick(
    sessionId: string | undefined,
    fingerprint: string,
    allowRepeat = false
  ): DesktopActionGuardDecision {
    if (allowRepeat) return { blocked: false }
    const state = this.getState(sessionId)
    const clickedAt = state.clicks.get(fingerprint)
    if (clickedAt === undefined) return { blocked: false }
    if (Date.now() - clickedAt > 30_000) {
      state.clicks.delete(fingerprint)
      return { blocked: false }
    }
    return {
      blocked: true,
      reason: '相同视觉状态下已派发过相同点击；请先截图确认界面发生变化，或改用键盘/语义元素定位。'
    }
  }

  public recordClick(sessionId: string | undefined, fingerprint: string): void {
    this.getState(sessionId).clicks.set(fingerprint, Date.now())
  }

  public clear(sessionId?: string): void {
    if (sessionId) this.sessions.delete(sessionId)
    else this.sessions.clear()
  }

  private getState(sessionId?: string): SessionState {
    const key = sessionId || 'default'
    let state = this.sessions.get(key)
    if (!state) {
      if (this.sessions.size >= 200) {
        const oldestKey = this.sessions.keys().next().value
        if (oldestKey) this.sessions.delete(oldestKey)
      }
      state = { clicks: new Map() }
      this.sessions.set(key, state)
    }
    return state
  }
}

export function desktopClickFingerprint(target: {
  scope: 'screen' | 'window' | 'element'
  x?: number
  y?: number
  windowTitle?: string
  processId?: number
  displayId?: number
  name?: string
  automationId?: string
  button?: string
  double?: boolean
}): string {
  return JSON.stringify({
    scope: target.scope,
    x: Number.isFinite(target.x) ? Math.round(Number(target.x)) : undefined,
    y: Number.isFinite(target.y) ? Math.round(Number(target.y)) : undefined,
    windowTitle: target.windowTitle || '',
    processId: target.processId || 0,
    displayId: target.displayId || 0,
    name: target.name || '',
    automationId: target.automationId || '',
    button: target.button || 'left',
    double: Boolean(target.double)
  })
}

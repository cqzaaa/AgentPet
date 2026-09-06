import { createHash } from 'crypto'

export type ComputerStateScope = 'desktop' | 'browser'

export interface ComputerState {
  id: string
  scope: ComputerStateScope
  capturedAt: number
  stateHash: string
  screenshotPath?: string
  coordinateSpace?: string
  display?: {
    id?: number
    x: number
    y: number
    width: number
    height: number
    scaleFactor?: number
  }
  window?: {
    pid?: number
    processName?: string
    title?: string
    x?: number
    y?: number
    width?: number
    height?: number
  }
  page?: { pageId?: string; url: string; title: string }
}

export function createComputerStateId(
  scope: ComputerStateScope,
  stateHash: string,
  capturedAt = Date.now()
): string {
  return `${scope}-${createHash('sha1').update(`${scope}:${stateHash}:${capturedAt}`).digest('hex').slice(0, 16)}`
}

export function stateMismatchMessage(scope: ComputerStateScope): string {
  return `[${scope === 'desktop' ? '电脑' : '浏览器'}状态已过期] 当前操作依赖的截图或页面状态已经变化。请重新获取 screenshot 或 browser_snapshot，再执行操作。`
}

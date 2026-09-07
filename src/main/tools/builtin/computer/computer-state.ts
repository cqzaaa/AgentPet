import { createHash } from 'crypto'

export type ComputerStateScope = 'desktop'

export interface ComputerState {
  id: string
  scope: ComputerStateScope
  capturedAt: number
  stateHash: string
  screenshotPath?: string
  screenshot?: {
    mode: 'screen' | 'window'
    width: number
    height: number
  }
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

export function stateMismatchMessage(_scope: ComputerStateScope): string {
  return `[电脑状态已过期] 当前操作依赖的截图状态已经变化。请重新获取 screenshot，再执行操作。`
}

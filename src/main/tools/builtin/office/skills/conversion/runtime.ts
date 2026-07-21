import * as fs from 'fs'
import { extname, resolve } from 'path'

import type { ToolContext } from '../../../../core/types'
import { getAllowedFileRoots, isPathWithinRoots, resolveSessionPath } from '../../../../utils/paths'
import { formatFromPath, type OfficeConversionFormat } from './capabilities'

export interface ConversionSourceFile {
  path: string
  format: OfficeConversionFormat
}

export interface ConversionRuntime {
  check: () => void
  report: (completed: number, total: number, detail: string) => void
  timeoutMs: number
}

export function resolveConversionSource(
  rawPath: unknown,
  context: ToolContext
): ConversionSourceFile {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('转换输入路径不能为空')
  const localPath = resolve(resolveSessionPath(rawPath.trim(), context.sessionId))
  if (!fs.existsSync(localPath)) throw new Error(`转换输入文件不存在：${localPath}`)
  const realPath = fs.realpathSync(localPath)
  if (!fs.statSync(realPath).isFile()) throw new Error(`转换输入不是文件：${realPath}`)
  if (!isPathWithinRoots(realPath, getAllowedFileRoots(context))) {
    throw new Error(`转换输入路径不在允许范围内：${realPath}`)
  }
  const format = formatFromPath(realPath)
  if (!format) throw new Error(`不支持的转换输入格式：${extname(realPath) || '无扩展名'}`)
  return { path: realPath, format }
}

export function createConversionRuntime(
  input: Record<string, unknown>,
  context: ToolContext,
  label: string
): ConversionRuntime {
  const requestedSeconds = Number(input.timeout_seconds ?? 240)
  const timeoutMs =
    Math.min(Math.max(Number.isFinite(requestedSeconds) ? requestedSeconds : 240, 10), 300) * 1000
  const deadline = Date.now() + timeoutMs
  let lastPercent = -1

  const check = (): void => {
    if (context.abortSignal?.aborted) throw new Error('转换已取消')
    if (Date.now() > deadline)
      throw new Error(`转换超时（限制 ${Math.round(timeoutMs / 1000)} 秒）`)
  }

  const report = (completed: number, total: number, detail: string): void => {
    check()
    const safeTotal = Math.max(1, total)
    const percent = Math.max(0, Math.min(100, Math.round((completed / safeTotal) * 100)))
    if (percent !== 100 && lastPercent >= 0 && percent - lastPercent < 5) return
    lastPercent = percent
    context.event?.sender.send('api:llm-tool-event', {
      type: 'tool_progress',
      name: label,
      detail: `${detail}（${percent}%）`,
      progress: percent,
      timestamp: Date.now(),
      messageId: context.messageId,
      sessionId: context.sessionId
    })
  }

  return { check, report, timeoutMs }
}

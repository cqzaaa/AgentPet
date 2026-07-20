/* eslint-disable @typescript-eslint/no-explicit-any */

import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import { extname, join } from 'path'

import type { ToolContext, ToolResult } from '../../../core/types'
import { getGeneratedFilesDir, resolveLocalPath } from '../../../utils/paths'
import { requestVisibleOfficePreview, type OfficePreviewFocus } from '../preview-capture'

export function resolveRequiredSource(input: Record<string, any>, extension: string): string {
  const rawPath = input.source_path || input.file_path
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error(`缺少 source_path（需要 ${extension} 文件）`)
  }

  const sourcePath = resolveLocalPath(rawPath)
  if (!fs.existsSync(sourcePath)) throw new Error(`源文件不存在：${sourcePath}`)
  if (extname(sourcePath).toLowerCase() !== extension) {
    throw new Error(
      `文件格式不匹配：需要 ${extension}，实际为 ${extname(sourcePath) || '无扩展名'}`
    )
  }
  return sourcePath
}

export function normalizeOutputName(rawName: unknown, fallback: string, extension: string): string {
  const requested = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : fallback
  const safeName = [...requested]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character
    )
    .join('')
  return safeName.toLowerCase().endsWith(extension) ? safeName : `${safeName}${extension}`
}

export async function writeGeneratedFile(
  data: Buffer | Uint8Array,
  outputName: unknown,
  fallback: string,
  extension: string,
  context: ToolContext
): Promise<{ filePath: string; fileName: string }> {
  const fileName = normalizeOutputName(outputName, fallback, extension)
  const filePath = join(getGeneratedFilesDir(context.sessionId), fileName)
  await fs.promises.writeFile(filePath, Buffer.from(data))
  notifyGeneratedFilesChanged()
  return { filePath, fileName }
}

export function notifyGeneratedFilesChanged(): void {
  const activeWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  activeWindow?.webContents.send('api:generated-file-updated')
}

export function jsonResult(state: Record<string, any>, success = true): ToolResult {
  return {
    content: JSON.stringify(state, null, 2),
    state,
    success
  }
}

export function readToolResultState(result: ToolResult): Record<string, any> {
  if (result.state && typeof result.state === 'object') return result.state
  try {
    const parsed = JSON.parse(result.content)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function attachVisiblePreviewValidation(
  result: ToolResult,
  context: ToolContext,
  focus: OfficePreviewFocus = { mode: 'overview' }
): Promise<ToolResult> {
  if (!result.success) return result
  const state = readToolResultState(result)
  if (typeof state.file_path !== 'string') return result

  const preview = await requestVisibleOfficePreview(state.file_path, context, {
    maxFrames: focus.mode === 'changes' ? 6 : 8,
    focus
  })
  const { imagePaths, ...previewSummary } = preview
  return jsonResult({
    ...state,
    visual_validation: {
      ...previewSummary,
      image_count: imagePaths.length
    },
    ...(imagePaths.length > 0
      ? {
          imagePaths: [...(Array.isArray(state.imagePaths) ? state.imagePaths : []), ...imagePaths]
        }
      : {})
  })
}

export function skillError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: JSON.stringify({ status: 'error', message }, null, 2),
    success: false,
    error: { message }
  }
}

export function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length || 0
}

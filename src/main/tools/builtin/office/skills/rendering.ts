/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolContext, ToolResult } from '../../../core/types'
import { requestVisibleOfficePreview } from '../preview-capture'
import { jsonResult } from './shared'
import type { OfficeSkillName } from './types'

export async function renderOfficeArtifact(
  skill: OfficeSkillName,
  sourcePath: string,
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const maxFrames = Math.min(
    12,
    Math.max(1, Math.floor(Number(input.max_frames ?? input.max_pages) || 8))
  )
  const preview = await requestVisibleOfficePreview(sourcePath, context, {
    maxFrames,
    focus: { mode: 'overview' }
  })

  if (preview.status === 'success') {
    return jsonResult({
      status: 'success',
      skill,
      action: 'render',
      source_path: sourcePath,
      renderer: 'open-file-viewer',
      visible_to_user: true,
      imagePaths: preview.imagePaths,
      rendered_viewports: preview.frames,
      truncated: preview.truncated,
      next_step: '预览截图已发送给模型；请检查改动位置、文字裁切、重叠和缺字。'
    })
  }

  return jsonResult({
    status: preview.status,
    skill,
    action: 'render',
    source_path: sourcePath,
    renderer: 'open-file-viewer',
    degraded: true,
    message: preview.message || '当前没有可见的文件预览窗口，已跳过视觉校验。'
  })
}

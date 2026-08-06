/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IToolExecutor, ToolContext, ToolResult } from '../../../core/types'
import { basename, extname } from 'path'
import { loadOfficeSkill } from './registry'
import { attachVisiblePreviewValidation, jsonResult, readToolResultState, skillError } from './shared'
import type { OfficeSkillAction } from './types'
import { validateOfficeSkillInput } from './input-validation'

const validActions = new Set<OfficeSkillAction>([
  'create',
  'inspect',
  'modify',
  'validate',
  'render',
  'convert',
  'semantic_edit'
])

async function executePdfSemanticEdit(
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const sourcePath = String(input.source_path || '')
  const search = String(input.search || '')
  const hasReplacement = Object.prototype.hasOwnProperty.call(input, 'replace')
  const style = input.style && typeof input.style === 'object' ? input.style : undefined
  if (!sourcePath || !search) throw new Error('PDF semantic_edit 需要 source_path 和 search')
  if (!hasReplacement && !style) throw new Error('PDF semantic_edit 至少需要 replace 或 style')

  const outputFormat = String(input.output_format || 'pdf').toLowerCase()
  const sourceStem = basename(sourcePath, extname(sourcePath))
  const internalContext: ToolContext = { ...context, suppressOfficePreview: true }
  const pdfSkill = await loadOfficeSkill('pdf')
  const docxSkill = await loadOfficeSkill('docx')

  const editableResult = await executeConversionWithTimeout(pdfSkill, 'convert', {
    source_path: sourcePath,
    target_format: 'docx',
    conversion_mode: 'editable',
    output_name: `${sourceStem}-editable.docx`,
    timeout_seconds: input.timeout_seconds
  }, internalContext)
  if (!editableResult.success) return editableResult
  const editablePath = readToolResultState(editableResult).file_path
  if (typeof editablePath !== 'string') throw new Error('PDF 转换未返回可编辑 DOCX 路径')

  const modification: Record<string, any> = { search }
  if (hasReplacement) modification.replace = String(input.replace)
  if (style) modification.style = style
  const modifiedDocxName = outputFormat === 'docx'
    ? String(input.output_name || `${sourceStem}-edited.docx`)
    : `${sourceStem}-edited-intermediate.docx`
  const modifiedResult = await docxSkill.execute('modify', {
    source_path: editablePath,
    output_name: modifiedDocxName,
    modifications: [modification]
  }, internalContext)
  if (!modifiedResult.success) return modifiedResult
  const modifiedState = readToolResultState(modifiedResult)
  const modifiedPath = modifiedState.file_path
  if (typeof modifiedPath !== 'string') throw new Error('DOCX 修改未返回输出路径')

  const focus = { mode: 'changes' as const, texts: [hasReplacement ? String(input.replace) : search, search] }
  if (outputFormat === 'docx') {
    return attachVisiblePreviewValidation(jsonResult({
      ...modifiedState,
      skill: 'pdf',
      action: 'semantic_edit',
      source_path: sourcePath,
      output_format: 'docx',
      intermediate_files_hidden: true
    }), context, focus)
  }

  const finalResult = await executeConversionWithTimeout(docxSkill, 'convert', {
    source_path: modifiedPath,
    target_format: 'pdf',
    output_name: String(input.output_name || `${sourceStem}-edited.pdf`),
    timeout_seconds: input.timeout_seconds
  }, internalContext)
  if (!finalResult.success) return finalResult
  return attachVisiblePreviewValidation(jsonResult({
    ...readToolResultState(finalResult),
    skill: 'pdf',
    action: 'semantic_edit',
    source_path: sourcePath,
    output_format: 'pdf',
    replacements: modifiedState.replaced,
    style_changes_verified: modifiedState.style_changes_verified,
    intermediate_files_hidden: true
  }), context, focus)
}

async function executeConversionWithTimeout(
  skill: Awaited<ReturnType<typeof loadOfficeSkill>>,
  action: OfficeSkillAction,
  input: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const timeoutSeconds = Math.min(Math.max(Number(input.timeout_seconds ?? 240), 10), 300)
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = (): void => controller.abort(context.abortSignal?.reason)
  if (context.abortSignal) {
    if (context.abortSignal.aborted) forwardAbort()
    else context.abortSignal.addEventListener('abort', forwardAbort, { once: true })
  }

  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('ConversionTimeout'))
        resolve(skillError(new Error(`转换超时（限制 ${timeoutSeconds} 秒）`)))
      }, timeoutSeconds * 1000)
    })
    const execution = skill.execute(action, input, { ...context, abortSignal: controller.signal })
    const result = await Promise.race([execution, timeout])
    return timedOut ? skillError(new Error(`转换超时（限制 ${timeoutSeconds} 秒）`)) : result
  } finally {
    if (timer) clearTimeout(timer)
    context.abortSignal?.removeEventListener('abort', forwardAbort)
  }
}

export class OfficeSkillExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      if (api === 'run_office_skill') {
        const action = String(args.action || '').toLowerCase() as OfficeSkillAction
        if (!validActions.has(action)) {
          throw new Error(`未知 Office Skill action：${String(args.action)}`)
        }

        const skill = await loadOfficeSkill(args.skill)
        const operation = skill.descriptor.operations[action]
        if (!operation) {
          throw new Error(`${skill.descriptor.name} Skill 不支持 ${action} 操作`)
        }

        const input = args.input && typeof args.input === 'object' ? args.input : {}
        validateOfficeSkillInput(input, operation.inputSchema)
        if (action === 'semantic_edit') {
          if (skill.descriptor.name !== 'pdf') throw new Error('semantic_edit 当前仅支持 PDF')
          return executePdfSemanticEdit(input, context)
        }
        if (action === 'convert') {
          const result = await executeConversionWithTimeout(skill, action, input, context)
          const targetFormat = String(input.target_format || '').toLowerCase()
          return ['docx', 'xlsx', 'pptx', 'pdf'].includes(targetFormat)
            ? attachVisiblePreviewValidation(result, context)
            : result
        }
        return skill.execute(action, input, context)
      }

      throw new Error(`未知 Office Skill API：${api}`)
    } catch (error) {
      return skillError(error)
    }
  }

  public getApiNames(): string[] {
    return ['run_office_skill']
  }
}

export const officeSkillExecutor = new OfficeSkillExecutor()

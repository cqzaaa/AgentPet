/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IToolExecutor, ToolContext, ToolResult } from '../../../core/types'
import { getLoadedOfficeSkillNames, listOfficeSkills, loadOfficeSkill } from './registry'
import { jsonResult, skillError } from './shared'
import type { OfficeSkillAction } from './types'

const validActions = new Set<OfficeSkillAction>([
  'create',
  'inspect',
  'modify',
  'validate',
  'render',
  'convert'
])

function validateInput(value: any, schema: any, path = 'input'): void {
  if (!schema || typeof schema !== 'object') return

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path} 必须是以下值之一：${schema.enum.join(', ')}`)
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} 必须是对象`)
    }
    for (const requiredKey of schema.required || []) {
      if (value[requiredKey] === undefined || value[requiredKey] === null) {
        throw new Error(`${path}.${requiredKey} 是必填参数`)
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) validateInput(value[key], childSchema, `${path}.${key}`)
    }
    return
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new Error(`${path} 至少需要 ${schema.minItems} 项`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new Error(`${path} 最多允许 ${schema.maxItems} 项`)
    }
    value.forEach((item, index) => validateInput(item, schema.items, `${path}[${index}]`))
    return
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} 必须是字符串`)
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new Error(`${path} 长度不能小于 ${schema.minLength}`)
    }
  }

  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${path} 必须是有限数值`)
    }
    if (schema.integer && !Number.isInteger(value)) throw new Error(`${path} 必须是整数`)
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new Error(`${path} 不能小于 ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new Error(`${path} 不能大于 ${schema.maximum}`)
    }
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${path} 必须是布尔值`)
  }
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
      if (api === 'load_office_skill') {
        const skill = await loadOfficeSkill(args.skill)
        return jsonResult({
          status: 'success',
          message: `已按需加载 ${skill.descriptor.name} Skill。`,
          skill: skill.descriptor,
          loaded_skills: getLoadedOfficeSkillNames(),
          available_skill_index: listOfficeSkills(),
          next_step: '调用 run_office_skill，并按照目标 action 的 inputSchema 传入 input。'
        })
      }

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
        validateInput(input, operation.inputSchema)
        return action === 'convert'
          ? executeConversionWithTimeout(skill, action, input, context)
          : skill.execute(action, input, context)
      }

      throw new Error(`未知 Office Skill API：${api}`)
    } catch (error) {
      return skillError(error)
    }
  }

  public getApiNames(): string[] {
    return ['load_office_skill', 'run_office_skill']
  }
}

export const officeSkillExecutor = new OfficeSkillExecutor()

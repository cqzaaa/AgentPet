/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IToolExecutor, ToolContext, ToolResult } from '../../../core/types'
import { getLoadedOfficeSkillNames, listOfficeSkills, loadOfficeSkill } from './registry'
import type { OfficeSkillAction } from './types'
import { jsonResult, skillError } from './shared'

const validActions = new Set<OfficeSkillAction>([
  'create',
  'inspect',
  'modify',
  'validate',
  'render'
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
    value.forEach((item, index) => validateInput(item, schema.items, `${path}[${index}]`))
    return
  }
  if (schema.type === 'string' && typeof value !== 'string') throw new Error(`${path} 必须是字符串`)
  if (schema.type === 'number' && typeof value !== 'number') throw new Error(`${path} 必须是数字`)
  if (schema.type === 'boolean' && typeof value !== 'boolean')
    throw new Error(`${path} 必须是布尔值`)
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
        if (!validActions.has(action))
          throw new Error(`未知 Office Skill action：${String(args.action)}`)
        const skill = await loadOfficeSkill(args.skill)
        const input = args.input && typeof args.input === 'object' ? args.input : {}
        validateInput(input, skill.descriptor.operations[action].inputSchema)
        return skill.execute(action, input, context)
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

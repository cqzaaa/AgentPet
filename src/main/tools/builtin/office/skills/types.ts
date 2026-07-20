/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolContext, ToolResult } from '../../../core/types'

export type OfficeSkillName = 'docx' | 'xlsx' | 'pdf' | 'pptx'
export type OfficeSkillAction = 'create' | 'inspect' | 'modify' | 'validate' | 'render'

export interface OfficeSkillOperation {
  description: string
  inputSchema: Record<string, any>
}

export interface OfficeSkillDescriptor {
  name: OfficeSkillName
  title: string
  description: string
  extensions: string[]
  instructions: string[]
  operations: Record<OfficeSkillAction, OfficeSkillOperation>
}

export interface OfficeSkill {
  descriptor: OfficeSkillDescriptor
  execute(
    action: OfficeSkillAction,
    input: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult>
}

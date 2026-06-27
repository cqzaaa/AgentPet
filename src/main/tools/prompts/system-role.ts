import { ToolManifest } from '../core/types'

export function buildSystemRole(params: {
  basePrompt: string
  tools: ToolManifest[]
  historySummary?: string
  dateTime?: string
}): string {
  const parts: string[] = []

  // 1. 基础提示词
  parts.push(params.basePrompt)

  // 2. 时间与环境元数据
  if (params.dateTime) {
    parts.push(`<system_context>
<current_datetime>${params.dateTime}</current_datetime>
</system_context>`)
  }

  // 3. 工具规则组装
  const toolRoles = params.tools
    .map(t => t.systemRole)
    .filter(Boolean)

  if (toolRoles.length > 0) {
    parts.push(`<available_tools description="可用工具相关的系统规则，你必须严格遵守">
${toolRoles.join('\n\n')}
</available_tools>`)
  }

  // 4. 对话历史摘要
  if (params.historySummary) {
    parts.push(`<chat_history_summary>
${params.historySummary}
</chat_history_summary>`)
  }

  return parts.filter(Boolean).join('\n\n')
}

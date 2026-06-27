import { ToolResult } from '../core/types'

export function formatToolResult(result: ToolResult, toolName: string): string {
  if (result.success) {
    return `<tool_result name="${toolName}" status="success">
${result.content}
</tool_result>`
  }
  return `<tool_result name="${toolName}" status="error">
<error>${result.error?.message || result.content}</error>
</tool_result>`
}

export function formatFileContent(params: {
  path: string
  content: string
  totalLines: number
  startLine?: number
  endLine?: number
}): string {
  return `<file path="${params.path}" total_lines="${params.totalLines}"${
    params.startLine ? ` showing="${params.startLine}-${params.endLine}"` : ''
  }>
${params.content}
</file>`
}

export function formatSearchResults(results: string[], query: string): string {
  return `<search_results query="${query}" count="${results.length}">
${results.map((r, i) => `<match index="${i + 1}">${r}</match>`).join('\n')}
</search_results>`
}

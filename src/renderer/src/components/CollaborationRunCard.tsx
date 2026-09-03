import React, { useMemo } from 'react'
import { CheckCircle2, ChevronRight, CircleDashed, ExternalLink, FileText, Loader2, Network, XCircle } from 'lucide-react'
import { renderAdvancedMessage } from './ChatMessageItem'
import { TaskDagGraph, type TaskPlan, type TaskPlanStep, type TaskStepStatus } from './TaskPlanCard'

export interface CollaborationSnapshot {
  run: any
  steps: any[]
}

type PreviewFileHandler = (file: { name: string; path: string; size: number }) => void

function resolveArtifactPath(value: string, workspacePath?: string): string {
  const path = String(value || '').trim()
  if (!path || /^(?:local-file|file):\/\//i.test(path) || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('/')) return path
  const root = String(workspacePath || '').trim().replace(/[\\/]+$/, '')
  if (!root) return path
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root}${separator}${path.replace(/^[\\/]+/, '')}`
}

function normalizeArtifactUrl(path: string): string {
  const value = path.trim()
  if (value.startsWith('file:///')) return value.replace('file:///', 'local-file:///')
  if (value.startsWith('local-file:///')) return value
  if (/^[A-Za-z]:[/\\]/.test(value)) return `local-file:///${value.replace(/\\/g, '/')}`
  return value
}

function artifactDisplayName(path: string): { fileName: string; folderPath: string } {
  const clean = decodeURIComponent(path.trim())
    .replace(/^local-file:\/\/\/?/i, '')
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/')
  const parts = clean.split('/').filter(Boolean)
  const fileName = parts.pop() || path
  const folderPath = parts.slice(-2).join('/')
  return { fileName, folderPath: folderPath ? `…/${folderPath}` : '' }
}

function artifactSystemPath(path: string): string {
  let value = decodeURIComponent(path.trim()).replace(/^local-file:\/\/\/?/i, '').replace(/^file:\/\/\/?/i, '')
  if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1)
  return value.replace(/\//g, '\\')
}

export function CollaborationArtifactCards({
  paths,
  workspacePath,
  onPreviewFile,
  className = ''
}: {
  paths: string[]
  workspacePath?: string
  onPreviewFile?: PreviewFileHandler
  className?: string
}): React.JSX.Element | null {
  const artifacts = [...new Map(paths.map(path => {
    const resolved = resolveArtifactPath(path, workspacePath)
    return [resolved.toLowerCase(), resolved] as const
  }).filter((entry): entry is readonly [string, string] => Boolean(entry[1]))).values()]
  if (!artifacts.length) return null
  return <section className={`collab-node-artifacts ${className}`.trim()}>
    <header className="collab-artifacts-header">
      <h3>修改 / 新增文件</h3>
      <span className="collab-artifacts-badge">{artifacts.length} 个文件</span>
    </header>
    <div className="collab-artifacts-list">
      {artifacts.map(path => {
        const { fileName, folderPath } = artifactDisplayName(path)
        const url = normalizeArtifactUrl(path)
        return <button
          key={path}
          type="button"
          className="collab-artifact-card"
          title={`${onPreviewFile ? '点击预览' : '点击打开'}：${path}`}
          onClick={() => {
            if (onPreviewFile) onPreviewFile({ name: fileName, path: artifactSystemPath(path), size: 0 })
            else void window.api.openLocalFile(url)
          }}
        >
          <span className="collab-artifact-icon"><FileText size={13} /></span>
          <span className="collab-artifact-info">
            <span className="collab-artifact-name">{fileName}</span>
            {folderPath && <span className="collab-artifact-path">{folderPath}</span>}
          </span>
          <ExternalLink size={11} className="collab-artifact-open" />
        </button>
      })}
    </div>
  </section>
}

function planStatus(status: string): TaskStepStatus {
  if (status === 'running') return 'in_progress'
  if (status === 'completed') return 'completed'
  if (['failed', 'blocked', 'cancelled'].includes(status)) return 'blocked'
  return 'pending'
}

export function cleanResultSummary(rawText: string): string {
  const str = String(rawText || '').trim()
  if (!str) return ''

  // 检查是否是 JSON
  if ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))) {
    try {
      const parsed = JSON.parse(str)
      // 如果包含标准的 event 结果包装 (例如 CLI 输出)
      if (parsed && typeof parsed === 'object') {
        const responseCandidate = parsed.response || parsed.result?.response || parsed.result || parsed.output || parsed.message
        if (typeof responseCandidate === 'string' && responseCandidate.trim()) {
          return cleanResultSummary(responseCandidate.trim())
        }
        // 如果无法提炼单个 response 字符串，格式化为缩进 json 代码块
        return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
      }
    } catch {
      // JSON 解析失败，维持原样
    }
  }

  // 检查文本内部是否夹杂单独一行 Raw JSON 的情况 (如 `{"event":"init"...}`)
  if (str.startsWith('{"event":')) {
    const lines = str.split('\n')
    const responses: string[] = []
    const completedTools = new Set<string>()
    const failedTools: string[] = []
    let conversationId = ''
    let responseTurns = 0
    lines.forEach(line => {
      const trimmed = line.trim()
      if (trimmed.startsWith('{"event":')) {
        try {
          const parsed = JSON.parse(trimmed)
          conversationId ||= String(parsed.conversation_id || parsed.result?.conversation_id || parsed.step_update?.conversation_id || '')
          if (typeof parsed.response === 'string' && parsed.response.trim()) responses.push(parsed.response.trim())
          if (typeof parsed.result?.response === 'string' && parsed.result.response.trim()) responses.push(parsed.result.response.trim())
          const update = parsed.step_update
          if (update?.step_type === 'agent_response' && update?.state === 'DONE') responseTurns += 1
          if (update?.step_type === 'tool' && update?.state === 'DONE' && update?.tool_name) completedTools.add(String(update.tool_name))
          if (update?.step_type === 'tool' && update?.state === 'ERROR') failedTools.push(String(update?.tool_name || update?.tool_info?.name || 'tool'))
        } catch { /* Ignore malformed transport lines. */ }
      }
    })
    if (responses.length) return responses[responses.length - 1]
    return [
      'Antigravity CLI 已完成任务。',
      conversationId ? `会话：${conversationId}` : '',
      responseTurns ? `Agent 响应轮次：${responseTurns}` : '',
      completedTools.size ? `已完成工具：${[...completedTools].join('、')}` : '',
      failedTools.length ? `失败工具：${[...new Set(failedTools)].join('、')}` : ''
    ].filter(Boolean).join('\n')
  }

  return str
}

export function collaborationFinalContent(steps: any[]): string {
  const dependencyIds = new Set(steps.flatMap(step => Array.isArray(step?.dependencies) ? step.dependencies.map(String) : []))
  const terminalSteps = steps.filter(step => !dependencyIds.has(String(step?.id)))
  if (!terminalSteps.length || terminalSteps.some(step => step?.status !== 'completed')) return ''
  const finalSteps = terminalSteps.filter(step => String(step?.resultSummary || '').trim())
  if (finalSteps.length !== terminalSteps.length) return ''
  const removeEmptyArtifactHeading = (text: string): string => text
    .replace(/(?:^|\n+)#{1,6}\s*[^\n]*(?:产物|文件清单)[^\n]*\s*$/i, '')
    .trim()
  if (finalSteps.length === 1) return removeEmptyArtifactHeading(cleanResultSummary(finalSteps[0].resultSummary))
  return finalSteps.map(step => `### ${String(step.title || '最终结果')}\n\n${removeEmptyArtifactHeading(cleanResultSummary(step.resultSummary))}`).join('\n\n')
}

export const CollaborationRunCard = React.memo(function CollaborationRunCard({ snapshot, onOpenDetails, onPreviewFile }: { snapshot: CollaborationSnapshot; onOpenDetails?: (taskRunId: string) => void; onPreviewFile?: PreviewFileHandler }): React.JSX.Element {
  const { run, steps = [] } = snapshot
  const plan = useMemo<TaskPlan>(() => ({
    runId: run.id,
    title: run.title || '多 Agent 协作',
    explanation: run.explanation,
    steps: steps.map((step, index): TaskPlanStep => ({
      ...step,
      id: String(step.id || `step-${index + 1}`),
      title: String(step.title || `任务 ${index + 1}`),
      status: planStatus(String(step.status || 'pending'))
    }))
  }), [run, steps])
  const finalContent = useMemo(() => run.status === 'completed' ? collaborationFinalContent(steps) : '', [run.status, steps])
  const artifactPaths = useMemo(() => steps.flatMap(step => Array.isArray(step?.artifactPaths) ? step.artifactPaths.map(String) : []), [steps])
  const completed = steps.filter(step => step.status === 'completed').length
  const running = steps.some(step => step.status === 'running')
  const failed = ['failed', 'blocked', 'cancelled'].includes(String(run.status))

  return <article className={`collaboration-chat-card status-${run.status || 'pending'}`} aria-label={`协作记录：${plan.title}`}>
    <header className="collaboration-chat-card-header">
      <span className="collaboration-chat-card-icon"><Network size={16} /></span>
      <span><small>多 Agent 协作</small><strong>{plan.title}</strong></span>
      <em>{running ? <Loader2 className="spin" size={13} /> : failed ? <XCircle size={13} /> : run.status === 'completed' ? <CheckCircle2 size={13} /> : <CircleDashed size={13} />}{running ? `${completed}/${steps.length} 执行中` : failed ? '未完成' : `${completed}/${steps.length} 已完成`}</em>
      {onOpenDetails && <button type="button" onClick={() => onOpenDetails(String(run.id))}>查看详情<ChevronRight size={13} /></button>}
    </header>
    <TaskDagGraph plan={plan} />
    {finalContent && <section className="collaboration-chat-result">
      <div className="collaboration-result-markdown">{renderAdvancedMessage(finalContent)}</div>
    </section>}
    <CollaborationArtifactCards paths={artifactPaths} workspacePath={run.workspacePath} onPreviewFile={onPreviewFile} className="collaboration-chat-artifacts" />
  </article>
})

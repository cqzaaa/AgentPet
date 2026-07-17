import type { RpaTaskManifest } from '../../../rpa/domain/types'
import { getRpaRunRepository } from '../../../rpa/persistence/repository-manager'
import { PlaywrightRpaExecutor } from '../../../rpa/playwrightExecutor'
import { loadManifest, loadTaskFlow } from '../../../rpa/rpaStorage'
import type { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { collectTemplateParameters, sanitizeWorkflowInputs, workflowScore } from './workflow-utils'
import { recordingCoordinator } from '../../../rpa/recording/recording-coordinator'

type ToolArguments = Record<string, unknown>

const findWorkflow = async (workflowId: string): Promise<RpaTaskManifest | undefined> => {
  const manifest = await loadManifest()
  return manifest.find((workflow) => workflow.id === workflowId)
}

export class RpaToolExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: ToolArguments,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      switch (api) {
        case 'rpa_search_workflows':
          return await this.searchWorkflows(args)
        case 'rpa_describe_workflow':
          return await this.describeWorkflow(args)
        case 'rpa_run_workflow':
          return await this.runWorkflow(args, context)
        case 'rpa_get_run_status':
          return await this.getRunStatus(args)
        case 'rpa_cancel_run':
          return await this.cancelRun(args)
        case 'rpa_start_recording':
          return this.startRecording(args)
        case 'rpa_pause_recording':
          return this.recordingResult(recordingCoordinator.pause(String(args.recording_session_id || '')))
        case 'rpa_resume_recording':
          return this.recordingResult(recordingCoordinator.resume(String(args.recording_session_id || ''), typeof args.start_url === 'string' ? args.start_url : undefined))
        case 'rpa_get_recording_status':
          return this.recordingResult(recordingCoordinator.getStatus(String(args.recording_session_id || '')))
        case 'rpa_finish_recording':
          return this.recordingResult(await recordingCoordinator.finish(String(args.recording_session_id || '')))
        case 'rpa_bind_recording_secret':
          return this.recordingResult(recordingCoordinator.bindSecret(
            String(args.recording_session_id || ''),
            String(args.selector || ''),
            String(args.secret_ref || '') as `secret.${string}`
          ))
        case 'rpa_cancel_recording':
          return this.recordingResult(await recordingCoordinator.cancel(String(args.recording_session_id || '')))
        default:
          return { content: `未知 RPA 工具: ${api}`, success: false }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: `RPA 工具执行失败: ${message}`,
        success: false,
        error: { message }
      }
    }
  }

  public getApiNames(): string[] {
    return [
      'rpa_search_workflows',
      'rpa_describe_workflow',
      'rpa_run_workflow',
      'rpa_get_run_status',
      'rpa_cancel_run',
      'rpa_start_recording',
      'rpa_pause_recording',
      'rpa_resume_recording',
      'rpa_get_recording_status',
      'rpa_finish_recording',
      'rpa_bind_recording_secret',
      'rpa_cancel_recording'
    ]
  }

  private async searchWorkflows(args: ToolArguments): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 10))
    const manifest = await loadManifest()
    const workflows = manifest
      .map((workflow) => ({ workflow, score: workflowScore(workflow, query) }))
      .filter((candidate) => !query || candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.workflow.name.localeCompare(right.workflow.name)
      )
      .slice(0, limit)
      .map(({ workflow, score }) => ({
        workflowId: workflow.id,
        name: workflow.name,
        description: workflow.description || '',
        relevance: Number(score.toFixed(2)),
        lastRunStatus: workflow.lastRunStatus || 'idle',
        lastRunTime: workflow.lastRunTime || null
      }))

    const result = { query, count: workflows.length, workflows }
    return { content: JSON.stringify(result, null, 2), state: result, success: true }
  }

  private async describeWorkflow(args: ToolArguments): Promise<ToolResult> {
    const workflowId = String(args.workflow_id || '')
    const workflow = await findWorkflow(workflowId)
    if (!workflow) return { content: `未找到工作流: ${workflowId}`, success: false }
    const flow = await loadTaskFlow(workflow.id)
    if (!flow) return { content: `工作流定义不存在: ${workflowId}`, success: false }

    const nodeTypes = flow.nodes.reduce<Record<string, number>>((counts, node) => {
      counts[node.type] = (counts[node.type] || 0) + 1
      return counts
    }, {})
    const result = {
      workflowId: workflow.id,
      name: workflow.name,
      description: workflow.description || '',
      nodeCount: flow.nodes.length,
      nodeTypes,
      parameters: collectTemplateParameters(flow.nodes),
      hasManualApproval: flow.nodes.some((node) => node.type === 'manual_confirm')
    }
    return { content: JSON.stringify(result, null, 2), state: result, success: true }
  }

  private async runWorkflow(args: ToolArguments, context: ToolContext): Promise<ToolResult> {
    const workflowId = String(args.workflow_id || '')
    const workflow = await findWorkflow(workflowId)
    if (!workflow) return { content: `未找到工作流: ${workflowId}`, success: false }
    const flow = await loadTaskFlow(workflow.id)
    if (!flow) return { content: `工作流定义不存在: ${workflowId}`, success: false }
    if (!flow.nodes.some((node) => node.type === 'start')) {
      return { content: `工作流 ${workflowId} 缺少开始节点，无法运行。`, success: false }
    }
    if (!context.event?.sender || context.event.sender.isDestroyed()) {
      return {
        content: 'RPA 只能从当前前台聊天窗口启动；后台任务不能操作交互式浏览器。',
        success: false
      }
    }

    const inputs = sanitizeWorkflowInputs(args.inputs)
    const requiredParameters = collectTemplateParameters(flow.nodes)
    const missingParameters = requiredParameters.filter((parameter) => !(parameter in inputs))
    if (missingParameters.length > 0) {
      return {
        content: `缺少工作流参数: ${missingParameters.join(', ')}`,
        state: { missingParameters },
        success: false
      }
    }

    const runId = await PlaywrightRpaExecutor.run(
      workflow.id,
      flow.nodes,
      flow.edges,
      context.event.sender,
      inputs
    )
    const result = {
      runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: 'running'
    }
    return { content: JSON.stringify(result, null, 2), state: result, success: true }
  }

  private async getRunStatus(args: ToolArguments): Promise<ToolResult> {
    const runId = String(args.run_id || '')
    const active = PlaywrightRpaExecutor.findByRunId(runId)
    if (active) {
      const status = active.getRunStatus()
      const result = {
        runId,
        status,
        active: status === 'pending' || status === 'running' || status === 'paused',
        processAttached: true
      }
      return { content: JSON.stringify(result, null, 2), state: result, success: true }
    }

    const run = await getRpaRunRepository().getRun(runId)
    if (!run) return { content: `未找到 RPA 运行记录: ${runId}`, success: false }
    const result = { ...run, active: false }
    return { content: JSON.stringify(result, null, 2), state: result, success: true }
  }

  private async cancelRun(args: ToolArguments): Promise<ToolResult> {
    const runId = String(args.run_id || '')
    const active = PlaywrightRpaExecutor.findByRunId(runId)
    if (!active) {
      const run = await getRpaRunRepository().getRun(runId)
      return {
        content: run
          ? `运行 ${runId} 当前状态为 ${run.status}，已不在当前进程中执行。`
          : `未找到 RPA 运行记录: ${runId}`,
        success: false
      }
    }
    const previousStatus = active.getRunStatus()
    await active.stop()
    const result = {
      runId,
      status:
        previousStatus === 'success' || previousStatus === 'failed' ? previousStatus : 'cancelled',
      resourcesReleased: true
    }
    return { content: JSON.stringify(result, null, 2), state: result, success: true }
  }

  private startRecording(args: ToolArguments): ToolResult {
    const mode = args.mode === 'collaborative' || args.mode === 'autonomous' ? args.mode : 'guided'
    if (mode === 'autonomous') {
      return {
        content: '真实系统录制不能直接使用 autonomous 模式。请改用 guided 或 collaborative。',
        success: false
      }
    }
    const session = recordingCoordinator.start({
      name: String(args.name || ''),
      objective: String(args.objective || ''),
      startUrl: typeof args.start_url === 'string' && args.start_url.trim() ? args.start_url.trim() : undefined,
      mode,
      surfaces: ['browser', 'desktop']
    })
    return this.recordingResult(session)
  }

  private recordingResult(session: ReturnType<typeof recordingCoordinator.getStatus>): ToolResult {
    const result = {
      recordingSessionId: session.id,
      workflowId: session.workflowId,
      workflowName: session.name,
      status: session.status,
      actionCount: session.actionCount,
      missingSecretBindings: session.missingSecretBindings,
      pendingSecretBindings: session.pendingSecretBindings || [],
      needsStartUrl: session.status === 'preparing'
    }
    return { content: JSON.stringify(result, null, 2), state: result, success: true }
  }
}

export const rpaToolExecutor = new RpaToolExecutor()

import React from 'react'
import {
  Background, Controls, Handle, Position, ReactFlow, addEdge,
  useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowLeft, Bot, CheckCircle2, FolderOpen, GitBranch, Loader2, Network, Play, Plus, RotateCcw, ShieldAlert, Sparkles, TerminalSquare, Trash2, Zap } from 'lucide-react'
import { AgentBrandIcon } from './AgentBrandIcon'
import { renderAdvancedMessage } from './ChatMessageItem'
import { cleanResultSummary, CollaborationArtifactCards } from './CollaborationRunCard'
import { TaskDagGraph, type TaskPlan } from './TaskPlanCard'

type AgentStatus = 'unchecked' | 'missing' | 'ready' | 'interactive' | 'auth_required' | 'error'

interface AgentChoice {
  id: string
  name: string
  description: string
  protocol: string
  probe: null | { status: AgentStatus; installed: boolean; error?: string }
}

interface AgentModel { id: string; name: string; description?: string; source: string }

interface TaskNodeData extends Record<string, unknown> {
  title: string
  prompt: string
  agentId: string
  agentName: string
  model?: string
}

interface RuntimeLine {
  id: string
  time: number
  kind: 'status' | 'stream' | 'model' | 'tool' | 'error'
  text: string
}

interface RuntimeStep {
  id: string
  title: string
  status: string
  detail?: string
  resultSummary?: string
  agentId?: string
  model?: string
  dependencies?: string[]
  prompt?: string
  acceptanceCriteria?: string
  artifactPaths?: string[]
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  unchecked: '待检测', missing: '未安装', ready: '可用', interactive: '仅 IDE 交互', auth_required: '需登录', error: '不可用'
}

function TaskNode({ data, selected }: NodeProps<Node<TaskNodeData>>): React.JSX.Element {
  const isDefaultModel = !data.model || data.model === 'default'
  return (
    <div className={`collab-flow-node ${selected ? 'selected' : ''}`}>
      <div className="collab-node-header">
        <div className="collab-node-brand">
          <div className="agent-brand-icon">
            <AgentBrandIcon agentId={data.agentId} />
          </div>
          <span className="collab-node-agent-name">{data.agentName}</span>
        </div>
        <span className="collab-node-badge">Agent</span>
      </div>
      <div className="collab-node-body">
        <div className="collab-node-title" title={data.title}>{data.title}</div>
        <div className="collab-node-meta">
          <span className="collab-model-pill">
            <Zap size={11} className="collab-model-icon" />
            {isDefaultModel ? '默认模型' : data.model}
          </span>
        </div>
      </div>
      <Handle type="target" position={Position.Left} className="collab-handle collab-handle-target" />
      <Handle type="source" position={Position.Right} className="collab-handle collab-handle-source" />
    </div>
  )
}

const nodeTypes = { task: TaskNode }

function canAutomate(agent: AgentChoice): boolean {
  return agent.id === 'agentpet' || agent.probe?.status === 'ready'
}

function chooseAgent(agents: AgentChoice[], preferred: string[]): AgentChoice {
  return preferred.map(id => agents.find(agent => agent.id === id && canAutomate(agent))).find(Boolean)
    || agents.find(canAutomate)
    || { id: 'agentpet', name: 'AgentPet', description: '', protocol: 'internal', probe: null }
}

function taskNode(id: string, title: string, prompt: string, agent: AgentChoice, x: number, y: number): Node<TaskNodeData> {
  return { id, type: 'task', position: { x, y }, data: { title, prompt, agentId: agent.id, agentName: agent.name } }
}

function buildAutomaticGraph(goal: string, agents: AgentChoice[]): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  const participatingAgents = agents.filter(canAutomate).slice(0, 4)
  const fallbackAgent = chooseAgent(participatingAgents, ['agentpet'])
  const reviewAgent = participatingAgents.find(agent => agent.id === 'agentpet') || participatingAgents[participatingAgents.length - 1] || fallbackAgent
  const implementationAgents = participatingAgents.filter(agent => agent.id !== reviewAgent.id)
  if (implementationAgents.length === 0) implementationAgents.push(reviewAgent)
  const implementationNodes = implementationAgents.map((agent, index) => taskNode(
    `implementation-${index + 1}`,
    implementationAgents.length === 1 ? '完整实现' : `${agent.name} 实现分工`,
    `负责一个完整且独立的交付范围，直接实现代码并避免与其他参与 Agent 重复修改；完成后列出修改文件和验证结果。\n\n总体目标：${goal}`,
    agent,
    70,
    90 + index * 190
  ))
  const verificationNode = taskNode(
    'verification',
    '集成验收与修复',
    `整合所有参与 Agent 的实现，运行必要验证并直接修复发现的问题，交付最终可用结果。\n\n总体目标：${goal}`,
    reviewAgent,
    520,
    90 + Math.max(0, implementationNodes.length - 1) * 95
  )
  return {
    nodes: [...implementationNodes, verificationNode],
    edges: implementationNodes.map(node => ({ id: `${node.id}-verification`, source: node.id, target: 'verification', animated: true }))
  }
}

function graphFromPlan(plan: any, agents: AgentChoice[], goal: string): { title: string; nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  const rawTasks = Array.isArray(plan?.tasks) ? plan.tasks.slice(0, 5) : []
  const ids = new Set(rawTasks.map((task: any, index: number) => String(task?.id || `task-${index + 1}`)))
  const levels = new Map<string, number>()
  for (let pass = 0; pass < rawTasks.length + 1; pass += 1) {
    rawTasks.forEach((task: any, index: number) => {
      const id = String(task?.id || `task-${index + 1}`)
      const dependencies = (Array.isArray(task?.dependencies) ? task.dependencies.map(String) : []).filter((value: string) => ids.has(value) && value !== id)
      if (dependencies.every((dependency: string) => levels.has(dependency))) levels.set(id, dependencies.length ? Math.max(...dependencies.map((dependency: string) => levels.get(dependency) || 0)) + 1 : 0)
    })
  }
  const perLevel = new Map<number, number>()
  const nodes = rawTasks.map((task: any, index: number) => {
    const id = String(task?.id || `task-${index + 1}`)
    const level = levels.get(id) || 0
    const row = perLevel.get(level) || 0
    perLevel.set(level, row + 1)
    const requested = agents.find(agent => agent.id === String(task?.agentId) && canAutomate(agent))
    const agent = requested || chooseAgent(agents, ['agentpet'])
    return taskNode(
      id,
      String(task?.title || `任务 ${index + 1}`).slice(0, 80),
      String(task?.prompt || `完成该子任务并交付可验证结果。\n\n总体目标：${goal}`).slice(0, 8000),
      agent,
      60 + level * 330,
      60 + row * 180
    )
  })
  const edges: Edge[] = rawTasks.flatMap((task: any, index: number) => {
    const target = String(task?.id || `task-${index + 1}`)
    return (Array.isArray(task?.dependencies) ? task.dependencies.map(String) : [])
      .filter((source: string) => ids.has(source) && source !== target)
      .map((source: string) => ({ id: `${source}-${target}`, source, target, animated: true }))
  })
  if (!nodes.length || hasCycle(nodes, edges)) throw new Error('模型返回了无效流程')
  return { title: String(plan?.title || goal).slice(0, 80), nodes, edges }
}

function hasCycle(nodes: Node[], edges: Edge[]): boolean {
  const adjacency = new Map(nodes.map(node => [node.id, [] as string[]]))
  edges.forEach(edge => adjacency.get(edge.source)?.push(edge.target))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    if ((adjacency.get(id) || []).some(visit)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return nodes.some(node => visit(node.id))
}

function runtimeMessage(update: any, step?: RuntimeStep): Omit<RuntimeLine, 'id' | 'time'> | null {
  const payload = update?.payload || {}
  const agentEvent = payload.update || {}
  if (update.action === 'agent_event') {
    if (agentEvent?.event === 'init') {
      const toolCount = Array.isArray(agentEvent?.init?.tools) ? agentEvent.init.tools.length : 0
      return { kind: 'status', text: `Antigravity 会话已连接${toolCount ? ` · ${toolCount} 个工具可用` : ''}` }
    }
    if (agentEvent?.event === 'step_update' && agentEvent?.step_update) {
      const antigravityStep = agentEvent.step_update
      const state = String(antigravityStep.state || '').toUpperCase()
      const stepType = String(antigravityStep.step_type || '')
      if (stepType === 'user_input') return { kind: 'status', text: state === 'DONE' ? '任务指令已提交' : '正在提交任务指令' }
      if (stepType === 'agent_response') {
        const usage = antigravityStep.usage || {}
        const tokenText = Number(usage.output_tokens) > 0 ? ` · 输出 ${Number(usage.output_tokens).toLocaleString()} tokens` : ''
        return { kind: 'model', text: state === 'DONE' ? `Agent 完成一轮响应${tokenText}` : 'Agent 正在分析与生成' }
      }
      if (stepType === 'tool') {
        const toolInfo = antigravityStep.tool_info || {}
        const toolName = String(antigravityStep.tool_name || toolInfo.name || '工具')
        const parameters = toolInfo.parameters && typeof toolInfo.parameters === 'object'
          ? JSON.stringify(toolInfo.parameters).slice(0, 260)
          : ''
        if (state === 'ACTIVE') return { kind: 'tool', text: `正在调用 ${toolName}${parameters ? `\n${parameters}` : ''}` }
        if (state === 'ERROR') return { kind: 'error', text: `${toolName} 失败：${String(toolInfo?.error?.message || '执行失败')}` }
        const output = typeof toolInfo.output === 'string' ? toolInfo.output.trim() : ''
        return { kind: 'tool', text: `${toolName} 已完成${output ? `\n${output.slice(0, 500)}${output.length > 500 ? '…' : ''}` : ''}` }
      }
      return { kind: state === 'ERROR' ? 'error' : 'status', text: `${stepType || '步骤'} · ${state || '更新'}` }
    }
    const contentBlocks = Array.isArray(agentEvent?.message?.content) ? agentEvent.message.content : []
    const latestBlock = contentBlocks[contentBlocks.length - 1]
    if (latestBlock?.type === 'tool_use') return { kind: 'tool', text: `调用工具 ${latestBlock.name || ''}`.trim() }
    if (latestBlock?.type === 'thinking' && latestBlock.thinking) return { kind: 'model', text: String(latestBlock.thinking) }
    if (latestBlock?.type === 'text' && latestBlock.text) return { kind: 'stream', text: String(latestBlock.text) }
    const delta = agentEvent?.params?.delta || agentEvent?.event?.delta?.text || agentEvent?.delta || agentEvent?.text || agentEvent?.content?.text || agentEvent?.message?.text
    if (typeof delta === 'string' && delta) return { kind: 'stream', text: delta }
    if (typeof agentEvent?.response === 'string') return { kind: 'stream', text: agentEvent.response }
    if (agentEvent?.event === 'result' && typeof agentEvent?.result?.response === 'string' && agentEvent.result.response) return { kind: 'stream', text: agentEvent.result.response }
    if (agentEvent?.event === 'result' && agentEvent?.result?.status === 'SUCCESS') return { kind: 'status', text: 'Antigravity CLI 执行完成' }
    if (agentEvent?.event === 'result' && agentEvent?.result?.error) return { kind: 'error', text: String(agentEvent.result.error) }
    if (agentEvent?.type === 'result' && typeof agentEvent?.result === 'string') return { kind: 'stream', text: agentEvent.result }
    const label = agentEvent?.method || agentEvent?.type || agentEvent?.event
    if (!label) return null
    if (/tool|command|exec/i.test(String(label))) return { kind: 'tool', text: String(label) }
    if (/reason|think|model/i.test(String(label))) return { kind: 'model', text: String(label) }
    return { kind: 'status', text: String(label) }
  }
  if (update.action === 'model_call') return { kind: 'model', text: `调用模型 ${payload.model || step?.model || ''}`.trim() }
  if (update.action === 'model_response') return { kind: 'model', text: '模型返回响应' }
  if (update.action === 'tool_call') return { kind: 'tool', text: `调用工具 ${payload.name || ''}`.trim() }
  if (update.action === 'tool_result') return { kind: 'tool', text: `${payload.name || '工具'} 执行完成` }
  if (update.action === 'step_running') return { kind: 'status', text: `${step?.agentId || 'Agent'} 已开始执行` }
  if (update.action === 'step_progress') return { kind: 'status', text: step?.detail || '正在处理' }
  if (update.action === 'step_completed') return { kind: 'status', text: step?.resultSummary || step?.detail || '任务完成' }
  if (update.action === 'step_retrying') return { kind: 'error', text: step?.detail || '执行失败，正在重试' }
  if (update.action === 'step_failed' || update.action === 'blocked') return { kind: 'error', text: step?.detail || '任务执行失败' }
  if (update.action === 'cancelled') return { kind: 'error', text: '任务已取消' }
  return null
}

function runtimeStatusLabel(status: string): string {
  const labels: Record<string, string> = { pending: '等待', running: '运行中', completed: '完成', failed: '失败', blocked: '阻塞', cancelled: '取消', paused: '暂停' }
  return labels[status] || status
}

function RuntimeConsolePanel({ step, agentName, lines }: { step: RuntimeStep; agentName: string; lines: RuntimeLine[] }): React.JSX.Element {
  const outputRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const output = outputRef.current
    if (output) output.scrollTop = output.scrollHeight
  }, [lines])
  return <section className={`collab-cli-panel status-${step.status}`}>
    <header>
      <div className="agent-brand-icon"><AgentBrandIcon agentId={step.agentId || 'agentpet'} /></div>
      <span><strong>{agentName}</strong><small>{step.model || '默认模型'} · {step.title}</small></span>
      <em>{step.status === 'running' && <Loader2 className="spin" size={12} />}{runtimeStatusLabel(step.status)}</em>
    </header>
    <div ref={outputRef} className="collab-cli-output" role="log" aria-live="polite" aria-label={`${step.title} CLI 输出`}>
      {lines.length ? lines.map(line => <div className={`collab-cli-line kind-${line.kind}`} key={line.id}><time>{new Date(line.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><i>{line.kind === 'tool' ? 'tool' : line.kind === 'model' ? 'model' : line.kind === 'error' ? 'error' : '›'}</i><pre>{line.text}</pre></div>) : <div className="collab-cli-waiting"><Loader2 className="spin" size={16} />等待 Agent 输出…</div>}
    </div>
  </section>
}

function OrchestrationApprovalCard({ request, onRespond }: { request: any; onRespond: (approved: boolean, scope?: 'once' | 'turn') => void }): React.JSX.Element {
  const dangerous = /删除|高危|rm\b|del\b|remove-item|delete/i.test(`${request?.command || ''}\n${request?.warning || ''}`)
  return <section className={`collab-approval-card ${dangerous ? 'is-danger' : ''}`} aria-label="编排任务审批">
    <header><span><ShieldAlert size={17} /></span><div><small>当前节点等待审批</small><strong>是否允许执行这项操作？</strong></div><em>等待确认</em></header>
    <p>{request?.warning || '这项操作需要你确认后才会继续执行。'}</p>
    <pre>{request?.command || '内置工具调用'}</pre>
    {request?.execCwd && <div className="collab-approval-cwd"><span>目录</span><code>{request.execCwd}</code></div>}
    <footer>
      <button type="button" onClick={() => onRespond(false)}>拒绝</button>
      {request?.allowTurnScope !== false && <button type="button" onClick={() => onRespond(true, 'turn')}>本次协作允许</button>}
      <button className="primary" type="button" onClick={() => onRespond(true, 'once')}>允许一次</button>
    </footer>
  </section>
}

export function CollaborationComposer({
  sessionId, workspacePath: sessionWorkspacePath, llmConfig, initialGoal, initialRunId, permissionRequest, onRespondPermission, onWorkspaceSelected, onStarted, onClose, showToast
}: {
  sessionId: string
  workspacePath?: string
  llmConfig: any
  initialGoal: string
  initialRunId?: string
  permissionRequest?: any
  onRespondPermission?: (approved: boolean, scope?: 'once' | 'turn') => void
  onWorkspaceSelected: (workspacePath: string) => Promise<void>
  onStarted?: (title: string) => void
  onClose: () => void
  showToast: (message: string, type: any) => void
}): React.JSX.Element {
  const [mode, setMode] = React.useState<'auto' | 'manual'>('auto')
  const [goal, setGoal] = React.useState(initialGoal)
  const [title, setTitle] = React.useState('多 Agent 协作')
  const [workspacePath, setWorkspacePath] = React.useState(sessionWorkspacePath || '')
  const [agents, setAgents] = React.useState<AgentChoice[]>([])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNodeId, setSelectedNodeId] = React.useState<string>()
  const [models, setModels] = React.useState<Record<string, AgentModel[]>>({})
  const [allowedAgentIds, setAllowedAgentIds] = React.useState<string[]>([])
  const [loadingModels, setLoadingModels] = React.useState(false)
  const [planning, setPlanning] = React.useState(false)
  const [maxConcurrency, setMaxConcurrency] = React.useState(3)
  const [executionPhase, setExecutionPhase] = React.useState<'editing' | 'starting' | 'running' | 'finished'>(initialRunId ? 'starting' : 'editing')
  const [executionRunId, setExecutionRunId] = React.useState('')
  const [runtimeSnapshot, setRuntimeSnapshot] = React.useState<{ run?: any; steps: RuntimeStep[] }>({ steps: [] })
  const [runtimeLogs, setRuntimeLogs] = React.useState<Record<string, RuntimeLine[]>>({})
  const [pinnedRuntimeTaskId, setPinnedRuntimeTaskId] = React.useState<string | null>(null)
  const [showRuntimeGraph, setShowRuntimeGraph] = React.useState(false)
  const [selectedReadonlyStepId, setSelectedReadonlyStepId] = React.useState<string | null>(null)
  const [retryingFailed, setRetryingFailed] = React.useState(false)
  const workspaceOverriddenRef = React.useRef(false)
  const agentSelectionTouchedRef = React.useRef(false)
  const flowInstanceRef = React.useRef<ReactFlowInstance<Node<TaskNodeData>, Edge> | null>(null)
  const selectedNode = nodes.find(node => node.id === selectedNodeId)

  const fitGeneratedGraph = (): void => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void flowInstanceRef.current?.fitView({ padding: 0.25, maxZoom: 0.8, duration: 180 })
      })
    })
  }

  React.useEffect(() => {
    document.documentElement.classList.add('collab-takeover-active')
    return () => document.documentElement.classList.remove('collab-takeover-active')
  }, [])

  React.useEffect(() => {
    if (!workspaceOverriddenRef.current) setWorkspacePath(sessionWorkspacePath || '')
  }, [sessionWorkspacePath])

  React.useEffect(() => {
    if (!executionRunId) return
    return window.api.onTaskRunUpdated((update: any) => {
      if (update?.taskRunId !== executionRunId) return
      const steps = Array.isArray(update.steps) ? update.steps as RuntimeStep[] : []
      setRuntimeSnapshot({ run: update.run, steps })
      if (['completed', 'failed', 'blocked', 'cancelled'].includes(String(update.run?.status))) setExecutionPhase('finished')
      else setExecutionPhase('running')
      const stepId = String(update.taskStepId || '')
      if (!stepId) return
      const message = runtimeMessage(update, steps.find(step => step.id === stepId))
      if (!message) return
      setRuntimeLogs(current => {
        const lines = current[stepId] || []
        const previous = lines[lines.length - 1]
        const nextLine: RuntimeLine = { ...message, id: `${Date.now()}-${Math.random()}`, time: Date.now() }
        const nextLines = message.kind === 'stream' && previous?.kind === 'stream'
          ? [...lines.slice(0, -1), { ...previous, text: `${previous.text}${message.text}`, time: Date.now() }]
          : [...lines, nextLine]
        return { ...current, [stepId]: nextLines.slice(-400) }
      })
    })
  }, [executionRunId])

  React.useEffect(() => {
    if (!initialRunId) return
    let active = true
    void window.api.getTaskRun(initialRunId).then((snapshot: any) => {
      if (!active || !snapshot?.run) return
      const steps = Array.isArray(snapshot.steps) ? snapshot.steps : []
      const restoredAgents: AgentChoice[] = steps.map((step: any) => ({
        id: String(step.agentId || 'agentpet'), name: String(step.agentId || 'AgentPet'), description: '', protocol: 'restored', probe: { status: 'ready', installed: true }
      }))
      const graph = graphFromPlan({ title: snapshot.run.title, tasks: steps }, restoredAgents, snapshot.run.title || '')
      setExecutionRunId(initialRunId)
      setRuntimeSnapshot({ run: snapshot.run, steps })
      setTitle(snapshot.run.title || '多 Agent 协作')
      setWorkspacePath(snapshot.run.workspacePath || sessionWorkspacePath || '')
      setNodes(graph.nodes)
      setEdges(graph.edges)
      setExecutionPhase(['completed', 'failed', 'blocked', 'cancelled'].includes(String(snapshot.run.status)) ? 'finished' : 'running')
    }).catch((error: any) => showToast(error?.message || '读取协作详情失败', 'error'))
    return () => { active = false }
  }, [initialRunId, sessionWorkspacePath, setEdges, setNodes, showToast])

  React.useEffect(() => {
    if (permissionRequest?.taskStepId) {
      setPinnedRuntimeTaskId(String(permissionRequest.taskStepId))
      setShowRuntimeGraph(false)
    }
  }, [permissionRequest?.taskStepId])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  React.useEffect(() => {
    let active = true
    void window.api.listAgents().then(async (items: AgentChoice[]) => {
      if (!active) return
      setAgents(items)
      const candidates = items.filter(item => item.protocol !== 'internal' && item.probe?.installed !== false)
      const probes = await Promise.all(candidates.map(async item => {
        try { return await window.api.probeAgent(item.id, workspacePath || sessionWorkspacePath) } catch { return null }
      }))
      if (!active) return
      const byId = new Map(candidates.map((item, index) => [item.id, probes[index]]))
      const nextAgents = items.map(item => byId.has(item.id) ? { ...item, probe: byId.get(item.id) } : item)
      setAgents(nextAgents)
      if (!agentSelectionTouchedRef.current) setAllowedAgentIds(nextAgents.filter(canAutomate).map(item => item.id))
    }).catch((error: any) => showToast(error?.message || '读取 Agent 列表失败', 'error'))
    return () => { active = false }
  }, [sessionWorkspacePath, showToast])

  React.useEffect(() => {
    if (!selectedNode || models[selectedNode.data.agentId]) return
    const agentId = selectedNode.data.agentId
    setLoadingModels(true)
    void window.api.listAgentModels(agentId, workspacePath || sessionWorkspacePath, llmConfig?.model)
      .then((items: AgentModel[]) => setModels(current => ({ ...current, [agentId]: items })))
      .catch((error: any) => showToast(error?.message || '读取模型失败', 'error'))
      .finally(() => setLoadingModels(false))
  }, [llmConfig?.model, models, selectedNode, sessionWorkspacePath, showToast, workspacePath])

  const updateSelected = (patch: Partial<TaskNodeData>): void => {
    if (!selectedNodeId) return
    setNodes(current => current.map(node => node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node))
  }

  const generatePlan = async (): Promise<void> => {
    if (!goal.trim()) { showToast('请先填写协作目标', 'info'); return }
    const allowedAgents = agents.filter(agent => allowedAgentIds.includes(agent.id) && canAutomate(agent))
    if (!allowedAgents.length) { showToast('请至少选择一个可用 Agent', 'info'); return }
    setPlanning(true)
    try {
      const available = allowedAgents.map(agent => ({ id: agent.id, name: agent.name, protocol: agent.protocol }))
      const response = await window.api.callLLM(
        { ...llmConfig, temperature: 0.2 },
        [{ role: 'user', content: [
          '你是多 Agent 编排器。请生成最小、清晰、可直接执行的 DAG，只输出 JSON，不要 Markdown。',
          `目标：${goal.trim()}`,
          `可用 Agent：${JSON.stringify(available)}`,
          '格式：{"title":"任务组名称","tasks":[{"id":"短英文id","title":"任务名","prompt":"完整自包含任务说明与验收标准","agentId":"可用Agent id","dependencies":["前置任务id"]}]}。',
          '编排规则：',
          '1. 默认只生成 2～4 个任务，绝对不超过 5 个；能由一个节点完整承担的职责不要继续拆分。',
          '2. 按完整交付职责拆分，例如“界面完整实现”“核心逻辑完整实现”“集成验收”，不要按按钮、组件、文件或细小功能拆节点。',
          '3. 不要创建纯分析、纯规划、进度汇报、结果汇总等没有直接产物的节点。',
          '4. “可用 Agent”就是用户明确勾选的参与 Agent，必须全部使用：每个列出的 Agent id 至少分配一个节点，不得遗漏，也不得使用列表外的 Agent。',
          '5. 只有真正可以独立修改不同范围的任务才并行；可能修改同一文件的任务必须合并或建立依赖。',
          '6. 有多个实现节点时只增加一个最终“集成验收”节点；简单目标使用“完整实现 → 验收与修复”两步即可。',
          '7. 每个 Prompt 必须包含工作范围、预期产物和验收标准，但保持简洁，禁止重复总体目标的长篇说明。'
        ].join('\n') }],
        workspacePath || sessionWorkspacePath
      )
      const jsonText = String(response).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      const parsedPlan = JSON.parse(jsonText)
      const plannedTasks = (Array.isArray(parsedPlan?.tasks) ? parsedPlan.tasks : []).slice(0, 5)
      const plannedAgentIds = new Set(plannedTasks.map((task: any) => String(task?.agentId || '')))
      const missingAgents = allowedAgents.filter(agent => !plannedAgentIds.has(agent.id))
      if (missingAgents.length > 0) throw new Error(`规划遗漏参与 Agent：${missingAgents.map(agent => agent.name).join('、')}`)
      const allowedAgentIdSet = new Set(allowedAgents.map(agent => agent.id))
      if (plannedTasks.some((task: any) => !allowedAgentIdSet.has(String(task?.agentId || '')))) throw new Error('规划使用了未参与的 Agent')
      const graph = graphFromPlan(parsedPlan, allowedAgents, goal.trim())
      setNodes(graph.nodes); setEdges(graph.edges); setSelectedNodeId(undefined); setTitle(graph.title); fitGeneratedGraph()
    } catch (error) {
      const graph = buildAutomaticGraph(goal.trim(), allowedAgents)
      setNodes(graph.nodes); setEdges(graph.edges); setSelectedNodeId(undefined); setTitle(goal.trim().slice(0, 36)); fitGeneratedGraph()
      showToast(`智能规划未完成，已生成可编辑的默认流程：${error instanceof Error ? error.message : String(error)}`, 'info')
    } finally {
      setPlanning(false)
    }
  }

  const addTask = (): void => {
    const id = `task-${Date.now()}`
    const agent = chooseAgent(agents, ['agentpet'])
    setNodes(current => [...current, taskNode(id, `新任务 ${current.length + 1}`, '', agent, 120 + (current.length % 3) * 260, 100 + Math.floor(current.length / 3) * 190)])
    setSelectedNodeId(id)
  }

  const deleteSelected = (): void => {
    if (!selectedNodeId) return
    setNodes(current => current.filter(node => node.id !== selectedNodeId))
    setEdges(current => current.filter(edge => edge.source !== selectedNodeId && edge.target !== selectedNodeId))
    setSelectedNodeId(undefined)
  }

  const selectWorkspace = async (): Promise<void> => {
    try {
      const selected = await window.api.selectDirectory({ title: '选择并绑定当前会话的工作文件夹' })
      if (selected) {
        await onWorkspaceSelected(selected)
        workspaceOverriddenRef.current = true
        setWorkspacePath(selected)
        showToast('当前会话已绑定工作文件夹', 'success')
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '绑定工作文件夹失败', 'error')
    }
  }

  const start = async (): Promise<void> => {
    const boundWorkspacePath = workspacePath.trim()
    if (!boundWorkspacePath) { showToast('开始协作前，请先为当前会话绑定工作文件夹', 'info'); return }
    if (!nodes.length) { showToast('请先生成流程或添加任务节点', 'info'); return }
    if (hasCycle(nodes, edges)) { showToast('流程中存在循环依赖，请删除形成环路的连线', 'error'); return }
    const tasks = nodes.map(node => ({
      id: node.id, title: node.data.title.trim(), prompt: node.data.prompt.trim(), agentId: node.data.agentId,
      model: node.data.model && node.data.model !== 'default' ? node.data.model : undefined,
      dependencies: edges.filter(edge => edge.target === node.id).map(edge => edge.source)
    }))
    if (tasks.some(task => !task.title || !task.prompt)) { showToast('每个节点都需要任务名称和 Prompt', 'info'); return }
    const unavailable = tasks.find(task => {
      const agent = agents.find(item => item.id === task.agentId)
      return agent && !canAutomate(agent)
    })
    if (unavailable) { showToast(`${agents.find(item => item.id === unavailable.agentId)?.name || unavailable.agentId} 不是当前可自动执行的 CLI Agent`, 'error'); return }
    const collaborationTitle = title.trim() || goal.trim() || tasks[0]?.title || '多 Agent 协作'
    setExecutionPhase('starting')
    setPinnedRuntimeTaskId(null)
    setRuntimeLogs(Object.fromEntries(tasks.map(task => [task.id, [{ id: `queued-${task.id}`, time: Date.now(), kind: 'status' as const, text: '任务已进入调度队列' }] ])))
    setRuntimeSnapshot({ steps: tasks.map(task => ({ ...task, status: 'pending' })) })
    try {
      const result = await window.api.startAgentCollaboration({ sessionId, workspacePath: boundWorkspacePath, title: collaborationTitle, tasks, maxConcurrency })
      const taskRunId = String(result?.taskRunId || '')
      if (!taskRunId) throw new Error('任务启动后未返回运行 ID')
      onStarted?.(collaborationTitle)
      setExecutionRunId(taskRunId)
      const snapshot = await window.api.getTaskRun(taskRunId)
      if (snapshot) {
        setRuntimeSnapshot({ run: snapshot.run, steps: snapshot.steps || [] })
        setExecutionPhase(['completed', 'failed', 'blocked', 'cancelled'].includes(String(snapshot.run?.status)) ? 'finished' : 'running')
      } else {
        setExecutionPhase('running')
      }
      showToast(`协作已启动，最多并行 ${maxConcurrency} 个任务`, 'success')
    } catch (error) {
      setExecutionPhase('editing')
      showToast(error instanceof Error ? error.message : '协作任务启动失败', 'error')
    }
  }

  const automationAgents = agents.filter(canAutomate)
  const toggleAllowedAgent = (agentId: string): void => {
    agentSelectionTouchedRef.current = true
    setAllowedAgentIds(current => current.includes(agentId) ? current.filter(id => id !== agentId) : [...current, agentId])
  }
  const changeAgent = (agentId: string): void => {
    const agent = agents.find(item => item.id === agentId)
    if (agent) updateSelected({ agentId, agentName: agent.name, model: undefined })
  }
  const runtimeSteps: RuntimeStep[] = runtimeSnapshot.steps.length ? runtimeSnapshot.steps : nodes.map(node => ({
    id: node.id,
    title: node.data.title,
    status: 'pending',
    agentId: node.data.agentId,
    model: node.data.model,
    prompt: node.data.prompt,
    dependencies: edges.filter(edge => edge.target === node.id).map(edge => edge.source)
  }))
  const runningSteps = runtimeSteps.filter(step => step.status === 'running')
  const displayedRuntimeSteps = pinnedRuntimeTaskId
    ? runtimeSteps.filter(step => step.id === pinnedRuntimeTaskId)
    : runningSteps.length ? runningSteps : runtimeSteps
  const runtimeFlowPlan: TaskPlan = {
    runId: executionRunId,
    title,
    steps: runtimeSteps.map(step => ({
      ...step,
      status: step.status === 'running' ? 'in_progress' : step.status === 'completed' ? 'completed' : ['failed', 'blocked', 'cancelled'].includes(step.status) ? 'blocked' : 'pending'
    }))
  }
  const failedRuntimeSteps = runtimeSteps.filter(step => step.status === 'failed')
  const runStatus = String(runtimeSnapshot.run?.status || '')
  const isReadonlyDetails = Boolean(initialRunId && ['completed', 'failed', 'blocked', 'cancelled'].includes(runStatus))
  const isCompletedDetails = Boolean(isReadonlyDetails && runStatus === 'completed')
  const selectedReadonlyStep = runtimeSteps.find(step => step.id === selectedReadonlyStepId)

  const retryFailedSteps = async (taskStepId?: string): Promise<void> => {
    if (!executionRunId || retryingFailed) return
    setRetryingFailed(true)
    try {
      if (taskStepId) await window.api.retryTaskStep(executionRunId, taskStepId)
      else await window.api.retryFailedTaskSteps(executionRunId)
      const snapshot = await window.api.getTaskRun(executionRunId)
      if (snapshot?.run) setRuntimeSnapshot({ run: snapshot.run, steps: snapshot.steps || [] })
      setSelectedReadonlyStepId(null)
      setShowRuntimeGraph(false)
      setExecutionPhase('running')
      showToast(taskStepId ? '节点已重新进入执行队列' : `${failedRuntimeSteps.length} 个失败节点已重新进入执行队列`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重新执行失败，请稍后重试', 'error')
    } finally {
      setRetryingFailed(false)
    }
  }

  return (
    <div className="collab-overlay">
      <section className="collab-drawer collab-workbench" role="dialog" aria-modal="true" aria-labelledby="collab-title">
        <header className="collab-header">
          <button className="collab-back-button" type="button" onClick={onClose} aria-label="返回聊天">
            <ArrowLeft size={17} />
            <span>返回</span>
          </button>
          <h2 id="collab-title">{isReadonlyDetails ? '协作详情' : '多 Agent 编排'}</h2>
        </header>

        <div className={`collab-workbench-body ${isReadonlyDetails ? 'is-readonly-details' : ''}`}>
          {isReadonlyDetails ? <main className="collab-readonly-details">
            <header className={`collab-readonly-summary ${isCompletedDetails ? 'is-completed' : 'is-recoverable'}`}>
              <span>{isCompletedDetails ? <CheckCircle2 size={17} /> : <ShieldAlert size={17} />}<span><small>{isCompletedDetails ? '协作已完成 · 只读' : '协作未完成 · 可恢复'}</small><strong>{title}</strong></span></span>
              <em>{runtimeSteps.filter(step => step.status === 'completed').length}/{runtimeSteps.length} 节点完成</em>
              {failedRuntimeSteps.length > 0 && <button className="collab-retry-failed" type="button" disabled={retryingFailed} aria-busy={retryingFailed} onClick={() => { void retryFailedSteps() }}>{retryingFailed ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}<span>重试失败节点 ({failedRuntimeSteps.length})</span></button>}
            </header>
            <div className={`collab-readonly-stage ${selectedReadonlyStep ? 'has-detail' : ''}`}>
              <div className="collab-readonly-graph">
                <TaskDagGraph plan={runtimeFlowPlan} selectedStepId={selectedReadonlyStepId || undefined} onStepClick={step => setSelectedReadonlyStepId(step.id)} />
                {!selectedReadonlyStep && <p>点击任一节点查看执行详情</p>}
              </div>
              {selectedReadonlyStep && <aside className="collab-readonly-node-detail">
                <header><span className="agent-brand-icon"><AgentBrandIcon agentId={selectedReadonlyStep.agentId || 'agentpet'} /></span><span><small>节点详情 · {selectedReadonlyStep.status === 'failed' ? '可重试' : '只读'}</small><strong>{selectedReadonlyStep.title}</strong></span><div className="collab-readonly-node-actions">{selectedReadonlyStep.status === 'failed' && <button className="retry" type="button" disabled={retryingFailed} aria-busy={retryingFailed} onClick={() => { void retryFailedSteps(selectedReadonlyStep.id) }}>{retryingFailed ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />}重试</button>}<button type="button" onClick={() => setSelectedReadonlyStepId(null)}>关闭</button></div></header>
                <dl>
                  <div><dt>Agent</dt><dd>{agents.find(agent => agent.id === selectedReadonlyStep.agentId)?.name || selectedReadonlyStep.agentId || 'AgentPet'}</dd></div>
                  <div><dt>模型</dt><dd>{selectedReadonlyStep.model || '默认模型'}</dd></div>
                  <div><dt>状态</dt><dd>{runtimeStatusLabel(selectedReadonlyStep.status)}</dd></div>
                  <div><dt>依赖</dt><dd>{selectedReadonlyStep.dependencies?.length ? selectedReadonlyStep.dependencies.join('、') : '无'}</dd></div>
                </dl>
                {selectedReadonlyStep.prompt && <section><h3>Prompt</h3><pre>{selectedReadonlyStep.prompt}</pre></section>}
                {selectedReadonlyStep.resultSummary && (
                  <section className="collab-node-result-section">
                    <h3>节点结果</h3>
                    <div className="collab-node-result-content">
                      {renderAdvancedMessage(cleanResultSummary(selectedReadonlyStep.resultSummary))}
                    </div>
                  </section>
                )}
                <CollaborationArtifactCards paths={selectedReadonlyStep.artifactPaths || []} workspacePath={runtimeSnapshot.run?.workspacePath || workspacePath} />
              </aside>}
            </div>
          </main> : <>
          <aside className="collab-inspector">
            <div className="collab-mode-switch">
              <button className={mode === 'auto' ? 'active' : ''} type="button" onClick={() => { setMode('auto'); setSelectedNodeId(undefined) }}><Sparkles size={15} />自动</button>
              <button className={mode === 'manual' ? 'active' : ''} type="button" onClick={() => setMode('manual')}><Network size={15} />手动</button>
            </div>
            {mode === 'auto' && <div className="collab-auto-builder">
              <label className="collab-field"><span>协作目标</span><textarea autoFocus rows={6} value={goal} onChange={event => setGoal(event.target.value)} placeholder="描述最终目标、技术约束和验收标准…" /></label>
              <fieldset className="collab-agent-limiter">
                <legend>参与 Agent <small>仅用于自动编排</small></legend>
                <div>
                  {automationAgents.map(agent => {
                    const available = canAutomate(agent)
                    const selected = allowedAgentIds.includes(agent.id)
                    return <button
                      key={agent.id}
                      className={selected ? 'selected' : ''}
                      type="button"
                      disabled={!available}
                      aria-pressed={selected}
                      title={available ? `${selected ? '取消' : '允许'}自动编排使用 ${agent.name}` : `${agent.name} 当前不可自动执行`}
                      onClick={() => toggleAllowedAgent(agent.id)}
                    >
                      <span className="agent-brand-icon"><AgentBrandIcon agentId={agent.id} /></span>
                      <span><strong>{agent.name}</strong><small>{available ? selected ? '参与' : '不参与' : STATUS_LABEL[agent.probe?.status || 'missing']}</small></span>
                      <i>{selected ? '✓' : ''}</i>
                    </button>
                  })}
                </div>
              </fieldset>
              <button className="collab-generate" type="button" onClick={() => { void generatePlan() }} disabled={planning || !allowedAgentIds.some(id => agents.some(agent => agent.id === id && canAutomate(agent)))}><Sparkles size={15} />{planning ? '正在规划…' : '生成协作流程'}</button>
            </div>}
            {mode === 'manual' && <><div className="collab-inspector-divider"><span>{selectedNode ? '节点配置' : '流程设置'}</span></div>
            {selectedNode ? <div className="collab-node-form">
              <label className="collab-field compact"><span>任务名称</span><input value={selectedNode.data.title} onChange={event => updateSelected({ title: event.target.value })} /></label>
              <label className="collab-field compact"><span>执行 Agent</span><div className="collab-select-with-icon"><AgentBrandIcon agentId={selectedNode.data.agentId} /><select value={selectedNode.data.agentId} onChange={event => changeAgent(event.target.value)}>{automationAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {STATUS_LABEL[agent.id === 'agentpet' ? 'ready' : agent.probe?.status || 'unchecked']}</option>)}</select></div></label>
              <label className="collab-field compact"><span>模型 <small>{loadingModels ? '检测中…' : '来自本地 CLI'}</small></span><select value={selectedNode.data.model || 'default'} onChange={event => updateSelected({ model: event.target.value })}>{(models[selectedNode.data.agentId] || [{ id: 'default', name: '默认模型', source: 'configured' }]).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
              <label className="collab-field"><span>Prompt</span><textarea rows={8} value={selectedNode.data.prompt} onChange={event => updateSelected({ prompt: event.target.value })} placeholder="写清任务边界、输入、交付物和验收标准…" /></label>
              <button className="collab-delete-node" type="button" onClick={deleteSelected}><Trash2 size={14} />删除节点</button>
            </div> : <p className="collab-empty-tip">选择画布节点后配置 Agent、模型和 Prompt。拖动节点两侧端点即可建立依赖。</p>}</>}
          </aside>

          <main className="collab-canvas-shell">
            {executionPhase === 'editing' ? <>
              <div className="collab-canvas-toolbar">
                <label>任务名称<input value={title} onChange={event => setTitle(event.target.value)} /></label>
                {mode === 'manual' && <button type="button" onClick={addTask}><Plus size={15} />添加节点</button>}
              </div>
              <div className="collab-canvas">
                {!nodes.length && <div className="collab-canvas-empty"><GitBranch size={34} /><strong>{mode === 'auto' ? '填写目标并生成流程' : '添加第一个任务节点'}</strong><span>连线表示依赖，无依赖节点将并行执行</span></div>}
                <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                  onConnect={(connection: Connection) => setEdges(current => addEdge({ ...connection, animated: true }, current))}
                  onInit={instance => { flowInstanceRef.current = instance }}
                  onNodeClick={(_, node) => { if (mode === 'manual') setSelectedNodeId(node.id) }} onPaneClick={() => setSelectedNodeId(undefined)}
                  nodesDraggable={mode === 'manual'} nodesConnectable={mode === 'manual'} elementsSelectable={mode === 'manual'}
                  fitView fitViewOptions={{ padding: 0.25, maxZoom: 0.8 }} minZoom={0.35} maxZoom={1.6} deleteKeyCode={mode === 'manual' ? 'Delete' : null}>
                  <Background gap={24} size={1.5} color="var(--border-color, #e2e8f0)" />
                  <Controls className="collab-controls" />
                </ReactFlow>
              </div>
            </> : <div className="collab-runtime">
              <div className="collab-runtime-toolbar">
                <div>
                  <TerminalSquare size={17} />
                  <span><strong>{title}</strong><small>{executionPhase === 'starting' ? '正在建立 CLI 会话…' : executionPhase === 'finished' ? `执行${runtimeStatusLabel(String(runtimeSnapshot.run?.status || 'completed'))}` : `${runningSteps.length} 个节点正在执行`}</small></span>
                </div>
                <button className={`collab-runtime-graph-toggle ${showRuntimeGraph ? 'active' : ''}`} type="button" onClick={() => { setShowRuntimeGraph(current => !current); setPinnedRuntimeTaskId(null) }}>
                  {showRuntimeGraph ? <TerminalSquare size={13} /> : <Network size={13} />}
                  <span>{showRuntimeGraph ? '返回实时输出' : '查看实时流程图'}</span>
                </button>
              </div>
              {permissionRequest && onRespondPermission && <OrchestrationApprovalCard request={permissionRequest} onRespond={onRespondPermission} />}
              {showRuntimeGraph ? <div className="collab-runtime-graph"><TaskDagGraph plan={runtimeFlowPlan} /></div> : <div className={`collab-runtime-grid ${displayedRuntimeSteps.length > 1 ? 'parallel' : 'single'}`}>
                {displayedRuntimeSteps.map(step => {
                  const agent = agents.find(item => item.id === step.agentId)
                  const lines = runtimeLogs[step.id] || []
                  return <RuntimeConsolePanel key={step.id} step={step} agentName={agent?.name || step.agentId || 'AgentPet'} lines={lines} />
                })}
              </div>}
            </div>}
          </main>
          </>}
        </div>

        {!isCompletedDetails && <footer className="collab-footer collab-workbench-footer">
          {executionPhase === 'editing' ? <>
            <button className="collab-workspace-button" type="button" onClick={selectWorkspace} title={workspacePath || '当前会话未绑定工作文件夹'}><FolderOpen size={15} /><span>{workspacePath ? `当前会话：${workspacePath}` : '当前会话未绑定文件夹 · 点击选择'}</span></button>
            <div className="collab-concurrency"><label>并发上限<select value={maxConcurrency} onChange={event => setMaxConcurrency(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map(value => <option key={value}>{value}</option>)}</select></label></div>
            <span className="collab-runtime-note"><Bot size={14} />依赖调度由 AgentPet 执行</span>
            <button className="collab-start" type="button" onClick={() => { void start() }}><Play size={15} fill="currentColor" />开始协作</button>
          </> : <>
            <span className="collab-runtime-note"><TerminalSquare size={14} />运行记录同时写入执行轨迹</span>
            {executionPhase === 'finished' && failedRuntimeSteps.length > 0 && <button className="collab-retry-failed" type="button" disabled={retryingFailed} aria-busy={retryingFailed} onClick={() => { void retryFailedSteps() }}>{retryingFailed ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}重新执行失败节点</button>}
            {executionPhase === 'finished' && <button className="collab-return-flow" type="button" onClick={() => setExecutionPhase('editing')}><GitBranch size={14} />返回流程图</button>}
            <button className="collab-start" type="button" onClick={onClose}>{executionPhase === 'finished' ? '完成' : '在后台运行'}</button>
          </>}
        </footer>}
      </section>
    </div>
  )
}

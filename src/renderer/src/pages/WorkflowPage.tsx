import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock3,
  FolderOpen,
  GitBranch,
  History,
  Loader2,
  MessageSquarePlus,
  Monitor,
  Network,
  Play,
  Plus,
  Search,
  Sparkles,
  X
} from 'lucide-react'
import type { WorkflowDefinition } from '../../../preload/workflow-types'
import { CollaborationComposer } from '../components/CollaborationComposer'
import type { AppStore } from '../hooks/useAppStore'
import { RpaPage } from '../rpa/RpaPage'
import '../assets/workflow.css'

type WorkflowView = 'library' | 'runs' | 'rpa'
type TaskRunSummary = {
  id: string
  title: string
  goal?: string
  status: string
  createdAt: number
}
type TaskStepSummary = { id: string }
type TaskRunListItem = { run: TaskRunSummary; steps: TaskStepSummary[] }
type TaskRunUpdate = {
  action?: string
  taskRunId: string
  run?: TaskRunSummary
  steps?: TaskStepSummary[]
}

const RUN_STATUS: Record<string, string> = {
  pending: '等待中',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  blocked: '需处理',
  cancelled: '已取消'
}

type WorkflowStarterTemplate = {
  key: string
  badge: string
  title: string
  summary: string
  draft: WorkflowDefinition
}

const STARTER_TEMPLATES: WorkflowStarterTemplate[] = [
  {
    key: 'code-audit-verify',
    badge: '工程研发',
    title: '代码审查与自愈验证流水线',
    summary: '先静态扫描改动风险，再根据分支条件自动运行类型检查或回归修复。',
    draft: {
      id: '',
      title: '代码审查与自愈验证流水线',
      goal: '分析当前工作区代码改动，定位潜在边界问题，并在检查通过后输出验证报告。',
      workspacePath: '',
      maxConcurrency: 2,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: 'step-scan',
          type: 'task',
          position: { x: 80, y: 140 },
          data: {
            title: '差异与风险扫描',
            prompt: '检查最近修改的文件与上下文，梳理潜在类型风险、未处理异常及边界条件。',
            agentId: 'agentpet',
            agentName: 'AgentPet',
            control: { kind: 'agent' }
          }
        },
        {
          id: 'step-gate',
          type: 'task',
          position: { x: 390, y: 140 },
          data: {
            title: '判断是否存在阻断项',
            prompt: '根据扫描结果判断是否存在需要修复的错误。',
            agentId: 'agentpet',
            agentName: '条件判断',
            control: {
              kind: 'condition',
              condition: {
                source: 'step-scan',
                path: 'summary',
                operator: 'contains',
                value: '通过'
              },
              branches: {}
            }
          }
        },
        {
          id: 'step-verify',
          type: 'task',
          position: { x: 700, y: 140 },
          data: {
            title: '执行类型检查与汇总',
            prompt: '运行项目的 typecheck 验证改动，输出最终审查结论与测试凭据。',
            agentId: 'agentpet',
            agentName: 'AgentPet',
            control: { kind: 'agent' }
          }
        }
      ],
      edges: [
        { id: 'edge-scan-gate', source: 'step-scan', target: 'step-gate' },
        { id: 'edge-gate-verify', source: 'step-gate', target: 'step-verify', sourceHandle: 'true' }
      ]
    }
  },
  {
    key: 'research-briefing',
    badge: '调研文档',
    title: '多源信息检索与结构化简报',
    summary: '并行检索技术文档与本地资料，交叉核对事实后生成可直接交付的报告。',
    draft: {
      id: '',
      title: '多源信息检索与结构化简报',
      goal: '针对指定主题并行收集资料，去重核验后输出结构化结论文档。',
      workspacePath: '',
      maxConcurrency: 3,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: 'step-collect',
          type: 'task',
          position: { x: 90, y: 140 },
          data: {
            title: '关键资料检索',
            prompt: '围绕目标主题检索相关技术方案、核心指标与关键来源。',
            agentId: 'agentpet',
            agentName: 'AgentPet',
            control: { kind: 'agent' }
          }
        },
        {
          id: 'step-synthesize',
          type: 'task',
          position: { x: 430, y: 140 },
          data: {
            title: '交叉对比与提炼',
            prompt: '归纳各方方案优劣、适用场景与关键差异，剔除无依据的推断。',
            agentId: 'agentpet',
            agentName: 'AgentPet',
            control: { kind: 'agent' }
          }
        },
        {
          id: 'step-report',
          type: 'task',
          position: { x: 760, y: 140 },
          data: {
            title: '生成结构化简报',
            prompt: '整理为层次清晰的 Markdown 简报，附上行动建议与参考索引。',
            agentId: 'agentpet',
            agentName: 'AgentPet',
            control: { kind: 'agent' }
          }
        }
      ],
      edges: [
        { id: 'edge-collect-synth', source: 'step-collect', target: 'step-synthesize' },
        { id: 'edge-synth-report', source: 'step-synthesize', target: 'step-report' }
      ]
    }
  },
  {
    key: 'desktop-rpa-handoff',
    badge: '桌面协同',
    title: '桌面自动化采集与智能归档',
    summary: '结合桌面 RPA 动作与 Agent 解析能力，把重复的跨软件操作沉淀为固定工序。',
    draft: {
      id: '',
      title: '桌面自动化采集与智能归档',
      goal: '执行桌面录制流程获取界面数据，交由 Agent 清洗并归档到本地工作区。',
      workspacePath: '',
      maxConcurrency: 2,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: 'step-rpa-run',
          type: 'task',
          position: { x: 100, y: 140 },
          data: {
            title: '桌面操作执行',
            prompt: '运行指定的桌面自动化录制动作，完成页面打开与数据提取。',
            agentId: 'agentpet',
            agentName: 'RPA 节点',
            control: { kind: 'rpa' }
          }
        },
        {
          id: 'step-parse-archive',
          type: 'task',
          position: { x: 450, y: 140 },
          data: {
            title: '数据清洗与本地归档',
            prompt: '解析上一步采集的结果，按统一格式整理并写入工作区归档文件。',
            agentId: 'agentpet',
            agentName: 'AgentPet',
            control: { kind: 'agent' }
          }
        }
      ],
      edges: [{ id: 'edge-rpa-parse', source: 'step-rpa-run', target: 'step-parse-archive' }]
    }
  }
]

export function WorkflowPage({ store }: { store: AppStore }): React.JSX.Element {
  const [view, setView] = useState<WorkflowView>('library')
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [runs, setRuns] = useState<TaskRunListItem[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<WorkflowDefinition | 'new' | null>(null)
  const [runId, setRunId] = useState('')
  const [startingId, setStartingId] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [saved, history] = await Promise.all([
        window.api.listWorkflows(),
        window.api.listTaskRuns()
      ])
      setWorkflows(saved || [])
      setRuns(history || [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取工作流失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    document.title = '工作流 · AgentPet'
    queueMicrotask(() => void refresh())
  }, [refresh])

  useEffect(
    () =>
      window.api.onTaskRunUpdated((update: TaskRunUpdate) => {
        if (update.action === 'deleted') {
          setRuns((current) => current.filter((item) => item.run.id !== update.taskRunId))
          return
        }
        if (!update.run) return
        const run = update.run
        setRuns((current) => [
          { run, steps: update.steps || [] },
          ...current.filter((item) => item.run.id !== update.taskRunId)
        ])
      }),
    []
  )

  const needle = query.trim().toLocaleLowerCase()
  const visibleWorkflows = useMemo(
    () =>
      workflows.filter((item) => `${item.title} ${item.goal}`.toLocaleLowerCase().includes(needle)),
    [workflows, needle]
  )
  const visibleRuns = useMemo(
    () =>
      runs.filter((item) =>
        `${item.run?.title || ''} ${item.run?.goal || ''}`.toLocaleLowerCase().includes(needle)
      ),
    [runs, needle]
  )

  const closeEditor = (): void => {
    setEditor(null)
    setRunId('')
    void refresh()
  }

  const startWorkflow = async (workflow: WorkflowDefinition): Promise<void> => {
    if (startingId) return
    setStartingId(workflow.id)
    try {
      const result = await window.api.runWorkflow(workflow.id, store.activeSessionId)
      setRunId(result.taskRunId)
      store.showToast('工作流已开始执行', 'success')
    } catch (cause) {
      store.showToast(cause instanceof Error ? cause.message : '工作流启动失败', 'error')
    } finally {
      setStartingId('')
    }
  }

  if (editor || runId) {
    return (
      <WorkflowEditor
        store={store}
        editor={editor}
        runId={runId}
        onSaved={(saved) =>
          setWorkflows((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
        }
        onClose={closeEditor}
      />
    )
  }

  const searchableCount = view === 'library' ? workflows.length : runs.length

  return (
    <div className={`workflow-page ${view === 'rpa' ? 'workflow-page-rpa' : ''}`}>
      {view !== 'rpa' && (
        <div className="workflow-header-shell">
          <header className="workflow-hero">
            <div className="workflow-hero-copy">
              <span className="workflow-eyebrow">
                <Network size={13} />
                <span>工作流中心</span>
              </span>
              <h1>把协作，变成流程。</h1>
              <p>编排 Agent、条件判断与桌面操作，让每一次复杂执行都有迹可循。</p>
            </div>
            <div className="workflow-hero-actions">
              <button
                type="button"
                className="workflow-button"
                onClick={() => {
                  store.setAgentSubTab('cron')
                  store.setActiveTab('agent')
                }}
              >
                <Clock3 size={15} />
                定时任务
              </button>
              <button
                type="button"
                className="workflow-button primary"
                onClick={() => setEditor('new')}
              >
                <Plus size={16} />
                新建工作流
              </button>
            </div>
          </header>

          <nav className="workflow-nav" aria-label="工作流视图">
            <div className="workflow-tabs" role="tablist">
              {(
                [
                  ['library', '流程库', Network, workflows.length],
                  ['runs', '运行记录', History, runs.length],
                  ['rpa', '自动化录制', Monitor, null]
                ] as const
              ).map(([id, label, Icon, count]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === id}
                  key={id}
                  className={view === id ? 'selected' : ''}
                  onClick={() => {
                    setView(id)
                    setQuery('')
                  }}
                >
                  <Icon size={15} />
                  {label}
                  {count !== null && (
                    <span className={count > 0 ? 'has-items' : 'is-zero'}>{count}</span>
                  )}
                </button>
              ))}
            </div>
            {(searchableCount > 0 || Boolean(query)) && (
              <div className="workflow-search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  aria-label={view === 'library' ? '搜索工作流' : '搜索运行记录'}
                  placeholder={view === 'library' ? '搜索流程名称或目标…' : '搜索运行记录…'}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button
                    type="button"
                    aria-label="清除搜索"
                    onClick={() => {
                      setQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            )}
          </nav>
        </div>
      )}

      {view === 'rpa' ? (
        <section className="workflow-rpa">
          <RpaPage onExit={() => setView('library')} />
        </section>
      ) : (
        <main className="workflow-content">
          <div className="workflow-content-inner">
            {loading ? (
              <WorkflowSkeleton />
            ) : error ? (
              <Empty
                title="工作流暂时无法读取"
                text={error}
                action={
                  <button type="button" className="workflow-button" onClick={() => void refresh()}>
                    重新加载
                  </button>
                }
              />
            ) : view === 'library' ? (
              <Library
                workflows={visibleWorkflows}
                hasSaved={workflows.length > 0}
                startingId={startingId}
                onOpen={setEditor}
                onCreate={() => setEditor('new')}
                onGoChat={() => store.setActiveTab('chat')}
                onClearSearch={() => setQuery('')}
                onRun={startWorkflow}
              />
            ) : (
              <RunHistory
                runs={visibleRuns}
                hasRuns={runs.length > 0}
                onOpen={setRunId}
                onCreate={() => setEditor('new')}
                onClearSearch={() => setQuery('')}
              />
            )}
          </div>
        </main>
      )}
    </div>
  )
}

function WorkflowEditor({
  store,
  editor,
  runId,
  onSaved,
  onClose
}: {
  store: AppStore
  editor: WorkflowDefinition | 'new' | null
  runId: string
  onSaved: (workflow: WorkflowDefinition) => void
  onClose: () => void
}): React.JSX.Element {
  const workflow = editor && editor !== 'new' ? editor : undefined
  const editorKey =
    runId || (workflow ? workflow.id || `template-${workflow.title}` : 'new')
  return (
    <div className="workflow-page workflow-editor-host">
      <CollaborationComposer
        key={editorKey}
        embedded
        sessionId={store.activeSessionId}
        workspacePath={workflow?.workspacePath}
        llmConfig={store.llmConfig}
        initialGoal={workflow?.goal || ''}
        initialWorkflow={workflow}
        initialRunId={runId || undefined}
        permissionRequest={
          store.activePermissionRequest?.interactionOrigin === 'orchestration'
            ? store.activePermissionRequest
            : undefined
        }
        onRespondPermission={store.handleRespondPermission}
        onWorkspaceSelected={async () => undefined}
        onSaved={onSaved}
        onClose={onClose}
        onOpenTrajectory={onClose}
        showToast={store.showToast}
      />
    </div>
  )
}

function WorkflowSkeleton(): React.JSX.Element {
  return (
    <div className="workflow-skeleton-grid" aria-busy="true" aria-label="正在加载工作流">
      {[0, 1, 2].map((index) => (
        <div className="workflow-skeleton-card" key={index}>
          <div className="wf-sk-top">
            <span className="wf-sk-icon" />
            <span className="wf-sk-pill" />
          </div>
          <span className="wf-sk-title" />
          <span className="wf-sk-line" />
          <span className="wf-sk-line short" />
          <div className="wf-sk-nodes">
            <span />
            <span />
            <span />
          </div>
        </div>
      ))}
    </div>
  )
}

function Empty({
  icon,
  title,
  text,
  action
}: {
  icon?: React.ReactNode
  title: string
  text?: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="workflow-empty">
      {icon && <div className="workflow-empty-icon">{icon}</div>}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action && <div className="workflow-empty-actions">{action}</div>}
    </div>
  )
}

function LibraryEmptyShowcase({
  onSelectTemplate,
  onCreateBlank,
  onGoChat
}: {
  onSelectTemplate: (draft: WorkflowDefinition) => void
  onCreateBlank: () => void
  onGoChat: () => void
}): React.JSX.Element {
  return (
    <div className="workflow-onboarding">
      <div className="workflow-stage-shell">
        <div className="workflow-stage-canvas">
          <div className="workflow-topology-preview" aria-hidden="true">
            <div className="wf-topo-node">
              <span className="wf-topo-icon agent">
                <Bot size={14} />
              </span>
              <div className="wf-topo-meta">
                <strong>Agent 规划</strong>
                <small>拆解上下文与子目标</small>
              </div>
            </div>
            <div className="wf-topo-connector" />
            <div className="wf-topo-node">
              <span className="wf-topo-icon branch">
                <GitBranch size={14} />
              </span>
              <div className="wf-topo-meta">
                <strong>条件分流</strong>
                <small>按校验结果自动路由</small>
              </div>
            </div>
            <div className="wf-topo-connector" />
            <div className="wf-topo-node">
              <span className="wf-topo-icon rpa">
                <Monitor size={14} />
              </span>
              <div className="wf-topo-meta">
                <strong>桌面与工具执行</strong>
                <small>留存可追溯运行记录</small>
              </div>
            </div>
          </div>

          <div className="workflow-stage-copy">
            <h2>从一个目标开始，沉淀你的专属流程</h2>
            <p>
              将多步提示词、分支判断与桌面自动化串联为可视化蓝图。支持在对话中自然生成，也可以直接从下方典型范式快速起步。
            </p>
          </div>

          <div className="workflow-stage-actions">
            <button type="button" className="workflow-button" onClick={onCreateBlank}>
              <Sparkles size={14} />
              打开空白画布
            </button>
            <button type="button" className="workflow-button subtle" onClick={onGoChat}>
              <MessageSquarePlus size={14} />
              在对话中生成编排
            </button>
          </div>
        </div>
      </div>

      <section className="workflow-starters" aria-label="推荐工作流范式">
        <div className="workflow-caption">
          <span>快速起步范式</span>
          <small>点击载入画布后可自由调整节点与参数</small>
        </div>
        <div className="workflow-starter-grid">
          {STARTER_TEMPLATES.map((item) => (
            <button
              type="button"
              key={item.key}
              className="workflow-starter-card"
              onClick={() => onSelectTemplate(item.draft)}
            >
              <div className="workflow-starter-top">
                <span className="workflow-starter-badge">{item.badge}</span>
                <span className="workflow-starter-cta">
                  载入画布
                  <ArrowUpRight size={13} />
                </span>
              </div>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
              <div className="workflow-node-strip">
                {item.draft.nodes.map((node) => (
                  <span key={node.id}>
                    {node.data.control?.kind === 'condition' ? (
                      <GitBranch size={11} />
                    ) : node.data.control?.kind === 'rpa' ? (
                      <Monitor size={11} />
                    ) : (
                      <Bot size={11} />
                    )}
                    {node.data.title}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function Library({
  workflows,
  hasSaved,
  startingId,
  onOpen,
  onCreate,
  onGoChat,
  onClearSearch,
  onRun
}: {
  workflows: WorkflowDefinition[]
  hasSaved: boolean
  startingId: string
  onOpen: (workflow: WorkflowDefinition) => void
  onCreate: () => void
  onGoChat: () => void
  onClearSearch: () => void
  onRun: (workflow: WorkflowDefinition) => Promise<void>
}): React.JSX.Element {
  if (!workflows.length) {
    if (!hasSaved) {
      return (
        <LibraryEmptyShowcase
          onSelectTemplate={onOpen}
          onCreateBlank={onCreate}
          onGoChat={onGoChat}
        />
      )
    }
    return (
      <Empty
        icon={<Search size={22} />}
        title="没有匹配的工作流"
        text="换个关键词，或清除搜索条件查看全部已保存流程。"
        action={
          <button type="button" className="workflow-button" onClick={onClearSearch}>
            清除搜索条件
          </button>
        }
      />
    )
  }
  return (
    <>
      <div className="workflow-caption">
        <span>已保存的协作流程</span>
        <small>按最近更新排序 · 共 {workflows.length} 项</small>
      </div>
      <div className="workflow-grid">
        {workflows.map((workflow) => (
          <article className="workflow-card" key={workflow.id}>
            <button type="button" className="workflow-card-main" onClick={() => onOpen(workflow)}>
              <div className="workflow-card-top">
                <span>
                  <Network size={16} />
                </span>
                <small>{workflow.nodes.length} 个节点</small>
                <ArrowRight size={15} className="workflow-card-arrow" />
              </div>
              <h2>{workflow.title}</h2>
              <p>{workflow.goal || '打开画布，查看任务分工与执行路径。'}</p>
              <div className="workflow-node-strip">
                {workflow.nodes.slice(0, 4).map((node) => (
                  <span key={node.id}>
                    {node.data.control?.kind === 'condition' ? (
                      <GitBranch size={12} />
                    ) : node.data.control?.kind === 'rpa' ? (
                      <Monitor size={12} />
                    ) : (
                      <Bot size={12} />
                    )}
                    {node.data.title}
                  </span>
                ))}
              </div>
              <div className="workflow-path">
                <FolderOpen size={13} />
                <span>{workflow.workspacePath || '运行前选择工作文件夹'}</span>
              </div>
            </button>
            <footer>
              <small>更新于 {new Date(workflow.updatedAt).toLocaleDateString('zh-CN')}</small>
              <button
                type="button"
                disabled={Boolean(startingId)}
                onClick={() => void onRun(workflow)}
              >
                {startingId === workflow.id ? (
                  <Loader2 className="spin" size={13} />
                ) : (
                  <Play size={13} />
                )}
                {startingId === workflow.id ? '启动中' : '运行'}
              </button>
            </footer>
          </article>
        ))}
      </div>
    </>
  )
}

function RunHistory({
  runs,
  hasRuns,
  onOpen,
  onCreate,
  onClearSearch
}: {
  runs: TaskRunListItem[]
  hasRuns: boolean
  onOpen: (id: string) => void
  onCreate: () => void
  onClearSearch: () => void
}): React.JSX.Element {
  if (!runs.length)
    return (
      <Empty
        icon={<History size={22} />}
        title={hasRuns ? '没有匹配的运行记录' : '还没有运行记录'}
        text={
          hasRuns
            ? '换个关键词，或清除搜索查看全部历史执行。'
            : '从对话或流程库启动的每一次协作编排，都会在这里留下实时状态与执行轨迹。'
        }
        action={
          hasRuns ? (
            <button type="button" className="workflow-button" onClick={onClearSearch}>
              清除搜索条件
            </button>
          ) : (
            <button type="button" className="workflow-button" onClick={onCreate}>
              <Sparkles size={14} />
              前往画布编排流程
            </button>
          )
        }
      />
    )
  return (
    <>
      <div className="workflow-caption">
        <span>每次执行，独立记录</span>
        <small>{runs.length} 次运行</small>
      </div>
      <div className="workflow-run-list">
        {runs.map(({ run, steps }) => (
          <button
            type="button"
            className="workflow-run-row"
            key={run.id}
            onClick={() => onOpen(run.id)}
          >
            <span className={`workflow-run-icon ${run.status}`}>
              {run.status === 'completed' ? <CheckCircle2 size={18} /> : <History size={18} />}
            </span>
            <span className="workflow-run-title">
              <strong>{run.title}</strong>
              <small>
                {new Date(run.createdAt).toLocaleString('zh-CN')} · {steps?.length || 0} 个节点
              </small>
            </span>
            <em className={run.status}>{RUN_STATUS[run.status] || run.status}</em>
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
    </>
  )
}

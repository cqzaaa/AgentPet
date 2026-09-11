import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  FolderOpen,
  GitBranch,
  History,
  Loader2,
  Monitor,
  Network,
  Play,
  Plus,
  Search,
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
      const result = await window.api.runWorkflow(workflow.id)
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

  return (
    <div className={`workflow-page ${view === 'rpa' ? 'workflow-page-rpa' : ''}`}>
      {view !== 'rpa' && <>
      <header className="workflow-hero">
        <div>
          <span className="workflow-eyebrow">
            <Network size={14} /> 工作流中心
          </span>
          <h1>把协作，变成流程。</h1>
          <p>编排 Agent、条件判断与桌面操作，让下一次执行有迹可循。</p>
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
              ['library', '流程库', Network],
              ['runs', '运行记录', History],
              ['rpa', '自动化录制', Monitor]
            ] as const
          ).map(([id, label, Icon]) => (
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
              {id === 'library' && <span>{workflows.length}</span>}
            </button>
          ))}
        </div>
        {view !== 'rpa' && (
          <div className="workflow-search">
            <Search size={15} />
            <input
              ref={searchRef}
              aria-label={view === 'library' ? '搜索工作流' : '搜索运行记录'}
              placeholder={view === 'library' ? '搜索名称或目标…' : '搜索运行记录…'}
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
      </>}

      {view === 'rpa' ? (
        <section className="workflow-rpa">
          <RpaPage onExit={() => setView('library')} />
        </section>
      ) : (
        <main className="workflow-content">
          {loading ? (
            <Empty icon={<Loader2 className="spin" size={24} />} title="正在读取工作流" />
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
              onRun={startWorkflow}
            />
          ) : (
            <RunHistory runs={visibleRuns} onOpen={setRunId} />
          )}
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
  return (
    <div className="workflow-page workflow-editor-host">
      <CollaborationComposer
        key={runId || workflow?.id || 'new'}
        embedded
        sessionId={`workflow:${workflow?.id || 'draft'}`}
        workspacePath={workflow?.workspacePath}
        llmConfig={store.llmConfig}
        initialGoal=""
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
      {icon}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  )
}

function Library({
  workflows,
  hasSaved,
  startingId,
  onOpen,
  onCreate,
  onRun
}: {
  workflows: WorkflowDefinition[]
  hasSaved: boolean
  startingId: string
  onOpen: (workflow: WorkflowDefinition) => void
  onCreate: () => void
  onRun: (workflow: WorkflowDefinition) => Promise<void>
}): React.JSX.Element {
  if (!workflows.length) {
    return (
      <Empty
        icon={hasSaved ? <Search size={25} /> : <Network size={28} />}
        title={hasSaved ? '没有匹配的工作流' : '从一个目标开始，留下一套方法'}
        text={
          hasSaved
            ? '换个关键词，或清除搜索查看全部流程。'
            : '从 Chat 生成编排，或在这里创建可复用流程。'
        }
        action={
          !hasSaved ? (
            <button type="button" className="workflow-button primary" onClick={onCreate}>
              <Plus size={15} />
              创建第一个工作流
            </button>
          ) : undefined
        }
      />
    )
  }
  return (
    <>
      <div className="workflow-caption">
        <span>可复用的协作流程</span>
        <small>最近更新优先</small>
      </div>
      <div className="workflow-grid">
        {workflows.map((workflow) => (
          <article className="workflow-card" key={workflow.id}>
            <button type="button" className="workflow-card-main" onClick={() => onOpen(workflow)}>
              <div className="workflow-card-top">
                <span>
                  <Network size={18} />
                </span>
                <small>{workflow.nodes.length} 个节点</small>
                <ArrowRight size={16} />
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
  onOpen
}: {
  runs: TaskRunListItem[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  if (!runs.length)
    return (
      <Empty
        icon={<History size={28} />}
        title="还没有运行记录"
        text="从 Chat 或工作流启动的编排，会在这里留下执行记录。"
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

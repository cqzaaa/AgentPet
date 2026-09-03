import React from 'react'
import { CheckCircle2, LoaderCircle, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { AgentBrandIcon } from './AgentBrandIcon'

type AgentStatus = 'unchecked' | 'missing' | 'ready' | 'interactive' | 'auth_required' | 'error'
type AgentProtocol = 'internal' | 'acp-v1' | 'claude-stream-json' | 'codex-app-server' | 'antigravity-json'

interface AgentListItem {
  id: string
  name: string
  description: string
  source: 'builtin' | 'custom'
  protocol: AgentProtocol
  executable: string
  args: string[]
  probe: null | {
    status: AgentStatus
    installed: boolean
    protocolVersion?: number
    latencyMs: number
    error?: string
    agentInfo?: { name?: string; version?: string }
  }
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  unchecked: '未检测',
  missing: '未安装',
  ready: '可用',
  interactive: '交互式',
  auth_required: '需要登录',
  error: '连接失败'
}

function statusColor(status: AgentStatus): string {
  if (status === 'ready') return '#16a34a'
  if (status === 'interactive') return '#2563eb'
  if (status === 'missing' || status === 'error') return '#dc2626'
  if (status === 'auth_required') return '#d97706'
  return '#64748b'
}

export function AgentSettingsPanel({ showToast }: { showToast: (message: string, type: any) => void }): React.JSX.Element {
  const [agents, setAgents] = React.useState<AgentListItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [testingId, setTestingId] = React.useState<string | null>(null)
  const [showAdd, setShowAdd] = React.useState(false)
  const [name, setName] = React.useState('')
  const [executable, setExecutable] = React.useState('')
  const [argsText, setArgsText] = React.useState('')

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setAgents(await window.api.listAgents())
    } catch (error: any) {
      showToast(error?.message || '读取 Agent 列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  React.useEffect(() => { void refresh() }, [refresh])

  const testAgent = async (agent: AgentListItem): Promise<void> => {
    setTestingId(agent.id)
    try {
      const result = await window.api.probeAgent(agent.id)
      setAgents(current => current.map(item => item.id === agent.id ? { ...item, probe: result } : item))
      if (result.status === 'ready') showToast(`${agent.name} 连接成功`, 'success')
      else if (result.status === 'interactive') showToast(`${agent.name} 需要交互操作`, 'info')
      else if (result.status === 'auth_required') showToast(`${agent.name} 可以连接，但需要先登录`, 'info')
      else showToast(result.error || `${agent.name} 连接失败`, 'error')
    } catch (error: any) {
      showToast(error?.message || `${agent.name} 连接失败`, 'error')
    } finally {
      setTestingId(null)
    }
  }

  const addAgent = async (): Promise<void> => {
    if (!name.trim() || !executable.trim()) {
      showToast('请填写 Agent 名称和可执行文件', 'info')
      return
    }
    try {
      await window.api.upsertAgent({
        name: name.trim(),
        executable: executable.trim(),
        args: argsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      })
      setName('')
      setExecutable('')
      setArgsText('')
      setShowAdd(false)
      await refresh()
      showToast('Agent 已添加，可以开始测试连接', 'success')
    } catch (error: any) {
      showToast(error?.message || '添加 Agent 失败', 'error')
    }
  }

  const removeAgent = async (agent: AgentListItem): Promise<void> => {
    if (!window.confirm(`确定删除 Agent“${agent.name}”吗？`)) return
    try {
      await window.api.deleteAgent(agent.id)
      await refresh()
      showToast('Agent 已删除', 'success')
    } catch (error: any) {
      showToast(error?.message || '删除 Agent 失败', 'error')
    }
  }

  return (
    <div className="settings-sub-panel">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
        <div>
          <div className="settings-section-title" style={{ marginBottom: 6 }}>Agents</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary, #64748b)', lineHeight: 1.6 }}>
            AgentPet 是默认 Agent。Claude Code、Codex 和 Antigravity CLI 会使用用户本机安装。
          </div>
        </div>
        <button className="btn-primary" type="button" onClick={() => setShowAdd(value => !value)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {showAdd ? <XCircle size={15} /> : <Plus size={15} />}
          {showAdd ? '取消' : '添加 Agent'}
        </button>
      </div>

      {showAdd && (
        <div style={{ padding: 16, border: '1px solid var(--border-color, #dbe2ea)', borderRadius: 12, marginBottom: 18, background: 'var(--bg-card-sub, rgba(128,128,128,.04))' }}>
          <div style={{ fontWeight: 650, marginBottom: 14 }}>添加自定义 ACP Agent</div>
          <div className="form-group">
            <label className="form-label">名称</label>
            <input className="form-input" value={name} onChange={event => setName(event.target.value)} placeholder="例如：My Coding Agent" />
          </div>
          <div className="form-group">
            <label className="form-label">可执行文件</label>
            <input className="form-input" value={executable} onChange={event => setExecutable(event.target.value)} placeholder="例如：my-agent-acp 或 D:\\tools\\agent.exe" />
          </div>
          <div className="form-group">
            <label className="form-label">参数（每行一个参数）</label>
            <textarea className="form-input" rows={4} value={argsText} onChange={event => setArgsText(event.target.value)} placeholder={'--acp\n--profile\ndefault'} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn-primary" type="button" onClick={() => void addAgent()}>保存 Agent</button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><LoaderCircle className="spin" size={22} /></div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {agents.map(agent => {
            const status: AgentStatus = agent.probe?.status || 'unchecked'
            const testing = testingId === agent.id
            return (
              <div key={agent.id} style={{ border: '1px solid var(--border-color, #dbe2ea)', borderRadius: 12, padding: '15px 16px', background: 'var(--bg-card, #fff)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="agent-brand-icon"><AgentBrandIcon agentId={agent.id} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700 }}>{agent.name}</span>
                      {agent.id === 'agentpet' && <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 10, color: '#4f46e5', background: 'rgba(99,102,241,.12)' }}>默认</span>}
                      <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 10, color: statusColor(status), background: `${statusColor(status)}18` }}>{STATUS_LABELS[status]}</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text-secondary, #64748b)' }}>{agent.description}</div>
                    {agent.protocol !== 'internal' && <div style={{ marginTop: 5, fontSize: 11.5, color: 'var(--text-secondary, #64748b)', wordBreak: 'break-all' }}>{agent.executable} {agent.args.join(' ')}</div>}
                  </div>
                  {status === 'ready' && <CheckCircle2 size={19} color="#16a34a" />}
                  {agent.protocol !== 'internal' && (
                    <button className="btn-secondary" type="button" disabled={testing} onClick={() => void testAgent(agent)} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                      <RefreshCw size={14} className={testing ? 'spin' : ''} />{testing ? '检测中' : '测试连接'}
                    </button>
                  )}
                  {agent.source === 'custom' && <button className="btn-secondary" type="button" title="删除" onClick={() => void removeAgent(agent)}><Trash2 size={14} /></button>}
                </div>
                {agent.probe?.error && <div style={{ marginTop: 11, padding: '8px 10px', borderRadius: 8, fontSize: 12, color: '#b91c1c', background: 'rgba(220,38,38,.07)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{agent.probe.error}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

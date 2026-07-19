import React from 'react'
import { Handle, Position } from '@xyflow/react'
import { useRpaStore } from '../useRpaStore'
import {
  AppWindow,
  Bot,
  ClipboardCopy,
  Command,
  Crosshair,
  GitBranch,
  Globe2,
  Hourglass,
  Keyboard,
  Mouse,
  MousePointerClick,
  Play,
  Square,
  TextCursorInput,
  TriangleAlert
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// 节点状态辅助 Hook
function useNodeState(nodeId: string) {
  const currentNodeId = useRpaStore(state => state.currentNodeId)
  const executionState = useRpaStore(state => state.executionState)
  
  if (currentNodeId !== nodeId) return 'idle'
  
  if (executionState === 'running') return 'running'
  if (executionState === 'paused') return 'paused'
  if (executionState === 'failed') return 'failed'
  if (executionState === 'success') return 'success'
  
  return 'idle'
}

// 状态类名映射
function getStateClass(state: string) {
  switch (state) {
    case 'running': return 'node-state-running'
    case 'paused': return 'node-state-paused'
    case 'failed': return 'node-state-failed'
    case 'success': return 'node-state-success'
    default: return ''
  }
}

// ─────────────────────────────────────────────────────────────
// 1. 开始节点 (Start Node)
// ─────────────────────────────────────────────────────────────
export function StartNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="control">
      <div className="rpa-node-strip" style={{ background: 'var(--rpa-success)' }}></div>
      <div className="rpa-node-content" style={{ alignItems: 'center' }}>
        <div className="rpa-node-header" style={{ color: 'var(--rpa-success)', marginBottom: 0 }}>
          <span className="rpa-node-icon"><Play size={15} strokeWidth={2} fill="currentColor" aria-hidden="true" /></span>
          <span>{data?.label || '开始'}</span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 2. 结束节点 (End Node)
// ─────────────────────────────────────────────────────────────
export function EndNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="control">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip" style={{ background: 'var(--rpa-danger)' }}></div>
      <div className="rpa-node-content" style={{ alignItems: 'center' }}>
        <div className="rpa-node-header" style={{ color: 'var(--rpa-danger)', marginBottom: 0 }}>
          <span className="rpa-node-icon"><Square size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" /></span>
          <span>{data?.label || '结束'}</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 3. 打开网页节点 (Open URL)
// ─────────────────────────────────────────────────────────────
export function OpenUrlNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="web">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip"></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header">
          <span className="rpa-node-icon"><Globe2 size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>打开网页</span>
        </div>
        <div className="rpa-node-desc" title={data?.url}>{data?.url || '未配置 URL'}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 4. 点击元素节点 (Click Element)
// ─────────────────────────────────────────────────────────────
export function ClickNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="mouse">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip"></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header">
          <span className="rpa-node-icon"><MousePointerClick size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>点击元素</span>
        </div>
        <div className="rpa-node-desc" title={data?.selector}>{data?.selector || '未选择元素'}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 5. 填充文本节点 (Fill Input)
// ─────────────────────────────────────────────────────────────
export function FillNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="keyboard">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip"></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header">
          <span className="rpa-node-icon"><TextCursorInput size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>输入文本</span>
        </div>
        <div className="rpa-node-desc" title={data?.value}>内容: {data?.value || '未配置'}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 6. 数据提取节点 (Extract Content)
// ─────────────────────────────────────────────────────────────
export function ExtractNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="data">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip"></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header">
          <span className="rpa-node-icon"><ClipboardCopy size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>提取内容</span>
        </div>
        <div className="rpa-node-desc">存至: {data?.varName || '未命名'}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 7. 延时节点 (Delay Wait)
// ─────────────────────────────────────────────────────────────
export function WaitNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="control">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip" style={{ background: '#d97706' }}></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header">
          <span className="rpa-node-icon"><Hourglass size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>延时等待</span>
        </div>
        <div className="rpa-node-desc">等待: {data?.ms || '1000'} ms</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 8. 人工干预节点 (Manual Confirm)
// ─────────────────────────────────────────────────────────────
export function ManualConfirmNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="control">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip" style={{ background: 'var(--rpa-warn)' }}></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header" style={{ color: 'var(--rpa-warn)' }}>
          <span className="rpa-node-icon"><TriangleAlert size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>人工干预</span>
        </div>
        <div className="rpa-node-desc" title={data?.prompt}>{data?.prompt || '等待人工核实'}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 9. AI 处理节点 (AI Process)
// ─────────────────────────────────────────────────────────────
export function AiNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="ai">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip"></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header" style={{ color: '#2f54eb' }}>
          <span className="rpa-node-icon"><Bot size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>AI 智能处理</span>
        </div>
        <div className="rpa-node-desc">存至: {data?.varName || '未命名'}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 10. 分支判断节点 (Condition Branch)
// ─────────────────────────────────────────────────────────────
export function ConditionNode({ id, data }: any): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block ${getStateClass(state)}`} data-kind="control">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip"></div>
      <div className="rpa-node-content">
        <div className="rpa-node-header">
          <span className="rpa-node-icon"><GitBranch size={16} strokeWidth={2} aria-hidden="true" /></span>
          <span>条件分支</span>
        </div>
        <div className="rpa-node-desc" title={data?.expression}>{data?.expression || '1 === 1'}</div>
      </div>
      
      {/* 左右两侧分支桩 */}
      <Handle type="source" position={Position.Right} id="true" style={{ background: 'var(--rpa-success)', top: '50%' }} />
      <span style={{ position: 'absolute', right: '4px', top: '30%', fontSize: '9px', fontWeight: 'bold', color: 'var(--rpa-success)' }}>T</span>
      
      <Handle type="source" position={Position.Left} id="false" style={{ background: 'var(--rpa-danger)', top: '50%' }} />
      <span style={{ position: 'absolute', left: '4px', top: '30%', fontSize: '9px', fontWeight: 'bold', color: 'var(--rpa-danger)' }}>F</span>
    </div>
  )
}

function DesktopNode({ id, icon: Icon, title, description }: { id: string; icon: LucideIcon; title: string; description: string }): React.JSX.Element {
  const state = useNodeState(id)
  return (
    <div className={`rpa-node-block rpa-node-desktop ${getStateClass(state)}`} data-kind="desktop">
      <Handle type="target" position={Position.Top} />
      <div className="rpa-node-strip" />
      <div className="rpa-node-content">
        <div className="rpa-node-header"><span className="rpa-node-icon"><Icon size={16} strokeWidth={2} aria-hidden="true" /></span><span>{title}</span></div>
        <div className="rpa-node-desc">{description}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export const DesktopFocusNode = (props: any): React.JSX.Element => (
  <DesktopNode {...props} icon={AppWindow} title="切换窗口" description={props.data?.windowTitle || props.data?.processName || '切换到目标应用'} />
)
export const DesktopClickNode = (props: any): React.JSX.Element => (
  <DesktopNode {...props} icon={Crosshair} title={props.data?.double ? '双击坐标' : '点击坐标'} description={`${props.data?.x ?? 0}, ${props.data?.y ?? 0}`} />
)
export const DesktopTypeNode = (props: any): React.JSX.Element => (
  <DesktopNode {...props} icon={Keyboard} title="桌面输入" description={String(props.data?.value || '').startsWith('${secret.') ? '凭据 · 执行时注入' : '文本输入'} />
)
export const DesktopHotkeyNode = (props: any): React.JSX.Element => (
  <DesktopNode {...props} icon={Command} title="快捷键" description={props.data?.keys || 'Ctrl + C'} />
)
export const DesktopScrollNode = (props: any): React.JSX.Element => (
  <DesktopNode {...props} icon={Mouse} title="滚轮" description={`${props.data?.direction || 'down'} · ${props.data?.amount || 3}`} />
)

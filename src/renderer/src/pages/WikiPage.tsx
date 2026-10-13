import type { WikiSyncProgress as SyncProgress, WikiParserComponentStatus } from '../../../preload/wiki-types'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeProps, type ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, Clock3, Download, ExternalLink, FileCode2, FileText, Folder,
  FolderOpen, History, Link2, LoaderCircle, Maximize2, Minimize2, Network, Pencil,
  Plus, RefreshCw, Save, Search, Trash2, X
} from 'lucide-react'
import { FileIcon } from '../components/FileIcon'
import './WikiPage.css'

type Workspace = { id: string; name: string; rootPath: string; itemCount: number; pageCount: number }
type WikiItem = {
  id: string; workspaceId: string; documentId: string; relativePath: string; absolutePath: string
  parentPath: string; title: string; itemKind: 'page' | 'document'; fileType: string
  editable: number; fileSize: number; modifiedAt: number; content?: string
}
type DocNode = { id: string; type: string; title: string; content: string; pageStart: number | null }
type DocDetail = { document: { parser: string; warning: string }; nodes: DocNode[] }
type SourceEvidence = {
  id: string; itemId: string; resource: string; relativePath: string
  startLine: number | null; endLine: number | null; claimId: string
  statement: string; version: string; status: 'linked' | 'verified' | 'missing'
}
type SourcePreview = {
  itemId: string
  resource: string; relativePath: string; absolutePath: string
  startLine: number | null; endLine: number | null; excerptStart: number; excerptEnd: number
  totalLines: number; truncated: boolean; lines: Array<{ number: number; text: string }>
}
type GraphData = {
  nodes: Array<{ id: string; itemId: string | null; label: string; kind: string; entityType?: string; fileType: string; relativePath: string; resource?: string; size?: number }>
  edges: Array<{ id: string; source: string; target: string; kind: string; weight?: number }>
  entities: Array<{ id: string; name: string; type: string; mentionCount: number; confidence: number; evidence: string[] }>
  sources: SourceEvidence[]
  relatedItems: Array<{ id: string; title: string; relativePath: string; fileType: string; sharedEntities: string[]; sharedSources: string[]; directLink: boolean }>
  backlinks: Array<{ id: string; title: string; relativePath: string; fileType: string }>
  unresolved: Array<{ id: string; fromItemId: string; targetText: string }>
}
type TreeNode = { id: string; name: string; path: string; kind: 'folder' | 'file'; item?: WikiItem; children: TreeNode[] }
type Revision = { id: string; createdAt: number; characterCount: number }
type Dialog = { type: 'create'; parentPath: string }
  | { type: 'remove'; workspace: Workspace }
  | { type: 'delete-item'; item: WikiItem }
  | { type: 'discard'; nextId?: string; nextWorkspaceId?: string; nextFolder?: string; nextView?: 'workspaces' }

const emptyGraph: GraphData = { nodes: [], edges: [], entities: [], sources: [], relatedItems: [], backlinks: [], unresolved: [] }

function normalizeGraphData(value: unknown): GraphData {
  const graph = value && typeof value === 'object' ? value as Partial<GraphData> : {}
  return {
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    entities: Array.isArray(graph.entities) ? graph.entities : [],
    sources: Array.isArray(graph.sources) ? graph.sources : [],
    relatedItems: Array.isArray(graph.relatedItems) ? graph.relatedItems : [],
    backlinks: Array.isArray(graph.backlinks) ? graph.backlinks : [],
    unresolved: Array.isArray(graph.unresolved) ? graph.unresolved : []
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value || 0} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

function icon(type: string, size = 15, fileName = ''): React.JSX.Element {
  return <FileIcon fileName={fileName || type} fileType={type} size={size} className="wiki-file-icon" />
}

function makeTree(items: WikiItem[]): TreeNode[] {
  const root: TreeNode = { id: 'root', name: '', path: '', kind: 'folder', children: [] }
  const folders = new Map<string, TreeNode>([['', root]])
  for (const item of items) {
    const parts = item.relativePath.split('/').filter(Boolean)
    let parent = root
    let path = ''
    parts.slice(0, -1).forEach(part => {
      path = path ? `${path}/${part}` : part
      let folder = folders.get(path)
      if (!folder) {
        folder = { id: `folder:${path}`, name: part, path, kind: 'folder', children: [] }
        folders.set(path, folder)
        parent.children.push(folder)
      }
      parent = folder
    })
    parent.children.push({ id: item.id, name: parts.at(-1) || item.title, path: item.relativePath, kind: 'file', item, children: [] })
  }
  const sort = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'folder' ? -1 : 1)
    nodes.forEach(node => sort(node.children))
  }
  sort(root.children)
  return root.children
}

function relativeMarkdownTarget(currentPath: string, rawTarget: string): string {
  let decoded = ''
  try {
    decoded = decodeURIComponent(rawTarget.trim().replace(/^<|>$/g, '').split(/\s+["']/)[0].split(/[?#]/)[0])
  } catch {
    return ''
  }
  if (!decoded || decoded.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return ''
  const parts = currentPath.replace(/\\/g, '/').split('/').slice(0, -1)
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return ''
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/').toLocaleLowerCase('zh-CN')
}

function InlineText({ text, currentPath, items, open }: { text: string; currentPath: string; items: WikiItem[]; open: (id: string) => void }): React.JSX.Element {
  return <>{text.split(/(\[\[[^\]]+\]\]|(?<!!)\[[^\]]+\]\([^)]+\))/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('[[')) {
      const raw = part.slice(2, -2)
      const target = raw.split('|')[0].split('#')[0].trim().toLocaleLowerCase('zh-CN')
      const item = items.find(candidate => candidate.title.toLocaleLowerCase('zh-CN') === target || candidate.relativePath.replace(/\.[^.]+$/, '').toLocaleLowerCase('zh-CN') === target)
      return item
        ? <button type="button" className="wiki-inline-link" key={index} onClick={() => open(item.id)}><Link2 size={12} />{raw.split('|')[1] || raw}</button>
        : <span className="wiki-inline-link unresolved" key={index}>{raw}</span>
    }
    const markdownLink = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (!markdownLink) return <React.Fragment key={index}>{part}</React.Fragment>
    const target = relativeMarkdownTarget(currentPath, markdownLink[2])
    const item = items.find(candidate => {
      const candidatePath = candidate.relativePath.replace(/\\/g, '/').toLocaleLowerCase('zh-CN')
      return candidatePath === target || candidatePath.replace(/\.[^.]+$/, '') === target.replace(/\.[^.]+$/, '')
    })
    return item
      ? <button type="button" className="wiki-inline-link" key={index} onClick={() => open(item.id)}><Link2 size={12} />{markdownLink[1]}</button>
      : <React.Fragment key={index}>{markdownLink[1]}</React.Fragment>
  })}</>
}

function MarkdownView({ content, currentPath, items, open }: { content: string; currentPath: string; items: WikiItem[]; open: (id: string) => void }): React.JSX.Element {
  const normalizedContent = content.replace(/\r/g, '')
  const frontmatterEnd = normalizedContent.startsWith('---\n') ? normalizedContent.indexOf('\n---\n', 4) : -1
  const visibleContent = frontmatterEnd >= 0 ? normalizedContent.slice(frontmatterEnd + 5) : normalizedContent
  return <article className="wiki-markdown">{visibleContent.split('\n').map((line, index) => {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      const children = <InlineText text={heading[2]} currentPath={currentPath} items={items} open={open} />
      if (heading[1].length === 1) return <h1 key={index}>{children}</h1>
      if (heading[1].length === 2) return <h2 key={index}>{children}</h2>
      return <h3 key={index}>{children}</h3>
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line)
    if (bullet) return <div className="wiki-markdown-bullet" key={index}><i /><InlineText text={bullet[1]} currentPath={currentPath} items={items} open={open} /></div>
    if (line.startsWith('> ')) return <blockquote key={index}><InlineText text={line.slice(2)} currentPath={currentPath} items={items} open={open} /></blockquote>
    return line.trim() ? <p key={index}><InlineText text={line} currentPath={currentPath} items={items} open={open} /></p> : <div className="wiki-markdown-space" key={index} />
  })}</article>
}

type WikiGraphNodeData = {
  label: string
  itemId: string | null
  kind: string
  resource?: string
  nodeSize: number
  selected: boolean
  highlighted: boolean
  dimmed: boolean
  showLabel: boolean
  anchor: boolean
}
type WikiFlowNode = Node<WikiGraphNodeData, 'wikiGraph'>

let cachedGraphTopology = ''
let cachedPagePositions = new Map<string, { x: number; y: number }>()

function hashNumber(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function stablePagePositions(data: GraphData): Map<string, { x: number; y: number }> {
  const pages = data.nodes
    .filter(node => node.kind !== 'source' && node.kind !== 'entity')
    .sort((left, right) => left.id.localeCompare(right.id))
  const pageIds = new Set(pages.map(node => node.id))
  const links = data.edges
    .filter(edge => pageIds.has(edge.source) && pageIds.has(edge.target))
    .sort((left, right) => `${left.source}>${left.target}`.localeCompare(`${right.source}>${right.target}`))
  const signature = `${pages.map(node => node.id).join('|')}::${links.map(edge => `${edge.source}>${edge.target}`).join('|')}`
  if (signature === cachedGraphTopology) return cachedPagePositions

  const positions = pages.map((page, index) => {
    const phase = hashNumber(page.id) / 0xffffffff * Math.PI * 2
    const radius = 45 + Math.sqrt(index + 1) * 68
    const angle = index * 2.399963229728653 + phase * 0.18
    return { id: page.id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  const indexById = new Map(positions.map((position, index) => [position.id, index]))
  const linkIndexes = links.flatMap(edge => {
    const source = indexById.get(edge.source)
    const target = indexById.get(edge.target)
    return source === undefined || target === undefined ? [] : [[source, target] as const]
  })
  const iterations = pages.length > 180 ? 42 : 68
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forces = positions.map(() => ({ x: 0, y: 0 }))
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        const dx = positions[left].x - positions[right].x
        const dy = positions[left].y - positions[right].y
        const distanceSquared = Math.max(100, dx * dx + dy * dy)
        if (distanceSquared > 520000) continue
        const distance = Math.sqrt(distanceSquared)
        const repulsion = 5600 / distanceSquared
        const fx = dx / distance * repulsion
        const fy = dy / distance * repulsion
        forces[left].x += fx; forces[left].y += fy
        forces[right].x -= fx; forces[right].y -= fy
      }
    }
    for (const [sourceIndex, targetIndex] of linkIndexes) {
      const dx = positions[targetIndex].x - positions[sourceIndex].x
      const dy = positions[targetIndex].y - positions[sourceIndex].y
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const pull = (distance - 150) * 0.018
      const fx = dx / distance * pull
      const fy = dy / distance * pull
      forces[sourceIndex].x += fx; forces[sourceIndex].y += fy
      forces[targetIndex].x -= fx; forces[targetIndex].y -= fy
    }
    const temperature = 9 - iteration / iterations * 7
    positions.forEach((position, index) => {
      forces[index].x -= position.x * 0.0016
      forces[index].y -= position.y * 0.0016
      position.x += Math.max(-temperature, Math.min(temperature, forces[index].x))
      position.y += Math.max(-temperature, Math.min(temperature, forces[index].y))
    })
  }
  const centerX = positions.reduce((sum, position) => sum + position.x, 0) / Math.max(1, positions.length)
  const centerY = positions.reduce((sum, position) => sum + position.y, 0) / Math.max(1, positions.length)
  cachedGraphTopology = signature
  cachedPagePositions = new Map(positions.map(position => [position.id, { x: position.x - centerX, y: position.y - centerY }]))
  return cachedPagePositions
}

function WikiGraphNodeView({ data }: NodeProps<WikiFlowNode>): React.JSX.Element {
  return <div className={`wiki-graph-node ${data.kind}${data.selected ? ' selected' : ''}${data.highlighted ? ' highlighted' : ''}${data.dimmed ? ' dimmed' : ''}${data.anchor ? ' anchor' : ''}`} style={{ '--wiki-node-size': `${data.nodeSize}px` } as React.CSSProperties}>
    <Handle type="target" position={Position.Top} />
    <span aria-hidden="true" />
    {data.showLabel && <strong title={data.label}>{data.label}</strong>}
    <Handle type="source" position={Position.Bottom} />
  </div>
}

const wikiGraphNodeTypes = { wikiGraph: WikiGraphNodeView }

function layoutGraph(data: GraphData, focusId: string, hoveredId: string, wideLayout: boolean): { nodes: WikiFlowNode[]; edges: Edge[] } {
  const positions = stablePagePositions(data)
  const effectiveFocusId = focusId && data.nodes.some(node => node.id === focusId) ? focusId : ''
  const activeId = effectiveFocusId || hoveredId
  const highlightedIds = new Set<string>()
  if (activeId) {
    highlightedIds.add(activeId)
    for (const edge of data.edges) {
      if (edge.source === activeId || edge.target === activeId) {
        highlightedIds.add(edge.source)
        highlightedIds.add(edge.target)
      }
    }
  }
  const pages = data.nodes.filter(node => node.kind !== 'source' && node.kind !== 'entity')
  const anchor = pages.find(node => /quickstart/i.test(node.relativePath))
    || pages.find(node => /(^|\/)(index|overview|home)(?:\.[^.]+)?$/i.test(node.relativePath))
    || pages[0]
  const extraCounts = new Map<string, number>()
  const spreadPosition = (position: { x: number; y: number }): { x: number; y: number } => wideLayout
    ? { x: position.x * 1.48, y: position.y * 1.04 }
    : position

  const linkedPageCenterFor = (nodeId: string): { x: number; y: number } => {
    const directPos = positions.get(nodeId)
    if (directPos) return directPos
    const linkedPages = data.edges.flatMap(edge => {
      if (edge.source === nodeId && positions.has(edge.target)) return [positions.get(edge.target)!]
      if (edge.target === nodeId && positions.has(edge.source)) return [positions.get(edge.source)!]
      return []
    })
    return linkedPages.length
      ? {
          x: linkedPages.reduce((sum, position) => sum + position.x, 0) / linkedPages.length,
          y: linkedPages.reduce((sum, position) => sum + position.y, 0) / linkedPages.length
        }
      : { x: 0, y: 0 }
  }

  const rawPositionById = new Map<string, { x: number; y: number }>()
  for (const item of data.nodes) {
    const pagePosition = positions.get(item.id)
    if (pagePosition) {
      rawPositionById.set(item.id, pagePosition)
      continue
    }
    const base = linkedPageCenterFor(item.id)
    const count = extraCounts.get(item.kind) || 0
    extraCounts.set(item.kind, count + 1)
    const angle = hashNumber(item.id) / 0xffffffff * Math.PI * 2 + count * 0.72
    const radius = item.kind === 'source' ? 82 : 112
    rawPositionById.set(item.id, { x: base.x + Math.cos(angle) * radius, y: base.y + Math.sin(angle) * radius })
  }

  const focusedPositions = new Map<string, { x: number; y: number }>()
  if (effectiveFocusId) {
    const focusOrigin = rawPositionById.get(effectiveFocusId) || { x: 0, y: 0 }
    focusedPositions.set(effectiveFocusId, { x: 0, y: 0 })

    const connectedNodes = data.nodes.filter(node => node.id !== effectiveFocusId && highlightedIds.has(node.id))
    const connectedMeta = connectedNodes
      .filter(node => node.kind === 'entity' || node.kind === 'source')
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    const connectedPages = connectedNodes
      .filter(node => node.kind !== 'entity' && node.kind !== 'source')
      .sort((a, b) => {
        const posA = rawPositionById.get(a.id) || { x: 0, y: 0 }
        const posB = rawPositionById.get(b.id) || { x: 0, y: 0 }
        const angleA = Math.atan2(posA.y - focusOrigin.y, posA.x - focusOrigin.x)
        const angleB = Math.atan2(posB.y - focusOrigin.y, posB.x - focusOrigin.x)
        return angleA - angleB || a.id.localeCompare(b.id)
      })

    connectedMeta.forEach((node, index) => {
      const total = connectedMeta.length
      const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2
      const radius = total > 8 ? (index % 2 === 0 ? 96 : 132) : 108
      focusedPositions.set(node.id, spreadPosition({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }))
    })

    const hasInnerRing = connectedMeta.length > 0
    const firstPagePos = connectedPages[0] ? (rawPositionById.get(connectedPages[0].id) || { x: 0, y: -1 }) : { x: 0, y: -1 }
    const startAngle = Math.hypot(firstPagePos.x - focusOrigin.x, firstPagePos.y - focusOrigin.y) > 1
      ? Math.atan2(firstPagePos.y - focusOrigin.y, firstPagePos.x - focusOrigin.x)
      : -Math.PI / 2

    connectedPages.forEach((node, index) => {
      const total = connectedPages.length
      const angle = startAngle + (index / Math.max(1, total)) * Math.PI * 2
      const radius = hasInnerRing
        ? (total > 6 ? (index % 2 === 0 ? 188 : 226) : 196)
        : (total > 6 ? (index % 2 === 0 ? 128 : 164) : 142)
      focusedPositions.set(node.id, spreadPosition({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }))
    })

    const minBackgroundRadius = hasInnerRing && connectedPages.length > 0 ? 255 : 210
    for (const item of data.nodes) {
      if (focusedPositions.has(item.id)) continue
      const raw = rawPositionById.get(item.id) || { x: 0, y: 0 }
      const dx = raw.x - focusOrigin.x
      const dy = raw.y - focusOrigin.y
      const dist = Math.hypot(dx, dy)
      const theta = dist > 1 ? Math.atan2(dy, dx) : (hashNumber(item.id) / 0xffffffff) * Math.PI * 2
      const adjustedRadius = dist < minBackgroundRadius ? minBackgroundRadius + dist * 0.35 : dist
      focusedPositions.set(item.id, spreadPosition({ x: Math.cos(theta) * adjustedRadius, y: Math.sin(theta) * adjustedRadius }))
    }
  }

  const positionFor = (item: GraphData['nodes'][number], nodeSize: number): { x: number; y: number } => {
    const centerPos = effectiveFocusId
      ? (focusedPositions.get(item.id) || { x: 0, y: 0 })
      : spreadPosition(rawPositionById.get(item.id) || { x: 0, y: 0 })
    return { x: centerPos.x - nodeSize / 2, y: centerPos.y - nodeSize / 2 }
  }

  return {
    nodes: data.nodes.map(item => {
      const selected = item.id === effectiveFocusId
      const highlighted = highlightedIds.has(item.id)
      const anchorNode = item.id === anchor?.id
      const baseSize = item.kind === 'source' ? 16 : item.kind === 'entity' ? 16 : 18 + Math.min(14, Math.log2((item.size || 0) + 1) * 1.15)
      const nodeSize = baseSize + (anchorNode ? 7 : 0)
      return {
        id: item.id,
        type: 'wikiGraph',
        position: positionFor(item, nodeSize),
        data: {
          label: item.label,
          itemId: item.itemId,
          kind: item.kind,
          resource: item.resource,
          nodeSize,
          selected,
          highlighted,
          dimmed: Boolean(activeId && !highlighted),
          showLabel: effectiveFocusId ? highlighted : item.id === hoveredId,
          anchor: anchorNode
        },
        draggable: false,
        selectable: false,
        focusable: true,
        ariaLabel: item.label,
        className: 'wiki-flow-node',
        style: { width: nodeSize, height: nodeSize, zIndex: selected ? 4 : highlighted ? 3 : 1 }
      }
    }),
    edges: data.edges.map(edge => {
      const highlighted = Boolean(activeId && (edge.source === activeId || edge.target === activeId))
      const direct = edge.kind === 'explicit' || edge.kind === 'markdown'
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'straight',
        animated: highlighted && direct,
        selectable: false,
        focusable: false,
        markerEnd: direct ? { type: MarkerType.ArrowClosed, width: 10, height: 10 } : undefined,
        className: `wiki-graph-edge ${edge.kind}${highlighted ? ' highlighted' : ''}${activeId && !highlighted ? ' dimmed' : ''}`,
        style: { strokeWidth: highlighted ? 2 : Math.min(1.45, .65 + Math.log2((edge.weight || 1) + 1) * 0.25) }
      }
    })
  }
}

export function WikiPage(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [workspaceListOpen, setWorkspaceListOpen] = useState(false)
  const [items, setItems] = useState<WikiItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [folder, setFolder] = useState('')
  const [item, setItem] = useState<WikiItem | null>(null)
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [graph, setGraph] = useState<GraphData>(emptyGraph)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [parserComponent, setParserComponent] = useState<WikiParserComponentStatus | null>(null)
  const [parserInstalling, setParserInstalling] = useState(false)
  const [parserDismissed, setParserDismissed] = useState(false)
  const [showReadyBriefly, setShowReadyBriefly] = useState(false)
  const parserInstallRef = useRef(false)
  const previousParserStatusRef = useRef<string | null>(null)
  const visibleWorkspaceRef = useRef(workspaceId)
  visibleWorkspaceRef.current = workspaceId
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  const [sideTab, setSideTab] = useState<'graph' | 'links' | 'history'>('graph')
  const [contextWidth, setContextWidth] = useState(330)
  const [resizingContext, setResizingContext] = useState(false)
  const [graphExpanded, setGraphExpanded] = useState(false)
  const [hoveredGraphNode, setHoveredGraphNode] = useState('')
  const [focusedGraphNodeId, setFocusedGraphNodeId] = useState('')
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null)
  const [sourceLoading, setSourceLoading] = useState('')
  const [sourceError, setSourceError] = useState<{ itemId: string; message: string } | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const graphExpandButtonRef = useRef<HTMLButtonElement>(null)
  const graphContainerRef = useRef<HTMLDivElement>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<WikiFlowNode, Edge> | null>(null)
  const renderedPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const resizeSessionRef = useRef({ startX: 0, startWidth: 330 })

  useEffect(() => {
    let active = true
    let latest = 0
    const receive = (status: WikiParserComponentStatus): void => {
      if (!active || status.updatedAt < latest) return
      latest = status.updatedAt
      setParserComponent(status)
    }
    const unsubscribe = window.api.onWikiParserComponentStatus(receive)
    void window.api.wikiGetParserComponent().then(receive)
      .catch(reason => { if (active) setError(errorMessage(reason, '无法读取文档解析组件状态。')) })
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!parserComponent) return
    let timer: number | undefined
    if (previousParserStatusRef.current === 'installing' && parserComponent.status === 'ready') {
      setShowReadyBriefly(true)
      timer = window.setTimeout(() => setShowReadyBriefly(false), 2600)
    }
    previousParserStatusRef.current = parserComponent.status
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [parserComponent])

  const installParser = async (): Promise<void> => {
    if (parserInstallRef.current) return
    parserInstallRef.current = true
    setParserInstalling(true)
    try { setParserComponent(await window.api.wikiInstallParserComponent()) }
    catch (reason) { setError(errorMessage(reason, '组件下载失败，请重试。')) }
    finally { parserInstallRef.current = false; setParserInstalling(false) }
  }

  useEffect(() => {
    setFocusedGraphNodeId(selectedId)
  }, [selectedId])

  const workspace = workspaces.find(entry => entry.id === workspaceId)
  const displayedItem = item?.id === selectedId ? item : null
  const dirty = mode === 'edit' && draft !== saved
  const tree = useMemo(() => makeTree(items), [items])
  const activeGraphFocusId = focusedGraphNodeId || selectedId
  const graphElements = useMemo(
    () => layoutGraph(graph, activeGraphFocusId, activeGraphFocusId ? '' : hoveredGraphNode, graphExpanded),
    [activeGraphFocusId, graph, graphExpanded, hoveredGraphNode]
  )
  const [animatedNodes, setAnimatedNodes] = useState<WikiFlowNode[]>(graphElements.nodes)

  useEffect(() => {
    const targetNodes = graphElements.nodes
    if (!targetNodes.length) {
      renderedPositionsRef.current.clear()
      setAnimatedNodes([])
      return
    }
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const previousPositions = new Map(renderedPositionsRef.current)
    let hasMovement = false
    for (const node of targetNodes) {
      const prev = previousPositions.get(node.id)
      if (prev && (Math.abs(prev.x - node.position.x) > 0.5 || Math.abs(prev.y - node.position.y) > 0.5)) {
        hasMovement = true
        break
      }
    }
    if (reducedMotion || previousPositions.size === 0 || !hasMovement) {
      renderedPositionsRef.current = new Map(targetNodes.map(node => [node.id, { ...node.position }]))
      setAnimatedNodes(targetNodes)
      return
    }
    let frameId = 0
    const startTime = performance.now()
    const duration = 360
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startTime) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      const nextMap = new Map<string, { x: number; y: number }>()
      const interpolated = targetNodes.map(node => {
        const startPos = previousPositions.get(node.id) || node.position
        const x = startPos.x + (node.position.x - startPos.x) * eased
        const y = startPos.y + (node.position.y - startPos.y) * eased
        nextMap.set(node.id, { x, y })
        return { ...node, position: { x, y } }
      })
      renderedPositionsRef.current = nextMap
      setAnimatedNodes(interpolated)
      if (progress < 1) {
        frameId = window.requestAnimationFrame(step)
      }
    }
    frameId = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(frameId)
  }, [graphElements.nodes])

  const centerGraphViewport = useCallback((nodesToFit: WikiFlowNode[], animate = true): void => {
    const instance = flowInstanceRef.current
    const container = graphContainerRef.current
    if (!instance || !container || !nodesToFit.length) return
    const focusSubset = activeGraphFocusId
      ? nodesToFit.filter(node => node.data.selected || node.data.highlighted)
      : nodesToFit
    const boundsNodes = focusSubset.length > 1 ? focusSubset : nodesToFit
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const node of boundsNodes) {
      const size = node.data.nodeSize || 18
      minX = Math.min(minX, node.position.x - 36)
      maxX = Math.max(maxX, node.position.x + size + 36)
      minY = Math.min(minY, node.position.y - 24)
      maxY = Math.max(maxY, node.position.y + size + 34)
    }
    const width = Math.max(240, container.clientWidth)
    const height = Math.max(220, container.clientHeight)
    const padding = graphExpanded ? 0.16 : 0.22
    const spanX = Math.max(220, maxX - minX)
    const spanY = Math.max(220, maxY - minY)
    const maxZoom = graphExpanded ? 1.15 : 1.05
    const zoom = Math.max(0.22, Math.min(maxZoom, Math.min((width * (1 - padding * 2)) / spanX, (height * (1 - padding * 2)) / spanY)))
    const centerX = activeGraphFocusId ? 0 : (minX + maxX) / 2
    const centerY = activeGraphFocusId ? 0 : (minY + maxY) / 2
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    void instance.setCenter(centerX, centerY, { zoom, duration: animate && !reducedMotion ? 380 : 0 })
  }, [activeGraphFocusId, graphExpanded])

  useEffect(() => {
    if (sideTab !== 'graph' || !graphElements.nodes.length) return
    const timer = window.setTimeout(() => {
      centerGraphViewport(graphElements.nodes, true)
    }, 16)
    return () => window.clearTimeout(timer)
  }, [activeGraphFocusId, centerGraphViewport, graphElements.nodes, graphExpanded, sideTab])

  const handleGraphNodeEnter = useCallback((nodeId: string): void => {
    if (activeGraphFocusId) return
    setHoveredGraphNode(current => current === nodeId ? current : nodeId)
  }, [activeGraphFocusId])
  const handleGraphNodeLeave = useCallback((nodeId: string): void => {
    if (activeGraphFocusId) return
    setHoveredGraphNode(current => current === nodeId ? '' : current)
  }, [activeGraphFocusId])
  const sourceGroups = useMemo(() => {
    const grouped = new Map<string, SourceEvidence & { statements: string[]; claimCount: number }>()
    for (const source of graph.sources) {
      const current = grouped.get(source.resource)
      if (current) {
        current.claimCount += source.claimId ? 1 : 0
        if (source.statement && !current.statements.includes(source.statement)) current.statements.push(source.statement)
      } else {
        grouped.set(source.resource, {
          ...source,
          statements: source.statement ? [source.statement] : [],
          claimCount: source.claimId ? 1 : 0
        })
      }
    }
    return [...grouped.values()]
  }, [graph.sources])
  const visibleSourcePreview = sourcePreview?.itemId === selectedId ? sourcePreview : null
  const visibleSourceError = sourceError?.itemId === selectedId ? sourceError.message : ''
  const folderItems = useMemo(() => items.filter(candidate => candidate.parentPath === folder), [folder, items])
  const matches = useMemo(() => {
    const key = query.trim().toLocaleLowerCase('zh-CN')
    return key ? items.filter(candidate => `${candidate.title}\n${candidate.relativePath}`.toLocaleLowerCase('zh-CN').includes(key)).slice(0, 50) : []
  }, [items, query])
  const loadWorkspaces = useCallback(async (preferred?: string) => {
    const rows = await window.api.wikiListWorkspaces() as Workspace[]
    setWorkspaces(rows)
    setWorkspaceId(current => preferred || (rows.some(row => row.id === current) ? current : rows[0]?.id || ''))
  }, [])

  const loadItems = useCallback(async (id: string, preferred?: string) => {
    const rows = id ? await window.api.wikiListItems(id) as WikiItem[] : []
    setItems(rows)
    setSelectedId(current => preferred || (rows.some(row => row.id === current) ? current : rows[0]?.id || ''))
    setExpanded(new Set(rows.map(row => row.parentPath).filter(Boolean)))
  }, [])

  const loadGraph = useCallback(async (id: string, focus?: string) => {
    setGraph(id ? normalizeGraphData(await window.api.wikiGetGraph(id, focus)) : emptyGraph)
  }, [])

  const clampContextWidth = useCallback((width: number): number => {
    const available = (workbenchRef.current?.clientWidth || 1280) - 244 - 360
    return Math.max(260, Math.min(width, Math.max(260, Math.min(760, available))))
  }, [])

  const sync = useCallback(async (id: string) => {
    try {
      setError('')
      await window.api.wikiSyncWorkspace(id)
    } catch (reason: unknown) {
      if (visibleWorkspaceRef.current === id) setError(errorMessage(reason, '无法同步工作区，请确认文件夹仍然存在。'))
    }
  }, [])

  useEffect(() => {
    document.title = 'Wiki 工作区 | AgentPet'
    let active = true
    void window.api.wikiListWorkspaces()
      .then(value => {
        if (!active) return
        const rows = value as Workspace[]
        setWorkspaces(rows)
        const previous = sessionStorage.getItem('wiki.workspaceId')
        setWorkspaceId(rows.find(row => row.id === previous)?.id || rows[0]?.id || '')
      })
      .catch(reason => { if (active) setError(errorMessage(reason, '无法读取 Wiki 工作区。')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    setProgress(null)
    if (!workspaceId) return
    sessionStorage.setItem('wiki.workspaceId', workspaceId)
    let active = true
    let latestUpdate = 0
    const receive = (value: SyncProgress | null): void => {
      if (!active || !value || value.workspaceId !== workspaceId || value.updatedAt < latestUpdate) return
      latestUpdate = value.updatedAt
      setProgress(value)
      if (value.status === 'failed') setError(value.error || '同步失败，请重试。')
      if (value.status === 'completed') {
        if (value.failed) setError(`${value.failed} 个文件解析失败，请重试同步。`)
        void Promise.all([window.api.wikiListItems(workspaceId), window.api.wikiGetGraph(workspaceId), window.api.wikiListWorkspaces()])
          .then(([rows, graphValue, workspacesValue]) => {
            if (!active || latestUpdate !== value.updatedAt) return
            setItems(rows as WikiItem[])
            setSelectedId(current => rows.some(row => row.id === current) ? current : rows[0]?.id || '')
            setGraph(normalizeGraphData(graphValue))
            setWorkspaces(workspacesValue as Workspace[])
          })
          .catch(reason => { if (active) setError(errorMessage(reason, '同步完成，结果加载失败，请重试。')) })
      }
    }
    const unsubscribe = window.api.onWikiSyncProgress(receive)
    void window.api.wikiGetSyncProgress(workspaceId).then(receive)
      .catch(reason => { if (active) setError(errorMessage(reason, '无法恢复同步进度。')) })
    return () => { active = false; unsubscribe() }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let active = true
    void window.api.wikiListItems(workspaceId)
      .then(value => {
        if (!active) return
        const rows = value as WikiItem[]
        setItems(rows)
        setSelectedId(current => rows.some(row => row.id === current) ? current : rows[0]?.id || '')
        setExpanded(new Set(rows.map(row => row.parentPath).filter(Boolean)))
      })
      .then(() => window.api.wikiSyncWorkspace(workspaceId))
      .then(() => Promise.all([
        window.api.wikiListWorkspaces(),
        window.api.wikiListItems(workspaceId),
        window.api.wikiGetGraph(workspaceId)
      ]))
      .then(([workspaceValue, itemValue, graphValue]) => {
        if (!active) return
        const workspaceRows = workspaceValue as Workspace[]
        const itemRows = itemValue as WikiItem[]
        setWorkspaces(workspaceRows)
        setItems(itemRows)
        setSelectedId(current => itemRows.some(row => row.id === current) ? current : itemRows[0]?.id || '')
        setExpanded(new Set(itemRows.map(row => row.parentPath).filter(Boolean)))
        setGraph(normalizeGraphData(graphValue))
      })
      .catch(reason => { if (active) setError(errorMessage(reason, '工作区自动同步失败，可以稍后手动重试。')) })
    return () => { active = false }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || !selectedId) {
      void window.api.wikiGetGraph(workspaceId).then(value => setGraph(normalizeGraphData(value)))
      return
    }
    let stale = false
    window.api.wikiReadItem(selectedId).then(async value => {
      if (stale || !value) return
      const next = value as WikiItem
      setItem(next); setDraft(next.content || ''); setSaved(next.content || ''); setMode('read')
      const detail = next.documentId ? await window.api.knowledgeGetDocument(next.documentId) : null
      if (!stale) setDoc(detail as DocDetail | null)
    }).catch(reason => { if (!stale) setError(errorMessage(reason, '无法读取页面。')) })
    void window.api.wikiGetGraph(workspaceId, selectedId).then(value => {
      if (!stale) setGraph(normalizeGraphData(value))
    })
    return () => { stale = true }
  }, [selectedId, workspaceId])

  useEffect(() => {
    if (progress?.status !== 'completed' || !item?.documentId || item.editable) return
    let active = true
    void window.api.knowledgeGetDocument(item.documentId)
      .then(value => { if (active) setDoc(value as DocDetail | null) })
      .catch(reason => { if (active) setError(errorMessage(reason, '解析完成，文档加载失败，请重新打开。')) })
    return () => { active = false }
  }, [progress?.status, progress?.updatedAt, item?.documentId, item?.editable])

  useEffect(() => {
    if (sideTab === 'history' && selectedId) {
      void window.api.wikiListRevisions(selectedId).then(value => setRevisions(value as Revision[]))
    }
  }, [saved, selectedId, sideTab])

  useEffect(() => {
    if (!resizingContext) return
    const handlePointerMove = (event: PointerEvent): void => {
      const { startX, startWidth } = resizeSessionRef.current
      setContextWidth(clampContextWidth(startWidth + startX - event.clientX))
    }
    const stopResize = (): void => {
      setResizingContext(false)
    }
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', stopResize, { once: true })
    document.addEventListener('pointercancel', stopResize, { once: true })
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', stopResize)
      document.removeEventListener('pointercancel', stopResize)
    }
  }, [clampContextWidth, resizingContext])

  useEffect(() => {
    if (!graphExpanded) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setGraphExpanded(false)
      window.requestAnimationFrame(() => graphExpandButtonRef.current?.focus())
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [graphExpanded])

  const resizeContextByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = contextWidth + step
    if (event.key === 'ArrowRight') next = contextWidth - step
    if (event.key === 'Home') next = 330
    if (event.key === 'End') next = 760
    if (next === null) return
    event.preventDefault()
    setContextWidth(clampContextWidth(next))
  }

  useEffect(() => {
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        setDialog(null)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') || [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previous?.focus()
    }
  }, [busy, dialog])

  const openItem = (id: string): void => {
    if (id === selectedId) return
    if (dirty) return setDialog({ type: 'discard', nextId: id })
    setHoveredGraphNode('')
    setSelectedId(id); setFolder('')
  }

  const openSource = async (source: Pick<SourceEvidence, 'resource'>): Promise<void> => {
    if (!workspaceId || sourceLoading) return
    const sourceItemId = selectedId
    setSourceLoading(source.resource)
    setSourceError(null)
    try {
      const preview = await window.api.wikiReadSource(workspaceId, source.resource) as SourcePreview
      setSourcePreview({ ...preview, itemId: sourceItemId })
    } catch (reason: unknown) {
      setSourcePreview(null)
      setSourceError({ itemId: sourceItemId, message: errorMessage(reason, '无法读取源码依据。') })
    } finally {
      setSourceLoading('')
    }
  }

  const openFolder = (path: string): void => {
    if (dirty) return setDialog({ type: 'discard', nextFolder: path })
    setHoveredGraphNode('')
    setFolder(path); setSelectedId('')
    setExpanded(current => {
      const next = new Set(current)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const openWorkspace = (id: string): void => {
    if (id === workspaceId) {
      setWorkspaceListOpen(false)
      return
    }
    if (dirty) return setDialog({ type: 'discard', nextWorkspaceId: id })
    setWorkspaceId(id); setWorkspaceListOpen(false)
  }

  const openWorkspaceList = (): void => {
    if (dirty) return setDialog({ type: 'discard', nextView: 'workspaces' })
    setWorkspaceListOpen(true)
  }

  const chooseWorkspace = async (): Promise<void> => {
    const id = await window.api.wikiOpenWorkspace()
    if (!id) return
    setWorkspaceListOpen(false)
    await loadWorkspaces(id)
    await sync(id)
  }

  const savePage = async (): Promise<void> => {
    if (!displayedItem?.editable || !dirty || saving) return
    setSaving(true)
    try {
      await window.api.wikiSavePage(displayedItem.id, draft)
      setSaved(draft); setMode('read')
      await Promise.all([loadItems(workspaceId, displayedItem.id), loadGraph(workspaceId, displayedItem.id)])
    } catch (reason: unknown) {
      setError(errorMessage(reason, '保存失败，编辑内容仍保留在页面中。'))
    } finally { setSaving(false) }
  }

  const submitDialog = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!dialog || busy) return
    if (dialog.type === 'discard') {
      setDialog(null); setDraft(saved); setMode('read'); setHoveredGraphNode('')
      if (dialog.nextView === 'workspaces') setWorkspaceListOpen(true)
      else if (dialog.nextWorkspaceId) { setWorkspaceId(dialog.nextWorkspaceId); setWorkspaceListOpen(false) }
      else if (dialog.nextFolder !== undefined) { setFolder(dialog.nextFolder); setSelectedId('') }
      else if (dialog.nextId) { setSelectedId(dialog.nextId); setFolder('') }
      return
    }
    setBusy(true)
    try {
      if (dialog.type === 'create') {
        if (!dialogValue.trim()) return
        const id = await window.api.wikiCreatePage(workspaceId, dialogValue.trim(), dialog.parentPath)
        setDialog(null); setDialogValue('')
        await Promise.all([loadWorkspaces(workspaceId), loadItems(workspaceId, id)])
        setSelectedId(id)
      } else if (dialog.type === 'delete-item') {
        await window.api.wikiDeleteItem(dialog.item.id)
        setDialog(null)
        if (dialog.item.id === selectedId) {
          setItem(null)
          setDoc(null)
          setDraft('')
          setSaved('')
          setMode('read')
          setSelectedId('')
        }
        await Promise.all([loadWorkspaces(workspaceId), loadItems(workspaceId)])
        await loadGraph(workspaceId)
      } else {
        await window.api.wikiRemoveWorkspace(dialog.workspace.id)
        setDialog(null); setWorkspaceId(''); setSelectedId(''); await loadWorkspaces()
      }
    } catch (reason: unknown) {
      setError(errorMessage(reason, '操作失败，请稍后重试。'))
    } finally { setBusy(false) }
  }

  const renderTree = (nodes: TreeNode[], depth = 0): React.ReactNode => nodes.map(node => node.kind === 'folder' ? (
    <React.Fragment key={node.id}>
      <button type="button" className={`wiki-tree-row folder ${folder === node.path ? 'active' : ''}`} style={{ '--wiki-depth': depth } as React.CSSProperties} onClick={() => openFolder(node.path)} aria-expanded={expanded.has(node.path)}>
        <span className="wiki-disclosure">{expanded.has(node.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        {expanded.has(node.path) ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{node.name}</span><small>{node.children.length}</small>
      </button>
      {expanded.has(node.path) && renderTree(node.children, depth + 1)}
    </React.Fragment>
  ) : (
    <div key={node.id} className={`wiki-tree-file${selectedId === node.item!.id ? ' active' : ''}`} style={{ '--wiki-depth': depth } as React.CSSProperties}>
      <button type="button" className="wiki-tree-row file" onClick={() => openItem(node.item!.id)} title={node.item!.relativePath}>
        {icon(node.item!.fileType, 16, node.name)}<span>{node.name}</span>{node.item!.itemKind === 'page' && <i>W</i>}
      </button>
      <button type="button" className="wiki-item-remove" aria-label={`删除 ${node.name}`} title={`移入回收站：${node.name}`} onClick={(e) => { e.stopPropagation(); setDialog({ type: 'delete-item', item: node.item! }) }}><Trash2 size={13} /></button>
    </div>
  ))

  const percent = progress?.total ? Math.round((progress.completed + progress.failed) / progress.total * 100) : 0
  const contentNodes = (doc?.nodes || []).filter(node => node.type !== 'document').slice(0, 180)

  if (loading) return <div className="wiki-loading"><LoaderCircle className="wiki-spin" size={18} />正在打开 Wiki</div>

  const showWorkspaceList = workspaceListOpen && workspaces.length > 0
  const showOnboarding = !workspace && workspaces.length === 0
  const shouldShowParserCard = !parserDismissed && Boolean(
    parserComponent && (
      parserInstalling ||
      parserComponent.status === 'installing' ||
      parserComponent.status === 'not-installed' ||
      parserComponent.status === 'failed' ||
      showReadyBriefly
    )
  )

  return <div className={`wiki-page${showOnboarding ? ' is-onboarding-view' : ''}${showWorkspaceList ? ' is-workspace-list-view' : ''}`}>
    {shouldShowParserCard && (
      <section className="wiki-parser-component" aria-label="文档解析组件" aria-busy={parserInstalling || parserComponent?.status === 'installing'}>
        <div className="wiki-parser-card-body" aria-live="polite">
          <div className="wiki-parser-card-header">
            <strong>增强 PDF 解析</strong>
            <button
              type="button"
              className="wiki-parser-close"
              aria-label="关闭提示"
              title="关闭提示"
              onClick={() => setParserDismissed(true)}
            >
              <X size={13} />
            </button>
          </div>
          <span>{parserComponent?.detail || '正在检查文档解析组件…'}</span>
          {parserComponent?.status === 'not-installed' && (
            <small>首次下载包含 Python、Docling 和模型，需要网络连接及数 GB 可用磁盘空间。文档在本机处理。</small>
          )}
        </div>
        <div className="wiki-parser-actions">
          <button
            type="button"
            className={`wiki-parser-btn${parserComponent?.status === 'ready' ? ' ready' : ''}`}
            disabled={!parserComponent || parserInstalling || ['installing', 'ready', 'unsupported'].includes(parserComponent.status)}
            onClick={() => void installParser()}
          >
            {parserInstalling || parserComponent?.status === 'installing' ? (
              <LoaderCircle className="wiki-spin" size={13} />
            ) : parserComponent?.status === 'ready' ? (
              <Check size={13} />
            ) : (
              <Download size={13} />
            )}
            {parserInstalling || parserComponent?.status === 'installing'
              ? '正在下载组件'
              : parserComponent?.status === 'ready'
                ? '组件已就绪'
                : parserComponent?.status === 'failed'
                  ? '重试下载组件'
                  : '下载文档解析组件'}
          </button>
        </div>
      </section>
    )}
    {!showWorkspaceList && <header className={`wiki-header ${showOnboarding ? 'is-onboarding' : ''}`}>
      {workspace ? (
        <div className="wiki-brand">
          <button type="button" className="wiki-back-button" aria-label="返回工作区列表" title="返回工作区列表" onClick={openWorkspaceList}><ArrowLeft size={16} /></button>
          <h1 title={workspace.rootPath}>{workspace.name}</h1>
        </div>
      ) : <div className="wiki-brand-empty" />}
      <div className="wiki-header-actions">
        {workspace && <button type="button" onClick={() => void window.api.showItemInFolder(workspace.rootPath)}><FolderOpen size={14} />打开目录</button>}
        {workspace && <button type="button" disabled={progress?.status === 'running'} onClick={() => void sync(workspace.id)}><RefreshCw className={progress?.status === 'running' ? 'wiki-spin' : ''} size={14} />同步</button>}
        {workspace && <button type="button" className="wiki-btn-open-ws primary" onClick={() => void chooseWorkspace()}><Plus size={14} />添加工作区</button>}
      </div>
    </header>}
    {error && <div className="wiki-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button type="button" aria-label="关闭错误" onClick={() => setError('')}><X size={14} /></button></div>}
    {showWorkspaceList ? (
      <main className="wiki-workspace-list-view">
        <div className="wiki-workspace-list-heading">
          <div><h1>工作区</h1><p>选择一个工作区继续浏览，或添加新的本地文件夹。</p></div>
          <button type="button" className="wiki-workspace-add primary" onClick={() => void chooseWorkspace()}><Plus size={15} />添加工作区</button>
        </div>
        <section className="wiki-workspace-list" aria-label="工作区列表">
          {workspaces.map(entry => <div className={`wiki-workspace-row${entry.id === workspaceId ? ' active' : ''}`} key={entry.id}>
            <button type="button" className="wiki-workspace-main" onClick={() => openWorkspace(entry.id)} title={entry.rootPath}><span><FolderOpen size={16} /></span><span><strong>{entry.name}</strong><small>{entry.itemCount} 项 · {entry.pageCount} 页面</small></span><ChevronRight size={15} /></button>
            <button type="button" className="wiki-workspace-remove" aria-label={`移除 ${entry.name}`} title={`移除工作区：${entry.name}`} onClick={() => setDialog({ type: 'remove', workspace: entry })}><Trash2 size={14} /></button>
          </div>)}
        </section>
      </main>
    ) : showOnboarding ? (
      <main className="wiki-onboarding">
        <div className="wiki-hero-network" aria-hidden="true">
          <svg className="wiki-network-svg" viewBox="0 0 460 170" fill="none">
            <defs>
              <linearGradient id="wikiLineGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--wiki-accent)" stopOpacity="0.4" />
                <stop offset="100%" stopColor="var(--wiki-cyan)" stopOpacity="0.2" />
              </linearGradient>
              <linearGradient id="wikiLineGrad2" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="var(--wiki-accent)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--wiki-amber)" stopOpacity="0.25" />
              </linearGradient>
              <radialGradient id="wikiCoreGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="var(--wiki-accent)" stopOpacity="0.2" />
                <stop offset="100%" stopColor="var(--wiki-accent)" stopOpacity="0" />
              </radialGradient>
            </defs>
            <path d="M 80,115 Q 150,55 230,85" stroke="url(#wikiLineGrad1)" strokeWidth="1.2" strokeDasharray="3 3" />
            <path d="M 230,85 Q 310,115 380,65" stroke="url(#wikiLineGrad1)" strokeWidth="1.2" />
            <path d="M 140,135 L 230,85" stroke="var(--border-color)" strokeWidth="1" opacity="0.6" />
            <path d="M 230,85 L 310,38" stroke="url(#wikiLineGrad2)" strokeWidth="1" />
            <path d="M 230,85 L 285,135" stroke="var(--border-color)" strokeWidth="1" strokeDasharray="2 2" opacity="0.7" />
            <path d="M 80,115 L 140,135" stroke="var(--border-color)" strokeWidth="0.8" opacity="0.5" />
            <path d="M 310,38 L 380,65" stroke="var(--border-color)" strokeWidth="0.8" opacity="0.5" />
            <path d="M 285,135 L 380,65" stroke="var(--border-color)" strokeWidth="0.8" opacity="0.5" />

            <circle cx="230" cy="85" r="32" fill="url(#wikiCoreGlow)" className="wiki-core-pulse" />

            <g className="wiki-node" transform="translate(80, 115)">
              <circle r="4" fill="var(--bg-content)" stroke="var(--text-muted)" strokeWidth="1.5" />
            </g>
            <g className="wiki-node" transform="translate(140, 135)">
              <circle r="3" fill="var(--bg-content)" stroke="var(--text-muted)" strokeWidth="1.5" />
            </g>
            <g className="wiki-node" transform="translate(310, 38)">
              <circle r="3.5" fill="var(--bg-content)" stroke="var(--wiki-cyan)" strokeWidth="1.5" />
            </g>
            <g className="wiki-node" transform="translate(285, 135)">
              <circle r="3" fill="var(--bg-content)" stroke="var(--wiki-amber)" strokeWidth="1.5" />
            </g>
            <g className="wiki-node" transform="translate(380, 65)">
              <circle r="4.5" fill="var(--bg-content)" stroke="var(--wiki-accent)" strokeWidth="1.5" />
              <circle r="9" fill="none" stroke="var(--wiki-accent)" strokeWidth="0.75" opacity="0.35" />
            </g>

            <g className="wiki-node-core" transform="translate(230, 85)">
              <circle r="13" fill="none" stroke="var(--wiki-accent)" strokeWidth="1" opacity="0.25" className="wiki-ring-spin" />
              <circle r="5.5" fill="var(--bg-content)" stroke="var(--wiki-accent)" strokeWidth="1.75" />
              <circle r="2" fill="var(--wiki-accent)" />
            </g>
          </svg>
        </div>

        <h2 className="wiki-onboarding-title">让一个文件夹，长成一张知识地图</h2>
        <p className="wiki-onboarding-desc">
          Markdown 是可编辑页面，PDF、Word、表格和演示文稿是可引用来源。<br />
          原始文件完整保留在本地，无专有格式锁定。
        </p>

        <div className="wiki-onboarding-cta-wrap">
          <button type="button" className="wiki-btn-hero" onClick={() => void chooseWorkspace()}>
            <FolderOpen size={16} />
            <span>选择本地文件夹</span>
          </button>
          <span className="wiki-onboarding-hint">支持已有本地笔记目录，原始文件保持原样</span>
        </div>
      </main>
    ) : workspace ? (
      <div
        ref={workbenchRef}
        className={`wiki-workbench${resizingContext ? ' is-resizing' : ''}${graphExpanded ? ' is-graph-expanded' : ''}`}
        style={{ '--wiki-context-width': `${contextWidth}px` } as React.CSSProperties}
      >
        <aside className="wiki-sidebar" aria-label="Wiki 文件树">
          <div className="wiki-search"><Search size={14} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索页面与文件" aria-label="搜索页面与文件" />{query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); searchRef.current?.focus() }}><X size={13} /></button>}</div>
          <div className="wiki-tree">{query ? (matches.length ? matches.map(match => <div className="wiki-search-row" key={match.id}><button type="button" className="wiki-search-result" onClick={() => openItem(match.id)}>{icon(match.fileType, 16, match.relativePath || match.title)}<span><strong>{match.title}</strong><small>{match.relativePath}</small></span></button><button type="button" className="wiki-item-remove" aria-label={`删除 ${match.title}`} title={`移入回收站：${match.title}`} onClick={(e) => { e.stopPropagation(); setDialog({ type: 'delete-item', item: match }) }}><Trash2 size={13} /></button></div>) : <div className="wiki-empty-small">没有匹配结果</div>) : tree.length ? renderTree(tree) : <div className="wiki-empty-small">文件夹中还没有支持的文档</div>}</div>
        </aside>
        <main className="wiki-content">
          {progress?.status === 'running' && <div className="wiki-sync" role="status"><span style={{ width: `${percent}%` }} /><LoaderCircle className="wiki-spin" size={14} /><strong>正在建立索引</strong><small>{progress.currentFile || '准备文件'} · {progress.completed}/{progress.total}</small></div>}
          {displayedItem ? <><div className="wiki-toolbar"><div><strong title={displayedItem.relativePath}>{displayedItem.title}</strong></div><div><span className={dirty ? 'dirty' : ''}>{saving ? '保存中' : dirty ? '尚未保存' : <><Check size={12} />已保存</>}</span>{displayedItem.editable ? mode === 'read' ? <button type="button" onClick={() => setMode('edit')}><Pencil size={14} />编辑</button> : <><button type="button" onClick={() => { setDraft(saved); setMode('read') }}>取消</button><button type="button" className="primary" disabled={!dirty || saving} onClick={() => void savePage()}><Save size={14} />保存</button></> : <button type="button" onClick={() => void window.api.openLocalFile(`local-file:///${displayedItem.absolutePath.replace(/\\/g, '/')}`)}><ExternalLink size={14} />打开原文件</button>}</div></div>
            <div className="wiki-document"><section className="wiki-document-title"><h2>{displayedItem.title}</h2></section>{mode === 'edit' ? <textarea className="wiki-editor" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} aria-label={`编辑 ${displayedItem.title}`} /> : displayedItem.editable ? <MarkdownView content={saved} currentPath={displayedItem.relativePath} items={items} open={openItem} /> : <section className="wiki-source">{doc?.document.warning && <div className="wiki-source-warning"><AlertTriangle size={15} />{doc.document.warning}</div>}<div className="wiki-source-meta"><span>解析器：{doc?.document.parser || '等待解析'}</span><span>{contentNodes.length} 个结构节点</span></div>{contentNodes.map(node => <article key={node.id}><div><span>{node.type}</span>{node.pageStart && <small>第 {node.pageStart} 页</small>}</div>{node.title && <h3>{node.title}</h3>}{node.content && node.content !== node.title && <p>{node.content}</p>}</article>)}</section>}</div></> :
            <section className="wiki-folder-view"><div><FolderOpen size={22} /><span><small>FOLDER VIEW</small><h2>{folder || workspace.name}</h2><p>{folderItems.length} 个直接内容项</p></span></div><section>{folderItems.map(entry => <button type="button" key={entry.id} onClick={() => openItem(entry.id)}>{icon(entry.fileType, 18, entry.relativePath || entry.title)}<span><strong>{entry.title}</strong><small>{entry.fileType.toUpperCase()} · {formatBytes(entry.fileSize)}</small></span><ChevronRight size={14} /></button>)}</section></section>}
        </main>
        <div
          className="wiki-context-resizer"
          role="separator"
          tabIndex={0}
          aria-label="调整关系面板宽度"
          aria-orientation="vertical"
          aria-valuemin={260}
          aria-valuemax={760}
          aria-valuenow={Math.round(contextWidth)}
          title="左右拖动调整宽度；双击还原"
          onPointerDown={event => {
            event.preventDefault()
            resizeSessionRef.current = { startX: event.clientX, startWidth: contextWidth }
            setResizingContext(true)
          }}
          onDoubleClick={() => setContextWidth(clampContextWidth(330))}
          onKeyDown={resizeContextByKeyboard}
        ><span /></div>
        <aside className={`wiki-context${graphExpanded ? ' is-graph-expanded' : ''}`} aria-label={graphExpanded ? '放大的 Wiki 图谱' : 'Wiki 关系面板'}>
          <div className="wiki-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={sideTab === 'graph'} className={sideTab === 'graph' ? 'active' : ''} onClick={() => setSideTab('graph')}><Network size={14} />图谱</button>
            <button type="button" role="tab" aria-selected={sideTab === 'links'} className={sideTab === 'links' ? 'active' : ''} onClick={() => { setGraphExpanded(false); setSideTab('links') }}><Link2 size={14} />关联</button>
            <button type="button" role="tab" aria-selected={sideTab === 'history'} className={sideTab === 'history' ? 'active' : ''} onClick={() => { setGraphExpanded(false); setSideTab('history') }}><History size={14} />历史</button>
          </div>
          {sideTab === 'graph' ? (
            <div className="wiki-graph" ref={graphContainerRef}>
              <button
                ref={graphExpandButtonRef}
                type="button"
                className="wiki-graph-expand"
                aria-label={graphExpanded ? '还原图谱面板' : '放大图谱'}
                aria-pressed={graphExpanded}
                title={graphExpanded ? '还原图谱（Esc）' : '放大图谱'}
                onClick={() => setGraphExpanded(current => !current)}
              >{graphExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
              <div className="wiki-legend" aria-label="图谱节点颜色说明">
                <span title="当前选中节点"><i className="selected" />选中</span>
                <span title="Wiki 页面"><i className="page" />页面</span>
                <span title="正文实体"><i className="entity" />实体</span>
                <span title="结构文档"><i className="document" />文档</span>
                <span title="源码依据"><i className="source" />源码</span>
              </div>
              {graph.nodes.length ? (
                <ReactFlow
                  key={graphExpanded ? 'wiki-graph-wide' : 'wiki-graph-compact'}
                  nodes={animatedNodes}
                  edges={graphElements.edges}
                  nodeTypes={wikiGraphNodeTypes}
                  onInit={instance => {
                    flowInstanceRef.current = instance
                    centerGraphViewport(graphElements.nodes, false)
                  }}
                  onNodeMouseEnter={(_, node) => handleGraphNodeEnter(node.id)}
                  onNodeMouseLeave={(_, node) => handleGraphNodeLeave(node.id)}
                  onNodeClick={(_, node) => {
                    setHoveredGraphNode('')
                    setFocusedGraphNodeId(node.id)
                    if (typeof node.data.itemId === 'string') openItem(node.data.itemId)
                    else if (typeof node.data.resource === 'string') {
                      setGraphExpanded(false)
                      setSideTab('links')
                      void openSource({ resource: node.data.resource })
                    }
                  }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  edgesReconnectable={false}
                  fitView
                  fitViewOptions={{ padding: graphExpanded ? .12 : .2, maxZoom: graphExpanded ? 1.2 : 1.1 }}
                  minZoom={.18}
                  maxZoom={2.4}
                  deleteKeyCode={null}
                >
                  <Controls showInteractive={false} />
                </ReactFlow>
              ) : <div className="wiki-context-empty"><Network size={24} /><strong>还没有可展示的关系</strong><span>页面链接、源码依据和正文实体会在同步后出现在这里。</span></div>}
            </div>
          ) : sideTab === 'links' ? (
            <div className="wiki-link-list">
              <header><small>源码依据</small><strong>{sourceGroups.length}</strong></header>
              {sourceGroups.map(source => <button type="button" className={`wiki-evidence-row${visibleSourcePreview?.resource === source.resource ? ' active' : ''}`} key={source.resource} onClick={() => void openSource(source)} disabled={source.status === 'missing'}>
                {sourceLoading === source.resource ? <LoaderCircle className="wiki-spin" size={15} /> : <FileIcon fileName={source.relativePath} size={15} />}
                <span><strong>{source.relativePath}</strong><small>{source.startLine ? `第 ${source.startLine}-${source.endLine} 行` : '整个文件'}{source.claimCount ? ` · ${source.claimCount} 条事实` : ''}{source.status === 'verified' ? ' · 有验证记录' : source.status === 'missing' ? ' · 文件缺失' : ''}</small>{source.statements[0] && <p>{source.statements[0]}</p>}</span>
              </button>)}
              {!sourceGroups.length && <div className="wiki-evidence-empty"><FileCode2 size={17} /><span>当前页面没有 repo:// 源码依据。OpenWiki 项目请添加仓库根目录。</span></div>}
              {visibleSourceError && <div className="wiki-source-preview-error" role="alert"><AlertTriangle size={14} />{visibleSourceError}</div>}
              {visibleSourcePreview && <section className="wiki-source-preview" aria-label={`源码预览：${visibleSourcePreview.relativePath}`}>
                <div className="wiki-source-preview-head"><span><strong>{visibleSourcePreview.relativePath}</strong><small>{visibleSourcePreview.startLine ? `定位到第 ${visibleSourcePreview.startLine}-${visibleSourcePreview.endLine} 行` : `显示前 ${visibleSourcePreview.excerptEnd} 行`}</small></span><button type="button" aria-label="在文件夹中显示源码" title="在文件夹中显示" onClick={() => void window.api.showItemInFolder(visibleSourcePreview.absolutePath)}><ExternalLink size={13} /></button></div>
                <pre>{visibleSourcePreview.lines.map(line => <code className={visibleSourcePreview.startLine && line.number >= visibleSourcePreview.startLine && line.number <= (visibleSourcePreview.endLine || visibleSourcePreview.startLine) ? 'focused' : ''} key={line.number}><span>{line.number}</span>{line.text || ' '}</code>)}</pre>
                {visibleSourcePreview.truncated && <small className="wiki-source-preview-note">这里只显示关联位置附近的内容，共 {visibleSourcePreview.totalLines} 行。</small>}
              </section>}
              <header><small>正文实体</small><strong>{graph.entities.length}</strong></header>
              {graph.entities.map(entity => <div className="wiki-entity-row" key={entity.id}><span>{entity.type === 'technology' ? 'T' : 'C'}</span><div><strong>{entity.name}</strong><small>{entity.type === 'technology' ? '技术实体' : '概念'} · 提及 {entity.mentionCount} 次</small>{entity.evidence[0] && <p>{entity.evidence[0]}</p>}</div></div>)}
              {!graph.entities.length && <div className="wiki-context-empty compact"><Network size={20} /><span>当前文章尚未提取到可靠实体。</span></div>}
              {graph.relatedItems.length > 0 && <><header><small>相关页面</small><strong>{graph.relatedItems.length}</strong></header>{graph.relatedItems.map(related => <button type="button" key={related.id} onClick={() => openItem(related.id)}>{icon(related.fileType, 15, related.relativePath || related.title)}<span><strong>{related.title}</strong><small>{related.directLink ? '直接文档链接' : related.sharedSources.length ? `共同来源：${related.sharedSources.join('、')}` : `共同实体：${related.sharedEntities.join('、')}`}</small></span></button>)}</>}
              {graph.backlinks.length > 0 && <><header><small>反向链接</small><strong>{graph.backlinks.length}</strong></header>{graph.backlinks.map(backlink => <button type="button" key={backlink.id} onClick={() => openItem(backlink.id)}>{icon(backlink.fileType, 15, backlink.relativePath || backlink.title)}<span><strong>{backlink.title}</strong><small>{backlink.relativePath}</small></span></button>)}</>}
              {graph.unresolved.length > 0 && <><header><small>待创建人工链接</small><strong>{graph.unresolved.length}</strong></header>{graph.unresolved.map(link => <div className="wiki-unresolved" key={link.id}><span>[[{link.targetText}]]</span><button type="button" onClick={() => { setDialogValue(link.targetText); setDialog({ type: 'create', parentPath: displayedItem?.parentPath || '' }) }}><Plus size={12} />创建</button></div>)}</>}
            </div>
          ) : <div className="wiki-history"><header><small>保存记录</small><strong>{revisions.length}</strong></header>{revisions.map(revision => <div key={revision.id}><Clock3 size={14} /><span><strong>{new Date(revision.createdAt).toLocaleString('zh-CN')}</strong><small>{revision.characterCount} 字符</small></span></div>)}{!revisions.length && <div className="wiki-context-empty compact"><History size={20} /><span>保存页面后，这里会保留版本记录。</span></div>}</div>}
        </aside>
      </div>
    ) : null}
    {dialog && <div className="wiki-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setDialog(null) }}><form ref={dialogRef} className="wiki-dialog" role="dialog" aria-modal="true" aria-labelledby="wiki-dialog-title" onSubmit={event => void submitDialog(event)} noValidate><span className={dialog.type === 'remove' || dialog.type === 'delete-item' ? 'danger' : ''}>{dialog.type === 'create' ? <FileText size={20} /> : dialog.type === 'discard' ? <AlertTriangle size={20} /> : <Trash2 size={20} />}</span><div><h2 id="wiki-dialog-title">{dialog.type === 'create' ? '新建 Wiki 页面' : dialog.type === 'discard' ? '放弃未保存修改？' : dialog.type === 'delete-item' ? `删除 ${dialog.item.title}？` : '移除工作区？'}</h2><p>{dialog.type === 'create' ? `页面将保存到 ${dialog.parentPath || '工作区根目录'}。` : dialog.type === 'discard' ? '切换后无法恢复尚未保存的内容。' : dialog.type === 'delete-item' ? `本地文件 ${dialog.item.relativePath} 将移入系统回收站，关联索引也会更新。` : '只移除 AgentPet 中的索引，不会删除原始文件。'}</p>{dialog.type === 'create' && <><label htmlFor="wiki-title">页面标题</label><input id="wiki-title" autoFocus value={dialogValue} onChange={event => setDialogValue(event.target.value)} aria-invalid={!dialogValue.trim()} /></>}</div><footer><button type="button" autoFocus={dialog.type !== 'create'} onClick={() => setDialog(null)}>取消</button><button type="submit" className={dialog.type === 'create' ? 'primary' : 'danger'} disabled={busy || (dialog.type === 'create' && !dialogValue.trim())}>{busy && <LoaderCircle className="wiki-spin" size={14} />}{dialog.type === 'create' ? '创建页面' : dialog.type === 'discard' ? '放弃并切换' : dialog.type === 'delete-item' ? '移入回收站' : '移除工作区'}</button></footer></form></div>}
  </div>
}

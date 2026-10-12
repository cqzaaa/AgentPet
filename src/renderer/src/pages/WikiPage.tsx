import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, Controls, ReactFlow, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Clock3, ExternalLink, File,
  FileSpreadsheet, FileText, Folder, FolderOpen, History, Link2, LoaderCircle,
  Maximize2, Minimize2, Network, Pencil, Plus, RefreshCw, Save, Search, Trash2, X
} from 'lucide-react'
import './WikiPage.css'

type Workspace = { id: string; name: string; rootPath: string; itemCount: number; pageCount: number }
type WikiItem = {
  id: string; workspaceId: string; documentId: string; relativePath: string; absolutePath: string
  parentPath: string; title: string; itemKind: 'page' | 'document'; fileType: string
  editable: number; fileSize: number; modifiedAt: number; content?: string
}
type DocNode = { id: string; type: string; title: string; content: string; pageStart: number | null }
type DocDetail = { document: { parser: string; warning: string }; nodes: DocNode[] }
type GraphData = {
  nodes: Array<{ id: string; itemId: string | null; label: string; kind: string; entityType?: string; fileType: string; relativePath: string }>
  edges: Array<{ id: string; source: string; target: string; kind: string; weight?: number }>
  entities: Array<{ id: string; name: string; type: string; mentionCount: number; confidence: number; evidence: string[] }>
  relatedItems: Array<{ id: string; title: string; relativePath: string; fileType: string; sharedEntities: string[] }>
  backlinks: Array<{ id: string; title: string; relativePath: string; fileType: string }>
  unresolved: Array<{ id: string; fromItemId: string; targetText: string }>
}
type SyncProgress = { workspaceId: string; status: 'running' | 'completed'; total: number; completed: number; failed: number; currentFile: string }
type TreeNode = { id: string; name: string; path: string; kind: 'folder' | 'file'; item?: WikiItem; children: TreeNode[] }
type Revision = { id: string; createdAt: number; characterCount: number }
type Dialog = { type: 'create'; parentPath: string }
  | { type: 'remove'; workspace: Workspace }
  | { type: 'delete-item'; item: WikiItem }
  | { type: 'discard'; nextId?: string; nextWorkspaceId?: string; nextFolder?: string }

const emptyGraph: GraphData = { nodes: [], edges: [], entities: [], relatedItems: [], backlinks: [], unresolved: [] }

function normalizeGraphData(value: unknown): GraphData {
  const graph = value && typeof value === 'object' ? value as Partial<GraphData> : {}
  return {
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    entities: Array.isArray(graph.entities) ? graph.entities : [],
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

function icon(type: string, size = 15): React.JSX.Element {
  if (['xlsx', 'xls', 'csv'].includes(type)) return <FileSpreadsheet size={size} />
  if (['md', 'txt'].includes(type)) return <FileText size={size} />
  return <File size={size} />
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

function InlineText({ text, items, open }: { text: string; items: WikiItem[]; open: (id: string) => void }): React.JSX.Element {
  return <>{text.split(/(\[\[[^\]]+\]\])/g).filter(Boolean).map((part, index) => {
    if (!part.startsWith('[[')) return <React.Fragment key={index}>{part}</React.Fragment>
    const raw = part.slice(2, -2)
    const target = raw.split('|')[0].split('#')[0].trim().toLocaleLowerCase('zh-CN')
    const item = items.find(candidate => candidate.title.toLocaleLowerCase('zh-CN') === target || candidate.relativePath.replace(/\.[^.]+$/, '').toLocaleLowerCase('zh-CN') === target)
    return item
      ? <button type="button" className="wiki-inline-link" key={index} onClick={() => open(item.id)}><Link2 size={12} />{raw.split('|')[1] || raw}</button>
      : <span className="wiki-inline-link unresolved" key={index}>{raw}</span>
  })}</>
}

function MarkdownView({ content, items, open }: { content: string; items: WikiItem[]; open: (id: string) => void }): React.JSX.Element {
  return <article className="wiki-markdown">{content.replace(/\r/g, '').split('\n').map((line, index) => {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      const children = <InlineText text={heading[2]} items={items} open={open} />
      if (heading[1].length === 1) return <h1 key={index}>{children}</h1>
      if (heading[1].length === 2) return <h2 key={index}>{children}</h2>
      return <h3 key={index}>{children}</h3>
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line)
    if (bullet) return <div className="wiki-markdown-bullet" key={index}><i /><InlineText text={bullet[1]} items={items} open={open} /></div>
    if (line.startsWith('> ')) return <blockquote key={index}><InlineText text={line.slice(2)} items={items} open={open} /></blockquote>
    return line.trim() ? <p key={index}><InlineText text={line} items={items} open={open} /></p> : <div className="wiki-markdown-space" key={index} />
  })}</article>
}

function layoutGraph(data: GraphData, focusId: string): { nodes: Node[]; edges: Edge[] } {
  const focus = data.nodes.find(node => node.id === focusId)
  const entities = data.nodes.filter(node => node.kind === 'entity')
  const relatedItems = data.nodes.filter(node => node.kind !== 'entity' && node.id !== focusId)
  const ordered = focus ? [focus, ...entities, ...relatedItems] : [...entities, ...relatedItems]
  const entityCount = Math.max(1, entities.length)
  const relatedCount = Math.max(1, relatedItems.length)
  return {
    nodes: ordered.map(item => {
      const center = item.id === focusId
      const entityIndex = entities.findIndex(entity => entity.id === item.id)
      const relatedIndex = relatedItems.findIndex(related => related.id === item.id)
      const angle = entityIndex >= 0
        ? entityIndex / entityCount * Math.PI * 2 - Math.PI / 2
        : relatedIndex / relatedCount * Math.PI * 2 - Math.PI / 2
      const radius = entityIndex >= 0 ? 155 : 280
      return {
        id: item.id,
        position: center ? { x: 0, y: 0 } : { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
        data: { label: item.label, itemId: item.itemId, entityType: item.entityType },
        draggable: false,
        className: `wiki-graph-node ${item.kind}${center ? ' current' : ''}`,
        style: { width: center ? 132 : item.kind === 'entity' ? 92 : 112 }
      }
    }),
    edges: data.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'straight',
      className: `wiki-graph-edge ${edge.kind}`,
      style: { strokeWidth: Math.min(2.8, 1 + Math.log2((edge.weight || 1) + 1) * 0.45) }
    }))
  }
}

export function WikiPage(): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
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
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  const [sideTab, setSideTab] = useState<'graph' | 'links' | 'history'>('graph')
  const [contextWidth, setContextWidth] = useState(330)
  const [resizingContext, setResizingContext] = useState(false)
  const [graphExpanded, setGraphExpanded] = useState(false)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const graphFlowRef = useRef<ReactFlowInstance | null>(null)
  const graphExpandButtonRef = useRef<HTMLButtonElement>(null)
  const resizeSessionRef = useRef({ startX: 0, startWidth: 330 })

  const workspace = workspaces.find(entry => entry.id === workspaceId)
  const displayedItem = item?.id === selectedId ? item : null
  const dirty = mode === 'edit' && draft !== saved
  const tree = useMemo(() => makeTree(items), [items])
  const graphElements = useMemo(() => layoutGraph(graph, selectedId), [graph, selectedId])
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

  const fitGraph = useCallback((): void => {
    window.requestAnimationFrame(() => {
      void graphFlowRef.current?.fitView({ padding: graphExpanded ? .14 : .22, maxZoom: graphExpanded ? 1.35 : 1.2, duration: 180 })
    })
  }, [graphExpanded])

  const sync = useCallback(async (id: string) => {
    try {
      setError('')
      await window.api.wikiSyncWorkspace(id)
      await Promise.all([loadWorkspaces(id), loadItems(id)])
      await loadGraph(id, selectedId || undefined)
    } catch (reason: unknown) {
      setError(errorMessage(reason, '无法同步工作区，请确认文件夹仍然存在。'))
    }
  }, [loadGraph, loadItems, loadWorkspaces, selectedId])

  useEffect(() => {
    document.title = 'Wiki 工作区 | AgentPet'
    let active = true
    void window.api.wikiListWorkspaces()
      .then(value => {
        if (!active) return
        const rows = value as Workspace[]
        setWorkspaces(rows)
        setWorkspaceId(rows[0]?.id || '')
      })
      .catch(reason => { if (active) setError(errorMessage(reason, '无法读取 Wiki 工作区。')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => window.api.onWikiSyncProgress(value => {
    const next = value as SyncProgress
    if (next.workspaceId === workspaceId) setProgress(next)
  }), [workspaceId])

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
      fitGraph()
    }
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', stopResize, { once: true })
    document.addEventListener('pointercancel', stopResize, { once: true })
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', stopResize)
      document.removeEventListener('pointercancel', stopResize)
    }
  }, [clampContextWidth, fitGraph, resizingContext])

  useEffect(() => {
    fitGraph()
    if (!graphExpanded) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setGraphExpanded(false)
      window.requestAnimationFrame(() => graphExpandButtonRef.current?.focus())
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [fitGraph, graphExpanded])

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
    fitGraph()
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
    setSelectedId(id); setFolder('')
  }

  const openFolder = (path: string): void => {
    if (dirty) return setDialog({ type: 'discard', nextFolder: path })
    setFolder(path); setSelectedId('')
    setExpanded(current => {
      const next = new Set(current)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const openWorkspace = (id: string): void => {
    if (id === workspaceId) return
    if (dirty) return setDialog({ type: 'discard', nextWorkspaceId: id })
    setWorkspaceId(id)
  }

  const chooseWorkspace = async (): Promise<void> => {
    const id = await window.api.wikiOpenWorkspace()
    if (!id) return
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
      setDialog(null); setDraft(saved); setMode('read')
      if (dialog.nextWorkspaceId) setWorkspaceId(dialog.nextWorkspaceId)
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
        <span className="wiki-disclosure" />{icon(node.item!.fileType)}<span>{node.name}</span>{node.item!.itemKind === 'page' && <i>W</i>}
      </button>
      <button type="button" className="wiki-item-remove" aria-label={`删除 ${node.name}`} title={`移入回收站：${node.name}`} onClick={(e) => { e.stopPropagation(); setDialog({ type: 'delete-item', item: node.item! }) }}><Trash2 size={13} /></button>
    </div>
  ))

  const percent = progress?.total ? Math.round((progress.completed + progress.failed) / progress.total * 100) : 0
  const contentNodes = (doc?.nodes || []).filter(node => node.type !== 'document').slice(0, 180)

  if (loading) return <div className="wiki-loading"><LoaderCircle className="wiki-spin" size={18} />正在打开 Wiki</div>

  return <div className={`wiki-page ${!workspace ? 'is-onboarding-view' : ''}`}>
    <header className={`wiki-header ${!workspace ? 'is-onboarding' : ''}`}>
      {workspace ? (
        <div className="wiki-brand"><h1 title={workspace.rootPath}>{workspace.name}</h1></div>
      ) : <div className="wiki-brand-empty" />}
      <div className="wiki-header-actions">
        {workspace && <button type="button" onClick={() => void window.api.showItemInFolder(workspace.rootPath)}><FolderOpen size={14} />打开目录</button>}
        {workspace && <button type="button" disabled={progress?.status === 'running'} onClick={() => void sync(workspace.id)}><RefreshCw className={progress?.status === 'running' ? 'wiki-spin' : ''} size={14} />同步</button>}
        {workspace && <button type="button" className="wiki-btn-open-ws primary" onClick={() => void chooseWorkspace()}><Plus size={14} />添加工作区</button>}
      </div>
    </header>
    {error && <div className="wiki-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button type="button" aria-label="关闭错误" onClick={() => setError('')}><X size={14} /></button></div>}
    {!workspace ? (
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
    ) : (
      <div
        ref={workbenchRef}
        className={`wiki-workbench${resizingContext ? ' is-resizing' : ''}${graphExpanded ? ' is-graph-expanded' : ''}`}
        style={{ '--wiki-context-width': `${contextWidth}px` } as React.CSSProperties}
      >
        <aside className="wiki-sidebar" aria-label="Wiki 文件树">
          <div className="wiki-workspaces"><div className="wiki-section-label"><span>工作区</span><small>{workspaces.length}</small></div>{workspaces.map(entry => <button type="button" className={`wiki-workspace-main${entry.id === workspaceId ? ' active' : ''}`} key={entry.id} onClick={() => openWorkspace(entry.id)} title={entry.rootPath}><span><FolderOpen size={15} /></span><span><strong>{entry.name}</strong><small>{entry.itemCount} 项 · {entry.pageCount} 页面</small></span></button>)}</div>
          <div className="wiki-search"><Search size={14} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索页面与文件" aria-label="搜索页面与文件" />{query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); searchRef.current?.focus() }}><X size={13} /></button>}</div>
          <div className="wiki-tree">{query ? (matches.length ? matches.map(match => <div className="wiki-search-row" key={match.id}><button type="button" className="wiki-search-result" onClick={() => openItem(match.id)}>{icon(match.fileType)}<span><strong>{match.title}</strong><small>{match.relativePath}</small></span></button><button type="button" className="wiki-item-remove" aria-label={`删除 ${match.title}`} title={`移入回收站：${match.title}`} onClick={(e) => { e.stopPropagation(); setDialog({ type: 'delete-item', item: match }) }}><Trash2 size={13} /></button></div>) : <div className="wiki-empty-small">没有匹配结果</div>) : tree.length ? renderTree(tree) : <div className="wiki-empty-small">文件夹中还没有支持的文档</div>}</div>
        </aside>
        <main className="wiki-content">
          {progress?.status === 'running' && <div className="wiki-sync" role="status"><span style={{ width: `${percent}%` }} /><LoaderCircle className="wiki-spin" size={14} /><strong>正在建立索引</strong><small>{progress.currentFile || '准备文件'} · {progress.completed}/{progress.total}</small></div>}
          {displayedItem ? <><div className="wiki-toolbar"><div><strong title={displayedItem.relativePath}>{displayedItem.title}</strong></div><div><span className={dirty ? 'dirty' : ''}>{saving ? '保存中' : dirty ? '尚未保存' : <><Check size={12} />已保存</>}</span>{displayedItem.editable ? mode === 'read' ? <button type="button" onClick={() => setMode('edit')}><Pencil size={14} />编辑</button> : <><button type="button" onClick={() => { setDraft(saved); setMode('read') }}>取消</button><button type="button" className="primary" disabled={!dirty || saving} onClick={() => void savePage()}><Save size={14} />保存</button></> : <button type="button" onClick={() => void window.api.openLocalFile(`local-file:///${displayedItem.absolutePath.replace(/\\/g, '/')}`)}><ExternalLink size={14} />打开原文件</button>}</div></div>
            <div className="wiki-document"><section className="wiki-document-title"><h2>{displayedItem.title}</h2></section>{mode === 'edit' ? <textarea className="wiki-editor" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} aria-label={`编辑 ${displayedItem.title}`} /> : displayedItem.editable ? <MarkdownView content={saved} items={items} open={openItem} /> : <section className="wiki-source">{doc?.document.warning && <div className="wiki-source-warning"><AlertTriangle size={15} />{doc.document.warning}</div>}<div className="wiki-source-meta"><span>解析器：{doc?.document.parser || '等待解析'}</span><span>{contentNodes.length} 个结构节点</span></div>{contentNodes.map(node => <article key={node.id}><div><span>{node.type}</span>{node.pageStart && <small>第 {node.pageStart} 页</small>}</div>{node.title && <h3>{node.title}</h3>}{node.content && node.content !== node.title && <p>{node.content}</p>}</article>)}</section>}</div></> :
            <section className="wiki-folder-view"><div><FolderOpen size={22} /><span><small>FOLDER VIEW</small><h2>{folder || workspace.name}</h2><p>{folderItems.length} 个直接内容项</p></span></div><section>{folderItems.map(entry => <button type="button" key={entry.id} onClick={() => openItem(entry.id)}>{icon(entry.fileType, 18)}<span><strong>{entry.title}</strong><small>{entry.fileType.toUpperCase()} · {formatBytes(entry.fileSize)}</small></span><ChevronRight size={14} /></button>)}</section></section>}
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
          onDoubleClick={() => { setContextWidth(clampContextWidth(330)); fitGraph() }}
          onKeyDown={resizeContextByKeyboard}
        ><span /></div>
        <aside className={`wiki-context${graphExpanded ? ' is-graph-expanded' : ''}`} aria-label={graphExpanded ? '放大的 Wiki 图谱' : 'Wiki 关系面板'}>
          <div className="wiki-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={sideTab === 'graph'} className={sideTab === 'graph' ? 'active' : ''} onClick={() => setSideTab('graph')}><Network size={14} />图谱</button>
            <button type="button" role="tab" aria-selected={sideTab === 'links'} className={sideTab === 'links' ? 'active' : ''} onClick={() => { setGraphExpanded(false); setSideTab('links') }}><Link2 size={14} />关联</button>
            <button type="button" role="tab" aria-selected={sideTab === 'history'} className={sideTab === 'history' ? 'active' : ''} onClick={() => { setGraphExpanded(false); setSideTab('history') }}><History size={14} />历史</button>
          </div>
          {sideTab === 'graph' ? (
            <div className="wiki-graph">
              <button
                ref={graphExpandButtonRef}
                type="button"
                className="wiki-graph-expand"
                aria-label={graphExpanded ? '还原图谱面板' : '放大图谱'}
                aria-pressed={graphExpanded}
                title={graphExpanded ? '还原图谱（Esc）' : '放大图谱'}
                onClick={() => setGraphExpanded(current => !current)}
              >{graphExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
              {graph.nodes.some(node => node.kind === 'entity') ? (
                <ReactFlow nodes={graphElements.nodes} edges={graphElements.edges} onInit={instance => { graphFlowRef.current = instance }} onNodeClick={(_, node) => { if (typeof node.data.itemId === 'string') openItem(node.data.itemId) }} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} fitView fitViewOptions={{ padding: .22, maxZoom: 1.2 }} minZoom={.25} maxZoom={2} deleteKeyCode={null}>
                  <Background gap={22} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              ) : <div className="wiki-context-empty"><Network size={24} /><strong>还没有识别到内容实体</strong><span>同步工作区后，会从正文中提取技术、产品和概念关系。</span></div>}
              <div className="wiki-legend"><span><i className="page" />当前文章</span><span><i className="document" />相关文档</span><span><i className="entity" />内容实体</span></div>
            </div>
          ) : sideTab === 'links' ? (
            <div className="wiki-link-list">
              <header><small>正文实体</small><strong>{graph.entities.length}</strong></header>
              {graph.entities.map(entity => <div className="wiki-entity-row" key={entity.id}><span>{entity.type === 'technology' ? 'T' : 'C'}</span><div><strong>{entity.name}</strong><small>{entity.type === 'technology' ? '技术实体' : '概念'} · 提及 {entity.mentionCount} 次</small>{entity.evidence[0] && <p>{entity.evidence[0]}</p>}</div></div>)}
              {!graph.entities.length && <div className="wiki-context-empty compact"><Network size={20} /><span>当前文章尚未提取到可靠实体。</span></div>}
              {graph.relatedItems.length > 0 && <><header><small>实体关联文章</small><strong>{graph.relatedItems.length}</strong></header>{graph.relatedItems.map(related => <button type="button" key={related.id} onClick={() => openItem(related.id)}>{icon(related.fileType)}<span><strong>{related.title}</strong><small>共同实体：{related.sharedEntities.join('、')}</small></span></button>)}</>}
              {graph.backlinks.length > 0 && <><header><small>人工反向链接</small><strong>{graph.backlinks.length}</strong></header>{graph.backlinks.map(backlink => <button type="button" key={backlink.id} onClick={() => openItem(backlink.id)}>{icon(backlink.fileType)}<span><strong>{backlink.title}</strong><small>{backlink.relativePath}</small></span></button>)}</>}
              {graph.unresolved.length > 0 && <><header><small>待创建人工链接</small><strong>{graph.unresolved.length}</strong></header>{graph.unresolved.map(link => <div className="wiki-unresolved" key={link.id}><span>[[{link.targetText}]]</span><button type="button" onClick={() => { setDialogValue(link.targetText); setDialog({ type: 'create', parentPath: displayedItem?.parentPath || '' }) }}><Plus size={12} />创建</button></div>)}</>}
            </div>
          ) : <div className="wiki-history"><header><small>保存记录</small><strong>{revisions.length}</strong></header>{revisions.map(revision => <div key={revision.id}><Clock3 size={14} /><span><strong>{new Date(revision.createdAt).toLocaleString('zh-CN')}</strong><small>{revision.characterCount} 字符</small></span></div>)}{!revisions.length && <div className="wiki-context-empty compact"><History size={20} /><span>保存页面后，这里会保留版本记录。</span></div>}</div>}
        </aside>
      </div>
    )}
    {dialog && <div className="wiki-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setDialog(null) }}><form ref={dialogRef} className="wiki-dialog" role="dialog" aria-modal="true" aria-labelledby="wiki-dialog-title" onSubmit={event => void submitDialog(event)} noValidate><span className={dialog.type === 'remove' || dialog.type === 'delete-item' ? 'danger' : ''}>{dialog.type === 'create' ? <FileText size={20} /> : dialog.type === 'discard' ? <AlertTriangle size={20} /> : <Trash2 size={20} />}</span><div><h2 id="wiki-dialog-title">{dialog.type === 'create' ? '新建 Wiki 页面' : dialog.type === 'discard' ? '放弃未保存修改？' : dialog.type === 'delete-item' ? `删除 ${dialog.item.title}？` : '移除工作区？'}</h2><p>{dialog.type === 'create' ? `页面将保存到 ${dialog.parentPath || '工作区根目录'}。` : dialog.type === 'discard' ? '切换后无法恢复尚未保存的内容。' : dialog.type === 'delete-item' ? `本地文件 ${dialog.item.relativePath} 将移入系统回收站，关联索引也会更新。` : '只移除 AgentPet 中的索引，不会删除原始文件。'}</p>{dialog.type === 'create' && <><label htmlFor="wiki-title">页面标题</label><input id="wiki-title" autoFocus value={dialogValue} onChange={event => setDialogValue(event.target.value)} aria-invalid={!dialogValue.trim()} /></>}</div><footer><button type="button" autoFocus={dialog.type !== 'create'} onClick={() => setDialog(null)}>取消</button><button type="submit" className={dialog.type === 'create' ? 'primary' : 'danger'} disabled={busy || (dialog.type === 'create' && !dialogValue.trim())}>{busy && <LoaderCircle className="wiki-spin" size={14} />}{dialog.type === 'create' ? '创建页面' : dialog.type === 'discard' ? '放弃并切换' : dialog.type === 'delete-item' ? '移入回收站' : '移除工作区'}</button></footer></form></div>}
  </div>
}

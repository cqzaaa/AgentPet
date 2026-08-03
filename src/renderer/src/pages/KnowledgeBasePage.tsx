import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  CircleX,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FolderPlus,
  GripVertical,
  ImageIcon,
  Layers3,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload
} from 'lucide-react'
import './KnowledgeBasePage.css'

interface KnowledgeBaseSummary {
  id: string
  name: string
  description: string
  documentCount: number
  nodeCount: number
  updatedAt: number
}

interface KnowledgeDocumentSummary {
  id: string
  knowledgeBaseId: string
  name: string
  sourcePath: string
  fileType: string
  fileSize: number
  parser: string
  parseStatus: 'ready' | 'needs_cloud' | string
  warning: string
  qualityScore?: number
  profileJson?: string
  characterCount: number
  nodeCount: number
  updatedAt: number
}

interface KnowledgeNode {
  id: string
  documentId: string
  parentId: string | null
  type: 'document' | 'part' | 'chapter' | 'section' | 'article' | 'clause' | 'item' |
    'heading' | 'paragraph' | 'list' | 'table' | 'table_row' | 'figure' | 'caption' |
    'footnote' | 'appendix'
  level: number
  title: string
  headingPath: string[]
  content: string
  orderIndex: number
  pageStart: number | null
  pageEnd: number | null
  tokenCount: number
  confidence?: number
  sourceMeta?: Record<string, unknown>
}

interface DocumentDetail {
  document: KnowledgeDocumentSummary
  nodes: KnowledgeNode[]
}

interface SearchEvidence {
  citationId: string
  document: string
  headingPath: string[]
  parentTitle: string
  matchedContent: string
  contextBefore: string
  contextAfter: string
  pageStart: number | null
  lexicalScore: number
  vectorScore: number
  fusionScore: number
  matchSources: string[]
  matchedQueries?: string[]
  retrievalPlan?: {
    mode: 'direct' | 'agentic'
    intent: string
    originalQuery: string
    normalizedQuery: string
    subQueries: string[]
    planner: 'none' | 'heuristic' | 'llm'
    coveredSubQueries: string[]
    missingSubQueries: string[]
  }
}

type ImportStage = 'queued' | 'parsing' | 'structuring' | 'saving' | 'embedding' | 'completed' | 'failed'

interface ImportFileProgress {
  name: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: ImportStage
  processedNodes: number
  totalNodes: number
  documentId?: string
  error?: string
}

interface ImportBatchProgress {
  batchId: string
  knowledgeBaseId: string
  status: 'running' | 'completed'
  total: number
  completed: number
  failed: number
  currentIndex: number
  startedAt: number
  updatedAt: number
  files: ImportFileProgress[]
}

type KnowledgeDialog =
  | { type: 'create' }
  | { type: 'delete-base'; base: KnowledgeBaseSummary }
  | { type: 'delete-document'; document: KnowledgeDocumentSummary }

function formatBytes(value: number): string {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: number): string {
  if (!value) return '刚刚'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value)
}

function importStageLabel(stage: ImportStage): string {
  const labels: Record<ImportStage, string> = {
    queued: '等待处理',
    parsing: '解析正文',
    structuring: '识别结构',
    saving: '写入数据库',
    embedding: '生成向量',
    completed: '已入库',
    failed: '导入失败'
  }
  return labels[stage]
}

function importBatchPercent(batch: ImportBatchProgress): number {
  if (batch.total <= 0) return 0
  const stageBase: Record<ImportStage, number> = {
    queued: 0,
    parsing: 0.18,
    structuring: 0.42,
    saving: 0.52,
    embedding: 0.76,
    completed: 1,
    failed: 1
  }
  const totalProgress = batch.files.reduce((sum, file) => {
    const nodeRatio = file.totalNodes > 0 ? Math.min(1, file.processedNodes / file.totalNodes) : 0
    const progress = file.stage === 'saving'
      ? stageBase.saving + nodeRatio * 0.22
      : file.stage === 'embedding'
        ? stageBase.embedding + nodeRatio * 0.24
        : stageBase[file.stage]
    return sum + progress
  }, 0)
  return Math.round(totalProgress / batch.total * 100)
}

function documentIcon(type: string): React.JSX.Element {
  if (['xlsx', 'xls', 'csv'].includes(type)) return <FileSpreadsheet size={17} />
  return <FileText size={17} />
}

function nodeLabel(type: KnowledgeNode['type']): string {
  const labels: Record<KnowledgeNode['type'], string> = {
    document: '文档',
    part: '编',
    chapter: '章',
    section: '章节',
    article: '条',
    clause: '款',
    item: '项',
    heading: '标题',
    paragraph: '段落',
    list: '列表',
    table: '表格',
    table_row: '表格行',
    figure: '图片',
    caption: '图注',
    footnote: '脚注',
    appendix: '附录'
  }
  return labels[type]
}

function nodeBody(node: KnowledgeNode): string {
  if (node.title && node.content.startsWith(node.title)) {
    return node.content.slice(node.title.length).trim()
  }
  return node.content
}

function nodeImageUrl(node: KnowledgeNode): string {
  const imagePath = node.sourceMeta?.imagePath
  if (typeof imagePath !== 'string' || !imagePath) return ''
  return `local-file:///${imagePath.replace(/\\/g, '/')}`
}

function readStoredNumber(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function KnowledgeBasePage(): React.JSX.Element {
  const [bases, setBases] = useState<KnowledgeBaseSummary[]>([])
  const [activeBaseId, setActiveBaseId] = useState('')
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([])
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importBatch, setImportBatch] = useState<ImportBatchProgress | null>(null)
  const [importDockCollapsed, setImportDockCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [evidence, setEvidence] = useState<SearchEvidence[]>([])
  const [dialog, setDialog] = useState<KnowledgeDialog | null>(null)
  const [draftName, setDraftName] = useState('项目知识库')
  const [dialogBusy, setDialogBusy] = useState(false)
  const [libraryCollapsed, setLibraryCollapsed] = useState(() => window.localStorage.getItem('kb-library-collapsed') === '1')
  const [documentCollapsed, setDocumentCollapsed] = useState(() => window.localStorage.getItem('kb-document-collapsed') === '1')
  const [libraryWidth, setLibraryWidth] = useState(() => readStoredNumber('kb-library-width', 210))
  const [documentWidth, setDocumentWidth] = useState(() => readStoredNumber('kb-document-width', 286))
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set())
  const [documentPanelView, setDocumentPanelView] = useState<'documents' | 'outline'>('documents')
  const [activeOutlineNodeId, setActiveOutlineNodeId] = useState('')
  const nodeElements = useRef(new Map<string, HTMLElement>())
  const lastSettledImportRef = useRef('')

  const activeBase = useMemo(() => bases.find(item => item.id === activeBaseId), [activeBaseId, bases])

  const childrenByParent = useMemo(() => {
    const result = new Map<string | null, KnowledgeNode[]>()
    for (const node of detail?.nodes || []) {
      const children = result.get(node.parentId) || []
      children.push(node)
      result.set(node.parentId, children)
    }
    for (const children of result.values()) children.sort((a, b) => a.orderIndex - b.orderIndex)
    return result
  }, [detail])

  const collapsibleNodeIds = useMemo(() => new Set(
    [...childrenByParent.entries()].filter(([parentId, children]) => parentId && children.length > 0).map(([parentId]) => parentId as string)
  ), [childrenByParent])

  const outlineNodes = useMemo(() => {
    const outlineTypes = new Set<KnowledgeNode['type']>(['part', 'chapter', 'section', 'article', 'heading', 'appendix'])
    return (detail?.nodes || [])
      .filter(node => outlineTypes.has(node.type) && Boolean(node.title || node.content))
      .sort((a, b) => a.orderIndex - b.orderIndex)
  }, [detail])

  const loadBases = useCallback(async (preferredId?: string): Promise<void> => {
    const rows = await window.api.knowledgeListBases() as KnowledgeBaseSummary[]
    setBases(rows)
    setActiveBaseId(current => preferredId || current || rows[0]?.id || '')
  }, [])

  const loadDocuments = useCallback(async (baseId: string, preferredId?: string): Promise<void> => {
    if (!baseId) {
      setDocuments([])
      setSelectedDocumentId('')
      setDetail(null)
      return
    }
    const rows = await window.api.knowledgeListDocuments(baseId) as KnowledgeDocumentSummary[]
    setDocuments(rows)
    setSelectedDocumentId(current => preferredId || (rows.some(row => row.id === current) ? current : rows[0]?.id || ''))
  }, [])

  useEffect(() => {
    void loadBases().finally(() => setLoading(false))
  }, [loadBases])

  useEffect(() => {
    void loadDocuments(activeBaseId)
    setEvidence([])
  }, [activeBaseId, loadDocuments])

  useEffect(() => {
    if (!activeBaseId) {
      setImportBatch(null)
      return undefined
    }
    void window.api.knowledgeGetImportProgress(activeBaseId).then(progress => {
      if (progress?.knowledgeBaseId === activeBaseId) setImportBatch(progress as ImportBatchProgress)
    })
    const dispose = window.api.onKnowledgeImportProgress(progress => {
      const next = progress as ImportBatchProgress
      if (next.knowledgeBaseId !== activeBaseId) return
      setImportBatch(next)
      if (next.status === 'running') setImportDockCollapsed(false)
      const settledKey = `${next.batchId}:${next.completed + next.failed}`
      if (next.completed + next.failed > 0 && settledKey !== lastSettledImportRef.current) {
        lastSettledImportRef.current = settledKey
        void Promise.all([loadBases(activeBaseId), loadDocuments(activeBaseId)])
      }
    })
    return dispose
  }, [activeBaseId, loadBases, loadDocuments])

  useEffect(() => {
    if (!selectedDocumentId) {
      setDetail(null)
      setDocumentPanelView('documents')
      return
    }
    void window.api.knowledgeGetDocument(selectedDocumentId).then(result => setDetail(result as DocumentDetail | null))
    setCollapsedNodeIds(new Set())
    setActiveOutlineNodeId('')
  }, [selectedDocumentId])

  useEffect(() => {
    if (!activeOutlineNodeId) return
    const frame = window.requestAnimationFrame(() => {
      nodeElements.current.get(activeOutlineNodeId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    const timer = window.setTimeout(() => setActiveOutlineNodeId(''), 1800)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [activeOutlineNodeId, collapsedNodeIds])

  useEffect(() => {
    window.localStorage.setItem('kb-library-collapsed', libraryCollapsed ? '1' : '0')
    window.localStorage.setItem('kb-document-collapsed', documentCollapsed ? '1' : '0')
    window.localStorage.setItem('kb-library-width', String(libraryWidth))
    window.localStorage.setItem('kb-document-width', String(documentWidth))
  }, [documentCollapsed, documentWidth, libraryCollapsed, libraryWidth])

  const openCreateBase = (): void => {
    setDraftName('项目知识库')
    setDialog({ type: 'create' })
  }

  const submitCreateBase = async (): Promise<void> => {
    const name = draftName.trim()
    if (!name || dialogBusy) return
    setDialogBusy(true)
    try {
      const id = await window.api.knowledgeCreateBase(name, '保存项目文档，并保留章节与父子段落结构。')
      setDialog(null)
      await loadBases(id)
    } finally {
      setDialogBusy(false)
    }
  }

  const importDocuments = async (): Promise<void> => {
    if (!activeBaseId || importing) return
    setImporting(true)
    try {
      const result = await window.api.knowledgeImportDocuments(activeBaseId) as Array<{ id?: string; success: boolean }>
      const preferredId = result.find(item => item.success && item.id)?.id
      await Promise.all([loadBases(activeBaseId), loadDocuments(activeBaseId, preferredId)])
    } finally {
      setImporting(false)
    }
  }

  const confirmDialogAction = async (): Promise<void> => {
    if (!dialog || dialog.type === 'create' || dialogBusy) return
    setDialogBusy(true)
    try {
      if (dialog.type === 'delete-base') {
        await window.api.knowledgeDeleteBase(dialog.base.id)
        setActiveBaseId('')
        setDialog(null)
        await loadBases()
      } else {
        await window.api.knowledgeDeleteDocument(dialog.document.id)
        if (selectedDocumentId === dialog.document.id) setSelectedDocumentId('')
        setDialog(null)
        await Promise.all([loadBases(activeBaseId), loadDocuments(activeBaseId)])
      }
    } finally {
      setDialogBusy(false)
    }
  }

  const runSearch = async (): Promise<void> => {
    if (!activeBaseId || !query.trim() || searching) return
    setSearching(true)
    try {
      setEvidence(await window.api.knowledgeSearch(activeBaseId, query.trim()) as SearchEvidence[])
    } finally {
      setSearching(false)
    }
  }

  const beginResize = (panel: 'library' | 'document', event: React.MouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panel === 'library' ? libraryWidth : documentWidth
    const minWidth = panel === 'library' ? 170 : 230
    const maxWidth = panel === 'library' ? 360 : 520
    const handleMove = (moveEvent: MouseEvent): void => {
      const nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + moveEvent.clientX - startX))
      if (panel === 'library') setLibraryWidth(nextWidth)
      else setDocumentWidth(nextWidth)
    }
    const handleUp = (): void => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.classList.remove('kb-is-resizing')
    }
    document.body.classList.add('kb-is-resizing')
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }

  const toggleNode = (nodeId: string): void => {
    setCollapsedNodeIds(current => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const selectDocument = (documentId: string): void => {
    setSelectedDocumentId(documentId)
    setDocumentPanelView('outline')
  }

  const jumpToNode = (nodeId: string): void => {
    if (!detail) return
    const nodesById = new Map(detail.nodes.map(node => [node.id, node]))
    const ancestorIds = new Set<string>()
    let current = nodesById.get(nodeId)
    while (current?.parentId) {
      ancestorIds.add(current.parentId)
      current = nodesById.get(current.parentId)
    }
    setEvidence([])
    setCollapsedNodeIds(collapsed => {
      if (![...ancestorIds].some(id => collapsed.has(id))) return collapsed
      const next = new Set(collapsed)
      for (const id of ancestorIds) next.delete(id)
      return next
    })
    setActiveOutlineNodeId(nodeId)
  }

  const renderKnowledgeNode = (node: KnowledgeNode): React.JSX.Element => {
    const children = childrenByParent.get(node.id) || []
    const collapsed = collapsedNodeIds.has(node.id)
    const imageUrl = nodeImageUrl(node)
    const body = nodeBody(node)
    return (
      <div key={node.id} className={`kb-tree-branch ${collapsed ? 'collapsed' : ''}`}>
        <article
          ref={element => {
            if (element) nodeElements.current.set(node.id, element)
            else nodeElements.current.delete(node.id)
          }}
          className={`kb-node ${node.type} ${activeOutlineNodeId === node.id ? 'jump-target' : ''}`}
        >
          <span className="kb-node-rail" />
          <div className="kb-node-header">
            <div className="kb-node-heading-copy">
              {children.length > 0 ? (
                <button className="kb-tree-toggle" title={collapsed ? '展开子节点' : '收起子节点'} onClick={() => toggleNode(node.id)}>
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : <span className="kb-tree-toggle-placeholder" />}
              <span className="kb-node-type">{nodeLabel(node.type)}</span>
            </div>
            {node.type !== 'document' && <small>{node.tokenCount} tokens{node.pageStart ? ` · 第 ${node.pageStart} 页` : ''}</small>}
          </div>
          {node.headingPath.length > 1 && node.type !== 'section' && <div className="kb-breadcrumb">{node.headingPath.join(' / ')}</div>}
          {node.title && <p className="kb-node-title">{node.title}</p>}
          {body && body !== node.title && <p className="kb-node-content">{body}</p>}
          {imageUrl && (
            <div className="kb-figure-preview">
              <img src={imageUrl} alt={node.title || `第 ${node.pageStart || ''} 页图片`} loading="lazy" />
              <div>
                <span><ImageIcon size={12} />{String(node.sourceMeta?.role || 'figure') === 'page_scan' ? '整页扫描图' : '文档图片'}</span>
                <button onClick={() => void window.api.openLocalFile(imageUrl)}><ExternalLink size={12} />打开原图</button>
              </div>
            </div>
          )}
        </article>
        {!collapsed && children.length > 0 && (
          <div className="kb-node-children">{children.map(renderKnowledgeNode)}</div>
        )}
      </div>
    )
  }

  const importRunning = importBatch?.status === 'running'
  const importSettled = importBatch ? importBatch.completed + importBatch.failed : 0
  const importPercent = importBatch ? importBatchPercent(importBatch) : 0
  const currentImportFile = importBatch?.files[importBatch.currentIndex]

  if (loading) {
    return <div className="kb-loading"><LoaderCircle className="kb-spin" size={24} />正在载入知识库</div>
  }

  return (
    <div className="kb-page">
      <header className="kb-header">
        <div>
          <div className="kb-eyebrow"><Layers3 size={14} /> STRUCTURED KNOWLEDGE</div>
          <h1>知识库</h1>
          <p>文档不是被切碎保存，而是沿着章节脊柱组织成可引用的证据。</p>
        </div>
        <div className="kb-header-actions">
          <button className="kb-button secondary" onClick={openCreateBase}><FolderPlus size={16} />新建知识库</button>
          <button
            className="kb-button primary"
            disabled={!activeBaseId || (importing && !importRunning)}
            onClick={() => importRunning ? setImportDockCollapsed(false) : void importDocuments()}
          >
            {importRunning || importing ? <LoaderCircle className="kb-spin" size={16} /> : <Upload size={16} />}
            {importRunning ? `${importSettled}/${importBatch.total} 入库中` : importing ? '选择文件' : '导入文档'}
          </button>
        </div>
      </header>

      {bases.length === 0 ? (
        <section className="kb-empty">
          <div className="kb-empty-mark"><BookOpen size={30} /></div>
          <h2>从一个知识库开始</h2>
          <p>创建后可导入 PDF、Word、Excel、Markdown 和文本文件。本地解析失败的扫描件会标记为“建议云端解析”。</p>
          <button className="kb-button primary" onClick={openCreateBase}><Plus size={16} />创建知识库</button>
        </section>
      ) : (
        <div
          className={`kb-workbench ${libraryCollapsed ? 'library-collapsed' : ''} ${documentCollapsed ? 'document-collapsed' : ''}`}
          style={{
            '--kb-library-width': `${libraryCollapsed ? 44 : libraryWidth}px`,
            '--kb-document-width': `${documentCollapsed ? 44 : documentWidth}px`
          } as React.CSSProperties}
        >
          <aside className={`kb-panel kb-library-panel ${libraryCollapsed ? 'collapsed' : ''}`}>
            <div className="kb-panel-heading">
              <span className="kb-panel-title">知识库</span>
              <span className="kb-panel-heading-actions">
                {!libraryCollapsed && <span className="kb-count">{bases.length}</span>}
                <button className="kb-panel-toggle" title={libraryCollapsed ? '展开知识库栏' : '收起知识库栏'} onClick={() => setLibraryCollapsed(value => !value)}>
                  {libraryCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                </button>
              </span>
            </div>
            <div className="kb-list">
              {bases.map(base => (
                <button key={base.id} className={`kb-library-item ${base.id === activeBaseId ? 'active' : ''}`} onClick={() => setActiveBaseId(base.id)}>
                  <span className="kb-library-icon"><Database size={17} /></span>
                  <span className="kb-library-copy">
                    <strong>{base.name}</strong>
                    <small>{base.documentCount} 个文档 · {base.nodeCount} 个节点</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
            {activeBase && (
              <div className="kb-library-footer">
                <p>{activeBase.description || '尚未添加说明。'}</p>
                <button className="kb-text-danger" onClick={() => setDialog({ type: 'delete-base', base: activeBase })}><Trash2 size={13} />删除知识库</button>
              </div>
            )}
            {!libraryCollapsed && <div className="kb-panel-resizer" role="separator" aria-orientation="vertical" onMouseDown={event => beginResize('library', event)}><GripVertical size={12} /></div>}
          </aside>

          <section className={`kb-panel kb-document-panel ${documentCollapsed ? 'collapsed' : ''}`}>
            <div className="kb-panel-heading">
              {documentCollapsed ? (
                <span className="kb-panel-title">{documentPanelView === 'outline' ? '大纲' : '文档'}</span>
              ) : (
                <span className="kb-panel-switch" role="tablist" aria-label="文档栏视图">
                  <button className={documentPanelView === 'documents' ? 'active' : ''} onClick={() => setDocumentPanelView('documents')}>文档</button>
                  <button className={documentPanelView === 'outline' ? 'active' : ''} disabled={!detail} onClick={() => setDocumentPanelView('outline')}>大纲</button>
                </span>
              )}
              <span className="kb-panel-heading-actions">
                {!documentCollapsed && <span className="kb-count">{documentPanelView === 'outline' ? outlineNodes.length : documents.length}</span>}
                <button className="kb-panel-toggle" title={documentCollapsed ? '展开文档栏' : '收起文档栏'} onClick={() => setDocumentCollapsed(value => !value)}>
                  {documentCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                </button>
              </span>
            </div>
            {documentPanelView === 'outline' && detail ? (
              outlineNodes.length > 0 ? (
                <nav className="kb-outline-list" aria-label={`${detail.document.name} 大纲`}>
                  <div className="kb-outline-document">
                    <span className="kb-doc-icon">{documentIcon(detail.document.fileType)}</span>
                    <span><strong title={detail.document.name}>{detail.document.name}</strong><small>{detail.nodes.length} 个结构节点</small></span>
                  </div>
                  {outlineNodes.map(node => (
                    <button
                      key={node.id}
                      className={activeOutlineNodeId === node.id ? 'active' : ''}
                      style={{ '--kb-outline-depth': Math.max(0, Math.min(4, node.level - 1)) } as React.CSSProperties}
                      onClick={() => jumpToNode(node.id)}
                    >
                      <span className="kb-outline-marker" />
                      <span className="kb-outline-copy">
                        <small>{nodeLabel(node.type)}{node.pageStart ? ` · 第 ${node.pageStart} 页` : ''}</small>
                        <strong>{node.title || node.content}</strong>
                      </span>
                      <ChevronRight size={12} />
                    </button>
                  ))}
                </nav>
              ) : (
                <div className="kb-panel-empty">
                  <Layers3 size={24} />
                  <strong>没有可导航的大纲</strong>
                  <span>此文档目前只有正文段落，可在右侧直接查看完整结构。</span>
                </div>
              )
            ) : documents.length === 0 ? (
              <div className="kb-panel-empty">
                <FileText size={24} />
                <strong>还没有文档</strong>
                <span>导入后会自动分析标题和段落层级。</span>
              </div>
            ) : (
              <div className="kb-document-list">
                {documents.map(document => (
                  <button key={document.id} className={`kb-document-item ${document.id === selectedDocumentId ? 'active' : ''}`} onClick={() => selectDocument(document.id)}>
                    <span className="kb-doc-icon">{documentIcon(document.fileType)}</span>
                    <span className="kb-doc-copy">
                      <strong title={document.name}>{document.name}</strong>
                      <small>{formatBytes(document.fileSize)} · {document.nodeCount} 节点</small>
                      <span className={`kb-status ${document.parseStatus}`}>
                        {document.parseStatus === 'needs_review' || document.parseStatus === 'needs_cloud'
                          ? '建议高级解析复核'
                          : `结构已就绪${document.qualityScore ? ` · ${Math.round(document.qualityScore * 100)}分` : ''}`}
                      </span>
                    </span>
                    <span className="kb-doc-actions">
                      <small>{formatDate(document.updatedAt)}</small>
                      <span role="button" tabIndex={0} title="删除文档" onClick={event => { event.stopPropagation(); setDialog({ type: 'delete-document', document }) }}><Trash2 size={13} /></span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!documentCollapsed && <div className="kb-panel-resizer" role="separator" aria-orientation="vertical" onMouseDown={event => beginResize('document', event)}><GripVertical size={12} /></div>}
          </section>

          <main className="kb-panel kb-inspector">
            <div className="kb-search-strip">
              <Search size={17} />
              <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runSearch() }} placeholder="测试检索：例如“指定部门是否包含下级部门”" />
              <button disabled={!query.trim() || searching} onClick={() => void runSearch()}>
                {searching ? <LoaderCircle className="kb-spin" size={15} /> : <Sparkles size={15} />}
                生成证据包
              </button>
            </div>

            {evidence.length > 0 ? (
              <section className="kb-evidence-view">
                <div className="kb-inspector-title">
                  <div><Braces size={17} /><span>给大模型的结构化证据</span></div>
                  <small>{evidence.length} 条命中</small>
                </div>
                {evidence[0]?.retrievalPlan && (
                  <div className={`kb-retrieval-plan ${evidence[0].retrievalPlan.mode}`}>
                    <div>
                      <strong>{evidence[0].retrievalPlan.mode === 'agentic' ? 'Agentic 多步检索' : '直接检索'}</strong>
                      <span>
                        {evidence[0].retrievalPlan.planner === 'llm' ? '模型规划' : evidence[0].retrievalPlan.planner === 'heuristic' ? '本地规划' : '无需拆解'}
                      </span>
                    </div>
                    {evidence[0].retrievalPlan.normalizedQuery !== evidence[0].retrievalPlan.originalQuery && (
                      <p>查询归一化：{evidence[0].retrievalPlan.normalizedQuery}</p>
                    )}
                    {evidence[0].retrievalPlan.mode === 'agentic' && (
                      <ol>
                        {evidence[0].retrievalPlan.subQueries.map((subQuery, index) => (
                          <li key={`${index}-${subQuery}`} className={evidence[0].retrievalPlan?.missingSubQueries.includes(subQuery) ? 'missing' : ''}>
                            {subQuery}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
                <div className="kb-evidence-list">
                  {evidence.map(item => (
                    <article key={item.citationId} className="kb-evidence-card">
                      <div className="kb-evidence-meta">
                        <span className="kb-citation">{item.citationId}</span>
                        <span>{item.document}</span>
                        <small>
                          匹配分 {item.fusionScore.toFixed(3)}
                          {item.matchSources?.length ? ` · ${item.matchSources.join(' / ')}` : ''}
                        </small>
                      </div>
                      <div className="kb-breadcrumb">{item.headingPath.join(' / ')}</div>
                      {item.retrievalPlan?.mode === 'agentic' && item.matchedQueries?.length ? (
                        <div className="kb-matched-query">对应：{item.matchedQueries.join('；')}</div>
                      ) : null}
                      {item.contextBefore && <p className="kb-context">上文 · {item.contextBefore}</p>}
                      <p className="kb-match">{item.matchedContent}</p>
                      {item.contextAfter && <p className="kb-context">下文 · {item.contextAfter}</p>}
                    </article>
                  ))}
                </div>
                <button className="kb-back-structure" onClick={() => setEvidence([])}>返回文档结构</button>
              </section>
            ) : detail ? (
              <section className="kb-structure-view">
                <div className="kb-inspector-title">
                  <div><Layers3 size={17} /><span>{detail.document.name}</span></div>
                  <div className="kb-tree-actions">
                    <small>{detail.nodes.length} 个结构节点</small>
                    <button disabled={collapsibleNodeIds.size === 0} onClick={() => setCollapsedNodeIds(new Set(collapsibleNodeIds))}>全部收起</button>
                    <button disabled={collapsedNodeIds.size === 0} onClick={() => setCollapsedNodeIds(new Set())}>全部展开</button>
                  </div>
                </div>
                {detail.document.warning && (
                  <div className="kb-warning"><AlertTriangle size={15} /><span>{detail.document.warning}</span></div>
                )}
                <div className="kb-structure-legend">
                  <span><i className="section" />章节节点</span>
                  <span><i className="leaf" />可检索叶子</span>
                  <span>解析器：{detail.document.parser}</span>
                  {detail.document.qualityScore != null && <span>质量：{Math.round(detail.document.qualityScore * 100)} 分</span>}
                </div>
                <div className="kb-node-tree">
                  {(childrenByParent.get(null) || []).map(renderKnowledgeNode)}
                </div>
              </section>
            ) : (
              <div className="kb-panel-empty large"><Layers3 size={30} /><strong>选择一个文档查看结构</strong><span>这里会显示父子章节、叶子段落和最终引用路径。</span></div>
            )}
          </main>
        </div>
      )}

      {importBatch && (
        <section className={`kb-import-dock ${importDockCollapsed ? 'collapsed' : ''}`} aria-live="polite">
          <header>
            <div className="kb-import-dock-title">
              <span className={`kb-import-pulse ${importRunning ? 'running' : ''}`} />
              <span>
                <strong>{importRunning ? '文档入库中' : '本次入库完成'}</strong>
                <small>{importSettled} / {importBatch.total} 个文件{importBatch.failed ? ` · ${importBatch.failed} 个失败` : ''}</small>
              </span>
            </div>
            <div className="kb-import-dock-actions">
              <span>{importPercent}%</span>
              <button title={importDockCollapsed ? '展开入库进度' : '收起入库进度'} onClick={() => setImportDockCollapsed(value => !value)}>
                {importDockCollapsed ? <ChevronLeft size={15} /> : <ChevronDown size={15} />}
              </button>
              {!importRunning && (
                <button title="关闭入库记录" onClick={() => setImportBatch(null)}><CircleX size={15} /></button>
              )}
            </div>
          </header>
          <div className="kb-import-track"><span style={{ width: `${importPercent}%` }} /></div>
          {!importDockCollapsed && (
            <>
              {currentImportFile && importRunning && (
                <div className="kb-import-current">
                  <span><LoaderCircle className="kb-spin" size={15} /></span>
                  <div>
                    <strong title={currentImportFile.name}>{currentImportFile.name}</strong>
                    <small>
                      {importStageLabel(currentImportFile.stage)}
                      {currentImportFile.totalNodes > 0 && ['saving', 'embedding'].includes(currentImportFile.stage)
                        ? ` · ${currentImportFile.processedNodes}/${currentImportFile.totalNodes} 个节点`
                        : ''}
                    </small>
                  </div>
                </div>
              )}
              <div className="kb-import-files">
                {importBatch.files.map((file, index) => (
                  <div key={`${index}-${file.name}`} className={`kb-import-file ${file.status}`}>
                    <span className="kb-import-file-state">
                      {file.status === 'completed'
                        ? <CheckCircle2 size={15} />
                        : file.status === 'failed'
                          ? <AlertTriangle size={15} />
                          : file.status === 'running'
                            ? <LoaderCircle className="kb-spin" size={15} />
                            : <span className="kb-import-queued-dot" />}
                    </span>
                    <span className="kb-import-file-copy">
                      <strong title={file.name}>{file.name}</strong>
                      <small title={file.error || ''}>{file.error || importStageLabel(file.stage)}</small>
                    </span>
                    {file.totalNodes > 0 && <span className="kb-import-node-count">{file.totalNodes} 节点</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {dialog && (
        <div
          className="kb-dialog-backdrop"
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget && !dialogBusy) setDialog(null) }}
          onKeyDown={event => { if (event.key === 'Escape' && !dialogBusy) setDialog(null) }}
        >
          <section className="kb-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-dialog-title">
            <div className={`kb-dialog-mark ${dialog.type === 'create' ? '' : 'danger'}`}>
              {dialog.type === 'create' ? <Database size={20} /> : <Trash2 size={20} />}
            </div>
            <div className="kb-dialog-copy">
              <h2 id="kb-dialog-title">
                {dialog.type === 'create'
                  ? '创建知识库'
                  : dialog.type === 'delete-base'
                    ? '删除知识库'
                    : '删除文档'}
              </h2>
              {dialog.type === 'create' ? (
                <>
                  <p>知识库会保存文档结构、父子段落和后续生成的检索索引。</p>
                  <label htmlFor="kb-name-input">名称</label>
                  <input
                    id="kb-name-input"
                    autoFocus
                    value={draftName}
                    maxLength={80}
                    onChange={event => setDraftName(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') void submitCreateBase() }}
                    placeholder="例如：产品与技术文档"
                  />
                </>
              ) : (
                <p>
                  {dialog.type === 'delete-base'
                    ? `“${dialog.base.name}”中的全部文档和结构节点都会删除，此操作不可撤销。`
                    : `“${dialog.document.name}”及其结构节点将从当前知识库移除。`}
                </p>
              )}
            </div>
            <div className="kb-dialog-actions">
              <button className="kb-button secondary" disabled={dialogBusy} onClick={() => setDialog(null)}>取消</button>
              {dialog.type === 'create' ? (
                <button className="kb-button primary" disabled={!draftName.trim() || dialogBusy} onClick={() => void submitCreateBase()}>
                  {dialogBusy && <LoaderCircle className="kb-spin" size={15} />}创建知识库
                </button>
              ) : (
                <button className="kb-button danger" disabled={dialogBusy} onClick={() => void confirmDialogAction()}>
                  {dialogBusy && <LoaderCircle className="kb-spin" size={15} />}确认删除
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

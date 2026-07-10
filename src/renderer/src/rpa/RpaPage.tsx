import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { ReactFlow, Background, Controls, MiniMap, Connection, addEdge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useRpaStore } from './useRpaStore'
import { useAppStore } from '../hooks/useAppStore' // 用于获取 LLM 密钥等配置
import {
  StartNode,
  EndNode,
  OpenUrlNode,
  ClickNode,
  FillNode,
  ExtractNode,
  WaitNode,
  ManualConfirmNode,
  AiNode,
  ConditionNode
} from './nodes/CustomNodes'
import './rpa.css'

// 注册 React Flow 自定义节点类型
const nodeTypes = {
  start: StartNode,
  end: EndNode,
  open_url: OpenUrlNode,
  click: ClickNode,
  fill: FillNode,
  extract: ExtractNode,
  wait: WaitNode,
  manual_confirm: ManualConfirmNode,
  ai_node: AiNode,
  condition: ConditionNode
}

export function RpaPage(): React.JSX.Element {
  const store = useRpaStore()
  const appStore = useAppStore() // 获取全局大模型设置

  const {
    tasks,
    activeTaskId,
    nodes,
    edges,
    executionState,
    logs,
    runContext,
    manualConfirmData,
    fetchTasks,
    selectTask,
    createTask,
    deleteTask,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    runTask,
    stopTask,
    respondManualConfirm,
    setupListeners
  } = store

  // 1. 初始化监听 IPC 状态
  useEffect(() => {
    fetchTasks()
    const cleanup = setupListeners()
    return () => cleanup()
  }, [])

  // 2. 状态：选中的节点（用于右侧属性编辑）
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const selectedNode = useMemo(() => {
    return nodes.find(n => n.id === selectedNodeId) || null
  }, [nodes, selectedNodeId])

  // 3. 状态：右侧 Tab
  const [activeTab, setActiveTab] = useState<'attr' | 'logs' | 'chat'>('logs')

  // 4. 状态：创建新任务 Modal
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')



  // 6. 状态：人工确认中修改变量的临时存储
  const [manualInputVal, setManualInputVal] = useState('')

  // 7. 状态：可视化拾取器相关
  const [showPickerPrompt, setShowPickerPrompt] = useState(false)
  const [pickerUrl, setPickerUrl] = useState('')
  const [pendingPickNode, setPendingPickNode] = useState<any>(null)

  // 8. 状态：是否显示缩略图
  const [showMiniMap, setShowMiniMap] = useState(false)

  // 9. 状态：是否显示右侧面板
  const [showPanel, setShowPanel] = useState(false)

  // 10. 状态：右侧临时 AI 聊天框消息历史与输入管理
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([
    { role: 'assistant', content: '你好！我是您的 RPA AI 助手。你可以问我关于如何设计流程，或者使用左侧打开网页节点的“录制操作”按钮让 AI 帮你生成后续节点！' }
  ])
  const [chatInput, setChatInput] = useState('')
  const [isChatSending, setIsChatSending] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // 11. 状态：右键菜单管理
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)



  // 14. 状态：撤回历史栈
  const [history, setHistory] = useState<{ nodes: any[]; edges: any[] }[]>([])

  // 保存当前画布状态到历史栈中
  const saveToHistory = useCallback((ns = nodes, es = edges) => {
    setHistory(prev => {
      const newHist = [...prev, { nodes: ns, edges: es }]
      if (newHist.length > 50) newHist.shift()
      return newHist
    })
  }, [nodes, edges])

  // 执行撤回
  const handleUndo = useCallback(() => {
    if (history.length === 0) return
    const prevState = history[history.length - 1]
    setHistory(prev => prev.slice(0, -1))
    setNodes(prevState.nodes)
    setEdges(prevState.edges)
    if (activeTaskId) {
      window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: prevState.nodes, edges: prevState.edges })
    }
  }, [history, setNodes, setEdges, activeTaskId])

  // 监听键盘 Ctrl+Z 撤回快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        handleUndo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleUndo])

  // 自动滚动到最新消息
  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages, activeTab])

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!menu) return
    const handleGlobalClick = () => {
      setMenu(null)
    }
    window.addEventListener('click', handleGlobalClick)
    return () => window.removeEventListener('click', handleGlobalClick)
  }, [menu])

  // 当人工确认弹窗弹出时，初始化输入框
  useEffect(() => {
    if (manualConfirmData) {
      setActiveTab('logs') // 自动切到控制台，方便查看
      setShowPanel(true) // 自动展开控制台，方便用户确认和操作
      setManualInputVal('')
    }
  }, [manualConfirmData])

  // ── 画布连接事件 ───────────────────────────────────────────
  const onConnect = useCallback((params: Connection) => {
    saveToHistory()
    const newEdges = addEdge(params, edges)
    setEdges(newEdges)
    if (activeTaskId) {
      window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes, edges: newEdges })
    }
  }, [edges, nodes, activeTaskId, saveToHistory])

  // ── 新增自定义节点类型 ───────────────────────────────────────
  const handleAddNode = (type: string) => {
    saveToHistory()
    const newId = `node_${Date.now()}`
    let label = ''
    let data: Record<string, any> = {}

    switch (type) {
      case 'open_url': label = '打开网页'; data = { url: 'https://' }; break
      case 'click': label = '点击元素'; data = { selector: '' }; break
      case 'fill': label = '输入文本'; data = { selector: '', value: '' }; break
      case 'extract': label = '内容提取'; data = { selector: '', extractType: 'text', varName: 'extracted_var' }; break
      case 'wait': label = '延时等待'; data = { ms: '2000' }; break
      case 'manual_confirm': label = '人工干预'; data = { prompt: '确认继续操作' }; break
      case 'ai_node': label = 'AI 处理'; data = { prompt: '分析以下内容: {{var}}', varName: 'ai_var' }; break
      case 'condition': label = '条件判断'; data = { expression: 'output !== null' }; break

      default: return
    }

    const newNode = {
      id: newId,
      type,
      position: { x: 150 + Math.random() * 80, y: 150 + Math.random() * 80 },
      data: { label, ...data }
    }

    const updatedNodes = [...nodes, newNode]
    setNodes(updatedNodes)

    if (activeTaskId) {
      window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: updatedNodes, edges })
    }

    setSelectedNodeId(newId)
    setActiveTab('attr')
    setShowPanel(true)
  }

  // ── 属性编辑器修改事件 ──────────────────────────────────────
  const handleAttrChange = (key: string, val: any) => {
    if (!selectedNodeId) return
    const updatedNodes = nodes.map(n => {
      if (n.id === selectedNodeId) {
        return {
          ...n,
          data: { ...n.data, [key]: val }
        }
      }
      return n
    })
    setNodes(updatedNodes)
    if (activeTaskId) {
      window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: updatedNodes, edges })
    }
  }

  // ── 元素拾取器处理逻辑 ──────────────────────────────────────
  const handlePickElement = (node: any) => {
    // 尝试寻找当前流程中的测试网址 (寻找前置或第一个打开网页的节点)
    const openUrlNode = nodes.find(n => n.type === 'open_url')
    let testUrl = openUrlNode?.data?.url || 'https://www.baidu.com'

    setPickerUrl(testUrl)
    setPendingPickNode(node)
    setShowPickerPrompt(true)
  }

  const confirmPickElement = async () => {
    setShowPickerPrompt(false)
    if (!pickerUrl || !pendingPickNode) return

    try {
      const selectedCss = await window.api.rpaPickElement(pickerUrl)
      if (selectedCss) {
        // 直接更新表单并存入图节点
        const updatedNodes = nodes.map(n => {
          if (n.id === pendingPickNode.id) {
            return { ...n, data: { ...n.data, selector: selectedCss } }
          }
          return n
        })
        setNodes(updatedNodes)
        if (activeTaskId) {
          window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: updatedNodes, edges })
        }
      }
    } catch (e: any) {
      alert('拾取元素失败: ' + e.message)
    }
  }

  const parseAndApplyCanvasJson = useCallback((text: string, anchorNodeId?: string) => {
    try {
      store.appendLog('info', `[AI 助手] 开始解析回复中的流程 JSON...`)
      const regex = /```(?:json)?([\s\S]*?)```/gi
      let match
      let applied = false
      let blockCount = 0

      // 动态从 Zustand 获取最新的 nodes 与 edges，避免 React 闭包旧值问题
      let currentNodes = useRpaStore.getState().nodes
      let currentEdges = useRpaStore.getState().edges

      while ((match = regex.exec(text)) !== null) {
        blockCount++
        const jsonStr = match[1].trim()
        store.appendLog('info', `[AI 助手] 匹配到第 ${blockCount} 个代码块，长度为 ${jsonStr.length}，正在解析...`)

        let parsed
        try {
          parsed = JSON.parse(jsonStr)
        } catch (parseErr: any) {
          store.appendLog('warn', `[AI 助手] 代码块 JSON 解析失败: ${parseErr.message}`)
          continue
        }

        if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
          store.appendLog('info', `[AI 助手] 成功解析 JSON：节点数 = ${parsed.nodes.length}，边数 = ${parsed.edges.length}`)

          // 保存历史记录，以便撤回
          saveToHistory(currentNodes, currentEdges)

          if (!anchorNodeId) {
            // ==========================================
            // 模式 A：完全替换模式 (如通用 AI 聊天重布局/重生成)
            // ==========================================
            currentNodes = parsed.nodes
            currentEdges = parsed.edges

            setNodes(currentNodes)
            setEdges(currentEdges)
            applied = true

            store.appendLog(
              'info',
              `[AI 助手] 画布已完全替换重建：总节点数 ${currentNodes.length} 个，总连线数 ${currentEdges.length} 条。`
            )
          } else {
            // ==========================================
            // 模式 B：局部追加/合并模式 (如指定节点录制操作追加)
            // ==========================================

            // 1. 构建邻接表以识别下游节点
            const adjacencyList = new Map<string, string[]>()
            currentEdges.forEach((edge: any) => {
              if (!adjacencyList.has(edge.source)) {
                adjacencyList.set(edge.source, [])
              }
              adjacencyList.get(edge.source)!.push(edge.target)
            })

            // 2. BFS 搜集从 anchorNodeId 出发的所有下游节点 ID (不包含 anchorNodeId 本身)
            const downstreamIds = new Set<string>()
            const queue: string[] = []
            const directNeighbors = adjacencyList.get(anchorNodeId) || []
            directNeighbors.forEach(neigh => {
              queue.push(neigh)
              downstreamIds.add(neigh)
            })

            while (queue.length > 0) {
              const curr = queue.shift()!
              const nextNeighbors = adjacencyList.get(curr) || []
              nextNeighbors.forEach(neigh => {
                if (!downstreamIds.has(neigh)) {
                  downstreamIds.add(neigh)
                  queue.push(neigh)
                }
              })
            }

            if (downstreamIds.size > 0) {
              store.appendLog('info', `[AI 助手] 重新录制检测：正在清空节点 [${anchorNodeId}] 之后的 ${downstreamIds.size} 个下游旧步骤。`)
            }

            // 3. 过滤剥离下游旧节点与相关的边
            const cleanedNodes = currentNodes.filter((n: any) => !downstreamIds.has(n.id))
            const cleanedEdges = currentEdges.filter((e: any) => !downstreamIds.has(e.source) && !downstreamIds.has(e.target))

            // 4. 重建以 cleanedNodes 为基准的 Map 字典
            const currentNodesMap = new Map(cleanedNodes.map((n: any) => [n.id, n]))

            // 对节点进行分流：已有节点更新坐标及属性；新节点生成唯一 ID 并记录映射
            const idMap: Record<string, string> = {}
            const mappedNewNodes: any[] = []
            let updatedCount = 0

            const updatedNodes = cleanedNodes.map((n: any) => {
              const aiNode = parsed.nodes.find((an: any) => an.id === n.id)
              if (aiNode) {
                updatedCount++
                // 合并更新现有节点（坐标和 data 中的属性，同时保留 ReactFlow 的内部状态）
                return {
                  ...n,
                  ...aiNode,
                  data: {
                    ...n.data,
                    ...aiNode.data
                  },
                  position: aiNode.position || n.position
                }
              }
              return n
            })

            // 筛选出全新生成的节点
            const newAiNodes = parsed.nodes.filter((an: any) => !currentNodesMap.has(an.id))
            mappedNewNodes.push(...newAiNodes.map((node: any) => {
              const oldId = node.id
              const newId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
              idMap[oldId] = newId
              return {
                ...node,
                id: newId
              }
            }))

            // 5. 建立已清洗边的 Map，以 "source->target" 作为键，防止连线重复添加
            const currentEdgesMap = new Map(cleanedEdges.map((e: any) => [`${e.source}->${e.target}`, e]))

            // 处理边，并将悬空或未识别的 source/target 替换为 anchorNodeId
            const mappedNewEdges: any[] = []
            parsed.edges.forEach((edge: any) => {
              let source = edge.source
              let target = edge.target

              // 1. 如果 source 是新生成的节点，则映射为新生成的唯一 ID
              if (idMap[source]) {
                source = idMap[source]
              } else {
                // 2. 如果 source 既不是新生成的节点，也不在当前已清洗节点中，
                // 说明它是 AI 臆想的起始节点，我们将其替换为已知的锚点节点 ID (anchorNodeId)
                if (!currentNodesMap.has(source) && anchorNodeId) {
                  source = anchorNodeId
                }
              }

              // 同样处理 target
              if (idMap[target]) {
                target = idMap[target]
              } else {
                if (!currentNodesMap.has(target) && anchorNodeId) {
                  target = anchorNodeId
                }
              }

              // 检查这是否是一条已有的边
              const edgeKey = `${source}->${target}`
              if (currentEdgesMap.has(edgeKey)) {
                return
              }

              const newEdgeId = `e_${source}_${target}_${Math.random().toString(36).substr(2, 5)}`
              mappedNewEdges.push({
                ...edge,
                id: newEdgeId,
                source,
                target
              })
            })

            // 更新当前节点与边
            currentNodes = [...updatedNodes, ...mappedNewNodes]
            currentEdges = [...cleanedEdges, ...mappedNewEdges]

            setNodes(currentNodes)
            setEdges(currentEdges)
            applied = true

            store.appendLog(
              'info',
              `[AI 助手] 画布已局部追加：已移除旧下游 ${downstreamIds.size} 个，更新已有 ${updatedCount} 个，新增节点 ${mappedNewNodes.length} 个，新增连线 ${mappedNewEdges.length} 条。`
            )
          }
        } else {
          store.appendLog('warn', `[AI 助手] 匹配的代码块格式不符合 { nodes, edges } 规范`)
        }
      }

      if (blockCount === 0) {
        store.appendLog('warn', `[AI 助手] 未能在 AI 回复中匹配到任何 \`\`\`json\`\`\` 代码块`)
      }

      if (applied && activeTaskId) {
        setTimeout(async () => {
          const latestNodes = useRpaStore.getState().nodes
          const latestEdges = useRpaStore.getState().edges
          await window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: latestNodes, edges: latestEdges })
          store.appendLog('info', `[AI 助手] 画布节点数据已成功保存至磁盘。`)
        }, 150)
      }
    } catch (e: any) {
      console.error('Failed to parse and apply JSON from chat', e)
      store.appendLog('error', `[AI 助手] 解析同步 JSON 发生异常: ${e.message}`)
    }
  }, [activeTaskId, saveToHistory, setNodes, setEdges])

  // ── 浏览器操作录制并发送到 AI 助手 ────────────────────────────────
  const handleRecordBrowser = async (node: any) => {
    let testUrl = node.data?.url || 'https://www.baidu.com'
    if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
      testUrl = 'https://' + testUrl
    }

    try {
      setActiveTab('logs')
      setShowPanel(true)
      store.appendLog('info', `[录制] 正在启动浏览器录制：${testUrl}`)

      const recordedActions = await window.api.rpaRecordActions(testUrl)
      if (!recordedActions || recordedActions.length === 0) {
        store.appendLog('warn', `[录制] 录制已取消或没有捕捉到有效操作`)
        return
      }

      store.appendLog('info', `[录制] 录制结束。共捕获到 ${recordedActions.length} 步操作。`)

      // 智能过滤第一步的打开网页/导航操作，因为当前节点已经代劳了
      let filteredActions = [...recordedActions]
      if (filteredActions.length > 0) {
        const first = filteredActions[0]
        if (
          first.type === 'open_url' ||
          first.action === 'open_url' ||
          first.type === 'goto' ||
          first.action === 'goto' ||
          first.label?.includes('打开') ||
          first.label?.includes('导航')
        ) {
          filteredActions.shift()
          store.appendLog('info', `[录制] 自动忽略第一步的打开网页/导航动作，仅生成后续流程步骤。`)
        }
      }

      if (filteredActions.length === 0) {
        store.appendLog('warn', `[录制] 录制未捕获到除打开网页之外的其他有效操作`)
        return
      }

      store.appendLog('info', `[AI] 正在打开 AI 助手并自动发送录制步骤...`)

      // 打开面板，切到 AI 助手
      setActiveTab('chat')
      setShowPanel(true)

      const promptText = `我完成了以下浏览器操作录制，请帮我生成后续流程节点并连接到当前节点（当前节点ID为 "${node.id}"，其坐标为 x=${node.position.x}, y=${node.position.y}）：

\`\`\`json
${JSON.stringify(filteredActions, null, 2)}
\`\`\``

      // 触发自动对话
      handleRecordAutoChat(promptText, node.id)

    } catch (e: any) {
      console.error(e)
      store.appendLog('error', `[录制生成] 失败: ${e.message}`)
    }
  }

  // 录制自动发送并在 AI 助手端回复
  const handleRecordAutoChat = async (promptText: string, recordNodeId: string) => {
    setIsChatSending(true)
    const userMsg = { role: 'user' as const, content: promptText }
    setChatMessages(prev => [...prev, userMsg])

    try {
      const systemPrompt = `你是一个专业的 RPA 流程图设计助手。用户完成了网页操作录制，你需要根据录制的步骤，生成对应节点图。
请务必返回完整的 RPA 流程节点图数据结构 (React Flow 格式) 作为 JSON 代码块。JSON 代码块之外你可以用自然语言解释你的设计。
请确保 JSON 的格式为：
\`\`\`json
{
  "nodes": [
    { "id": "node_1", "type": "click", "position": { "x": 250, "y": 250 }, "data": { "label": "点击百度按钮", "selector": "#su" } }
  ],
  "edges": [
    { "id": "e_open_1", "source": "CURRENT_NODE_ID", "target": "node_1" }
  ]
}
\`\`\`
其中首个连接边的 source 必须是当前节点的 ID（当前节点ID在 prompt 中已给出）。
注意：用户录制的第一步动作通常是网页加载/导航，请勿为重复的导航动作生成新的节点。你只需要为列表中的点击、填充、等待等后续操作步骤生成流程图节点。
支持的节点类型（type）规范：
- "click"：点击元素。data 格式为 { "label": "点击xxx", "selector": "CSS 选择器" }
- "fill"：输入文本。data 格式为 { "label": "输入xxx", "selector": "CSS 选择器", "value": "输入文本内容" }
- "wait"：延时等待。data 格式为 { "label": "延时", "ms": "延迟毫秒数" }
按垂直向下排列的拓扑顺序为 position 赋值（y坐标以100为步长递增，从当前节点的 y 坐标开始递增）。`

      const llmConfig = {
        provider: appStore.llmConfig.provider,
        apiKey: appStore.llmConfig.apiKey,
        baseUrl: appStore.llmConfig.baseUrl,
        model: appStore.llmConfig.model,
        temperature: 0.1,
        sessionId: (activeTaskId || 'rpa') + '-chat'
      }

      const response = await window.api.callLLM(llmConfig, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptText }
      ])

      setChatMessages(prev => [...prev, { role: 'assistant', content: response }])
      parseAndApplyCanvasJson(response, recordNodeId)
    } catch (e: any) {
      console.error(e)
      setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ 自动生成失败: ${e.message}` }])
    } finally {
      setIsChatSending(false)
    }
  }

  // 选中节点的表单渲染
  const renderAttrEditor = () => {
    if (!selectedNode) {
      return <div style={{ fontSize: '13px', color: '#64748b', textAlign: 'center', marginTop: '40px' }}>双击或选中节点进行配置</div>
    }

    return (
      <div>
        <div className="attr-title">配置 [{selectedNode.data?.label || selectedNode.type}]</div>

        <div className="attr-group">
          <label className="attr-label">节点名称</label>
          <input
            type="text"
            className="attr-input"
            value={selectedNode.data?.label || ''}
            onChange={(e) => handleAttrChange('label', e.target.value)}
          />
        </div>

        {selectedNode.type === 'open_url' && (
          <div className="attr-group">
            <label className="attr-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>网页 URL</span>
              <button
                onClick={() => handleRecordBrowser(selectedNode)}
                disabled={isChatSending}
                style={{ background: '#722ed1', color: 'white', border: 'none', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}
              >
                🎥 录制操作
              </button>
            </label>
            <input
              type="text"
              className="attr-input"
              value={selectedNode.data?.url || ''}
              onChange={(e) => handleAttrChange('url', e.target.value)}
              placeholder="https://..."
            />
          </div>
        )}

        {(selectedNode.type === 'click' || selectedNode.type === 'fill' || selectedNode.type === 'extract') && (
          <div className="attr-group">
            <label className="attr-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>元素选择器 (CSS Selector)</span>
              <button
                onClick={() => handlePickElement(selectedNode)}
                style={{ background: 'var(--rpa-primary)', color: 'white', border: 'none', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}
              >
                🎯 从网页拾取
              </button>
            </label>
            <input
              type="text"
              className="attr-input"
              value={selectedNode.data?.selector || ''}
              onChange={(e) => handleAttrChange('selector', e.target.value)}
              placeholder="e.g. #submit-btn or .input-field"
            />
          </div>
        )}

        {selectedNode.type === 'fill' && (
          <div className="attr-group">
            <label className="attr-label">填充文本值 (支持插值如 {"{{var}}"} )</label>
            <input
              type="text"
              className="attr-input"
              value={selectedNode.data?.value || ''}
              onChange={(e) => handleAttrChange('value', e.target.value)}
            />
          </div>
        )}

        {selectedNode.type === 'extract' && (
          <>
            <div className="attr-group">
              <label className="attr-label">提取类型</label>
              <select
                className="attr-input"
                value={selectedNode.data?.extractType || 'text'}
                onChange={(e) => handleAttrChange('extractType', e.target.value)}
              >
                <option value="text">提取 Text 纯文本</option>
                <option value="html">提取 Inner HTML</option>
                <option value="value">提取 Input Value</option>
              </select>
            </div>
            <div className="attr-group">
              <label className="attr-label">保存目标变量名</label>
              <input
                type="text"
                className="attr-input"
                value={selectedNode.data?.varName || ''}
                onChange={(e) => handleAttrChange('varName', e.target.value)}
                placeholder="e.g. extracted_result"
              />
            </div>
          </>
        )}

        {selectedNode.type === 'wait' && (
          <div className="attr-group">
            <label className="attr-label">延时时长 (ms)</label>
            <input
              type="number"
              className="attr-input"
              value={selectedNode.data?.ms || '1000'}
              onChange={(e) => handleAttrChange('ms', e.target.value)}
            />
          </div>
        )}

        {selectedNode.type === 'manual_confirm' && (
          <div className="attr-group">
            <label className="attr-label">等待时展示的提示语</label>
            <input
              type="text"
              className="attr-input"
              value={selectedNode.data?.prompt || ''}
              onChange={(e) => handleAttrChange('prompt', e.target.value)}
            />
          </div>
        )}

        {selectedNode.type === 'ai_node' && (
          <>
            <div className="attr-group">
              <label className="attr-label">Prompt 提示词模板 (支持 {"{{var}}"} 插值)</label>
              <textarea
                className="attr-input"
                style={{ height: '120px', resize: 'vertical' }}
                value={selectedNode.data?.prompt || ''}
                onChange={(e) => handleAttrChange('prompt', e.target.value)}
              />
            </div>
            <div className="attr-group">
              <label className="attr-label">结果保存变量名</label>
              <input
                type="text"
                className="attr-input"
                value={selectedNode.data?.varName || ''}
                onChange={(e) => handleAttrChange('varName', e.target.value)}
                placeholder="e.g. summary_data"
              />
            </div>
          </>
        )}

        {selectedNode.type === 'condition' && (
          <div className="attr-group">
            <label className="attr-label">JS 条件表达式 (评估 true/false)</label>
            <input
              type="text"
              className="attr-input"
              value={selectedNode.data?.expression || ''}
              onChange={(e) => handleAttrChange('expression', e.target.value)}
              placeholder="e.g. context.var_name.includes('成功')"
            />
          </div>
        )}


      </div>
    )
  }

  // ── AI 聊天助手选项卡渲染逻辑 ────────────────────────────────────
  const handleSendChat = async () => {
    if (!chatInput.trim() || isChatSending) return
    const userMsg = { role: 'user' as const, content: chatInput.trim() }
    const newMessages = [...chatMessages, userMsg]
    setChatMessages(newMessages)
    setChatInput('')
    setIsChatSending(true)

    try {
      const systemPrompt = `你是一个专业的 RPA 流程图设计助手。用户当前正在编辑一个 RPA 任务流程图。
任务信息: ${JSON.stringify(currentTask || {})}
当前选中的节点: ${selectedNode ? JSON.stringify(selectedNode) : '未选中节点'}
当前流程图的完整节点与连线数据如下：
- 节点列表 (nodes): ${JSON.stringify(nodes)}
- 边列表 (edges): ${JSON.stringify(edges)}
- 当前选中节点 ID: ${selectedNodeId || '无'}

如果用户要求你调整流程图（例如调整节点坐标位置、修改节点名称、修改 selector 等属性，或者追加新节点）：
1. 如果是调整或修改已有的节点，请在返回的 JSON 代码块中，务必保持它们原本的 "id" 不变，仅更新对应的坐标坐标 "position"、标签 label 或配置属性。
2. 如果是增加新节点，请为它们分配一个全新的唯一 id（如 "node_xxx"），并在 "edges" 中建立正确的连接关系。
3. 请务必返回完整的 RPA 流程节点图数据结构 (React Flow 格式) 作为 JSON 代码块，格式如下：
\`\`\`json
{
  "nodes": [
    { "id": "node_existing_or_new", "type": "click", "position": { "x": 250, "y": 250 }, "data": { "label": "点击按钮", "selector": ".btn" } }
  ],
  "edges": [
    { "id": "e_link", "source": "node_source", "target": "node_target" }
  ]
}
\`\`\`
请以简明、专业的态度回答用户的问题，提供关于如何组织流程节点、如何设置 CSS 选择器、如何使用 AI 处理节点等方面的指导。`

      const llmConfig = {
        provider: appStore.llmConfig.provider,
        apiKey: appStore.llmConfig.apiKey,
        baseUrl: appStore.llmConfig.baseUrl,
        model: appStore.llmConfig.model,
        temperature: 0.7,
        sessionId: (activeTaskId || 'rpa') + '-chat'
      }

      const formattedMessages = [
        { role: 'system', content: systemPrompt },
        ...newMessages.map(m => ({ role: m.role, content: m.content }))
      ]

      const response = await window.api.callLLM(llmConfig, formattedMessages)
      setChatMessages(prev => [...prev, { role: 'assistant', content: response }])

      // 自动解析聊天框里的 JSON 并应用到画布
      parseAndApplyCanvasJson(response)
    } catch (e: any) {
      console.error(e)
      setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ 发送失败: ${e.message}` }])
    } finally {
      setIsChatSending(false)
    }
  }

  const renderChatTab = () => {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* 聊天历史记录 */}
        <div className="rpa-chat-history" style={{ flex: 1, overflowY: 'auto', paddingBottom: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {chatMessages.map((msg, idx) => (
            <div key={idx} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div
                style={{
                  maxWidth: '85%',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  fontSize: '12.5px',
                  lineHeight: '1.4',
                  whiteSpace: 'pre-wrap',
                  background: msg.role === 'user' ? 'var(--rpa-primary)' : 'var(--rpa-bg-layout)',
                  color: msg.role === 'user' ? '#fff' : 'var(--rpa-text-main)',
                  border: msg.role === 'user' ? 'none' : '1px solid var(--rpa-border)'
                }}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {isChatSending && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{ padding: '8px 12px', borderRadius: '8px', background: 'var(--rpa-bg-layout)', color: 'var(--rpa-text-muted)', fontSize: '12px', border: '1px solid var(--rpa-border)' }}>
                🤖 AI 正在输入中...
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* 底部输入框 */}
        <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid var(--rpa-border)', paddingTop: '10px' }}>
          <input
            type="text"
            className="attr-input"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSendChat() }}
            placeholder="向 AI 咨询或下达指令..."
            disabled={isChatSending}
            style={{ flex: 1 }}
          />
          <button
            className="btn-primary"
            onClick={handleSendChat}
            disabled={isChatSending || !chatInput.trim()}
            style={{ padding: '6px 12px', flexShrink: 0 }}
          >
            发送
          </button>
        </div>
      </div>
    )
  }

  // ── 第一级：任务列表主页 ─────────────────────────────────────
  if (activeTaskId === null) {
    return (
      <div className="rpa-container">
        <div className="rpa-list-view">
          <div className="rpa-list-header" style={{ justifyContent: 'flex-end' }}>
            <button className="btn-primary" onClick={() => { setNewName(''); setNewDesc(''); setShowCreateModal(true) }}>
              + 新建 RPA 任务
            </button>
          </div>

          <div className="rpa-task-grid">
            {tasks.map(task => (
              <div key={task.id} className="glass-panel rpa-task-card" onClick={() => selectTask(task.id)}>
                <div className="rpa-card-actions" onClick={e => e.stopPropagation()}>
                  <button className="btn-card-action" style={{ color: '#ef4444' }} onClick={() => { if (confirm('确定删除该任务吗？')) deleteTask(task.id) }} title="删除任务">
                    🗑️
                  </button>
                </div>
                <div className="rpa-card-name">📋 {task.name}</div>
                <div className="rpa-card-desc">{task.description || '无任务说明'}</div>
                <div className="rpa-card-footer">
                  <span className={`status-badge ${task.lastRunStatus || 'idle'}`}>{task.lastRunStatus || '未运行'}</span>
                  <span>创建: {task.createdAt?.split(' ')[0] || '-'}</span>
                </div>
              </div>
            ))}

            {tasks.length === 0 && (
              <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '60px', color: '#94a3b8', fontSize: '14px' }}>
                🫙 暂无 RPA 任务，点击右上方按钮开始创建！
              </div>
            )}
          </div>
        </div>

        {/* 新建任务 Modal */}
        {showCreateModal && (
          <div className="mcp-modal-overlay">
            <div className="mcp-modal-card" style={{ maxWidth: '400px', width: '90%' }}>
              <div className="mcp-modal-header">
                <div className="mcp-modal-title">新建 RPA 任务</div>
                <button className="mcp-modal-close-btn" onClick={() => setShowCreateModal(false)}>×</button>
              </div>
              <div className="mcp-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label className="attr-label">任务名称</label>
                  <input type="text" className="attr-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="输入有意义的名称" />
                </div>
                <div>
                  <label className="attr-label">任务描述</label>
                  <input type="text" className="attr-input" value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="简要描述任务目标" />
                </div>
              </div>
              <div className="mcp-modal-footer">
                <button onClick={() => setShowCreateModal(false)} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(0,0,0,0.15)', background: 'transparent', cursor: 'pointer' }}>取消</button>
                <button
                  onClick={async () => {
                    if (!newName.trim()) return
                    await createTask(newName.trim(), newDesc.trim())
                    setShowCreateModal(false)
                  }}
                  style={{ padding: '6px 16px', borderRadius: '6px', border: 'none', background: '#3b82f6', color: 'white', cursor: 'pointer', fontWeight: 600 }}
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── 第二级：左右结构详情页 ────────────────────────────────────
  const currentTask = tasks.find(t => t.id === activeTaskId)

  return (
    <div className="rpa-container">
      <div className="rpa-detail-header">
        <div className="rpa-header-left">
          <button className="btn-back" onClick={() => selectTask(null)}>
            ⬅ 返回列表
          </button>
          <div style={{ fontSize: '16px', fontWeight: 700 }}>
            {currentTask?.name}
          </div>
        </div>
      </div>

      <div className="rpa-detail-body">
        {/* 左侧 React Flow 编辑画布 */}
        <div className="rpa-canvas-container">
          {/* 常用操作节点快捷添加悬浮栏 */}
          <div className="rpa-canvas-toolbar">
            <button className="btn-back" onClick={() => handleAddNode('open_url')} title="添加网页节点 (打开网页)">🌐</button>
            <button className="btn-back" onClick={() => handleAddNode('click')} title="添加点击节点 (点击元素)">🖱️</button>
            <button className="btn-back" onClick={() => handleAddNode('fill')} title="添加输入节点 (输入文本)">✍️</button>
            <button className="btn-back" onClick={() => handleAddNode('extract')} title="添加提取节点 (内容提取)">📋</button>
            <button className="btn-back" onClick={() => handleAddNode('wait')} title="添加延时节点 (延时等待)">⏳</button>
            <button className="btn-back" onClick={() => handleAddNode('manual_confirm')} title="添加人工确认节点 (人工干预)">⚠️</button>
            <button className="btn-back" onClick={() => handleAddNode('condition')} title="添加条件判断节点 (条件分支)">❓</button>



            {/* 撤回按钮 */}
            <button
              className="btn-back"
              style={{ marginLeft: '12px' }}
              onClick={handleUndo}
              disabled={history.length === 0}
              title="撤回到上一步 (Undo, 支持 Ctrl+Z)"
            >
              ↩️
            </button>

            <button
              className={`btn-back ${showPanel ? 'active-toggle' : ''}`}
              style={{ marginLeft: 'auto', marginRight: '8px' }}
              onClick={() => setShowPanel(prev => !prev)}
              title={showPanel ? '隐藏操作面板' : '显示操作面板'}
            >
              💻
            </button>

            <button
              className={`btn-back ${showMiniMap ? 'active-toggle' : ''}`}
              style={{ marginLeft: 0 }}
              onClick={() => setShowMiniMap(prev => !prev)}
              title={showMiniMap ? '隐藏缩略图' : '显示缩略图'}
            >
              🗺️
            </button>
          </div>

          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => {
              const hasRemove = changes.some((c: any) => c.type === 'remove')
              if (hasRemove) saveToHistory()
              onNodesChange(changes)
            }}
            onEdgesChange={(changes) => {
              const hasRemove = changes.some((c: any) => c.type === 'remove')
              if (hasRemove) saveToHistory()
              onEdgesChange(changes)
            }}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id)
              setActiveTab('attr')
              setShowPanel(true)
              setMenu(null)
            }}
            onPaneClick={() => {
              setSelectedNodeId(null)
              setMenu(null)
              if (activeTab === 'attr') {
                setShowPanel(false)
              }
            }}
            onNodeDragStart={() => saveToHistory()}
            onNodeContextMenu={(event, node) => {
              event.preventDefault()
              setMenu({
                id: node.id,
                x: event.clientX,
                y: event.clientY
              })
            }}
            fitView
          >
            <Background />
            <Controls />
            {showMiniMap && (
              <MiniMap
                nodeColor={(node) => {
                  switch (node.type) {
                    case 'start': return '#00b42a';
                    case 'end': return '#f53f3f';
                    case 'open_url': return '#1677ff';
                    case 'click': return '#13c2c2';
                    case 'fill': return '#722ed1';
                    case 'extract': return '#eb2f96';
                    case 'wait': return '#d97706';
                    case 'manual_confirm': return '#ff7d00';
                    case 'ai_node': return '#2f54eb';
                    case 'condition': return '#ff7d00';
                    default: return '#e5e6eb';
                  }
                }}
                nodeStrokeColor="rgba(0, 0, 0, 0.15)"
                nodeStrokeWidth={1}
                nodeBorderRadius={4}
              />
            )}
          </ReactFlow>
        </div>

        {/* 右侧属性面板 / 运行日志与变量状态 */}
        {showPanel && (
          <div className="rpa-panel-container">
            <div className="rpa-panel-tabs" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', flex: 1 }}>
                <div className={`rpa-panel-tab ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
                  💻 控制台
                </div>
                <div className={`rpa-panel-tab ${activeTab === 'attr' ? 'active' : ''}`} onClick={() => setActiveTab('attr')}>
                  ⚙️ 节点配置
                </div>
                <div className={`rpa-panel-tab ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}>
                  💬 AI 助手
                </div>
              </div>
              <button
                onClick={() => setShowPanel(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '18px',
                  color: 'var(--rpa-text-muted)',
                  cursor: 'pointer',
                  padding: '0 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: 1
                }}
                title="关闭面板"
              >
                ×
              </button>
            </div>

            <div className="rpa-panel-content">
              {activeTab === 'attr' && renderAttrEditor()}
              {activeTab === 'chat' && renderChatTab()}

              {activeTab === 'logs' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  {/* 运行控制 */}
                  <div className="rpa-control-section">
                    {executionState === 'running' || executionState === 'paused' ? (
                      <button className="btn-ctrl stop" onClick={stopTask}>
                        🟥 停止运行
                      </button>
                    ) : (
                      <button className="btn-ctrl run" onClick={runTask}>
                        ▶️ 启动流程
                      </button>
                    )}
                    <button className="btn-back" style={{ flex: 'none', padding: '0 12px' }} onClick={store.clearLogs}>
                      🧹 清空
                    </button>
                  </div>

                  {/* 执行状态高亮 */}
                  <div style={{ fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 10px' }}>
                    <span>状态: </span>
                    <span className={`status-badge ${executionState}`}>{executionState === 'paused' ? '等待人工干预' : executionState}</span>
                  </div>

                  {/* 人工干预操作抽屉 */}
                  {manualConfirmData && (
                    <div style={{ padding: '12px', border: '1px solid #fde68a', background: '#fffdf5', borderRadius: '4px', marginBottom: '12px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#b45309', marginBottom: '6px' }}>⚠️ 等待人工确认 / 手动干预</div>
                      <div style={{ fontSize: '12px', color: '#78350f', marginBottom: '10px', lineHeight: '1.4' }}>
                        {manualConfirmData.prompt}
                      </div>

                      {/* 提供一个轻量级表单允许人工修改变量或写入确认信息 */}
                      <div style={{ marginBottom: '10px' }}>
                        <label className="attr-label" style={{ fontSize: '11px', color: '#b45309' }}>追加/覆盖确认信息到上下文 (可选)</label>
                        <input
                          type="text"
                          className="attr-input"
                          style={{ padding: '6px 10px', fontSize: '12px', borderColor: '#fde68a' }}
                          value={manualInputVal}
                          onChange={e => setManualInputVal(e.target.value)}
                          placeholder="请输入你要覆盖的中间值或备注"
                        />
                      </div>

                      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => respondManualConfirm(manualInputVal ? { manual_notes: manualInputVal } : undefined)}
                          style={{ padding: '5px 12px', fontSize: '11px', background: '#d97706', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                        >
                          我已处理，继续流程
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 日志框 */}
                  <div style={{ fontSize: '12.5px', fontWeight: 'bold', margin: '10px 0 4px' }}>运行日志:</div>
                  <div className="rpa-log-box">
                    {logs.map((log, idx) => (
                      <div key={idx} className={`log-item ${log.level}`}>
                        {log.message}
                      </div>
                    ))}
                    {logs.length === 0 && <div style={{ color: '#64748b', textAlign: 'center', marginTop: '40px' }}>暂无运行日志</div>}
                  </div>

                  {/* 变量列表 */}
                  <div className="rpa-variables-box">
                    <div style={{ fontSize: '12.5px', fontWeight: 'bold', margin: '12px 0 6px' }}>上下文变量状态 (Variables):</div>
                    {Object.entries(runContext).map(([key, val]) => (
                      <div key={key} className="variable-tag">
                        <span style={{ fontWeight: 'bold' }}>{key}</span>
                        <span style={{ color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '200px' }} title={String(val)}>
                          {String(val)}
                        </span>
                      </div>
                    ))}
                    {Object.keys(runContext).length === 0 && (
                      <div style={{ fontSize: '12px', color: '#94a3b8', fontStyle: 'italic' }}>目前无保存的中间变量</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 元素拾取测试 URL 输入弹窗 */}
      {showPickerPrompt && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: 'var(--rpa-bg-panel)', padding: '24px', borderRadius: '8px', width: '420px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '15px', color: 'var(--rpa-text-main)' }}>启动可视化元素拾取器</h3>
            <p style={{ margin: '0 0 16px 0', fontSize: '12.5px', color: '#64748b' }}>我们需要一个测试网址来启动真实浏览器，请确认或修改：</p>
            <input
              type="text"
              value={pickerUrl}
              onChange={e => setPickerUrl(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--rpa-border)', borderRadius: '4px', fontSize: '13px', marginBottom: '20px', background: 'var(--rpa-bg-layout)', color: 'var(--rpa-text-main)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button
                onClick={() => setShowPickerPrompt(false)}
                style={{ padding: '6px 16px', border: '1px solid var(--rpa-border)', background: 'transparent', color: 'var(--rpa-text-main)', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
              >
                取消
              </button>
              <button
                onClick={confirmPickElement}
                style={{ padding: '6px 16px', border: 'none', background: 'var(--rpa-primary)', color: 'white', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
              >
                🚀 启动浏览器拾取
              </button>
            </div>
          </div>
        </div>
      )}
      {menu && (
        <div
          className="rpa-context-menu"
          style={{
            position: 'fixed',
            top: menu.y,
            left: menu.x,
            zIndex: 10000
          }}
        >
          <button
            className="rpa-context-menu-item"
            onClick={() => {
              // Delete the node
              saveToHistory()
              const updatedNodes = nodes.filter(n => n.id !== menu.id)
              const updatedEdges = edges.filter(e => e.source !== menu.id && e.target !== menu.id)
              setNodes(updatedNodes)
              setEdges(updatedEdges)
              if (activeTaskId) {
                window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: updatedNodes, edges: updatedEdges })
              }
              if (selectedNodeId === menu.id) {
                setSelectedNodeId(null)
                if (activeTab === 'attr') setShowPanel(false)
              }
              setMenu(null)
            }}
          >
            🗑️ 删除节点
          </button>
        </div>
      )}
    </div>
  )
}

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { ReactFlow, Background, Controls, MiniMap, Connection, addEdge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useRpaStore } from './useRpaStore'
import { useAppStoreRaw } from '../hooks/useAppStore'
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
  ConditionNode,
  DesktopFocusNode,
  DesktopClickNode,
  DesktopTypeNode,
  DesktopHotkeyNode,
  DesktopScrollNode
} from './nodes/CustomNodes'
import './rpa.css'
import {
  ArrowLeft,
  Bot,
  Crosshair,
  Eraser,
  KeyRound,
  List,
  Map as MapIcon,
  Pause,
  Play,
  Plus,
  Square,
  Target,
  Trash2,
  TriangleAlert,
  Undo2,
  X
} from 'lucide-react'

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
  condition: ConditionNode,
  desktop_focus: DesktopFocusNode,
  desktop_click: DesktopClickNode,
  desktop_type: DesktopTypeNode,
  desktop_hotkey: DesktopHotkeyNode,
  desktop_scroll: DesktopScrollNode
}

export function RpaPage(): React.JSX.Element {
  const store = useRpaStore()
  const appLlmConfig = useAppStoreRaw(state => state.llmConfig)

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
    updateTask,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    runTask,
    pauseTask,
    resumeTask,
    stopTask,
    respondManualConfirm,
    setupListeners
  } = store

  // 1. 初始化监听 IPC 状态
  useEffect(() => {
    fetchTasks()
    window.api.listRpaSecrets().then(setSecrets).catch(() => setSecrets([]))
    const cleanup = setupListeners()
    return () => cleanup()
  }, [])

  // 2. 状态：选中的节点（用于右侧属性编辑）
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [nodeCardPosition, setNodeCardPosition] = useState<{ x: number; y: number } | null>(null)
  const selectedNode = useMemo(() => {
    return nodes.find(n => n.id === selectedNodeId) || null
  }, [nodes, selectedNodeId])

  // 3. 状态：右侧 Tab
  const [activeTab, setActiveTab] = useState<'attr' | 'logs' | 'chat' | 'credentials'>('logs')
  const [secrets, setSecrets] = useState<any[]>([])
  const [newSecretRef, setNewSecretRef] = useState('secret.')
  const [newSecretLabel, setNewSecretLabel] = useState('')
  const [newSecretValue, setNewSecretValue] = useState('')
  const [editingSecretRef, setEditingSecretRef] = useState<string | null>(null)
  const [editingSecretValue, setEditingSecretValue] = useState('')
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [chatInput, setChatInput] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

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
  const [pickerMode, setPickerMode] = useState<'pick' | 'record'>('pick')
  const [recordingMode, setRecordingMode] = useState<'browser' | 'desktop'>('browser')
  const [desktopWindows, setDesktopWindows] = useState<Array<{ processId: number; processName: string; windowTitle: string }>>([])
  const [selectedDesktopProcessId, setSelectedDesktopProcessId] = useState('')
  const [isLoadingDesktopWindows, setIsLoadingDesktopWindows] = useState(false)
  const [recordingSetupError, setRecordingSetupError] = useState('')

  // 8. 状态：是否显示缩略图
  const [showMiniMap, setShowMiniMap] = useState(false)

  // 9. 状态：是否显示右侧面板
  const [showPanel, setShowPanel] = useState(false)

  const [isChatSending, setIsChatSending] = useState(false)

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

  const captureDesktopTargetForNode = async () => {
    if (!selectedNodeId) return
    store.appendLog('info', '[坐标拾取] 请在 1.5 秒内将鼠标移到目标位置。')
    const target = await window.api.captureRpaDesktopTarget(1500)
    const updatedNodes = nodes.map((node) => node.id === selectedNodeId ? {
      ...node,
      data: {
        ...node.data,
        x: target.x,
        y: target.y,
        name: target.name || node.data?.name,
        automationId: target.automationId || node.data?.automationId,
        controlType: target.controlType || node.data?.controlType,
        processName: target.processName || node.data?.processName,
        windowTitle: target.windowTitle || node.data?.windowTitle
      }
    } : node)
    setNodes(updatedNodes)
    if (activeTaskId) await window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: updatedNodes, edges })
    store.appendLog('info', `[桌面拾取] 已捕获 ${target.controlType || '坐标'} · (${target.x}, ${target.y})`)
  }

  // ── 元素拾取器处理逻辑 ──────────────────────────────────────
  const handlePickElement = (node: any) => {
    // 尝试寻找当前流程中的测试网址 (寻找前置或第一个打开网页的节点)
    const openUrlNode = nodes.find(n => n.type === 'open_url')
    let testUrl = openUrlNode?.data?.url || 'https://www.baidu.com'

    setPickerUrl(testUrl)
    setPendingPickNode(node)
    setPickerMode('pick')
    setShowPickerPrompt(true)
  }

  const refreshDesktopWindows = () => {
    setIsLoadingDesktopWindows(true)
    void window.api.listRpaDesktopWindows()
      .then(setDesktopWindows)
      .catch(() => setDesktopWindows([]))
      .finally(() => setIsLoadingDesktopWindows(false))
  }

  const handleRecordWorkflow = () => {
    const openUrlNode = nodes.find(node => node.type === 'open_url')
    setPickerUrl(openUrlNode?.data?.url || 'https://')
    setPendingPickNode(null)
    setPickerMode('record')
    setRecordingMode('browser')
    setSelectedDesktopProcessId('')
    setRecordingSetupError('')
    setShowPickerPrompt(true)
  }

  const confirmPickElement = async () => {
    if (pickerMode === 'record' && recordingMode === 'browser' && (!pickerUrl || pickerUrl === 'https://')) {
      setRecordingSetupError('请输入要打开的网址。')
      return
    }
    if (pickerMode !== 'record' && !pickerUrl) return
    setShowPickerPrompt(false)

    if (pickerMode === 'record') {
      const selectedDesktopTarget = desktopWindows.find(item => String(item.processId) === selectedDesktopProcessId)
      await handleRecordBrowser(recordingMode, selectedDesktopTarget)
      return
    }

    if (!pendingPickNode) return

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

  // ── 浏览器 / Windows 桌面录制 ────────────────────────────────────
  const handleRecordBrowser = async (
    mode: 'browser' | 'desktop' = 'browser',
    desktopTarget?: { processId: number; processName: string; windowTitle: string }
  ) => {
    let testUrl = mode === 'desktop' ? 'about:blank' : pickerUrl || 'https://www.baidu.com'
    if (testUrl !== 'about:blank' && !testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
      testUrl = 'https://' + testUrl
    }

    try {
      setActiveTab('logs')
      const initialTargetLabel = mode === 'browser' ? testUrl : desktopTarget?.windowTitle || 'Windows 桌面'
      store.appendLog('info', `[录制] 正在启动${mode === 'desktop' ? '桌面' : '浏览器'}录制：${initialTargetLabel}`)
      if (mode !== 'browser') store.appendLog('info', '[录制] 操作完成后按 Ctrl+Shift+F12 结束录制。')

      const rawRecordedActions = await window.api.rpaRecordActions({ url: testUrl, mode, desktopTarget })
      const recordedActions = await window.api.normalizeRpaRecordedActions(rawRecordedActions).catch(() => rawRecordedActions)
      if (!recordedActions || recordedActions.length === 0) {
        store.appendLog('warn', `[录制] 录制已取消或没有捕捉到有效操作`)
        return
      }

      store.appendLog('info', `[录制] 录制结束。共捕获到 ${recordedActions.length} 步操作。`)
      recordedActions.filter((action: any) => action?.normalizationSource).forEach((action: any) => {
        const source = action.normalizationSource === 'uia' ? '系统输入框' : '输入法模型'
        store.appendLog('info', `[录制生成] ${source}内容已还原：${action.rawRecordedValue || '(组合输入)'} → ${action.value}`)
      })

      let filteredActions = recordedActions.map((action: any) => {
        if (!action?.sensitive) return action
        const safeAction = { ...action }
        delete safeAction.value
        return { ...safeAction, value: '', requiresCredentialBinding: true }
      })
      filteredActions = filteredActions.filter((action: any) => {
        if (action.automationId === 'finish-button') return false
        if (action.type !== 'open_url') return true
        return action.url !== 'about:blank'
      })

      if (filteredActions.length === 0) {
        store.appendLog('warn', `[录制] 录制未捕获到除打开网页之外的其他有效操作`)
        return
      }

      const startX = 250
      const startY = 60
      const stamp = Date.now()
      const generatedNodes = filteredActions.map((action: any, index: number) => {
        const previousRecordedAt = Number(filteredActions[index - 1]?.recordedAt || action.recordedAt || 0)
        const recordedDelayMs = Math.max(0, Number(action.recordedAt || 0) - previousRecordedAt)
        const common = {
          id: `recorded_${stamp}_${index}`,
          position: { x: startX, y: startY + (index + 1) * 120 },
          recordedDelayMs
        }
        switch (action.type) {
          case 'open_url': return { ...common, type: 'open_url', data: { label: action.label || '打开网页', url: action.url } }
          case 'click': return { ...common, type: 'click', data: { label: action.label || '点击元素', selector: action.selector } }
          case 'fill': return { ...common, type: 'fill', data: { label: action.label || '输入文本', selector: action.selector, value: action.value || '', requiresCredentialBinding: Boolean(action.requiresCredentialBinding) } }
          case 'desktop_focus': return { ...common, type: 'desktop_focus', data: { label: action.label || '切换窗口', windowAlias: 'desktop', windowTitle: action.windowTitle || '', processName: action.processName || '', recordedPid: action.processId, showDesktop: Boolean(action.showDesktop) } }
          case 'desktop_click': return { ...common, type: 'desktop_click', data: { label: action.label || '桌面点击', windowAlias: 'desktop', x: action.x, y: action.y, relativeX: action.relativeX, relativeY: action.relativeY, displayRelativeX: action.displayRelativeX, displayRelativeY: action.displayRelativeY, displayLeft: action.displayLeft, displayTop: action.displayTop, displayWidth: action.displayWidth, displayHeight: action.displayHeight, displayPrimary: action.displayPrimary, button: action.button || 'left', double: Boolean(action.double), name: action.name || '', automationId: action.automationId || '', controlType: action.controlType || '', processName: action.processName || '', windowTitle: action.windowTitle || '', recordedPid: action.processId } }
          case 'desktop_type': return { ...common, type: 'desktop_type', data: { label: action.label || '桌面输入', windowAlias: 'desktop', value: action.value || '', rawRecordedValue: action.rawRecordedValue || '', normalizationSource: action.normalizationSource || '', normalizationConfidence: action.normalizationConfidence || '', requiresCredentialBinding: Boolean(action.requiresCredentialBinding), x: action.x, y: action.y, relativeX: action.relativeX, relativeY: action.relativeY, displayRelativeX: action.displayRelativeX, displayRelativeY: action.displayRelativeY, displayPrimary: action.displayPrimary, name: action.name || '', automationId: action.automationId || '', controlType: action.controlType || '', recordedPid: action.processId, processName: action.processName || '', windowTitle: action.windowTitle || '' } }
          case 'desktop_hotkey': return { ...common, type: 'desktop_hotkey', data: { label: action.label || '快捷键', windowAlias: 'desktop', keys: action.keys, processName: action.processName || '', windowTitle: action.windowTitle || '' } }
          case 'desktop_scroll': return { ...common, type: 'desktop_scroll', data: { label: action.label || '桌面滚动', windowAlias: 'desktop', x: action.x, y: action.y, relativeX: action.relativeX, relativeY: action.relativeY, displayRelativeX: action.displayRelativeX, displayRelativeY: action.displayRelativeY, displayLeft: action.displayLeft, displayTop: action.displayTop, displayWidth: action.displayWidth, displayHeight: action.displayHeight, displayPrimary: action.displayPrimary, processName: action.processName || '', windowTitle: action.windowTitle || '', direction: action.direction || 'down', amount: action.amount || 1 } }
          default: return null
        }
      }).filter(Boolean) as any[]

      if (generatedNodes.length === 0) {
        store.appendLog('warn', '[录制] 捕获到的动作暂时无法转换为流程节点。')
        return
      }

      const startNode = { id: 'start', type: 'start', position: { x: startX, y: startY }, data: { label: '开始' } }
      const endNode = { id: 'end', type: 'end', position: { x: startX, y: startY + (generatedNodes.length + 1) * 120 }, data: { label: '结束' } }
      const chainNodes = [startNode, ...generatedNodes, endNode]
      const updatedEdges = chainNodes.slice(0, -1).map((sourceNode, index) => ({
        id: `e_recorded_${stamp}_${index}`,
        source: sourceNode.id,
        target: chainNodes[index + 1].id
      }))
      const updatedNodes = chainNodes
      saveToHistory()
      setNodes(updatedNodes)
      setEdges(updatedEdges)
      if (activeTaskId) await window.api.saveRpaTaskFlow(activeTaskId, { id: activeTaskId, nodes: updatedNodes, edges: updatedEdges })
      store.appendLog('info', `[录制] 已生成 ${generatedNodes.length} 个流程节点，其中桌面节点 ${generatedNodes.filter(item => item.type.startsWith('desktop_')).length} 个。`)

    } catch (e: any) {
      console.error(e)
      store.appendLog('error', `[录制生成] 失败: ${e.message}`)
    } finally {
      await window.api.completeRpaRecordingProcessing().catch(() => false)
    }
  }

  const createCredential = async () => {
    if (!activeTaskId || !newSecretRef.startsWith('secret.') || !newSecretValue) return
    await window.api.createRpaSecret({
      ref: newSecretRef,
      plaintext: newSecretValue,
      label: newSecretLabel || newSecretRef,
      allowedWorkflowIds: [activeTaskId],
      allowedSurfaces: ['browser', 'desktop']
    })
    setNewSecretValue('')
    setNewSecretLabel('')
    setSecrets(await window.api.listRpaSecrets())
  }

  const updateCredentialValue = async () => {
    if (!editingSecretRef || !editingSecretValue) return
    await window.api.rotateRpaSecret(editingSecretRef, editingSecretValue)
    setEditingSecretRef(null)
    setEditingSecretValue('')
    setSecrets(await window.api.listRpaSecrets())
  }

  // 选中节点的表单渲染
  const renderAttrEditor = () => {
    if (!selectedNode) {
      return <div style={{ fontSize: '13px', color: '#64748b', textAlign: 'center', marginTop: '40px' }}>双击或选中节点进行配置</div>
    }

    return (
      <div className="rpa-node-config-fields">

        {selectedNode.type === 'open_url' && (
          <div className="attr-group">
            <label className="attr-label">网页 URL</label>
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
                <Target size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                从网页拾取
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
            <label className="attr-label" style={{ marginTop: 10 }}>或绑定凭据</label>
            <select className="attr-input" value={String(selectedNode.data?.value || '').startsWith('${secret.') ? selectedNode.data.value : ''} onChange={(e) => handleAttrChange('value', e.target.value)}>
              <option value="">不使用凭据</option>
              {secrets.filter((secret) => secret.status === 'active').map((secret) => <option key={secret.ref} value={`\${${secret.ref}}`}>{secret.label} · {secret.ref}</option>)}
            </select>
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

        {selectedNode.type.startsWith('desktop_') && (
          <div className="rpa-desktop-inspector">
            <div className="rpa-surface-note"><span />桌面点击使用窗口或显示器相对坐标；分辨率变化时自动按比例换算。</div>
            <div className="attr-group"><label className="attr-label">窗口锚点</label><input className="attr-input" value={selectedNode.data?.windowAlias || 'desktop'} onChange={(e) => handleAttrChange('windowAlias', e.target.value)} /></div>
            {selectedNode.type === 'desktop_focus' && <><div className="attr-group"><label className="attr-label">窗口标题</label><input className="attr-input" value={selectedNode.data?.windowTitle || ''} onChange={(e) => handleAttrChange('windowTitle', e.target.value)} placeholder="例如：ERP 客户端" /></div><div className="attr-group"><label className="attr-label">进程名</label><input className="attr-input" value={selectedNode.data?.processName || ''} onChange={(e) => handleAttrChange('processName', e.target.value)} /></div></>}
            {selectedNode.type === 'desktop_click' && <><button className="btn-primary rpa-pick-desktop" onClick={captureDesktopTargetForNode}><Crosshair size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />拾取屏幕坐标</button><div className="attr-group"><label className="attr-label">点击方式</label><select className="attr-input" value={selectedNode.data?.double ? 'double' : 'single'} onChange={(e) => handleAttrChange('double', e.target.value === 'double')}><option value="single">单击</option><option value="double">双击</option></select></div><div className="rpa-coordinate-grid"><input className="attr-input" type="number" value={selectedNode.data?.x || 0} onChange={(e) => handleAttrChange('x', Number(e.target.value))} /><input className="attr-input" type="number" value={selectedNode.data?.y || 0} onChange={(e) => handleAttrChange('y', Number(e.target.value))} /></div></>}
            {selectedNode.type === 'desktop_type' && <><div className="attr-group"><label className="attr-label">输入内容</label><input className="attr-input" value={selectedNode.data?.value || ''} onChange={(e) => handleAttrChange('value', e.target.value)} /></div><div className="attr-group"><label className="attr-label">凭据绑定</label><select className="attr-input" value={String(selectedNode.data?.value || '').startsWith('${secret.') ? selectedNode.data.value : ''} onChange={(e) => handleAttrChange('value', e.target.value)}><option value="">不使用凭据</option>{secrets.filter((secret) => secret.status === 'active').map((secret) => <option key={secret.ref} value={`\${${secret.ref}}`}>{secret.label} · {secret.ref}</option>)}</select></div></>}
            {selectedNode.type === 'desktop_hotkey' && <div className="attr-group"><label className="attr-label">组合键</label><input className="attr-input" value={selectedNode.data?.keys || ''} onChange={(e) => handleAttrChange('keys', e.target.value)} placeholder="Ctrl+Shift+S" /></div>}
            {selectedNode.type === 'desktop_scroll' && <><div className="attr-group"><label className="attr-label">方向</label><select className="attr-input" value={selectedNode.data?.direction || 'down'} onChange={(e) => handleAttrChange('direction', e.target.value)}><option value="down">向下</option><option value="up">向上</option></select></div><div className="attr-group"><label className="attr-label">滚动量</label><input className="attr-input" type="number" value={selectedNode.data?.amount || 3} onChange={(e) => handleAttrChange('amount', Number(e.target.value))} /></div><div className="attr-group"><label className="attr-label">滚动位置</label><div className="rpa-coordinate-grid"><input className="attr-input" type="number" value={selectedNode.data?.x || 0} onChange={(e) => handleAttrChange('x', Number(e.target.value))} /><input className="attr-input" type="number" value={selectedNode.data?.y || 0} onChange={(e) => handleAttrChange('y', Number(e.target.value))} /></div></div></>}
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
        provider: appLlmConfig.provider,
        apiKey: appLlmConfig.apiKey,
        baseUrl: appLlmConfig.baseUrl,
        model: appLlmConfig.model,
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
      setChatMessages(prev => [...prev, { role: 'assistant', content: `发送失败: ${e.message}` }])
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
                <Bot size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                AI 正在输入中...
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
  void renderChatTab

  // ── 第一级：任务列表主页 ─────────────────────────────────────
  if (activeTaskId === null) {
    const statusLabels: Record<string, string> = {
      idle: '待编排',
      running: '运行中',
      paused: '等待确认',
      success: '已成功',
      failed: '需处理'
    }
    const scheduleLabel = (task: typeof tasks[number]) => {
      if (!task.schedule || task.schedule.type === 'manual') return '手动执行'
      if (task.schedule.type === 'interval') return `每 ${task.schedule.intervalMinutes || 60} 分钟`
      return `每天 ${task.schedule.dailyTime || '09:00'}`
    }

    return (
      <div className="rpa-container">
        <div className="rpa-list-view">
          <div className="rpa-command-hero">
            <div className="rpa-hero-copy">
              <div className="rpa-kicker">Hybrid automation console</div>
              <h1>RPA 自动化任务清单</h1>
              <p>把浏览器 DOM、桌面坐标操作、视觉定位和凭据注入编排成可审计的桌面流程。</p>
            </div>

            <div className="rpa-hero-actions">
              <div className="rpa-hero-metric">
                <strong>{tasks.length}</strong>
                <span>工作流</span>
              </div>
              <button className="btn-primary rpa-create-primary" onClick={() => { setNewName(''); setNewDesc(''); setShowCreateModal(true) }}>
                <Plus size={17} strokeWidth={2} aria-hidden="true" />
                新建 RPA 任务
              </button>
            </div>
          </div>

          <div className="rpa-task-grid">
            {tasks.map(task => (
              <div key={task.id} className="glass-panel rpa-task-card" onClick={() => selectTask(task.id)}>
                <div className="rpa-card-rail" aria-hidden="true">
                  <span className="rpa-card-rail-node browser" />
                  <span className="rpa-card-rail-line" />
                  <span className="rpa-card-rail-node desktop" />
                </div>
                <div className="rpa-card-actions" onClick={e => e.stopPropagation()}>
                  <button className="btn-card-action danger" onClick={() => { if (confirm('确定删除该任务吗？')) deleteTask(task.id) }} title="删除任务">
                    <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
                <div className="rpa-card-topline">
                  <span className={`status-badge ${task.lastRunStatus || 'idle'}`}>{statusLabels[task.lastRunStatus || 'idle'] || task.lastRunStatus}</span>
                  <span className="rpa-card-date">{task.createdAt?.split(' ')[0] || '-'}</span>
                </div>
                <div className="rpa-card-name">{task.name}</div>
                <div className="rpa-card-desc">{task.description || '还没有说明。建议写清触发场景、输入来源和期望结果。'}</div>
                <div className="rpa-task-policy" onClick={event => event.stopPropagation()}>
                  <button
                    className={`rpa-task-state ${task.enabled === false ? 'off' : task.lastRunStatus === 'failed' ? 'error' : 'on'}`}
                    onClick={() => updateTask(task.id, { enabled: task.enabled === false })}
                    title="切换任务是否允许自动执行"
                  >
                    {task.enabled === false ? '关闭' : task.lastRunStatus === 'failed' ? '异常' : '允许'}
                  </button>
                  <span>{scheduleLabel(task)}</span>
                </div>
              </div>
            ))}

            {tasks.length === 0 && (
              <div className="rpa-empty-state">
                <div className="rpa-empty-orbit" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <h3>还没有自动化流程</h3>
                <p>可以先用一句话创建流程，再进入录制器补齐浏览器和桌面步骤。</p>
                <button className="btn-primary rpa-create-primary" onClick={() => { setNewName(''); setNewDesc(''); setShowCreateModal(true) }}>
                  创建第一个 RPA 任务
                </button>
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
                <button className="mcp-modal-close-btn" onClick={() => setShowCreateModal(false)} title="关闭"><X size={18} strokeWidth={2} aria-hidden="true" /></button>
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
            <ArrowLeft size={16} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
            返回列表
          </button>
          <div style={{ fontSize: '16px', fontWeight: 700 }}>
            {currentTask?.name}
          </div>
        </div>
        {currentTask && (
          <div className="rpa-schedule-editor">
            <button
              className={`rpa-task-state ${currentTask.enabled === false ? 'off' : currentTask.lastRunStatus === 'failed' ? 'error' : 'on'}`}
              onClick={() => updateTask(currentTask.id, { enabled: currentTask.enabled === false })}
            >
              {currentTask.enabled === false ? '关闭' : currentTask.lastRunStatus === 'failed' ? '异常' : '允许'}
            </button>
            <select
              className="rpa-schedule-select"
              value={currentTask.schedule?.type || 'manual'}
              onChange={event => updateTask(currentTask.id, {
                schedule: {
                  ...currentTask.schedule,
                  type: event.target.value as 'manual' | 'interval' | 'daily'
                }
              })}
            >
              <option value="manual">手动执行</option>
              <option value="interval">固定间隔</option>
              <option value="daily">每天定时</option>
            </select>
            {currentTask.schedule?.type === 'interval' && (
              <label className="rpa-schedule-value">
                每
                <input
                  type="number"
                  min={1}
                  value={currentTask.schedule.intervalMinutes || 60}
                  onChange={event => updateTask(currentTask.id, {
                    schedule: { ...currentTask.schedule!, intervalMinutes: Math.max(1, Number(event.target.value) || 1) }
                  })}
                />
                分钟
              </label>
            )}
            {currentTask.schedule?.type === 'daily' && (
              <input
                className="rpa-schedule-time"
                type="time"
                value={currentTask.schedule.dailyTime || '09:00'}
                onChange={event => updateTask(currentTask.id, {
                  schedule: { ...currentTask.schedule!, dailyTime: event.target.value }
                })}
              />
            )}
          </div>
        )}
      </div>

      <div className="rpa-detail-body">
        {/* 左侧 React Flow 编辑画布 */}
        <div className="rpa-canvas-container">
          {/* 普通用户主路径：录制 → 自动生成 → 运行 */}
          <div className="rpa-canvas-toolbar">
            <button className="rpa-toolbar-primary" onClick={handleRecordWorkflow} disabled={isChatSending}><span className="rpa-record-dot" />录制</button>
            {executionState === 'running' ? (
              <><button className="rpa-toolbar-action" onClick={pauseTask}><Pause size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />暂停</button><button className="rpa-toolbar-action danger" onClick={stopTask}><Square size={13} strokeWidth={2} fill="currentColor" className="ui-icon-leading" aria-hidden="true" />停止</button></>
            ) : executionState === 'paused' ? (
              <><button className="rpa-toolbar-action run" onClick={resumeTask} disabled={Boolean(manualConfirmData)}><Play size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />继续</button><button className="rpa-toolbar-action danger" onClick={stopTask}><Square size={13} strokeWidth={2} fill="currentColor" className="ui-icon-leading" aria-hidden="true" />停止</button></>
            ) : (
              <button className="rpa-toolbar-action run" onClick={runTask}><Play size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />运行</button>
            )}
            <button className={`rpa-toolbar-action ${showPanel && activeTab === 'credentials' ? 'active' : ''}`} onClick={() => { setActiveTab('credentials'); setShowPanel(true); setNodeCardPosition(null) }}><KeyRound size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />凭证</button>
            <button className={`rpa-toolbar-action ${showPanel && activeTab === 'logs' ? 'active' : ''}`} onClick={() => { setActiveTab('logs'); setShowPanel(true); setNodeCardPosition(null) }}><List size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />运行记录</button>
            <span className="rpa-toolbar-spacer" />
            <button className="rpa-toolbar-icon" onClick={handleUndo} disabled={history.length === 0} title="撤回"><Undo2 size={15} strokeWidth={2} aria-hidden="true" /></button>
            <button className={`rpa-toolbar-icon ${showMiniMap ? 'active' : ''}`} onClick={() => setShowMiniMap(prev => !prev)} title="缩略图"><MapIcon size={15} strokeWidth={2} aria-hidden="true" /></button>
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
            onNodeClick={(event, node) => {
              setSelectedNodeId(node.id)
              setNodeCardPosition({ x: Math.min(event.clientX + 28, window.innerWidth - 360), y: Math.max(92, Math.min(event.clientY - 36, window.innerHeight - 520)) })
              setShowPanel(false)
              setMenu(null)
            }}
            onPaneClick={() => {
              setSelectedNodeId(null)
              setNodeCardPosition(null)
              setMenu(null)
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
            fitViewOptions={{ padding: 0.28, maxZoom: 1 }}
            minZoom={0.35}
            maxZoom={1.6}
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
          {selectedNode && nodeCardPosition && (
            <div className="rpa-node-config-card" style={{ left: nodeCardPosition.x, top: nodeCardPosition.y }}>
              <div className="rpa-node-config-head">
                <div>
                  <small>节点配置</small>
                  <strong>{selectedNode.data?.label || selectedNode.type}</strong>
                </div>
                <button onClick={() => { setSelectedNodeId(null); setNodeCardPosition(null) }} title="关闭"><X size={15} strokeWidth={2} aria-hidden="true" /></button>
              </div>
              <div className="rpa-node-config-body">{renderAttrEditor()}</div>
            </div>
          )}
        </div>

        {/* 流程级面板：凭证与运行记录 */}
        {showPanel && (
          <div className="rpa-panel-container">
            <div className="rpa-panel-simple-head">
              <div><small>流程设置</small><strong>{activeTab === 'credentials' ? '凭证与节点绑定' : '运行记录'}</strong></div>
              <button onClick={() => setShowPanel(false)} title="关闭面板"><X size={16} strokeWidth={2} aria-hidden="true" /></button>
            </div>

            <div className="rpa-panel-content">
              {activeTab === 'credentials' && (
                <div className="rpa-credential-panel">
                  <p className="rpa-panel-hint">凭据属于整个流程；只有输入节点保存引用，真实值不会写入流程文件、日志或 AI 上下文。</p>
                  <div className="rpa-credential-bindings">
                    <strong>节点绑定</strong>
                    {nodes.filter(node => node.type === 'fill' || node.type === 'desktop_type').map(node => {
                      const value = String(node.data?.value || '')
                      const ref = value.startsWith('${secret.') ? value.slice(2, -1) : ''
                      const secret = secrets.find(item => item.ref === ref)
                      return <div key={node.id}><span>{node.data?.label || node.type}</span><code>{secret?.label || '未绑定'}</code></div>
                    })}
                    {nodes.every(node => node.type !== 'fill' && node.type !== 'desktop_type') && <div className="rpa-empty-compact">录制到账号或密码输入后，会在这里显示可绑定节点。</div>}
                  </div>
                  <div className="rpa-credential-list">
                    {secrets.map((secret) => (
                      <div className="rpa-credential-row" key={secret.ref}>
                        <div><strong>{secret.label}</strong><code>{secret.ref}</code></div>
                        <button className="rpa-secret-edit" onClick={() => { setEditingSecretRef(secret.ref); setEditingSecretValue('') }}>更新值</button>
                        {editingSecretRef === secret.ref && (
                          <div className="rpa-secret-update">
                            <input className="attr-input" type="password" value={editingSecretValue} onChange={event => setEditingSecretValue(event.target.value)} placeholder="输入新的敏感值" autoComplete="new-password" />
                            <button className="btn-primary" onClick={updateCredentialValue} disabled={!editingSecretValue}>保存</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {secrets.length === 0 && <div className="rpa-empty-compact">还没有凭据。创建后可在输入节点中绑定。</div>}
                  </div>
                  <div className="rpa-credential-create">
                    <div className="attr-group"><label className="attr-label">引用</label><input className="attr-input" value={newSecretRef} onChange={(e) => setNewSecretRef(e.target.value)} placeholder="secret.crm.password" /></div>
                    <div className="attr-group"><label className="attr-label">名称</label><input className="attr-input" value={newSecretLabel} onChange={(e) => setNewSecretLabel(e.target.value)} placeholder="CRM 密码" /></div>
                    <div className="attr-group"><label className="attr-label">真实值</label><input className="attr-input" type="password" value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} autoComplete="new-password" /></div>
                    <button className="btn-primary" onClick={createCredential} disabled={!activeTaskId || !newSecretValue || !newSecretRef.startsWith('secret.')}>保存并授权当前工作流</button>
                  </div>
                </div>
              )}

              {activeTab === 'logs' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  {/* 运行控制 */}
                  <div className="rpa-control-section">
                    {executionState === 'running' ? (
                      <><button className="btn-ctrl" onClick={pauseTask}><Pause size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />暂停流程</button><button className="btn-ctrl stop" onClick={stopTask}><Square size={13} strokeWidth={2} fill="currentColor" className="ui-icon-leading" aria-hidden="true" />停止运行</button></>
                    ) : executionState === 'paused' ? (
                      <><button className="btn-ctrl run" onClick={resumeTask} disabled={Boolean(manualConfirmData)}><Play size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />继续流程</button><button className="btn-ctrl stop" onClick={stopTask}><Square size={13} strokeWidth={2} fill="currentColor" className="ui-icon-leading" aria-hidden="true" />停止运行</button></>
                    ) : (
                      <button className="btn-ctrl run" onClick={runTask}>
                        <Play size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                        启动流程
                      </button>
                    )}
                    <button className="btn-back" style={{ flex: 'none', padding: '0 12px' }} onClick={store.clearLogs}>
                      <Eraser size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
                      清空
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
                      <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#b45309', marginBottom: '6px', display: 'flex', alignItems: 'center' }}><TriangleAlert size={15} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />等待人工确认 / 手动干预</div>
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
        <div className="rpa-recorder-backdrop">
          {pickerMode === 'record' ? (
            <section className="rpa-recorder-setup-card" role="dialog" aria-modal="true" aria-labelledby="rpa-recorder-title">
              <header className="rpa-recorder-setup-head">
                <div><span className="rpa-recorder-kicker">Record workflow</span><h3 id="rpa-recorder-title">从哪里开始？</h3></div>
                <button onClick={() => setShowPickerPrompt(false)} aria-label="关闭"><X size={16} strokeWidth={2} aria-hidden="true" /></button>
              </header>

              <div className="rpa-recorder-mode-tabs" aria-label="录制模式">
                <button className={recordingMode === 'browser' ? 'active' : ''} onClick={() => { setRecordingMode('browser'); setRecordingSetupError('') }}><strong>浏览器</strong><small>记录网页 DOM 操作</small></button>
                <button className={recordingMode === 'desktop' ? 'active' : ''} onClick={() => { setRecordingMode('desktop'); setRecordingSetupError(''); refreshDesktopWindows() }}><strong>电脑</strong><small>记录 Windows 应用操作</small></button>
              </div>

              {recordingMode === 'browser' && (
                <div className="rpa-recorder-section">
                  <label htmlFor="rpa-start-url">打开网址</label>
                  <input id="rpa-start-url" value={pickerUrl} onChange={event => { setPickerUrl(event.target.value); setRecordingSetupError('') }} placeholder="https://example.com" autoFocus />
                  <p>系统会打开独立浏览器，只记录其中的网页 DOM 操作。</p>
                </div>
              )}

              {recordingMode === 'desktop' && (
                <div className="rpa-recorder-section">
                  <div className="rpa-recorder-field-head"><label htmlFor="rpa-start-app">初始应用</label><button onClick={refreshDesktopWindows}>刷新</button></div>
                  <select id="rpa-start-app" value={selectedDesktopProcessId} onChange={event => setSelectedDesktopProcessId(event.target.value)} disabled={isLoadingDesktopWindows}>
                    <option value="">Windows 桌面（默认）</option>
                    {desktopWindows.map(item => <option key={`${item.processId}-${item.windowTitle}`} value={item.processId}>{item.windowTitle} · {item.processName}</option>)}
                  </select>
                  <p>{isLoadingDesktopWindows ? '正在读取任务栏应用…' : `已找到 ${desktopWindows.length} 个可用窗口；不选择时先回到桌面。`}</p>
                </div>
              )}

              {recordingSetupError && <div className="rpa-recorder-error">{recordingSetupError}</div>}
              <footer className="rpa-recorder-setup-footer">
                <span>开始后会显示全局悬浮控制卡</span>
                <div><button className="secondary" onClick={() => setShowPickerPrompt(false)}>取消</button><button className="primary" onClick={confirmPickElement}>开始录制</button></div>
              </footer>
            </section>
          ) : (
            <section className="rpa-picker-card">
              <h3>启动可视化元素拾取器</h3><p>输入测试网址后，在真实浏览器中选择目标元素。</p>
              <input value={pickerUrl} onChange={event => setPickerUrl(event.target.value)} />
              <footer><button onClick={() => setShowPickerPrompt(false)}>取消</button><button onClick={confirmPickElement}>启动浏览器拾取</button></footer>
            </section>
          )}
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
                setNodeCardPosition(null)
              }
              setMenu(null)
            }}
          >
            <Trash2 size={14} strokeWidth={2} className="ui-icon-leading" aria-hidden="true" />
            删除节点
          </button>
        </div>
      )}
    </div>
  )
}

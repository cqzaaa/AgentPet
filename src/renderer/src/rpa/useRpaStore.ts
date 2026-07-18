import { create } from 'zustand'

export interface RpaTask {
  id: string
  name: string
  description?: string
  enabled?: boolean
  schedule?: {
    type: 'manual' | 'interval' | 'daily'
    intervalMinutes?: number
    dailyTime?: string
  }
  lastScheduledRunAt?: string
  lastRunStatus?: 'idle' | 'running' | 'paused' | 'success' | 'failed'
  lastRunTime?: string
  createdAt?: string
}

export interface RpaLog {
  message: string
  level: 'info' | 'warn' | 'error'
  timestamp: string
}

interface RpaStore {
  tasks: RpaTask[]
  activeTaskId: string | null
  nodes: any[]
  edges: any[]
  executionState: 'idle' | 'running' | 'paused' | 'success' | 'failed'
  logs: RpaLog[]
  runContext: Record<string, any>
  currentNodeId: string | null
  manualConfirmData: { prompt: string; runContext: any; nodeId: string } | null
  
  // Actions
  fetchTasks: () => Promise<void>
  selectTask: (taskId: string | null) => Promise<void>
  createTask: (name: string, description?: string) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  updateTask: (taskId: string, updates: Partial<RpaTask>) => Promise<void>
  setNodes: (nodes: any[]) => void
  setEdges: (edges: any[]) => void
  onNodesChange: (changes: any) => void
  onEdgesChange: (changes: any) => void
  
  // Execution Control
  runTask: () => Promise<void>
  pauseTask: () => Promise<void>
  resumeTask: () => Promise<void>
  stopTask: () => Promise<void>
  respondManualConfirm: (updates?: Record<string, any>) => Promise<void>
  clearLogs: () => void
  appendLog: (level: 'info' | 'warn' | 'error', message: string) => void
  
  // Listeners Setup
  setupListeners: () => () => void
}

export const useRpaStore = create<RpaStore>((set, get) => {
  let logCleanup: (() => void) | null = null
  let statusCleanup: (() => void) | null = null
  let stepCleanup: (() => void) | null = null

  return {
    tasks: [],
    activeTaskId: null,
    nodes: [],
    edges: [],
    executionState: 'idle',
    logs: [],
    runContext: {},
    currentNodeId: null,
    manualConfirmData: null,

    fetchTasks: async () => {
      try {
        const manifest = await window.api.getRpaManifest()
        set({ tasks: manifest || [] })
      } catch (e) {
        console.error('获取 RPA 清单失败', e)
      }
    },

    selectTask: async (taskId) => {
      if (!taskId) {
        set({ activeTaskId: null, nodes: [], edges: [], executionState: 'idle', logs: [], runContext: {}, currentNodeId: null, manualConfirmData: null })
        return
      }
      
      try {
        // 读取具体的流程图 JSON
        const flowData = await window.api.getRpaTaskFlow(taskId)
        if (flowData) {
          set({
            activeTaskId: taskId,
            nodes: flowData.nodes || [],
            edges: flowData.edges || [],
            executionState: 'idle',
            logs: [],
            runContext: {},
            currentNodeId: null,
            manualConfirmData: null
          })
        } else {
          // 初始化默认流程
          const defaultNodes = [
            { id: 'start', type: 'start', position: { x: 250, y: 50 }, data: { label: '开始' } },
            { id: 'end', type: 'end', position: { x: 250, y: 400 }, data: { label: '结束' } }
          ]
          const defaultEdges: any[] = []
          set({
            activeTaskId: taskId,
            nodes: defaultNodes,
            edges: defaultEdges,
            executionState: 'idle',
            logs: [],
            runContext: {},
            currentNodeId: null,
            manualConfirmData: null
          })
          await window.api.saveRpaTaskFlow(taskId, { id: taskId, nodes: defaultNodes, edges: defaultEdges })
        }
      } catch (e) {
        console.error(`加载任务流程失败: ${taskId}`, e)
      }
    },

    createTask: async (name, description = '') => {
      const newId = `rpa_${Date.now()}`
      const newTask: RpaTask = {
        id: newId,
        name,
        description,
        enabled: true,
        schedule: { type: 'manual' },
        lastRunStatus: 'idle',
        lastRunTime: '-',
        createdAt: new Date().toLocaleString()
      }
      
      const currentTasks = get().tasks
      const updatedTasks = [newTask, ...currentTasks]
      
      // 保存至 manifest
      await window.api.saveRpaManifest(updatedTasks)
      
      // 初始化默认的流程图数据
      const defaultNodes = [
        { id: 'start', type: 'start', position: { x: 250, y: 50 }, data: { label: '开始' } },
        { id: 'end', type: 'end', position: { x: 250, y: 400 }, data: { label: '结束' } }
      ]
      await window.api.saveRpaTaskFlow(newId, { id: newId, nodes: defaultNodes, edges: [] })

      set({ tasks: updatedTasks })
      // 自动选中新任务
      await get().selectTask(newId)
    },

    deleteTask: async (taskId) => {
      try {
        // 主进程会自动删除 task_*.json 并在 manifest 移除
        await window.api.saveRpaManifest(get().tasks.filter(t => t.id !== taskId))
        // 主进程的 rpaStorage 包含单独的文件物理删除逻辑，但我们也可以通知主进程完全卸载
        // 为了安全，我们手动更新 manifest 即可，因为在 manifest.json 中移除了就意味着主页不显示它。
        // 当然，如果是彻底删除，通过 manifest 映射就足够了。
        set({ tasks: get().tasks.filter(t => t.id !== taskId) })
        if (get().activeTaskId === taskId) {
          get().selectTask(null)
        }
      } catch (e) {
        console.error('删除 RPA 任务失败', e)
      }
    },

    updateTask: async (taskId, updates) => {
      const updatedTasks = get().tasks.map(task => task.id === taskId ? { ...task, ...updates } : task)
      set({ tasks: updatedTasks })
      await window.api.saveRpaManifest(updatedTasks)
    },

    setNodes: (nodes) => set({ nodes }),
    setEdges: (edges) => set({ edges }),

    onNodesChange: (changes) => {
      // 简易节点移动更新
      const updatedNodes = get().nodes.map(n => {
        const match = changes.find(c => c.id === n.id)
        if (match && match.type === 'position' && match.position) {
          return { ...n, position: match.position }
        }
        return n
      })
      
      // 支持删除节点
      const idsToRemove = changes.filter(c => c.type === 'remove').map(c => c.id)
      const filteredNodes = updatedNodes.filter(n => !idsToRemove.includes(n.id))
      
      set({ nodes: filteredNodes })
      
      // 自动存盘流程图
      const taskId = get().activeTaskId
      if (taskId) {
        window.api.saveRpaTaskFlow(taskId, { id: taskId, nodes: filteredNodes, edges: get().edges })
      }
    },

    onEdgesChange: (changes) => {
      // 支持边变更
      const idsToRemove = changes.filter(c => c.type === 'remove').map(c => c.id)
      const filteredEdges = get().edges.filter(e => !idsToRemove.includes(e.id))
      
      set({ edges: filteredEdges })
      
      const taskId = get().activeTaskId
      if (taskId) {
        window.api.saveRpaTaskFlow(taskId, { id: taskId, nodes: get().nodes, edges: filteredEdges })
      }
    },

    runTask: async () => {
      const taskId = get().activeTaskId
      if (!taskId) return
      
      set({ executionState: 'running', logs: [], runContext: {}, currentNodeId: null, manualConfirmData: null })
      
      // 再次保存当前流程，确保数据最新
      const flowData = { id: taskId, nodes: get().nodes, edges: get().edges }
      await window.api.saveRpaTaskFlow(taskId, flowData)
      
      // 发送运行 IPC 消息
      await window.api.runRpaTask(taskId, flowData)
    },

    pauseTask: async () => {
      const taskId = get().activeTaskId
      if (!taskId || get().executionState !== 'running') return
      if (await window.api.pauseRpaTask(taskId)) set({ executionState: 'paused' })
    },

    resumeTask: async () => {
      const taskId = get().activeTaskId
      if (!taskId || get().executionState !== 'paused' || get().manualConfirmData) return
      if (await window.api.resumeRpaTask(taskId)) set({ executionState: 'running' })
    },

    stopTask: async () => {
      const taskId = get().activeTaskId
      if (!taskId) return
      await window.api.stopRpaTask(taskId)
      set({ executionState: 'idle', currentNodeId: null, manualConfirmData: null })
    },

    respondManualConfirm: async (updates) => {
      const taskId = get().activeTaskId
      if (!taskId) return
      
      // 通过 IPC 发送人工确认继续的消息，并可以向上下文更新变量
      await window.api.respondRpaManualConfirm(taskId, updates)
      set({ manualConfirmData: null, executionState: 'running' })
    },

    clearLogs: () => set({ logs: [] }),

    appendLog: (level, message) => {
      set(state => ({
        logs: [
          ...state.logs,
          {
            message,
            level,
            timestamp: new Date().toLocaleTimeString()
          }
        ]
      }))
    },

    setupListeners: () => {
      // 1. 运行日志监听
      logCleanup = window.api.onRpaLog((data) => {
        if (data.taskId !== get().activeTaskId) return
        set(state => ({
          logs: [...state.logs, {
            message: data.message,
            level: data.level,
            timestamp: new Date().toLocaleTimeString()
          }]
        }))
      })

      // 2. 状态监听
      statusCleanup = window.api.onRpaStatusEvent(async (data) => {
        if (data.taskId === get().activeTaskId) set({ executionState: data.status })
        const timestamp = new Date().toLocaleString()
        const updatedTasks = get().tasks.map(task => task.id === data.taskId ? {
          ...task,
          lastRunStatus: data.status,
          ...(data.status === 'running' ? {} : { lastRunTime: timestamp })
        } : task)
        set({ tasks: updatedTasks })
      })

      // 3. 节点步骤执行监听
      stepCleanup = window.api.onRpaStepEvent((data) => {
        if (data.taskId !== get().activeTaskId) return
        
        set({ 
          currentNodeId: data.nodeId, 
          runContext: data.context || get().runContext 
        })
        if (data.state === 'paused') set({ executionState: 'paused' })
        else if (data.state === 'running' && !get().manualConfirmData) set({ executionState: 'running' })
        
        // 专门处理人工干预挂起事件
        if (data.state === 'paused' && data.data?.prompt) {
          set({
            executionState: 'paused',
            manualConfirmData: {
              prompt: data.data.prompt,
              runContext: data.data.runContext || {},
              nodeId: data.nodeId
            }
          })
        }
      })

      // 返回清理监听器的闭包
      return () => {
        if (logCleanup) logCleanup()
        if (statusCleanup) statusCleanup()
        if (stepCleanup) stepCleanup()
      }
    }
  }
})

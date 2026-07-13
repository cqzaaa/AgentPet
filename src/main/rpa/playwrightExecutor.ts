import { chromium, Browser, BrowserContext, Page } from 'playwright-core'
import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { ModelRuntimeFactory } from '../model-runtime'

export interface RpaNode {
  id: string
  type: string
  data: Record<string, any>
}

export interface RpaEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export class PlaywrightRpaExecutor {
  private static activeExecutors = new Map<string, PlaywrightRpaExecutor>()

  private taskId: string
  private nodes: RpaNode[]
  private edges: RpaEdge[]
  private webContents: Electron.WebContents
  
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  
  private runContext: Record<string, any> = {}
  private isPaused: boolean = false
  private isStopped: boolean = false
  private resolvePause: (() => void) | null = null
  
  private currentNodeId: string = ''

  constructor(taskId: string, nodes: RpaNode[], edges: RpaEdge[], webContents: Electron.WebContents) {
    this.taskId = taskId
    this.nodes = nodes
    this.edges = edges
    this.webContents = webContents
  }

  public static async run(taskId: string, nodes: RpaNode[], edges: RpaEdge[], webContents: Electron.WebContents): Promise<void> {
    // 如果已经有正在运行的相同任务，先停止它
    const existing = this.activeExecutors.get(taskId)
    if (existing) {
      await existing.stop()
      this.activeExecutors.delete(taskId)
    }

    const executor = new PlaywrightRpaExecutor(taskId, nodes, edges, webContents)
    this.activeExecutors.set(taskId, executor)
    
    // 异步启动，不阻塞 IPC
    executor.execute().finally(() => {
      if (executor.isBrowserCleaned()) {
        this.activeExecutors.delete(taskId)
      }
    })
  }

  public static getActive(taskId: string): PlaywrightRpaExecutor | undefined {
    return this.activeExecutors.get(taskId)
  }

  public static async cleanAll(): Promise<void> {
    for (const executor of this.activeExecutors.values()) {
      try {
        await executor.stop()
      } catch (_) {}
    }
    this.activeExecutors.clear()
  }

  /**
   * 外部触发恢复执行
   */
  public resume(contextUpdates?: Record<string, any>): void {
    if (contextUpdates) {
      this.runContext = { ...this.runContext, ...contextUpdates }
    }
    this.isPaused = false
    this.log(`用户手动恢复了流程`)
    if (this.resolvePause) {
      this.resolvePause()
      this.resolvePause = null
    }
  }

  /**
   * 外部触发暂停流程
   */
  public pause(): void {
    this.isPaused = true
    this.log(`正在请求暂停流程...`)
    this.notifyStep(this.currentNodeId, 'paused')
  }

  /**
   * 外部终止流程
   */
  public async stop(): Promise<void> {
    this.isStopped = true
    this.log(`正在中止 RPA 流程...`)
    if (this.resolvePause) {
      this.resolvePause()
      this.resolvePause = null
    }
    await this.cleanup()
    PlaywrightRpaExecutor.activeExecutors.delete(this.taskId)
  }

  public isBrowserCleaned(): boolean {
    return this.browser === null
  }

  /**
   * 核心执行流程
   */
  private async execute(): Promise<void> {
    this.log(`🚀 开始执行 RPA 流程，任务 ID: ${this.taskId}`)
    this.notifyStatus('running')

    let hasError = false
    try {
      // 2. 找到 Start 节点
      const startNode = this.nodes.find(n => n.type === 'start')
      if (!startNode) {
        throw new Error('未找到开始节点 (Start Node)')
      }

      this.runContext = {}
      let currentNode: RpaNode | null = startNode

      // 3. 循环解释执行节点
      while (currentNode && !this.isStopped) {
        this.currentNodeId = currentNode.id
        
        // 检查暂停
        await this.checkPause()
        if (this.isStopped) break

        this.log(`👉 执行节点 [${currentNode.data?.label || currentNode.type}] (${currentNode.id})`)
        this.notifyStep(currentNode.id, 'running')
        
        // 执行当前节点
        let output: any = null
        try {
          output = await this.executeNode(currentNode)
          this.notifyStep(currentNode.id, 'success', output)
        } catch (nodeError: any) {
          this.log(`❌ 节点 [${currentNode.data?.label || currentNode.type}] 执行失败: ${nodeError.message}`, 'error')
          this.notifyStep(currentNode.id, 'failed', nodeError.message)
          throw nodeError
        }

        // 寻找下一个节点
        currentNode = this.findNextNode(currentNode, output)
      }

      if (!this.isStopped) {
        this.log(`🎉 RPA 流程执行成功结束！`)
        this.notifyStatus('success')
      }
    } catch (err: any) {
      hasError = true
      this.log(`🚨 流程运行中断: ${err.message}`, 'error')
      this.notifyStatus('failed', err.message)
    } finally {
      // 只有用户手动点击了“停止运行”(this.isStopped)，才主动在执行结束时自动关闭浏览器
      // 如果流程是自己正常跑完(success)或者由于报错中断(failed)，均保留浏览器窗口，以便用户查看和操作
      if (this.isStopped) {
        await this.cleanup()
      } else if (this.browser) {
        if (hasError) {
          this.log(`💡 流程执行失败，为便于排查，浏览器窗口已保留不自动关闭。你可以点击“停止运行”来手动关闭浏览器。`, 'warn')
        } else {
          this.log(`💡 流程执行完毕，浏览器窗口已保留以便您查看最终状态。你可以点击“停止运行”来手动关闭浏览器。`, 'info')
        }
      }
    }
  }

  /**
   * 初始化有头浏览器
   */
  private async initBrowser(): Promise<void> {
    this.log(`正在拉起浏览器页面（有头模式）...`)
    
    let launchOptions = {
      headless: false,
      channel: 'chrome',
      viewport: null, // 允许最大化
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'] // 避开一些反爬虫检测
    }

    try {
      this.browser = await chromium.launch(launchOptions)
    } catch (chromeErr) {
      this.log(`未找到 Chrome，正在尝试拉起 Edge 浏览器...`, 'warn')
      try {
        launchOptions.channel = 'msedge'
        this.browser = await chromium.launch(launchOptions)
      } catch (edgeErr) {
        throw new Error('未能在系统上定位到已安装的 Google Chrome 或 Microsoft Edge，请确保已安装其中之一。')
      }
    }

    this.context = await this.browser.newContext({
      viewport: null // 随窗口缩放
    })

    this.page = await this.context.newPage()
    
    // 监听新创建的页面（多页支持）
    this.context.on('page', async (newPage) => {
      this.page = newPage
      await this.setupInjectedControl(newPage)
    })

    // 暴露回调函数给网页内的悬浮按钮
    await this.page.exposeFunction('rpaControlCallback', async (action: string) => {
      this.log(`收到网页悬浮条指令: ${action}`)
      if (action === 'pause') {
        this.pause()
      } else if (action === 'resume') {
        this.resume()
      } else if (action === 'stop') {
        await this.stop()
      }
    })

    await this.setupInjectedControl(this.page)
    this.log(`浏览器启动完成，防自动化检测已注入。`)
  }

  /**
   * 注入网页的 RPA 悬浮控制条
   */
  private async setupInjectedControl(targetPage: Page): Promise<void> {
    // 每次页面加载完毕后重新注入
    targetPage.on('load', async () => {
      try {
        await this.injectHtmlControl(targetPage)
        // 更新悬浮控制条上的当前状态
        await this.updateWebControlText(targetPage)
      } catch (e) {
        // 忽略注入失败（例如页面突然关闭）
      }
    })
  }

  private async injectHtmlControl(targetPage: Page): Promise<void> {
    const script = `
      (function() {
        if (document.getElementById('rpa-overlay-panel')) return;

        const container = document.createElement('div');
        container.id = 'rpa-overlay-panel';
        container.style.cssText = 'position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 280px; background: rgba(255, 255, 255, 0.82); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1px solid rgba(255, 255, 255, 0.45); box-shadow: 0 8px 30px rgba(0,0,0,0.18); border-radius: 12px; font-family: system-ui, -apple-system, sans-serif; color: #1e293b; padding: 12px; user-select: none; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);';
        
        container.innerHTML = \`
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span id="rpa-indicator" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #10b981; animation: rpaPulse 1.5s infinite;"></span>
              <strong style="font-size: 13px; font-weight: 600;">RPA 流程控制条</strong>
            </div>
            <span id="rpa-toggle-btn" style="cursor: pointer; font-size: 11px; color: #64748b; padding: 2px 4px;">收起</span>
          </div>
          <div id="rpa-body" style="transition: all 0.3s ease;">
            <div id="rpa-status-text" style="font-size: 12px; color: #475569; margin-bottom: 10px; line-height: 1.5; font-weight: 500;">
              准备就绪...
            </div>
            <div style="display: flex; gap: 6px; justify-content: flex-end;">
              <button id="rpa-btn-pause" style="padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1); background: #f8fafc; color: #334155; cursor: pointer;">暂停</button>
              <button id="rpa-btn-resume" style="padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 6px; border: none; background: #3b82f6; color: white; cursor: pointer; display: none;">继续</button>
              <button id="rpa-btn-stop" style="padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 6px; border: none; background: #ef4444; color: white; cursor: pointer;">终止</button>
            </div>
          </div>
          <style>
            @keyframes rpaPulse {
              0% { transform: scale(0.9); opacity: 0.6; }
              50% { transform: scale(1.15); opacity: 1; }
              100% { transform: scale(0.9); opacity: 0.6; }
            }
          </style>
        \`;

        document.body.appendChild(container);

        // 绑定动作
        const btnPause = container.querySelector('#rpa-btn-pause');
        const btnResume = container.querySelector('#rpa-btn-resume');
        const btnStop = container.querySelector('#rpa-btn-stop');
        const toggleBtn = container.querySelector('#rpa-toggle-btn');
        const body = container.querySelector('#rpa-body');

        btnPause.addEventListener('click', () => {
          window.rpaControlCallback('pause');
        });
        btnResume.addEventListener('click', () => {
          window.rpaControlCallback('resume');
        });
        btnStop.addEventListener('click', () => {
          window.rpaControlCallback('stop');
        });

        let collapsed = false;
        toggleBtn.addEventListener('click', () => {
          collapsed = !collapsed;
          if (collapsed) {
            body.style.display = 'none';
            toggleBtn.textContent = '展开';
            container.style.width = '160px';
          } else {
            body.style.display = 'block';
            toggleBtn.textContent = '收起';
            container.style.width = '280px';
          }
        });

        // 全局更新接口
        window.updateRpaStatus = (statusStr, statusType) => {
          const statusText = document.getElementById('rpa-status-text');
          const indicator = document.getElementById('rpa-indicator');
          const resumeBtn = document.getElementById('rpa-btn-resume');
          const pauseBtn = document.getElementById('rpa-btn-pause');

          if (statusText) statusText.textContent = statusStr;
          
          if (indicator) {
            if (statusType === 'paused') {
              indicator.style.background = '#eab308'; // 黄色
              if (resumeBtn) resumeBtn.style.display = 'inline-block';
              if (pauseBtn) pauseBtn.style.display = 'none';
            } else if (statusType === 'failed') {
              indicator.style.background = '#ef4444'; // 红色
            } else {
              indicator.style.background = '#10b981'; // 绿色
              if (resumeBtn) resumeBtn.style.display = 'none';
              if (pauseBtn) pauseBtn.style.display = 'inline-block';
            }
          }
        };
      })();
    `
    await targetPage.evaluate(script)
  }

  private async updateWebControlText(targetPage: Page): Promise<void> {
    if (!targetPage) return
    const statusType = this.isPaused ? 'paused' : (this.isStopped ? 'failed' : 'running')
    let nodeLabel = '正在执行流程...'
    if (this.currentNodeId) {
      const node = this.nodes.find(n => n.id === this.currentNodeId)
      if (node) {
        nodeLabel = node.data?.label || node.type
      }
    }
    const statusStr = this.isPaused 
      ? `⏸️ 已暂停在步骤: ${nodeLabel}`
      : `▶️ 正在运行: ${nodeLabel}`
      
    try {
      await targetPage.evaluate(({ text, type }) => {
        if (typeof (window as any).updateRpaStatus === 'function') {
          (window as any).updateRpaStatus(text, type)
        }
      }, { text: statusStr, type: statusType })
    } catch (e) {
      // 忽略调用失败
    }
  }

  /**
   * 检查暂停挂起
   */
  private async checkPause(): Promise<void> {
    if (this.page) {
      await this.updateWebControlText(this.page)
    }
    if (this.isPaused) {
      await new Promise<void>((resolve) => {
        this.resolvePause = resolve
      })
    }
    if (this.page) {
      await this.updateWebControlText(this.page)
    }
  }

  /**
   * 执行单个节点逻辑
   */
  private async executeNode(node: RpaNode): Promise<any> {
    const webNodeTypes = ['open_url', 'click', 'fill', 'extract', 'wait']
    if (webNodeTypes.includes(node.type)) {
      if (!this.page) {
        await this.initBrowser()
      }
      if (!this.page) {
        throw new Error('网页操作节点执行失败：浏览器未初始化')
      }
      // 每次执行前更新网页悬浮框
      await this.updateWebControlText(this.page)
    }

    const page = this.page!

    switch (node.type) {
      case 'start':
        return null

      case 'end':
        return null



      case 'open_url': {
        const url = this.resolveExpression(node.data?.url || '')
        if (!url) throw new Error('打开网页节点未配置 URL')
        this.log(`正在打开网页: ${url}`)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        return null
      }

      case 'click': {
        const selector = this.resolveExpression(node.data?.selector || '')
        if (!selector) throw new Error('点击节点未配置选择器 (Selector)')
        this.log(`正在点击元素: ${selector}`)
        await page.waitForSelector(selector, { timeout: 10000 })
        await page.click(selector)
        return null
      }

      case 'fill': {
        const selector = this.resolveExpression(node.data?.selector || '')
        const value = this.resolveExpression(node.data?.value || '')
        if (!selector) throw new Error('输入节点未配置选择器 (Selector)')
        this.log(`正在输入文本到 ${selector}: "${value}"`)
        await page.waitForSelector(selector, { timeout: 10000 })
        await page.fill(selector, value)
        return null
      }

      case 'extract': {
        const selector = this.resolveExpression(node.data?.selector || '')
        const extractType = node.data?.extractType || 'text'
        const varName = node.data?.varName
        if (!selector) throw new Error('内容提取节点未配置选择器 (Selector)')
        if (!varName) throw new Error('内容提取节点未配置目标变量名 (Variable Name)')

        this.log(`正在提取元素 ${selector} 的内容 [类型: ${extractType}]...`)
        await page.waitForSelector(selector, { timeout: 10000 })

        let result: string = ''
        if (extractType === 'text') {
          result = (await page.textContent(selector)) || ''
        } else if (extractType === 'html') {
          result = (await page.innerHTML(selector)) || ''
        } else if (extractType === 'value') {
          result = await page.inputValue(selector)
        }

        result = result.trim()
        this.runContext[varName] = result
        this.log(`提取结果已保存至变量 [${varName}]: "${result.substring(0, 100)}${result.length > 100 ? '...' : ''}"`)
        return result
      }

      case 'wait': {
        const ms = parseInt(node.data?.ms || '1000', 10)
        this.log(`延时等待: ${ms} 毫秒`)
        await page.waitForTimeout(ms)
        return null
      }

      case 'manual_confirm': {
        const prompt = this.resolveExpression(node.data?.prompt || '请进行人工审核')
        this.log(`⚠️ 人工干预节点触发: ${prompt}`)
        
        // 强制进入暂停状态并发出暂停 IPC，带上当前的运行上下文
        this.isPaused = true
        this.notifyStep(node.id, 'paused', { prompt, runContext: this.runContext })
        
        // 更新网页上的操作条
        if (this.page) {
          await this.updateWebControlText(this.page)
          try {
            await this.page.evaluate((p) => {
              const el = document.getElementById('rpa-status-text');
              if (el) el.innerHTML = `⚠️ <b>人工确认等待中</b>: <br/>${p}`;
            }, prompt)
          } catch (_) {}
        }

        // 等待 resolve
        await new Promise<void>((resolve) => {
          this.resolvePause = resolve
        })

        this.isPaused = false
        this.log(`人工确认完毕，流程恢复执行`)
        return null
      }

      case 'ai_node': {
        const promptTemplate = node.data?.prompt || ''
        const varName = node.data?.varName
        if (!promptTemplate) throw new Error('AI 节点未配置 Prompt 模板')
        if (!varName) throw new Error('AI 节点未配置目标变量名 (Variable Name)')

        const resolvedPrompt = this.resolveExpression(promptTemplate)
        this.log(`🤖 正在调用大模型 AI 节点，Prompt: "${resolvedPrompt.substring(0, 100)}..."`)

        const aiResult = await this.callLLMForRpa(resolvedPrompt)
        this.runContext[varName] = aiResult
        this.log(`AI 节点响应结果已保存至变量 [${varName}]: "${aiResult.substring(0, 150)}..."`)
        return aiResult
      }

      default:
        throw new Error(`未知的节点类型: ${node.type}`)
    }
  }

  /**
   * 使用系统已配好的 LLM 进行推理
   */
  private async callLLMForRpa(prompt: string): Promise<string> {
    try {
      const configPath = join(app.getPath('userData'), 'system_llm_config.json')
      if (!fs.existsSync(configPath)) {
        throw new Error('未检测到大模型 API 密钥配置，请先在设置中完成配置。')
      }
      
      const configRaw = await fs.promises.readFile(configPath, 'utf-8')
      const llmConfig = JSON.parse(configRaw)
      
      const provider = ModelRuntimeFactory.getProvider(
        llmConfig.provider,
        llmConfig.apiKey,
        llmConfig.baseUrl
      )

      const result = await provider.chat(
        [{ role: 'user', content: prompt }],
        { model: llmConfig.model, temperature: llmConfig.temperature }
      )
      
      return typeof result.content === 'string' ? result.content : ''
    } catch (e: any) {
      throw new Error(`AI 调用失败: ${e.message}`)
    }
  }

  /**
   * 拓扑解析表达式模板，如 `请帮我总结: {{extracted_html}}`
   */
  private resolveExpression(template: string): string {
    if (typeof template !== 'string') return template
    return template.replace(/\{\{([^}]+)\}\}/g, (_, varName) => {
      const key = varName.trim()
      return this.runContext[key] !== undefined ? String(this.runContext[key]) : `{{${key}}}`
    })
  }

  /**
   * 查找当前节点的后续流转节点 (支持分支与连线过滤)
   */
  private findNextNode(currentNode: RpaNode, lastOutput: any): RpaNode | null {
    const outgoingEdges = this.edges.filter(e => e.source === currentNode.id)
    if (outgoingEdges.length === 0) return null

    // 1. 如果是条件判断节点
    if (currentNode.type === 'condition') {
      const expression = currentNode.data?.expression || ''
      this.log(`评估条件表达式: "${expression}"`)
      let conditionResult = false
      try {
        // 安全沙盒评估 JS 表达式（注入当前上下文）
        const evalFunc = new Function('context', 'output', `
          with(context) {
            try { return !!(${expression}); } catch(e) { return false; }
          }
        `)
        conditionResult = evalFunc(this.runContext, lastOutput)
      } catch (e: any) {
        this.log(`条件表达式评估出错: ${e.message}，默认走 [false] 分支`, 'warn')
      }
      
      this.log(`评估结果为: ${conditionResult}`)
      
      // 寻找对应的 edge (React Flow 区分 sourceHandle === 'true' / 'false')
      const targetHandle = conditionResult ? 'true' : 'false'
      const matchEdge = outgoingEdges.find(e => e.sourceHandle === targetHandle)
      if (matchEdge) {
        const next = this.nodes.find(n => n.id === matchEdge.target)
        return next || null
      }
      return null
    }

    // 2. 普通节点，取第一个连接的 target 节点
    const firstEdge = outgoingEdges[0]
    const next = this.nodes.find(n => n.id === firstEdge.target)
    return next || null
  }

  /**
   * 垃圾回收与清理
   */
  private async cleanup(): Promise<void> {
    this.log(`正在释放浏览器资源...`)
    
    if (this.page) {
      try { await this.page.close() } catch (_) {}
      this.page = null
    }
    if (this.context) {
      try { await this.context.close() } catch (_) {}
      this.context = null
    }
    if (this.browser) {
      try { await this.browser.close() } catch (_) {}
      this.browser = null
    }
  }

  /**
   * 辅助日志打印并发送至前端渲染
   */
  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    console.log(`[RPA Executor] [${level.toUpperCase()}] ${message}`)
    try {
      this.webContents.send('api:rpa-log', {
        taskId: this.taskId,
        message: `[${new Date().toLocaleTimeString()}] ${message}`,
        level
      })
    } catch (_) {}
  }

  private notifyStatus(status: 'running' | 'success' | 'failed', errorMsg?: string): void {
    try {
      this.webContents.send('api:rpa-status-event', {
        taskId: this.taskId,
        status,
        errorMsg
      })
    } catch (_) {}
  }

  private notifyStep(nodeId: string, state: 'idle' | 'running' | 'paused' | 'success' | 'failed', data?: any): void {
    try {
      this.webContents.send('api:rpa-step-event', {
        taskId: this.taskId,
        nodeId,
        state,
        data,
        context: this.runContext
      })
    } catch (_) {}
  }
}

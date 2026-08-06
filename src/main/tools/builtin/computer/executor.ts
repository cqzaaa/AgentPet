import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { clipboard } from 'electron'
import { promisify } from 'util'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { getActiveStorageDir } from '../../utils/paths'
import {
  clickDesktopPointNative,
  findDesktopElements,
  focusDesktopElement,
  inspectDesktopPoint,
  invokeDesktopElement,
  listDesktopWindows,
  resolveDesktopDisplayPoint,
  resolveDesktopRelativePoint,
  scrollDesktopPointNative
} from '../../../rpa/rpaDesktopPicker'
import { DesktopActionGuard, desktopClickFingerprint } from './action-guard'

const execFileAsync = promisify(execFile)

function cleanWindowText(value: unknown): string {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return text || '(无标题)'
}

function hasEncodingDamage(value: string): boolean {
  return value.includes('\uFFFD') || /�{2,}/.test(value)
}

// nut-js 按键名称映射表
const KEY_MAP: Record<string, string> = {
  ctrl: 'LeftControl',
  control: 'LeftControl',
  shift: 'LeftShift',
  alt: 'LeftAlt',
  win: 'LeftSuper',
  meta: 'LeftSuper',
  enter: 'Return',
  return: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4',
  f5: 'F5', f6: 'F6', f7: 'F7', f8: 'F8',
  f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12'
}

export class ComputerExecutor implements IToolExecutor {
  private readonly actionGuard = new DesktopActionGuard()
  private readonly windowDiagnosticCache = new Map<string, { diagnostic: any; expiresAt: number }>()
  private focusedWindow: { processId?: number; processName?: string; title?: string; expiresAt: number } | undefined

  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      switch (api) {
        case 'screenshot':
          return await this.screenshot(args, context)
        case 'mouse_move':
          return await this.mouseMove(args)
        case 'mouse_click':
          return await this.mouseClick(args, context)
        case 'mouse_click_relative':
          return await this.mouseClickRelative(args, context)
        case 'mouse_scroll':
          return await this.mouseScroll(args)
        case 'type_text':
          return await this.typeText(args)
        case 'key_press':
          return await this.keyPress(args)
        case 'find_ui_elements':
          return await this.findUiElements(args)
        case 'click_ui_element':
          return await this.clickUiElement(args, context)
        case 'focus_ui_element':
          return await this.focusUiElement(args)
        case 'perform_computer_actions':
          return await this.performComputerActions(args, context)
        case 'get_windows':
          return await this.getWindows()
        case 'focus_window':
          return await this.focusWindow(args)
        default:
          return { content: `未知操作: ${api}`, success: false }
      }
    } catch (err: any) {
      return {
        content: `[电脑操控] 执行失败: ${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    }
  }

  public getApiNames(): string[] {
    return [
      'screenshot',
      'mouse_move',
      'mouse_click',
      'mouse_click_relative',
      'mouse_scroll',
      'type_text',
      'key_press',
      'get_windows',
      'focus_window',
      'find_ui_elements',
      'click_ui_element',
      'focus_ui_element',
      'perform_computer_actions'
    ]
  }

  // ─── 截图 ────────────────────────────────────────────────────────────────────

  private async screenshot(
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    // 截图前等待（用于 focus_window 后给窗口动画留时间）
    const delayMs = typeof args.delay_ms === 'number' ? Math.min(args.delay_ms, 5000) : 0
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    const { desktopCapturer, screen } = await import('electron')
    const rememberedWindow = !args.mode && !args.pid && !args.title && !args.process_name && this.focusedWindow && this.focusedWindow.expiresAt > Date.now()
      ? this.focusedWindow
      : undefined
    const mode = args.mode === 'window' || args.pid || args.title || args.process_name || rememberedWindow ? 'window' : 'screen'
    const maxWidth = Math.min(3840, Math.max(640, Math.round(Number(args.max_width) || 1920)))
    const maxHeight = Math.min(2160, Math.max(360, Math.round(Number(args.max_height) || 1080)))
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const requestedDisplayId = Number.isFinite(args.display_id) ? Number(args.display_id) : undefined
    const display = requestedDisplayId === undefined
      ? primaryDisplay
      : displays.find(item => Number(item.id) === requestedDisplayId) || displays[Math.max(0, Math.min(displays.length - 1, Math.trunc(requestedDisplayId)))] || primaryDisplay

    let targetWindow: { processId?: number; processName?: string; title?: string } = {
      processId: Number.isFinite(args.pid) ? Math.trunc(Number(args.pid)) : undefined,
      processName: args.process_name ? String(args.process_name) : undefined,
      title: args.title ? String(args.title) : undefined
    }
    if (rememberedWindow) targetWindow = { ...rememberedWindow }
    if (mode === 'window' && !targetWindow.title && (targetWindow.processId || targetWindow.processName)) {
      const windows = await listDesktopWindows()
      const matched = windows.find(item =>
        (targetWindow.processId && item.processId === targetWindow.processId) ||
        (!targetWindow.processId && targetWindow.title && item.windowTitle.toLowerCase().includes(targetWindow.title.toLowerCase())) ||
        (!targetWindow.processId && !targetWindow.title && targetWindow.processName && item.processName.toLowerCase() === targetWindow.processName.toLowerCase())
      )
      if (matched) {
        targetWindow = { processId: matched.processId, processName: matched.processName, title: matched.windowTitle }
      }
    }

    const thumbnailSize = mode === 'window'
      ? { width: maxWidth, height: maxHeight }
      : {
          width: Math.min(maxWidth, Math.max(640, Math.round(display.size.width * display.scaleFactor))),
          height: Math.min(maxHeight, Math.max(360, Math.round(display.size.height * display.scaleFactor)))
        }
    const sources = await desktopCapturer.getSources({
      types: [mode === 'window' ? 'window' : 'screen'],
      thumbnailSize,
      fetchWindowIcons: false
    })

    if (sources.length === 0) {
      return { content: '截图失败：未找到可用的屏幕源', success: false }
    }

    const source = mode === 'window'
      ? sources.find(item => targetWindow.title && item.name === targetWindow.title) ||
        sources.find(item => targetWindow.title && item.name.toLowerCase().includes(targetWindow.title.toLowerCase())) ||
        sources[0]
      : sources.find(item => String(item.display_id) === String(display.id)) || sources[0]
    if (mode === 'window' && targetWindow.title && source.name.toLowerCase() !== targetWindow.title.toLowerCase() && !source.name.toLowerCase().includes(targetWindow.title.toLowerCase())) {
      return {
        content: `[截图失败] 未找到目标窗口：${targetWindow.title}`,
        success: false
      }
    }
    const thumbnail = source.thumbnail

    // 保存到 session 目录
    const screenshotDir = this.resolveScreenshotDir(context.sessionId)
    fs.mkdirSync(screenshotDir, { recursive: true })

    const timestamp = Date.now()
    const fileName = `screenshot_${timestamp}.png`
    const filePath = path.join(screenshotDir, fileName)

    const pngBuffer = thumbnail.toPNG()
    fs.writeFileSync(filePath, pngBuffer)

    const { width, height } = thumbnail.getSize()
    const stateHash = this.visualStateHash(thumbnail)
    const changedSincePrevious = this.actionGuard.updateVisualState(this.guardKey(context), stateHash)
    const windowBounds = mode === 'window'
      ? await this.resolveWindowBounds(targetWindow)
      : undefined
    let pointDiagnostic: any
    if (mode === 'window' && windowBounds) {
      const diagnosticKey = `${targetWindow.processId || 0}:${targetWindow.title || targetWindow.processName || ''}`
      const cachedDiagnostic = this.windowDiagnosticCache.get(diagnosticKey)
      if (cachedDiagnostic && cachedDiagnostic.expiresAt > Date.now()) {
        pointDiagnostic = cachedDiagnostic.diagnostic
      } else {
        pointDiagnostic = await inspectDesktopPoint({ x: windowBounds.x + Math.round(windowBounds.width / 2), y: windowBounds.y + Math.round(windowBounds.height / 2) })
        if (pointDiagnostic) this.windowDiagnosticCache.set(diagnosticKey, { diagnostic: pointDiagnostic, expiresAt: Date.now() + 30_000 })
      }
    }
    const displayBounds = mode === 'screen'
      ? {
          left: display.bounds.x,
          top: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
          primary: display.id === primaryDisplay.id
        }
      : pointDiagnostic?.displayBounds

    return {
      content: `[截图完成]\n范围: ${mode === 'window' ? '窗口' : '显示器'}\n文件路径: ${filePath}\n分辨率: ${width}x${height}\n名称: ${source.name}\n视觉状态哈希: ${stateHash}\n状态较上一张截图${changedSincePrevious ? '已变化' : '未变化'}\n${delayMs > 0 ? `等待了 ${delayMs}ms 后截图\n` : ''}\n截图已自动传入视觉上下文；优先使用返回的窗口/显示器相对坐标或 UI Automation 元素。`,
      state: {
        filePath,
        width,
        height,
        displayName: source.name,
        mode,
        stateHash,
        changedSincePrevious,
        coordinateSpace: mode === 'window' ? 'window-relative-or-global-physical' : 'display-image-or-global',
        displayId: display.id,
        displayBounds,
        scaleFactor: mode === 'screen' ? display.scaleFactor : pointDiagnostic?.scaleFactor,
        dpi: pointDiagnostic?.dpi,
        windowBounds,
        window: targetWindow
      },
      success: true
    }
  }

  // ─── 鼠标移动 ─────────────────────────────────────────────────────────────────

  private async mouseMove(args: Record<string, any>): Promise<ToolResult> {
    const { x, y } = args
    const { mouse, Point } = await import('@nut-tree/nut-js')
    await mouse.setPosition(new Point(x, y))
    return { content: `[鼠标已移动] 位置: (${x}, ${y})`, success: true }
  }

  // ─── 鼠标点击 ─────────────────────────────────────────────────────────────────

  private async mouseClick(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { x, y, button = 'left', double = false } = args
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { content: '鼠标点击失败：x/y 必须是有限数字', success: false }
    }
    const fingerprint = desktopClickFingerprint({ scope: 'screen', x, y, button, double })
    const guardDecision = this.actionGuard.shouldBlockClick(this.guardKey(context), fingerprint, Boolean(args.allow_repeat))
    if (guardDecision.blocked) {
      return { content: `[重复点击已拦截] ${guardDecision.reason}`, success: false, state: { duplicateBlocked: true } }
    }
    let dispatched = false
    if (process.platform === 'win32' && button !== 'middle') {
      dispatched = await clickDesktopPointNative({
        x: Math.round(Number(x)),
        y: Math.round(Number(y)),
        button: button === 'right' ? 'right' : 'left',
        double: Boolean(double)
      })
    }
    if (!dispatched) {
      const { mouse, Button, Point } = await import('@nut-tree/nut-js')
      await mouse.setPosition(new Point(x, y))
      const btn = button === 'right' ? Button.RIGHT : button === 'middle' ? Button.MIDDLE : Button.LEFT
      if (double) await mouse.doubleClick(btn)
      else await mouse.click(btn)
      dispatched = true
    }
    this.actionGuard.recordClick(this.guardKey(context), fingerprint)

    const action = double ? '双击' : '单击'
    const btnName = button === 'right' ? '右键' : button === 'middle' ? '中键' : '左键'
    return {
      content: `[鼠标${action}] ${btnName} 位置: (${x}, ${y})\n系统已派发点击事件；这不代表应用业务状态已改变，请按需用一次截图验证。`,
      state: { dispatched: true, x, y, coordinateSpace: 'global-physical' },
      success: true
    }
  }

  private async mouseClickRelative(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const scope = args.scope === 'display' ? 'display' : 'window'
    const relativeX = Number(args.relative_x)
    const relativeY = Number(args.relative_y)
    if (!Number.isFinite(relativeX) || !Number.isFinite(relativeY)) {
      return { content: '相对点击失败：relative_x/relative_y 必须是数字', success: false }
    }
    const target = scope === 'window'
      ? await this.resolveWindowTarget(args)
      : await this.resolveDisplayTarget(args)
    if (!target) return { content: '相对点击失败：无法解析目标窗口或显示器边界', success: false }
    const point = target.scope === 'window'
      ? await resolveDesktopRelativePoint({
          windowTitle: target.title,
          processName: target.processName,
          relativeX,
          relativeY
        })
      : await resolveDesktopDisplayPoint({
          displayRelativeX: relativeX,
          displayRelativeY: relativeY,
          displayLeft: target.left,
          displayTop: target.top,
          displayWidth: target.width,
          displayHeight: target.height,
          displayPrimary: target.primary
        })
    if (!point) return { content: '相对点击失败：Windows 未返回可用物理坐标', success: false }
    const fingerprint = desktopClickFingerprint({
      scope: scope === 'window' ? 'window' : 'screen',
      x: relativeX,
      y: relativeY,
      windowTitle: target.scope === 'window' ? target.title : undefined,
      processId: target.scope === 'window' ? target.processId : undefined,
      displayId: target.scope === 'display' ? Number(args.display_id) || 0 : undefined,
      button: args.button,
      double: args.double
    })
    const guardDecision = this.actionGuard.shouldBlockClick(this.guardKey(context), fingerprint, Boolean(args.allow_repeat))
    if (guardDecision.blocked) {
      return { content: `[重复点击已拦截] ${guardDecision.reason}`, success: false, state: { duplicateBlocked: true } }
    }
    const ok = await clickDesktopPointNative({
      x: point.x,
      y: point.y,
      button: args.button === 'right' ? 'right' : 'left',
      double: Boolean(args.double)
    })
    if (!ok) return { content: '相对点击失败：Windows 未接受输入事件', success: false }
    this.actionGuard.recordClick(this.guardKey(context), fingerprint)
    return {
      content: `[相对点击] ${scope === 'window' ? '窗口' : '显示器'}相对坐标 (${relativeX.toFixed(3)}, ${relativeY.toFixed(3)}) → 全局物理坐标 (${point.x}, ${point.y})\n系统已派发点击事件；请按需用一次截图验证。`,
      state: { dispatched: true, x: point.x, y: point.y, relativeX, relativeY, scope, coordinateSpace: 'global-physical' },
      success: true
    }
  }

  // ─── 鼠标滚轮 ─────────────────────────────────────────────────────────────────

  private async mouseScroll(args: Record<string, any>): Promise<ToolResult> {
    const { x, y, direction, amount = 3 } = args
    let dispatched = false
    if (process.platform === 'win32') {
      dispatched = await scrollDesktopPointNative({
        x: Math.round(Number(x)),
        y: Math.round(Number(y)),
        direction: direction === 'up' ? 'up' : 'down',
        amount
      })
    }
    if (!dispatched) {
      const { mouse, Point } = await import('@nut-tree/nut-js')
      await mouse.setPosition(new Point(x, y))
      if (direction === 'up') await mouse.scrollUp(amount)
      else await mouse.scrollDown(amount)
    }

    return {
      content: `[滚轮滚动] 方向: ${direction === 'up' ? '向上' : '向下'} 格数: ${amount} 位置: (${x}, ${y})`,
      success: true
    }
  }

  // ─── 键盘输入文字 ──────────────────────────────────────────────────────────────

  private async typeText(args: Record<string, any>): Promise<ToolResult> {
    const { text, method = 'clipboard_paste' } = args
    if (!text) return { content: '缺少参数 text', success: false }

    const { keyboard, Key } = await import('@nut-tree/nut-js')
    if (method === 'keyboard') {
      await keyboard.type(text)
    } else {
      const previousText = clipboard.readText()
      clipboard.writeText(String(text))
      await new Promise((resolve) => setTimeout(resolve, 80))
      await keyboard.pressKey(Key.LeftControl, Key.V)
      await keyboard.releaseKey(Key.V, Key.LeftControl)
      await new Promise((resolve) => setTimeout(resolve, 120))
      try {
        clipboard.writeText(previousText)
      } catch {
        // Restoring clipboard is best-effort; input correctness is more important.
      }
    }

    return {
      content: `[文字输入] 已通过 ${method === 'keyboard' ? '键盘逐字输入' : '剪贴板粘贴'} 输入 ${String(text).length} 个字符: "${String(text).length > 50 ? String(text).slice(0, 50) + '...' : String(text)}"`,
      success: true
    }
  }

  // ─── 按键组合 ─────────────────────────────────────────────────────────────────

  private async keyPress(args: Record<string, any>): Promise<ToolResult> {
    const { keys } = args
    if (!Array.isArray(keys) || keys.length === 0) {
      return { content: '缺少参数 keys（数组）', success: false }
    }

    const { keyboard, Key } = await import('@nut-tree/nut-js')

    const nutKeys = keys.map((k: string) => {
      const normalized = k.toLowerCase()
      const mapped = KEY_MAP[normalized]
      if (mapped) {
        return (Key as any)[mapped]
      }
      // 单字符直接查找
      const upper = k.toUpperCase()
      return (Key as any)[upper] ?? (Key as any)[k]
    })

    const validKeys = nutKeys.filter((k) => k !== undefined)
    if (validKeys.length === 0) {
      return { content: `无效的按键名称: ${keys.join(', ')}`, success: false }
    }

    await keyboard.pressKey(...validKeys)
    await keyboard.releaseKey(...validKeys)

    return {
      content: `[按键操作] 已按下: ${keys.join(' + ')}`,
      success: true
    }
  }

  private async findUiElements(args: Record<string, any>): Promise<ToolResult> {
    let processId = Number.isFinite(args.pid) ? Math.trunc(Number(args.pid)) : undefined
    let processName = args.process_name ? String(args.process_name) : undefined
    if (!processId && processName) {
      const windows = await listDesktopWindows()
      const matched = windows.find(item => item.processName.toLowerCase() === processName!.toLowerCase())
      if (matched) processId = matched.processId
    }
    const elements = await findDesktopElements({
      processId,
      processName,
      nameContains: args.name_contains,
      controlType: args.control_type,
      limit: args.limit
    })
    return {
      content: elements.length > 0
        ? `[UIA 元素] 找到 ${elements.length} 个\n${elements.map((element, index) => `${index + 1}. name="${element.name}" automationId="${element.automationId}" controlType=${element.controlType} pid=${element.processId} bounds=(${element.x},${element.y},${element.width},${element.height}) enabled=${element.isEnabled}`).join('\n')}`
        : '[UIA 元素] 未找到匹配元素。请补充 PID、name_contains 或 control_type，或回退到窗口相对坐标。',
      state: { elements },
      success: true
    }
  }

  private async clickUiElement(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const name = args.name ? String(args.name) : ''
    const automationId = args.automation_id ? String(args.automation_id) : ''
    if (!name && !automationId) return { content: 'UIA 点击失败：需要 name 或 automation_id', success: false }
    let processId = Number.isFinite(args.pid) ? Math.trunc(Number(args.pid)) : 0
    let processName = args.process_name ? String(args.process_name) : ''
    if (!processId && !processName) {
      return { content: 'UIA 点击失败：为了避免命中错误窗口，必须提供 pid 或 process_name', success: false }
    }
    if (!processId && processName) {
      const windows = await listDesktopWindows()
      const matched = windows.find(item => item.processName.toLowerCase() === processName.toLowerCase())
      if (matched) {
        processId = matched.processId
        processName = matched.processName
      }
    }
    const fingerprint = desktopClickFingerprint({
      scope: 'element',
      processId,
      name,
      automationId,
      button: args.button,
      double: args.double
    })
    const guardDecision = this.actionGuard.shouldBlockClick(this.guardKey(context), fingerprint, Boolean(args.allow_repeat))
    if (guardDecision.blocked) {
      return { content: `[重复点击已拦截] ${guardDecision.reason}`, success: false, state: { duplicateBlocked: true } }
    }
    const ok = await invokeDesktopElement({
      automationId: automationId || undefined,
      name: name || undefined,
      processId,
      processName: processName || undefined,
      controlType: args.control_type || undefined,
      button: args.button === 'right' ? 'right' : 'left',
      double: Boolean(args.double)
    })
    if (!ok) return { content: 'UIA 点击失败：未找到元素或元素不支持点击', success: false }
    this.actionGuard.recordClick(this.guardKey(context), fingerprint)
    return {
      content: `[UIA 点击] 已调用元素 ${automationId ? `automationId="${automationId}"` : `name="${name}"`}，系统已派发点击事件。`,
      state: { dispatched: true, automationId, name, processId },
      success: true
    }
  }

  private async focusUiElement(args: Record<string, any>): Promise<ToolResult> {
    const name = args.name ? String(args.name) : ''
    const automationId = args.automation_id ? String(args.automation_id) : ''
    if (!name && !automationId) return { content: 'UIA 聚焦失败：需要 name 或 automation_id', success: false }
    const ok = await focusDesktopElement({
      automationId: automationId || undefined,
      name: name || undefined,
      processId: Number.isFinite(args.pid) ? Math.trunc(Number(args.pid)) : undefined,
      processName: args.process_name ? String(args.process_name) : undefined
    })
    return ok
      ? { content: `[UIA 聚焦] 已聚焦 ${automationId ? `automationId="${automationId}"` : `name="${name}"`}`, success: true }
      : { content: 'UIA 聚焦失败：未找到元素或元素不可聚焦', success: false }
  }

  private async performComputerActions(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (!Array.isArray(args.actions) || args.actions.length === 0) {
      return { content: '复合电脑动作失败：actions 不能为空', success: false }
    }
    const defaults = {
      pid: Number.isFinite(args.pid) ? Math.trunc(Number(args.pid)) : undefined,
      title: args.title ? String(args.title) : undefined,
      process_name: args.process_name ? String(args.process_name) : undefined
    }
    const results: string[] = []
    for (const rawAction of args.actions.slice(0, 20)) {
      const action = { ...defaults, ...(rawAction || {}) }
      let result: ToolResult
      switch (action.type) {
        case 'focus_window':
          result = await this.focusWindow(action)
          break
        case 'click':
          result = await this.mouseClick(action, context)
          break
        case 'click_relative':
          result = await this.mouseClickRelative(action, context)
          break
        case 'click_ui':
          result = await this.clickUiElement(action, context)
          break
        case 'focus_ui':
          result = await this.focusUiElement(action)
          break
        case 'type':
          result = await this.typeText({ text: action.text, method: action.method })
          break
        case 'key':
          result = await this.keyPress({ keys: action.keys })
          break
        case 'wait': {
          const milliseconds = Math.min(5000, Math.max(0, Math.round(Number(action.milliseconds) || 0)))
          if (milliseconds > 0) await new Promise(resolve => setTimeout(resolve, milliseconds))
          result = { content: `[等待] ${milliseconds}ms`, success: true }
          break
        }
        default:
          result = { content: `未知复合动作类型: ${String(action.type || '')}`, success: false }
      }
      results.push(result.content)
      if (!result.success) {
        return {
          content: `[复合电脑动作] 在第 ${results.length} 步停止\n${results.join('\n')}`,
          state: { actionResults: results, failedAt: results.length },
          success: false
        }
      }
    }
    let verification: ToolResult | undefined
    if (args.verify_after) {
      verification = await this.screenshot({
        mode: defaults.pid || defaults.title || defaults.process_name ? 'window' : 'screen',
        pid: defaults.pid,
        title: defaults.title,
        process_name: defaults.process_name
      }, context)
      results.push(verification.content)
    }
    return {
      content: `[复合电脑动作] 已顺序完成 ${args.actions.length} 步${args.verify_after ? '，并完成一次验证截图' : ''}\n${results.join('\n')}`,
      state: {
        actionResults: results,
        ...(verification?.state || {})
      },
      success: true
    }
  }

  // ─── 获取窗口列表 ──────────────────────────────────────────────────────────────

  private async getWindows(): Promise<ToolResult> {
    const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WindowInfo {
    public string Title;
    public int ProcessId;
    public string ProcessName;
}
public class WinAPI {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    public static List<WindowInfo> GetWindows() {
        var list = new List<WindowInfo>();
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                int len = GetWindowTextLength(hWnd);
                if (len > 0) {
                    var sb = new StringBuilder(len + 1);
                    GetWindowText(hWnd, sb, sb.Capacity);
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    string pName = "";
                    try { pName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
                    list.Add(new WindowInfo { Title = sb.ToString(), ProcessId = (int)pid, ProcessName = pName });
                }
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@ -ErrorAction SilentlyContinue

[WinAPI]::GetWindows() | Select-Object ProcessId, ProcessName, Title | ConvertTo-Json -Compress
`
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], {
      timeout: 10000
    })

    let windows: any[] = []
    try {
      const parsed = JSON.parse(stdout.trim())
      windows = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return { content: `无法解析窗口列表:\n${stdout}`, success: false }
    }

    const list = windows
      .map((w) => {
        const title = cleanWindowText(w.Title)
        const processName = cleanWindowText(w.ProcessName)
        const warning = hasEncodingDamage(title) ? '  [标题可能编码异常，建议截图确认]' : ''
        return `PID=${w.ProcessId}  进程=${processName}  标题="${title}"${warning}`
      })
      .join('\n')

    return {
      content: `[当前窗口列表] 共 ${windows.length} 个\n\n${list}`,
      state: { windows },
      success: true
    }
  }

  // ─── 切换窗口焦点 ──────────────────────────────────────────────────────────────

  private async focusWindow(args: Record<string, any>): Promise<ToolResult> {
    const { title, pid, process_name, show_desktop } = args

    // 确定性显示桌面；避免 ToggleDesktop 在已经位于桌面时反向恢复窗口。
    if (show_desktop) {
      const ps = `
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Write-Output "OK:Desktop"
`
      await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 5000 })
      // 等待桌面动画完成
      await new Promise((resolve) => setTimeout(resolve, 300))
      this.focusedWindow = undefined
      return { content: '[显示桌面] 已切换到桌面，可以截图查看桌面图标', success: true }
    }

    if (!pid && !title && !process_name) {
      return { content: '缺少参数：请提供 title、pid、process_name 或 show_desktop=true', success: false }
    }

    const safeTitle = title ? title.replace(/["'\`\\]/g, '') : ''
    const safeProcessName = process_name ? String(process_name).replace(/["'\`\\]/g, '') : ''
    const targetPid = pid ? pid : 0

    const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class WinAPI {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    // Captions often contain an em dash or NBSP that a model cannot reproduce.
    static string NormalizeCaption(string value) {
        if (String.IsNullOrEmpty(value)) return "";
        var builder = new StringBuilder();
        foreach (char c in value.ToLowerInvariant()) {
            if (Char.IsLetterOrDigit(c)) builder.Append(c);
        }
        return builder.ToString();
    }
    
    public static string FocusWindow(string targetTitle, int targetPid, string targetProcessName) {
        IntPtr targetHWnd = IntPtr.Zero;
        IntPtr processFallbackHWnd = IntPtr.Zero;
        string foundTitle = "";
        string processFallbackTitle = "";
        
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                int len = GetWindowTextLength(hWnd);
                if (len > 0) {
                    var sb = new StringBuilder(len + 1);
                    GetWindowText(hWnd, sb, sb.Capacity);
                    string wTitle = sb.ToString();
                    uint wPid;
                    GetWindowThreadProcessId(hWnd, out wPid);
                    
                    bool titleMatch = !string.IsNullOrEmpty(targetTitle) && (
                        wTitle.IndexOf(targetTitle, StringComparison.OrdinalIgnoreCase) >= 0 ||
                        NormalizeCaption(wTitle).IndexOf(NormalizeCaption(targetTitle), StringComparison.OrdinalIgnoreCase) >= 0
                    );
                    bool pidMatch = targetPid > 0 && wPid == targetPid;
                    bool processMatch = false;
                    if (!string.IsNullOrEmpty(targetProcessName)) {
                        try {
                            string processName = Process.GetProcessById((int)wPid).ProcessName;
                            processMatch = processName.Equals(targetProcessName, StringComparison.OrdinalIgnoreCase);
                        } catch { }
                    }

                    if (pidMatch || titleMatch) {
                        targetHWnd = hWnd;
                        foundTitle = wTitle;
                        return false;
                    }
                    if (processFallbackHWnd == IntPtr.Zero && processMatch) {
                        processFallbackHWnd = hWnd;
                        processFallbackTitle = wTitle;
                    }
                }
            }
            return true;
        }, IntPtr.Zero);

        if (targetHWnd == IntPtr.Zero && processFallbackHWnd != IntPtr.Zero) {
            targetHWnd = processFallbackHWnd;
            foundTitle = processFallbackTitle;
        }
        
        if (targetHWnd != IntPtr.Zero) {
            ShowWindow(targetHWnd, 9);
            bool activated = SetForegroundWindow(targetHWnd);
            if (!activated || GetForegroundWindow() != targetHWnd) {
                keybd_event(0x12, 0, 0, UIntPtr.Zero);
                SetForegroundWindow(targetHWnd);
                keybd_event(0x12, 0, 2, UIntPtr.Zero);
            }
            Thread.Sleep(180);
            return GetForegroundWindow() == targetHWnd ? "OK:" + foundTitle : "FOCUS_FAILED:" + foundTitle;
        }
        return "NOT_FOUND";
    }
}
"@ -ErrorAction SilentlyContinue

[WinAPI]::FocusWindow("${safeTitle}", ${targetPid}, "${safeProcessName}")
`

    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], {
      timeout: 10000
    })

    const result = stdout.trim()
    if (result.startsWith('OK:')) {
      const windowTitle = result.slice(3)
      // 内置等待：给窗口动画和渲染留出时间，之后调用 screenshot 就能截到正确画面
      await new Promise((resolve) => setTimeout(resolve, 250))
      this.focusedWindow = {
        processId: targetPid || undefined,
        processName: safeProcessName || undefined,
        title: windowTitle,
        expiresAt: Date.now() + 30_000
      }
      return {
        content: `[窗口切换成功] 已聚焦: "${windowTitle}"\n提示：窗口已置顶，现在可以直接调用 screenshot 截图（无需再传 delay_ms）。`,
        success: true
      }
    } else {
      return {
        content: `[窗口切换失败] 未找到匹配的窗口（title="${title ?? ''}" process="${process_name ?? ''}" pid=${pid ?? ''}）\n建议先调用 get_windows 查看当前窗口列表。`,
        success: false
      }
    }
  }

  // ─── 工具函数 ─────────────────────────────────────────────────────────────────

  private guardKey(context: ToolContext): string {
    return `${context.sessionId || 'default'}:${context.messageId || 'turn'}`
  }

  private visualStateHash(image: any): string {
    try {
      const tiny = image.resize({ width: 16, height: 16, quality: 'good' })
      const bitmap = tiny.toBitmap()
      const luminances: number[] = []
      for (let index = 0; index < bitmap.length; index += 4) {
        const luminance = Math.round(bitmap[index] * 0.21 + bitmap[index + 1] * 0.72 + bitmap[index + 2] * 0.07)
        luminances.push(luminance)
      }
      const average = luminances.reduce((sum, value) => sum + value, 0) / Math.max(1, luminances.length)
      let hash = ''
      for (let index = 0; index < luminances.length; index++) {
        hash += luminances[index] >= average ? '1' : '0'
      }
      return hash
    } catch {
      return `unknown-${Date.now()}`
    }
  }

  private async resolveWindowTarget(args: Record<string, any>): Promise<{ scope: 'window'; processId?: number; processName?: string; title?: string } | null> {
    const requestedPid = Number.isFinite(args.pid) ? Math.trunc(Number(args.pid)) : undefined
    const requestedTitle = args.title ? String(args.title) : undefined
    const requestedProcessName = args.process_name ? String(args.process_name) : undefined
    if (!requestedPid && !requestedTitle && !requestedProcessName) return null
    if (this.focusedWindow && this.focusedWindow.expiresAt > Date.now()) {
      const matchesRemembered =
        (requestedPid && this.focusedWindow.processId === requestedPid) ||
        (!requestedPid && requestedTitle && this.focusedWindow.title?.toLowerCase().includes(requestedTitle.toLowerCase())) ||
        (!requestedPid && !requestedTitle && requestedProcessName && this.focusedWindow.processName?.toLowerCase() === requestedProcessName.toLowerCase())
      if (matchesRemembered) return { scope: 'window', ...this.focusedWindow }
    }
    const windows = await listDesktopWindows()
    const matched = windows.find(item =>
      (requestedPid && item.processId === requestedPid) ||
      (!requestedPid && requestedTitle && item.windowTitle.toLowerCase().includes(requestedTitle.toLowerCase())) ||
      (!requestedPid && !requestedTitle && requestedProcessName && item.processName.toLowerCase() === requestedProcessName.toLowerCase())
    )
    if (!matched) return null
    return { scope: 'window', processId: matched.processId, processName: matched.processName, title: matched.windowTitle }
  }

  private async resolveDisplayTarget(args: Record<string, any>): Promise<{ scope: 'display'; left: number; top: number; width: number; height: number; primary: boolean } | null> {
    const { screen } = await import('electron')
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    const requestedId = Number.isFinite(args.display_id) ? Number(args.display_id) : undefined
    const display = requestedId === undefined
      ? primary
      : displays.find(item => Number(item.id) === requestedId) || displays[Math.max(0, Math.min(displays.length - 1, Math.trunc(requestedId)))]
    if (!display) return null
    return {
      scope: 'display',
      left: display.bounds.x,
      top: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      primary: display.id === primary.id
    }
  }

  private async resolveWindowBounds(target: { processId?: number; processName?: string; title?: string }): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    if (!target.title && !target.processName) return undefined
    const topLeft = await resolveDesktopRelativePoint({
      windowTitle: target.title,
      processName: target.processName,
      relativeX: 0,
      relativeY: 0
    })
    const bottomRight = await resolveDesktopRelativePoint({
      windowTitle: target.title,
      processName: target.processName,
      relativeX: 1,
      relativeY: 1
    })
    if (!topLeft || !bottomRight || bottomRight.x <= topLeft.x || bottomRight.y <= topLeft.y) return undefined
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y
    }
  }

  private resolveScreenshotDir(sessionId?: string): string {
    const base = getActiveStorageDir()
    if (sessionId) {
      const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      return path.join(base, 'chat', safeId, 'screenshots')
    }
    return path.join(base, 'screenshots')
  }
}

export const computerExecutor = new ComputerExecutor()

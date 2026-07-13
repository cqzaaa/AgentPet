import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { getActiveStorageDir } from '../../utils/paths'

const execFileAsync = promisify(execFile)

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
          return await this.mouseClick(args)
        case 'mouse_scroll':
          return await this.mouseScroll(args)
        case 'type_text':
          return await this.typeText(args)
        case 'key_press':
          return await this.keyPress(args)
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
      'mouse_scroll',
      'type_text',
      'key_press',
      'get_windows',
      'focus_window'
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

    const { desktopCapturer } = await import('electron')
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })

    if (sources.length === 0) {
      return { content: '截图失败：未找到可用的屏幕源', success: false }
    }

    const displayId = typeof args.display_id === 'number' ? args.display_id : 0
    const source = sources[Math.min(displayId, sources.length - 1)]
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

    return {
      content: `[截图完成]\n文件路径: ${filePath}\n分辨率: ${width}x${height}\n显示器: ${source.name}\n${delayMs > 0 ? `等待了 ${delayMs}ms 后截图\n` : ''}\n请使用文件工具读取此图片以分析屏幕内容。`,
      state: { filePath, width, height, displayName: source.name },
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

  private async mouseClick(args: Record<string, any>): Promise<ToolResult> {
    const { x, y, button = 'left', double = false } = args
    const { mouse, Button, Point } = await import('@nut-tree/nut-js')

    await mouse.setPosition(new Point(x, y))

    const btn =
      button === 'right' ? Button.RIGHT : button === 'middle' ? Button.MIDDLE : Button.LEFT

    if (double) {
      await mouse.doubleClick(btn)
    } else {
      await mouse.click(btn)
    }

    const action = double ? '双击' : '单击'
    const btnName = button === 'right' ? '右键' : button === 'middle' ? '中键' : '左键'
    return { content: `[鼠标${action}] ${btnName} 位置: (${x}, ${y})`, success: true }
  }

  // ─── 鼠标滚轮 ─────────────────────────────────────────────────────────────────

  private async mouseScroll(args: Record<string, any>): Promise<ToolResult> {
    const { x, y, direction, amount = 3 } = args
    const { mouse, Point } = await import('@nut-tree/nut-js')

    await mouse.setPosition(new Point(x, y))

    if (direction === 'up') {
      await mouse.scrollUp(amount)
    } else {
      await mouse.scrollDown(amount)
    }

    return {
      content: `[滚轮滚动] 方向: ${direction === 'up' ? '向上' : '向下'} 格数: ${amount} 位置: (${x}, ${y})`,
      success: true
    }
  }

  // ─── 键盘输入文字 ──────────────────────────────────────────────────────────────

  private async typeText(args: Record<string, any>): Promise<ToolResult> {
    const { text } = args
    if (!text) return { content: '缺少参数 text', success: false }

    const { keyboard } = await import('@nut-tree/nut-js')
    await keyboard.type(text)

    return {
      content: `[文字输入] 已输入 ${text.length} 个字符: "${text.length > 50 ? text.slice(0, 50) + '...' : text}"`,
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

  // ─── 获取窗口列表 ──────────────────────────────────────────────────────────────

  private async getWindows(): Promise<ToolResult> {
    const ps = `
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
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
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
      .map((w) => `PID=${w.ProcessId}  进程=${w.ProcessName}  标题="${w.Title}"`)
      .join('\n')

    return {
      content: `[当前窗口列表] 共 ${windows.length} 个\n\n${list}`,
      state: { windows },
      success: true
    }
  }

  // ─── 切换窗口焦点 ──────────────────────────────────────────────────────────────

  private async focusWindow(args: Record<string, any>): Promise<ToolResult> {
    const { title, pid, show_desktop } = args

    // 显示桌面（Win+D）
    if (show_desktop) {
      const ps = `
$shell = New-Object -ComObject Shell.Application
$shell.ToggleDesktop()
Write-Output "OK:Desktop"
`
      await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 5000 })
      // 等待桌面动画完成
      await new Promise((resolve) => setTimeout(resolve, 600))
      return { content: '[显示桌面] 已切换到桌面，可以截图查看桌面图标', success: true }
    }

    if (!pid && !title) {
      return { content: '缺少参数：请提供 title、pid 或 show_desktop=true', success: false }
    }

    const safeTitle = title ? title.replace(/["'\`\\]/g, '') : ''
    const targetPid = pid ? pid : 0

    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    
    public static string FocusWindow(string targetTitle, int targetPid) {
        IntPtr targetHWnd = IntPtr.Zero;
        string foundTitle = "";
        
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                int len = GetWindowTextLength(hWnd);
                if (len > 0) {
                    var sb = new StringBuilder(len + 1);
                    GetWindowText(hWnd, sb, sb.Capacity);
                    string wTitle = sb.ToString();
                    uint wPid;
                    GetWindowThreadProcessId(hWnd, out wPid);
                    
                    bool match = false;
                    if (targetPid > 0 && wPid == targetPid) match = true;
                    else if (!string.IsNullOrEmpty(targetTitle) && wTitle.IndexOf(targetTitle, StringComparison.OrdinalIgnoreCase) >= 0) match = true;
                    
                    if (match) {
                        targetHWnd = hWnd;
                        foundTitle = wTitle;
                        return false; 
                    }
                }
            }
            return true;
        }, IntPtr.Zero);
        
        if (targetHWnd != IntPtr.Zero) {
            ShowWindow(targetHWnd, 9);
            SetForegroundWindow(targetHWnd);
            return "OK:" + foundTitle;
        }
        return "NOT_FOUND";
    }
}
"@ -ErrorAction SilentlyContinue

[WinAPI]::FocusWindow("${safeTitle}", ${targetPid})
`

    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], {
      timeout: 10000
    })

    const result = stdout.trim()
    if (result.startsWith('OK:')) {
      const windowTitle = result.slice(3)
      // 内置等待：给窗口动画和渲染留出时间，之后调用 screenshot 就能截到正确画面
      await new Promise((resolve) => setTimeout(resolve, 800))
      return {
        content: `[窗口切换成功] 已聚焦: "${windowTitle}"\n提示：窗口已置顶，现在可以直接调用 screenshot 截图（无需再传 delay_ms）。`,
        success: true
      }
    } else {
      return {
        content: `[窗口切换失败] 未找到匹配的窗口（title="${title ?? ''}" pid=${pid ?? ''}）\n建议先调用 get_windows 查看当前窗口列表。`,
        success: false
      }
    }
  }

  // ─── 工具函数 ─────────────────────────────────────────────────────────────────

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

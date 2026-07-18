import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'
import type { DesktopRecordedAction } from './domain/types'

type RawDesktopEvent = {
  event: 'focus' | 'click' | 'key' | 'scroll' | 'text'
  recordedAt?: number
  x?: number
  y?: number
  button?: 'left' | 'right'
  key?: string
  character?: string
  value?: string
  previousValue?: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  win?: boolean
  name?: string
  automationId?: string
  controlType?: string
  processId?: number
  processName?: string
  windowTitle?: string
  isPassword?: boolean
  inputLanguage?: number
  delta?: number
  windowLeft?: number
  windowTop?: number
  windowWidth?: number
  windowHeight?: number
  displayLeft?: number
  displayTop?: number
  displayWidth?: number
  displayHeight?: number
  displayPrimary?: boolean
}

export type DesktopRecordingOptions = {
  excludeProcessNames?: string[]
  excludeProcessIds?: number[]
}

const WINDOWS_RECORDER_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class RpaNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT point; public uint mouseData; public uint flags; public uint time; public IntPtr extraInfo; }
  public struct ClickEvent { public int X; public int Y; public int Button; }
  public struct WheelEvent { public int X; public int Y; public int Delta; }
  private delegate IntPtr MouseHookProc(int code, IntPtr message, IntPtr data);
  private static readonly ConcurrentQueue<ClickEvent> ClickEvents = new ConcurrentQueue<ClickEvent>();
  private static readonly ConcurrentQueue<WheelEvent> WheelEvents = new ConcurrentQueue<WheelEvent>();
  private static readonly MouseHookProc MouseProc = MouseHookCallback;
  private static IntPtr mouseHook = IntPtr.Zero;
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void EnablePerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte[] state);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern int ToUnicode(uint virtualKey, uint scanCode, byte[] state, StringBuilder text, int count, uint flags);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int hook, MouseHookProc callback, IntPtr module, uint threadId);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string moduleName);
  public static void StartMouseHook() { if (mouseHook == IntPtr.Zero) mouseHook = SetWindowsHookEx(14, MouseProc, GetModuleHandle(null), 0); }
  public static bool TryDequeueClick(out ClickEvent click) { return ClickEvents.TryDequeue(out click); }
  public static bool TryDequeueWheel(out WheelEvent wheel) { return WheelEvents.TryDequeue(out wheel); }
  private static IntPtr MouseHookCallback(int code, IntPtr message, IntPtr data) {
    if (code >= 0 && (message.ToInt32() == 0x0201 || message.ToInt32() == 0x0204)) {
      var info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(data);
      ClickEvents.Enqueue(new ClickEvent { X = info.point.X, Y = info.point.Y, Button = message.ToInt32() == 0x0204 ? 2 : 1 });
    } else if (code >= 0 && message.ToInt32() == 0x020A) {
      var info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(data);
      WheelEvents.Enqueue(new WheelEvent { X = info.point.X, Y = info.point.Y, Delta = (short)((info.mouseData >> 16) & 0xffff) });
    }
    return CallNextHookEx(mouseHook, code, message, data);
  }
}
'@
[RpaNativeInput]::EnablePerMonitorDpi()

function Get-WindowContext {
  $hwnd = [RpaNativeInput]::GetForegroundWindow()
  $builder = New-Object System.Text.StringBuilder 512
  [void][RpaNativeInput]::GetWindowText($hwnd, $builder, $builder.Capacity)
  [uint32]$pidValue = 0
  $threadId = [RpaNativeInput]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
  $processName = ''
  try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}
  $rect = New-Object RpaNativeInput+RECT
  [void][RpaNativeInput]::GetWindowRect($hwnd, [ref]$rect)
  return [pscustomobject]@{
    hwnd = $hwnd.ToInt64(); processId = $pidValue; processName = $processName; windowTitle = $builder.ToString()
    inputLanguage = ([int64][RpaNativeInput]::GetKeyboardLayout($threadId) -band 0xffff)
    windowLeft = $rect.Left; windowTop = $rect.Top; windowWidth = ($rect.Right - $rect.Left); windowHeight = ($rect.Bottom - $rect.Top)
  }
}

function Get-ElementAtPoint([int]$x, [int]$y) {
  try {
    $point = New-Object System.Windows.Point($x, $y)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    if ($null -eq $element) { return @{} }
    $elementProcessId = [int]$element.Current.ProcessId
    $elementProcessName = ''
    try { $elementProcessName = (Get-Process -Id $elementProcessId -ErrorAction Stop).ProcessName } catch {}
    return @{
      name = $element.Current.Name
      automationId = $element.Current.AutomationId
      controlType = $element.Current.ControlType.ProgrammaticName
      processId = $elementProcessId
      processName = $elementProcessName
    }
  } catch { return @{} }
}

function Get-FocusedTextState {
  try {
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $element -or [bool]$element.Current.IsPassword) { return $null }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -eq $pattern) { return $null }
    $bounds = $element.Current.BoundingRectangle
    return @{
      value = [string]$pattern.Current.Value
      name = $element.Current.Name
      automationId = $element.Current.AutomationId
      controlType = $element.Current.ControlType.ProgrammaticName
      x = $(if ($bounds.IsEmpty) { 0 } else { [int]($bounds.Left + ($bounds.Width / 2)) })
      y = $(if ($bounds.IsEmpty) { 0 } else { [int]($bounds.Top + ($bounds.Height / 2)) })
    }
  } catch { return $null }
}

function Get-MonitorContext([int]$x, [int]$y) {
  $point = New-Object RpaNativeInput+POINT
  $point.X = $x; $point.Y = $y
  $monitor = [RpaNativeInput]::MonitorFromPoint($point, 2)
  $info = New-Object RpaNativeInput+MONITORINFO
  $info.Size = [Runtime.InteropServices.Marshal]::SizeOf([type][RpaNativeInput+MONITORINFO])
  if ($monitor -eq [IntPtr]::Zero -or -not [RpaNativeInput]::GetMonitorInfo($monitor, [ref]$info)) { return @{} }
  return @{
    displayLeft = $info.Monitor.Left; displayTop = $info.Monitor.Top
    displayWidth = ($info.Monitor.Right - $info.Monitor.Left); displayHeight = ($info.Monitor.Bottom - $info.Monitor.Top)
    displayPrimary = (($info.Flags -band 1) -ne 0)
  }
}

function Get-KeyCharacter([int]$vk) {
  $state = New-Object byte[] 256
  if (-not [RpaNativeInput]::GetKeyboardState($state)) { return '' }
  $builder = New-Object System.Text.StringBuilder 8
  $scan = [RpaNativeInput]::MapVirtualKey([uint32]$vk, 0)
  $count = [RpaNativeInput]::ToUnicode([uint32]$vk, $scan, $state, $builder, $builder.Capacity, 0)
  if ($count -gt 0) { return $builder.ToString().Substring(0, $count) }
  return ''
}

$previous = New-Object bool[] 256
$lastWindow = 0
$lastTextProbeAt = 0
$lastTextContext = ''
$lastTextValue = $null
[RpaNativeInput]::StartMouseHook()
while ($true) {
  [System.Windows.Forms.Application]::DoEvents()
  $context = Get-WindowContext
  if ($context.hwnd -ne $lastWindow) {
    $lastWindow = $context.hwnd
    [pscustomobject]@{
      event = 'focus'; recordedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      processId = $context.processId; processName = $context.processName; windowTitle = $context.windowTitle
    } | ConvertTo-Json -Compress
  }

  $wheel = New-Object RpaNativeInput+WheelEvent
  while ([RpaNativeInput]::TryDequeueWheel([ref]$wheel)) {
    $monitor = Get-MonitorContext $wheel.X $wheel.Y
    [pscustomobject]@{
      event = 'scroll'; recordedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      x = $wheel.X; y = $wheel.Y; delta = $wheel.Delta
      processId = $context.processId; processName = $context.processName; windowTitle = $context.windowTitle
      windowLeft = $context.windowLeft; windowTop = $context.windowTop; windowWidth = $context.windowWidth; windowHeight = $context.windowHeight
      displayLeft = $monitor.displayLeft; displayTop = $monitor.displayTop; displayWidth = $monitor.displayWidth; displayHeight = $monitor.displayHeight; displayPrimary = $monitor.displayPrimary
    } | ConvertTo-Json -Compress
    $wheel = New-Object RpaNativeInput+WheelEvent
  }

  $click = New-Object RpaNativeInput+ClickEvent
  while ([RpaNativeInput]::TryDequeueClick([ref]$click)) {
    $element = Get-ElementAtPoint $click.X $click.Y
    $monitor = Get-MonitorContext $click.X $click.Y
    $targetProcessId = $(if ([int]$element.processId -gt 0) { [int]$element.processId } else { $context.processId })
    $targetProcessName = $(if ([string]$element.processName) { [string]$element.processName } else { $context.processName })
    [pscustomobject]@{
      event = 'click'; recordedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      button = $(if ($click.Button -eq 2) { 'right' } else { 'left' }); x = $click.X; y = $click.Y
      name = $element.name; automationId = $element.automationId; controlType = $element.controlType
      processId = $targetProcessId; processName = $targetProcessName; windowTitle = $context.windowTitle
      windowLeft = $context.windowLeft; windowTop = $context.windowTop; windowWidth = $context.windowWidth; windowHeight = $context.windowHeight
      displayLeft = $monitor.displayLeft; displayTop = $monitor.displayTop; displayWidth = $monitor.displayWidth; displayHeight = $monitor.displayHeight; displayPrimary = $monitor.displayPrimary
    } | ConvertTo-Json -Compress
    $click = New-Object RpaNativeInput+ClickEvent
  }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $foregroundProcess = ([string]$context.processName).ToLowerInvariant()
  if (($now - $lastTextProbeAt) -ge 45 -and @('textinputhost', 'ctfmon', 'chsime') -notcontains $foregroundProcess) {
    $lastTextProbeAt = $now
    $textState = Get-FocusedTextState
    if ($null -eq $textState) {
      $lastTextContext = ''
      $lastTextValue = $null
    } else {
      $textContext = "$($context.processId)|$($textState.automationId)|$($textState.name)|$($textState.controlType)|$($textState.x)|$($textState.y)"
      if ($textContext -ne $lastTextContext) {
        $lastTextContext = $textContext
        $lastTextValue = [string]$textState.value
      } elseif ([string]$textState.value -ne [string]$lastTextValue) {
        $monitor = Get-MonitorContext $textState.x $textState.y
        [pscustomobject]@{
          event = 'text'; recordedAt = $now
          value = [string]$textState.value; previousValue = [string]$lastTextValue
          inputLanguage = $context.inputLanguage
          name = $textState.name; automationId = $textState.automationId; controlType = $textState.controlType
          x = $textState.x; y = $textState.y
          processId = $context.processId; processName = $context.processName; windowTitle = $context.windowTitle
          windowLeft = $context.windowLeft; windowTop = $context.windowTop; windowWidth = $context.windowWidth; windowHeight = $context.windowHeight
          displayLeft = $monitor.displayLeft; displayTop = $monitor.displayTop; displayWidth = $monitor.displayWidth; displayHeight = $monitor.displayHeight; displayPrimary = $monitor.displayPrimary
        } | ConvertTo-Json -Compress
        $lastTextValue = [string]$textState.value
      }
    }
  }

  foreach ($vk in 1..254) {
    $down = (([RpaNativeInput]::GetAsyncKeyState($vk) -band 0x8000) -ne 0)
    if ($down -and -not $previous[$vk]) {
      if ($vk -gt 6) {
        $focused = $null
        $isPassword = $false
        $focusName = ''
        $focusAutomationId = ''
        $focusControlType = ''
        $focusX = 0
        $focusY = 0
        try {
          $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
          if ($null -ne $focused) {
            $isPassword = [bool]$focused.Current.IsPassword
            $focusName = $focused.Current.Name
            $focusAutomationId = $focused.Current.AutomationId
            $focusControlType = $focused.Current.ControlType.ProgrammaticName
            $bounds = $focused.Current.BoundingRectangle
            if (-not $bounds.IsEmpty) {
              $focusX = [int]($bounds.Left + ($bounds.Width / 2))
              $focusY = [int]($bounds.Top + ($bounds.Height / 2))
            }
          }
        } catch {}
        $monitor = Get-MonitorContext $focusX $focusY
        $character = Get-KeyCharacter $vk
        [pscustomobject]@{
          event = 'key'; recordedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); key = $vk
          character = $character
          ctrl = (([RpaNativeInput]::GetAsyncKeyState(17) -band 0x8000) -ne 0)
          alt = (([RpaNativeInput]::GetAsyncKeyState(18) -band 0x8000) -ne 0)
          shift = (([RpaNativeInput]::GetAsyncKeyState(16) -band 0x8000) -ne 0)
          win = ((([RpaNativeInput]::GetAsyncKeyState(91) -band 0x8000) -ne 0) -or (([RpaNativeInput]::GetAsyncKeyState(92) -band 0x8000) -ne 0))
          isPassword = $isPassword
          inputLanguage = $context.inputLanguage
          name = $focusName; automationId = $focusAutomationId; controlType = $focusControlType
          x = $focusX; y = $focusY
          processId = $context.processId; processName = $context.processName; windowTitle = $context.windowTitle
          windowLeft = $context.windowLeft; windowTop = $context.windowTop; windowWidth = $context.windowWidth; windowHeight = $context.windowHeight
          displayLeft = $monitor.displayLeft; displayTop = $monitor.displayTop; displayWidth = $monitor.displayWidth; displayHeight = $monitor.displayHeight; displayPrimary = $monitor.displayPrimary
        } | ConvertTo-Json -Compress
      }
    }
    $previous[$vk] = $down
  }
  Start-Sleep -Milliseconds 18
}
`

const KEY_NAMES: Record<number, string> = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: 'Space', 33: 'PageUp', 34: 'PageDown',
  35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 45: 'Insert', 46: 'Delete',
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6', 118: 'F7', 119: 'F8',
  120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12'
}

const CHINESE_INPUT_LANGUAGE_IDS = new Set([0x0804, 0x0404, 0x0c04, 0x1004, 0x1404])

function keyName(vk: number, character?: string): string {
  if (KEY_NAMES[vk]) return KEY_NAMES[vk]
  if (vk >= 65 && vk <= 90) return String.fromCharCode(vk)
  if (vk >= 48 && vk <= 57) return String.fromCharCode(vk)
  return character || `VK_${vk}`
}

function deriveInsertedValue(baseline: string, current: string): string {
  let prefixLength = 0
  const maxPrefix = Math.min(baseline.length, current.length)
  while (prefixLength < maxPrefix && baseline[prefixLength] === current[prefixLength]) prefixLength++

  let suffixLength = 0
  const maxSuffix = Math.min(baseline.length - prefixLength, current.length - prefixLength)
  while (
    suffixLength < maxSuffix &&
    baseline[baseline.length - 1 - suffixLength] === current[current.length - 1 - suffixLength]
  ) suffixLength++

  return current.slice(prefixLength, current.length - suffixLength)
}

export class RpaDesktopRecordingSession {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly scriptPath: string
  private readonly actions: DesktopRecordedAction[] = []
  private readonly excludedProcesses: Set<string>
  private readonly excludedProcessIds: Set<number>
  private readonly transientInputProcesses = new Set(['textinputhost', 'ctfmon', 'chsime'])
  private pendingText: { value: string; rawTail: string; rawRecordedValue: string; snapshotBaseline?: string; lastSnapshotAt?: number; sensitive: boolean; recordedAt: number; inputLanguage?: number; processId?: number; processName?: string; windowTitle?: string; x?: number; y?: number; relativeX?: number; relativeY?: number; displayRelativeX?: number; displayRelativeY?: number; displayPrimary?: boolean; name?: string; automationId?: string; controlType?: string } | null = null
  private stopped = false
  private completedResolved = false
  private readonly completed: Promise<DesktopRecordedAction[]>
  private resolveCompleted!: (actions: DesktopRecordedAction[]) => void

  constructor(options: DesktopRecordingOptions = {}) {
    this.excludedProcesses = new Set((options.excludeProcessNames || []).map(name => name.toLowerCase()))
    this.excludedProcessIds = new Set(options.excludeProcessIds || [])
    this.scriptPath = join(tmpdir(), `agentpet-rpa-recorder-${process.pid}-${Date.now()}.ps1`)
    // Windows PowerShell 5.1 对无 BOM 的 UTF-8 脚本识别不稳定；写入 BOM 保证中文和 JSON 正常输出。
    writeFileSync(this.scriptPath, `\uFEFF${WINDOWS_RECORDER_SCRIPT}`, 'utf8')
    this.child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.completed = new Promise(resolve => { this.resolveCompleted = resolve })

    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try {
        this.accept(JSON.parse(line) as RawDesktopEvent)
      } catch {
        // PowerShell can emit non-JSON diagnostic lines; ignore those lines.
      }
    })
    this.child.stderr.on('data', data => {
      const message = String(data).trim()
      if (!message || message.includes('#< CLIXML') || message.includes('Preparing modules for first use')) return
      console.warn('[RPA Desktop Recorder]', message)
    })
    this.child.once('exit', () => {
      try { rmSync(this.scriptPath, { force: true }) } catch { /* 临时脚本清理失败不影响录制结果 */ }
      this.complete()
    })
    this.child.once('error', error => {
      console.error('[RPA Desktop Recorder] Failed:', error)
      this.complete()
    })
  }

  public async stop(): Promise<DesktopRecordedAction[]> {
    if (!this.stopped) {
      this.stopped = true
      this.child.kill()
      setTimeout(() => this.complete(), 300)
    }
    return this.completed
  }

  private accept(event: RawDesktopEvent): void {
    const processName = String(event.processName || '').toLowerCase()
    if (event.event === 'click' && event.automationId === 'finish-button') {
      this.flushText()
      return
    }
    // 输入法候选窗属于临时系统界面，不应打断当前输入框的文本聚合。
    if (this.transientInputProcesses.has(processName)) return
    if (this.excludedProcesses.has(processName) || this.excludedProcessIds.has(Number(event.processId))) {
      this.flushText()
      return
    }

    if (event.event === 'focus') {
      this.flushText()
      const processId = Number(event.processId)
      if (!processId || processId <= 0 || ['idle', 'system'].includes(processName) || !event.windowTitle) return
      if (processName === 'explorer' && /^(program manager|workerw)$/i.test(String(event.windowTitle))) return
      const previous = this.actions[this.actions.length - 1]
      if (previous?.type === 'desktop_focus' && previous.windowTitle === event.windowTitle && previous.processName === event.processName) return
      this.actions.push({
        type: 'desktop_focus',
        windowTitle: event.windowTitle,
        processName: event.processName,
        processId: event.processId,
        label: `聚焦 ${event.windowTitle || event.processName || '窗口'}`,
        recordedAt: event.recordedAt || Date.now()
      })
      return
    }

    if (event.event === 'click') {
      this.flushText()
      const recordedAt = event.recordedAt || Date.now()
      const previous = this.actions[this.actions.length - 1]
      if (
        previous?.type === 'desktop_click' && previous.button === (event.button || 'left') &&
        Math.abs(previous.x - (Number(event.x) || 0)) <= 6 && Math.abs(previous.y - (Number(event.y) || 0)) <= 6 &&
        recordedAt - Number(previous.recordedAt || 0) < 550
      ) {
        previous.double = true
        previous.label = `双击 ${event.name || event.controlType || previous.name || '桌面控件'}`
        previous.recordedAt = recordedAt
        return
      }
      this.actions.push({
        type: 'desktop_click',
        x: Number(event.x) || 0,
        y: Number(event.y) || 0,
        button: event.button || 'left',
        relativeX: Number(event.windowWidth) > 0 ? (Number(event.x) - Number(event.windowLeft)) / Number(event.windowWidth) : undefined,
        relativeY: Number(event.windowHeight) > 0 ? (Number(event.y) - Number(event.windowTop)) / Number(event.windowHeight) : undefined,
        displayRelativeX: Number(event.displayWidth) > 0 ? (Number(event.x) - Number(event.displayLeft)) / Number(event.displayWidth) : undefined,
        displayRelativeY: Number(event.displayHeight) > 0 ? (Number(event.y) - Number(event.displayTop)) / Number(event.displayHeight) : undefined,
        displayLeft: event.displayLeft,
        displayTop: event.displayTop,
        displayWidth: event.displayWidth,
        displayHeight: event.displayHeight,
        displayPrimary: event.displayPrimary,
        name: event.name,
        automationId: event.automationId,
        controlType: event.controlType,
        processId: event.processId,
        processName: event.processName,
        windowTitle: event.windowTitle,
        label: `${event.button === 'right' ? '右键' : '点击'} ${event.name || event.controlType || '桌面控件'}`,
        recordedAt
      })
      return
    }

    if (event.event === 'scroll') {
      this.flushText()
      const direction = Number(event.delta) > 0 ? 'up' : 'down'
      const recordedAt = event.recordedAt || Date.now()
      const amount = Math.max(1, Math.round(Math.abs(Number(event.delta) || 120) / 120))
      const previous = this.actions[this.actions.length - 1]
      if (
        previous?.type === 'desktop_scroll' && previous.direction === direction &&
        previous.processName === event.processName && recordedAt - Number(previous.recordedAt || 0) < 650
      ) {
        previous.amount += amount
        previous.recordedAt = recordedAt
      } else {
        this.actions.push({
          type: 'desktop_scroll', x: Number(event.x) || 0, y: Number(event.y) || 0,
          direction, amount, processName: event.processName, windowTitle: event.windowTitle,
          relativeX: Number(event.windowWidth) > 0 ? (Number(event.x) - Number(event.windowLeft)) / Number(event.windowWidth) : undefined,
          relativeY: Number(event.windowHeight) > 0 ? (Number(event.y) - Number(event.windowTop)) / Number(event.windowHeight) : undefined,
          displayRelativeX: Number(event.displayWidth) > 0 ? (Number(event.x) - Number(event.displayLeft)) / Number(event.displayWidth) : undefined,
          displayRelativeY: Number(event.displayHeight) > 0 ? (Number(event.y) - Number(event.displayTop)) / Number(event.displayHeight) : undefined,
          displayLeft: event.displayLeft, displayTop: event.displayTop,
          displayWidth: event.displayWidth, displayHeight: event.displayHeight, displayPrimary: event.displayPrimary,
          label: direction === 'up' ? '向上滚动' : '向下滚动', recordedAt
        })
      }
      return
    }

    if (event.event === 'text') {
      this.acceptTextSnapshot(event)
      return
    }

    this.acceptKey(event)
  }

  private acceptTextSnapshot(event: RawDesktopEvent): void {
    const currentValue = String(event.value ?? '')
    const previousValue = String(event.previousValue ?? '')
    const windowChanged = this.pendingText && this.pendingText.processName !== event.processName
    if (windowChanged) this.flushText()
    if (!this.pendingText) {
      this.pendingText = {
        value: '', rawTail: '', rawRecordedValue: '', snapshotBaseline: previousValue, sensitive: false,
        inputLanguage: event.inputLanguage,
        recordedAt: event.recordedAt || Date.now(), processId: event.processId, processName: event.processName, windowTitle: event.windowTitle,
        x: event.x, y: event.y, name: event.name, automationId: event.automationId, controlType: event.controlType,
        relativeX: Number(event.windowWidth) > 0 ? (Number(event.x) - Number(event.windowLeft)) / Number(event.windowWidth) : undefined,
        relativeY: Number(event.windowHeight) > 0 ? (Number(event.y) - Number(event.windowTop)) / Number(event.windowHeight) : undefined,
        displayRelativeX: Number(event.displayWidth) > 0 ? (Number(event.x) - Number(event.displayLeft)) / Number(event.displayWidth) : undefined,
        displayRelativeY: Number(event.displayHeight) > 0 ? (Number(event.y) - Number(event.displayTop)) / Number(event.displayHeight) : undefined,
        displayPrimary: event.displayPrimary
      }
    } else {
      // UI Automation 给出的输入框信息比物理按键阶段的“窗口中心/最后点击位置”更准确。
      // 同一窗口内应由快照接管目标，不能误拆成两个输入节点。
      this.pendingText.inputLanguage = event.inputLanguage ?? this.pendingText.inputLanguage
      this.pendingText.processId = event.processId ?? this.pendingText.processId
      this.pendingText.windowTitle = event.windowTitle || this.pendingText.windowTitle
      this.pendingText.x = event.x ?? this.pendingText.x
      this.pendingText.y = event.y ?? this.pendingText.y
      this.pendingText.name = event.name || this.pendingText.name
      this.pendingText.automationId = event.automationId || this.pendingText.automationId
      this.pendingText.controlType = event.controlType || this.pendingText.controlType
      this.pendingText.relativeX = Number(event.windowWidth) > 0 ? (Number(event.x) - Number(event.windowLeft)) / Number(event.windowWidth) : this.pendingText.relativeX
      this.pendingText.relativeY = Number(event.windowHeight) > 0 ? (Number(event.y) - Number(event.windowTop)) / Number(event.windowHeight) : this.pendingText.relativeY
      this.pendingText.displayRelativeX = Number(event.displayWidth) > 0 ? (Number(event.x) - Number(event.displayLeft)) / Number(event.displayWidth) : this.pendingText.displayRelativeX
      this.pendingText.displayRelativeY = Number(event.displayHeight) > 0 ? (Number(event.y) - Number(event.displayTop)) / Number(event.displayHeight) : this.pendingText.displayRelativeY
      this.pendingText.displayPrimary = event.displayPrimary ?? this.pendingText.displayPrimary
    }
    const baseline = this.pendingText.snapshotBaseline ?? previousValue
    this.pendingText.snapshotBaseline = baseline
    this.pendingText.lastSnapshotAt = event.recordedAt || Date.now()
    this.pendingText.rawTail = ''
    this.pendingText.value = deriveInsertedValue(baseline, currentValue)
  }

  private acceptKey(event: RawDesktopEvent): void {
    const vk = Number(event.key)
    if ([16, 17, 18, 20, 91, 92, 144].includes(vk)) return
    const recordedAt = event.recordedAt || Date.now()
    const hasCommandModifier = Boolean(event.ctrl || event.alt || event.win)

    if (!hasCommandModifier && vk === 8) {
      if (this.pendingText?.value) {
        this.pendingText.value = this.pendingText.value.slice(0, -1)
        this.pendingText.rawTail = this.pendingText.rawTail.slice(0, -1)
        this.pendingText.rawRecordedValue = this.pendingText.rawRecordedValue.slice(0, -1)
      }
      return
    }

    const character = String(event.character || '')
    if (!hasCommandModifier && character && vk !== 13 && vk !== 9) {
      const isImeCandidateKey = Boolean(
        this.pendingText?.snapshotBaseline !== undefined &&
        CHINESE_INPUT_LANGUAGE_IDS.has(Number(event.inputLanguage || this.pendingText?.inputLanguage)) &&
        (vk === 32 || (vk >= 49 && vk <= 57)) &&
        recordedAt - Number(this.pendingText?.lastSnapshotAt || 0) <= 100
      )
      // 快照已拿到最终上屏中文时，同一轮捕获到的空格/数字只是候选选择键。
      // 若它确实是正文，后续 UIA 值变化仍会把它补回，不会丢失真实输入。
      if (isImeCandidateKey) return
      const previousAction = this.actions[this.actions.length - 1]
      const previousClick = previousAction?.type === 'desktop_click' &&
        previousAction.processName === event.processName && previousAction.windowTitle === event.windowTitle
        ? previousAction
        : undefined
      // 自绘应用常把焦点只暴露为整个 Window。此时窗口中心不是输入框，
      // 应继承用户输入前最后一次真实点击的位置，供回放重新聚焦。
      const focusedOnlyOnWindow = /ControlType\.Window$/i.test(String(event.controlType || ''))
      const targetX = focusedOnlyOnWindow && previousClick ? previousClick.x : event.x
      const targetY = focusedOnlyOnWindow && previousClick ? previousClick.y : event.y
      const targetRelativeX = focusedOnlyOnWindow && previousClick
        ? previousClick.relativeX
        : Number(event.windowWidth) > 0 ? (Number(event.x) - Number(event.windowLeft)) / Number(event.windowWidth) : undefined
      const targetRelativeY = focusedOnlyOnWindow && previousClick
        ? previousClick.relativeY
        : Number(event.windowHeight) > 0 ? (Number(event.y) - Number(event.windowTop)) / Number(event.windowHeight) : undefined
      const targetDisplayRelativeX = focusedOnlyOnWindow && previousClick
        ? previousClick.displayRelativeX
        : Number(event.displayWidth) > 0 ? (Number(event.x) - Number(event.displayLeft)) / Number(event.displayWidth) : undefined
      const targetDisplayRelativeY = focusedOnlyOnWindow && previousClick
        ? previousClick.displayRelativeY
        : Number(event.displayHeight) > 0 ? (Number(event.y) - Number(event.displayTop)) / Number(event.displayHeight) : undefined
      const targetName = focusedOnlyOnWindow ? undefined : event.name
      const targetAutomationId = focusedOnlyOnWindow ? undefined : event.automationId
      const targetControlType = focusedOnlyOnWindow ? undefined : event.controlType
      const hasAuthoritativeSnapshot = this.pendingText?.snapshotBaseline !== undefined
      const contextChanged = this.pendingText && (
        this.pendingText.processName !== event.processName ||
        this.pendingText.sensitive !== Boolean(event.isPassword) ||
        (!hasAuthoritativeSnapshot && (
          (this.pendingText.automationId || '') !== (targetAutomationId || '') ||
          (this.pendingText.name || '') !== (targetName || '') ||
          Math.abs(Number(this.pendingText.x || 0) - Number(targetX || 0)) > 8 ||
          Math.abs(Number(this.pendingText.y || 0) - Number(targetY || 0)) > 8
        ))
      )
      if (contextChanged) this.flushText()
      if (!this.pendingText) {
        this.pendingText = {
          value: '', rawTail: '', rawRecordedValue: '', sensitive: Boolean(event.isPassword), recordedAt,
          inputLanguage: event.inputLanguage,
          processId: event.processId, processName: event.processName, windowTitle: event.windowTitle,
          x: targetX, y: targetY, name: targetName,
          relativeX: targetRelativeX, relativeY: targetRelativeY,
          displayRelativeX: targetDisplayRelativeX, displayRelativeY: targetDisplayRelativeY,
          displayPrimary: focusedOnlyOnWindow && previousClick ? previousClick.displayPrimary : event.displayPrimary,
          automationId: targetAutomationId, controlType: targetControlType
        }
      }
      this.pendingText.value += character
      this.pendingText.rawTail += character
      this.pendingText.rawRecordedValue += character
      return
    }

    this.flushText()
    const keys = [event.ctrl && 'Ctrl', event.alt && 'Alt', event.shift && 'Shift', event.win && 'Meta', keyName(vk, character)].filter(Boolean).join('+')
    if (!keys || keys.startsWith('VK_')) return
    if (keys === 'Ctrl+Shift+F12') return
    const previous = this.actions[this.actions.length - 1]
    if (
      previous?.type === 'desktop_hotkey' && previous.keys === keys &&
      previous.windowTitle === event.windowTitle && recordedAt - Number(previous.recordedAt || 0) < 220
    ) return
    this.actions.push({
      type: 'desktop_hotkey', keys,
      processName: event.processName, windowTitle: event.windowTitle,
      label: `按下 ${keys}`, recordedAt
    })
  }

  private flushText(): void {
    const pending = this.pendingText
    this.pendingText = null
    if (!pending || (!pending.value && !pending.sensitive)) return
    this.actions.push({
      type: 'desktop_type',
      value: pending.sensitive ? '' : pending.value,
      rawRecordedValue: pending.sensitive ? '' : pending.rawRecordedValue,
      normalizationSource: pending.snapshotBaseline === undefined ? undefined : 'uia',
      normalizationConfidence: pending.snapshotBaseline === undefined ? undefined : 'high',
      inputLanguage: pending.inputLanguage,
      processId: pending.processId,
      sensitive: pending.sensitive,
      requiresCredentialBinding: pending.sensitive,
      processName: pending.processName,
      windowTitle: pending.windowTitle,
      x: pending.x,
      y: pending.y,
      relativeX: pending.relativeX,
      relativeY: pending.relativeY,
      displayRelativeX: pending.displayRelativeX,
      displayRelativeY: pending.displayRelativeY,
      displayPrimary: pending.displayPrimary,
      name: pending.name,
      automationId: pending.automationId,
      controlType: pending.controlType,
      label: pending.sensitive ? '输入敏感内容' : '桌面输入',
      recordedAt: pending.recordedAt
    })
  }

  private complete(): void {
    if (this.completedResolved) return
    this.completedResolved = true
    this.flushText()
    this.resolveCompleted(this.compactTextActions(this.actions))
  }

  private compactTextActions(actions: DesktopRecordedAction[]): DesktopRecordedAction[] {
    const compacted: DesktopRecordedAction[] = []
    for (const action of actions) {
      const previous = compacted[compacted.length - 1]
      if (
        action.type === 'desktop_type' && previous?.type === 'desktop_type' &&
        action.processName === previous.processName &&
        Number(action.recordedAt || 0) - Number(previous.recordedAt || 0) < 2500
      ) {
        const snapshotIsAuthoritative = action.normalizationSource === 'uia'
        compacted[compacted.length - 1] = {
          ...previous,
          ...action,
          value: snapshotIsAuthoritative ? action.value : `${previous.value || ''}${action.value || ''}`,
          rawRecordedValue: `${previous.rawRecordedValue || previous.value || ''}${action.rawRecordedValue || ''}`,
          recordedAt: previous.recordedAt
        }
        continue
      }
      compacted.push(action)
    }
    return compacted
  }
}

export function startDesktopRecording(options?: DesktopRecordingOptions): RpaDesktopRecordingSession {
  if (process.platform !== 'win32') throw new Error('桌面录制目前仅支持 Windows')
  return new RpaDesktopRecordingSession(options)
}

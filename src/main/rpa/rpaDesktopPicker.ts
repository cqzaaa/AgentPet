import { screen } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

type CachedBounds = { left: number; top: number; width: number; height: number; expiresAt: number }
const desktopWindowBoundsCache = new Map<string, CachedBounds>()
const desktopDisplayBoundsCache = new Map<string, CachedBounds>()
const BOUNDS_CACHE_TTL_MS = 30_000

export interface DesktopTargetSnapshot {
  x: number
  y: number
  name?: string
  automationId?: string
  controlType?: string
  processId?: number
  processName?: string
  windowTitle?: string
}

export interface DesktopWindowTarget {
  processId: number
  processName: string
  windowTitle: string
}

export interface DesktopPointDiagnostic {
  x: number
  y: number
  elementName?: string
  automationId?: string
  controlType?: string
  processName?: string
  windowTitle?: string
  foregroundProcess?: string
  foregroundTitle?: string
  displayBounds?: { left: number; top: number; width: number; height: number; primary: boolean }
  dpi?: number
  scaleFactor?: number
}

export async function listDesktopWindows(): Promise<DesktopWindowTarget[]> {
  if (process.platform !== 'win32') return []
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
  Sort-Object ProcessName, MainWindowTitle |
  ForEach-Object {
    [pscustomobject]@{
      processId = $_.Id
      processName = $_.ProcessName
      windowTitle = $_.MainWindowTitle
    }
  } | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  try {
    const parsed = JSON.parse(stdout.trim() || '[]')
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(item => Number(item?.processId) > 0 && item?.windowTitle)
  } catch {
    return []
  }
}

export async function focusDesktopWindow(processId: number): Promise<boolean> {
  if (process.platform !== 'win32' || !Number.isFinite(processId) || processId <= 0) return false
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RpaWindowFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
'@
$process = Get-Process -Id ${Math.trunc(processId)} -ErrorAction SilentlyContinue
if ($null -eq $process -or $process.MainWindowHandle -eq 0) { 'NOT_FOUND'; exit }
[void][RpaWindowFocus]::ShowWindowAsync($process.MainWindowHandle, 9)
Start-Sleep -Milliseconds 120
$activated = $false
try { $activated = (New-Object -ComObject WScript.Shell).AppActivate($process.Id) } catch {}
if ($activated -or [RpaWindowFocus]::SetForegroundWindow($process.MainWindowHandle)) { 'OK' } else { 'FAILED' }
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  return stdout.trim().includes('OK')
}

export async function showWindowsDesktop(): Promise<void> {
  if (process.platform !== 'win32') return
  const script = `$shell = New-Object -ComObject Shell.Application; $shell.MinimizeAll()`
  await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
}

export async function captureDesktopTarget(delayMs = 1500): Promise<DesktopTargetSnapshot> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, delayMs))))
  const point = screen.getCursorScreenPoint()
  if (process.platform !== 'win32') return { x: point.x, y: point.y }

  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$point = New-Object System.Windows.Point(${point.x}, ${point.y})
$element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
if ($null -eq $element) { '{}' ; exit }
$pidValue = $element.Current.ProcessId
$processName = ''
try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}
$root = $element
while ($null -ne $root.Current.ControlType -and $root.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') {
  $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($root)
  if ($null -eq $parent) { break }
  $root = $parent
}

[pscustomobject]@{
  name = $element.Current.Name
  automationId = $element.Current.AutomationId
  controlType = $element.Current.ControlType.ProgrammaticName
  processId = $pidValue
  processName = $processName
  windowTitle = $root.Current.Name
} | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  let semantic: Record<string, unknown> = {}
  try { semantic = JSON.parse(stdout.trim() || '{}') } catch { /* 语义信息不可用时保留坐标结果 */ }
  return { x: point.x, y: point.y, ...semantic } as DesktopTargetSnapshot
}

export async function invokeDesktopElement(target: Pick<DesktopTargetSnapshot, 'automationId' | 'name' | 'processId' | 'processName' | 'controlType'> & {
  button?: 'left' | 'right'
  double?: boolean
}): Promise<boolean> {
  if (process.platform !== 'win32' || (!target.automationId && !target.name)) return false
  const automationId = String(target.automationId || '').replace(/'/g, "''")
  const name = String(target.name || '').replace(/'/g, "''")
  const processName = String(target.processName || '').replace(/'/g, "''")
  const controlType = String(target.controlType || '').replace(/'/g, "''")
  const isDesktopShellTarget = processName.toLowerCase() === 'explorer' && controlType.toLowerCase().includes('listitem')
  const pid = Number(target.processId) || 0
  const processCondition = pid
    ? `$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})))`
    : ''
  const elementCondition = automationId
    ? `$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${automationId}')))`
    : `$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${name}')))`
  const script = `
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RpaSemanticClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void EnablePerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
}
'@
  [RpaSemanticClick]::EnablePerMonitorDpi()
  $root = [System.Windows.Automation.AutomationElement]::RootElement
$conditions = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
${processCondition}
${elementCondition}
$condition = if ($conditions.Count -eq 1) { $conditions[0] } else { New-Object System.Windows.Automation.AndCondition($conditions.ToArray()) }
  $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $element = $null
  foreach ($candidate in $elements) {
    $candidateProcess = ''
    try { $candidateProcess = (Get-Process -Id $candidate.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
    $processMatches = (${isDesktopShellTarget ? '$true' : '$false'} -or '${processName}' -eq '' -or $candidateProcess -ieq '${processName}')
    $controlMatches = ('${controlType}' -eq '' -or $candidate.Current.ControlType.ProgrammaticName -eq '${controlType}')
    if ($processMatches -and $controlMatches) { $element = $candidate; break }
  }
  if ($null -eq $element) { 'NOT_FOUND'; exit }
  $pattern = $null
  if (-not ${target.double ? '$true' : '$false'} -and '${target.button || 'left'}' -eq 'left' -and $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke(); 'OK'; exit
  }
  $bounds = $element.Current.BoundingRectangle
  if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) { 'NO_BOUNDS'; exit }
  $x = [int]($bounds.Left + ($bounds.Width / 2))
  $y = [int]($bounds.Top + ($bounds.Height / 2))
  [void][RpaSemanticClick]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 60
  $down = $(if ('${target.button || 'left'}' -eq 'right') { 0x0008 } else { 0x0002 })
  $up = $(if ('${target.button || 'left'}' -eq 'right') { 0x0010 } else { 0x0004 })
  $count = $(if (${target.double ? '$true' : '$false'}) { 2 } else { 1 })
  for ($i = 0; $i -lt $count; $i++) {
    [RpaSemanticClick]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [RpaSemanticClick]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($count -gt 1) { Start-Sleep -Milliseconds 110 }
  }
  'OK'
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  return stdout.trim().includes('OK')
}

export async function findDesktopElementPoint(target: {
  name: string
  x: number
  y: number
  radius?: number
}): Promise<{ x: number; y: number } | null> {
  if (process.platform !== 'win32' || !target.name || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return null
  const name = String(target.name).replace(/'/g, "''")
  const radius = Math.min(180, Math.max(24, Number(target.radius) || 120))
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RpaDesktopPointDpi {
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void Enable() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
}
'@
[RpaDesktopPointDpi]::Enable()
$originX = ${Math.round(target.x)}; $originY = ${Math.round(target.y)}; $radius = ${Math.round(radius)}
$offsets = @(0)
for ($distance = 16; $distance -le $radius; $distance += 16) { $offsets += $distance; $offsets += -$distance }
foreach ($dy in $offsets) {
  foreach ($dx in $offsets) {
    try {
      $point = New-Object System.Windows.Point(($originX + $dx), ($originY + $dy))
      $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
      if ($null -eq $element) { continue }
      $elementName = [string]$element.Current.Name
      $controlType = [string]$element.Current.ControlType.ProgrammaticName
      if ($elementName -ieq '${name}' -and $controlType -eq 'ControlType.ListItem') {
        $bounds = $element.Current.BoundingRectangle
        if (-not $bounds.IsEmpty -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) {
          [pscustomobject]@{ x = [int]($bounds.Left + ($bounds.Width / 2)); y = [int]($bounds.Top + ($bounds.Height / 2)) } | ConvertTo-Json -Compress
          exit
        }
      }
    } catch {}
  }
}
'{}'
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  try {
    const point = JSON.parse(stdout.trim() || '{}')
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: Number(point.x), y: Number(point.y) } : null
  } catch {
    return null
  }
}

export async function clickDesktopPointNative(target: {
  x: number
  y: number
  button?: 'left' | 'right'
  double?: boolean
}): Promise<boolean> {
  if (process.platform !== 'win32' || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return false
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RpaNativeClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void EnablePerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
}
'@
[RpaNativeClick]::EnablePerMonitorDpi()
[void][RpaNativeClick]::SetCursorPos(${Math.round(target.x)}, ${Math.round(target.y)})
Start-Sleep -Milliseconds 60
$down = $(if ('${target.button || 'left'}' -eq 'right') { 0x0008 } else { 0x0002 })
$up = $(if ('${target.button || 'left'}' -eq 'right') { 0x0010 } else { 0x0004 })
$count = $(if (${target.double ? '$true' : '$false'}) { 2 } else { 1 })
for ($i = 0; $i -lt $count; $i++) {
  [RpaNativeClick]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  [RpaNativeClick]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  if ($count -gt 1) { Start-Sleep -Milliseconds 110 }
}
'OK'
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  return stdout.trim().includes('OK')
}

export async function scrollDesktopPointNative(target: {
  x: number
  y: number
  direction: 'up' | 'down'
  amount?: number
}): Promise<boolean> {
  if (process.platform !== 'win32' || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return false
  const amount = Math.min(30, Math.max(1, Math.round(Number(target.amount) || 1)))
  const delta = target.direction === 'up' ? 120 : -120
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RpaNativeScroll {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void EnablePerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
  public static void Scroll(int delta) { mouse_event(0x0800, 0, 0, unchecked((uint)delta), UIntPtr.Zero); }
}
'@
[RpaNativeScroll]::EnablePerMonitorDpi()
[void][RpaNativeScroll]::SetCursorPos(${Math.round(target.x)}, ${Math.round(target.y)})
Start-Sleep -Milliseconds 80
for ($i = 0; $i -lt ${amount}; $i++) {
  [RpaNativeScroll]::Scroll(${delta})
  Start-Sleep -Milliseconds 45
}
'OK'
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  return stdout.trim().includes('OK')
}

export async function focusDesktopElement(target: Pick<DesktopTargetSnapshot, 'automationId' | 'name' | 'processName'>): Promise<boolean> {
  if (process.platform !== 'win32' || (!target.automationId && !target.name)) return false
  const automationId = String(target.automationId || '').replace(/'/g, "''")
  const name = String(target.name || '').replace(/'/g, "''")
  const processName = String(target.processName || '').replace(/'/g, "''")
  const elementCondition = automationId
    ? `$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${automationId}')`
    : `$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${name}')`
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
${elementCondition}
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
foreach ($element in $elements) {
  $matchesProcess = $true
  if ('${processName}' -ne '') {
    $elementProcess = ''
    try { $elementProcess = (Get-Process -Id $element.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
    $matchesProcess = ($elementProcess -ieq '${processName}')
  }
  if ($matchesProcess) {
    try { $element.SetFocus(); 'OK'; exit } catch {}
  }
}
'NOT_FOUND'
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  return stdout.trim().includes('OK')
}

export async function resolveDesktopRelativePoint(target: {
  windowTitle?: string
  processName?: string
  relativeX?: number
  relativeY?: number
}): Promise<{ x: number; y: number } | null> {
  if (process.platform !== 'win32' || !Number.isFinite(target.relativeX) || !Number.isFinite(target.relativeY)) return null
  const title = String(target.windowTitle || '').replace(/'/g, "''")
  const processName = String(target.processName || '').replace(/'/g, "''")
  if (!title && !processName) return null
  const cacheKey = `${title.toLowerCase()}\u0000${processName.toLowerCase()}`
  const cached = desktopWindowBoundsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return {
      x: Math.round(cached.left + cached.width * Number(target.relativeX)),
      y: Math.round(cached.top + cached.height * Number(target.relativeY))
    }
  }
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class RpaWindowBounds {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void EnablePerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
  public static IntPtr Find(string targetTitle, string targetProcessName) {
    IntPtr titleMatch = IntPtr.Zero;
    IntPtr processFallback = IntPtr.Zero;
    EnumWindows(delegate(IntPtr handle, IntPtr data) {
      if (!IsWindowVisible(handle)) return true;
      int length = GetWindowTextLength(handle);
      if (length <= 0) return true;
      var builder = new StringBuilder(length + 1);
      GetWindowText(handle, builder, builder.Capacity);
      string windowTitle = builder.ToString();
      uint processId;
      GetWindowThreadProcessId(handle, out processId);
      string processName = "";
      try { processName = Process.GetProcessById((int)processId).ProcessName; } catch {}
      if (!string.IsNullOrEmpty(targetTitle) && windowTitle.IndexOf(targetTitle, StringComparison.OrdinalIgnoreCase) >= 0) {
        titleMatch = handle;
        return false;
      }
      if (processFallback == IntPtr.Zero && !string.IsNullOrEmpty(targetProcessName) && processName.Equals(targetProcessName, StringComparison.OrdinalIgnoreCase)) {
        processFallback = handle;
      }
      return true;
    }, IntPtr.Zero);
    return titleMatch != IntPtr.Zero ? titleMatch : processFallback;
  }
}
'@
[RpaWindowBounds]::EnablePerMonitorDpi()
$handle = [RpaWindowBounds]::Find('${title}', '${processName}')
if ($handle -eq [IntPtr]::Zero) { '{}' ; exit }
$rect = New-Object RpaWindowBounds+RECT
if (-not [RpaWindowBounds]::GetWindowRect($handle, [ref]$rect)) { '{}' ; exit }
$width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
if ($width -lt 100 -or $height -lt 100) { '{}' ; exit }
[pscustomobject]@{
  x = [int]($rect.Left + ($width * ${Number(target.relativeX)}))
  y = [int]($rect.Top + ($height * ${Number(target.relativeY)}))
  left = $rect.Left; top = $rect.Top; width = $width; height = $height
} | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  try {
    const point = JSON.parse(stdout.trim() || '{}')
    if (Number.isFinite(point.left) && Number.isFinite(point.top) && Number.isFinite(point.width) && Number.isFinite(point.height)) {
      desktopWindowBoundsCache.set(cacheKey, {
        left: Number(point.left), top: Number(point.top), width: Number(point.width), height: Number(point.height),
        expiresAt: Date.now() + BOUNDS_CACHE_TTL_MS
      })
    }
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: Number(point.x), y: Number(point.y) } : null
  } catch {
    return null
  }
}

export async function resolveDesktopDisplayPoint(target: {
  displayRelativeX?: number
  displayRelativeY?: number
  displayLeft?: number
  displayTop?: number
  displayWidth?: number
  displayHeight?: number
  displayPrimary?: boolean
}): Promise<{ x: number; y: number } | null> {
  if (process.platform !== 'win32' || !Number.isFinite(target.displayRelativeX) || !Number.isFinite(target.displayRelativeY)) return null
  const relativeX = Math.min(1, Math.max(0, Number(target.displayRelativeX)))
  const relativeY = Math.min(1, Math.max(0, Number(target.displayRelativeY)))
  const cacheKey = [target.displayPrimary === false ? 'secondary' : 'primary', target.displayLeft, target.displayTop, target.displayWidth, target.displayHeight].join(':')
  const cached = desktopDisplayBoundsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return {
      x: Math.round(cached.left + cached.width * relativeX),
      y: Math.round(cached.top + cached.height * relativeY)
    }
  }
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RpaDisplays {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
  public sealed class Bounds { public int Left; public int Top; public int Width; public int Height; public bool Primary; }
  private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void EnablePerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
  public static Bounds[] GetAll() {
    var results = new List<Bounds>();
    MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data) {
      var info = new MONITORINFO { Size = Marshal.SizeOf(typeof(MONITORINFO)) };
      if (GetMonitorInfo(monitor, ref info)) results.Add(new Bounds {
        Left = info.Monitor.Left, Top = info.Monitor.Top,
        Width = info.Monitor.Right - info.Monitor.Left, Height = info.Monitor.Bottom - info.Monitor.Top,
        Primary = (info.Flags & 1) != 0
      });
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    return results.ToArray();
  }
}
'@
[RpaDisplays]::EnablePerMonitorDpi()
$monitors = [RpaDisplays]::GetAll() | Sort-Object Left, Top
$wantPrimary = ${target.displayPrimary === false ? '$false' : '$true'}
$recordedLeft = ${Number.isFinite(target.displayLeft) ? Number(target.displayLeft) : 0}
$recordedTop = ${Number.isFinite(target.displayTop) ? Number(target.displayTop) : 0}
$recordedWidth = ${Number.isFinite(target.displayWidth) ? Number(target.displayWidth) : 0}
$recordedHeight = ${Number.isFinite(target.displayHeight) ? Number(target.displayHeight) : 0}
$hasRecordedBounds = ($recordedWidth -gt 0 -and $recordedHeight -gt 0)
$candidate = if ($hasRecordedBounds) {
  $monitors | Sort-Object @{ Expression = {
    $primaryPenalty = $(if ($_.Primary -eq $wantPrimary) { 0 } else { 100000 })
    $primaryPenalty + [Math]::Abs($_.Left - $recordedLeft) + [Math]::Abs($_.Top - $recordedTop) +
      [Math]::Abs($_.Width - $recordedWidth) + [Math]::Abs($_.Height - $recordedHeight)
  }} | Select-Object -First 1
} else {
  $monitors | Where-Object { $_.Primary -eq $wantPrimary } | Select-Object -First 1
}
if ($null -eq $candidate) { $candidate = $monitors | Where-Object { $_.Primary } | Select-Object -First 1 }
if ($null -eq $candidate) { '{}' ; exit }
[pscustomobject]@{
  x = [int]($candidate.Left + ($candidate.Width * ${relativeX}))
  y = [int]($candidate.Top + ($candidate.Height * ${relativeY}))
  left = $candidate.Left; top = $candidate.Top; width = $candidate.Width; height = $candidate.Height
} | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  try {
    const point = JSON.parse(stdout.trim() || '{}')
    if (Number.isFinite(point.left) && Number.isFinite(point.top) && Number.isFinite(point.width) && Number.isFinite(point.height)) {
      desktopDisplayBoundsCache.set(cacheKey, {
        left: Number(point.left), top: Number(point.top), width: Number(point.width), height: Number(point.height),
        expiresAt: Date.now() + BOUNDS_CACHE_TTL_MS
      })
    }
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: Number(point.x), y: Number(point.y) } : null
  } catch {
    return null
  }
}

export async function isDesktopWindowForeground(target: { windowTitle?: string; processName?: string }): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const title = String(target.windowTitle || '').replace(/'/g, "''")
  const processName = String(target.processName || '').replace(/'/g, "''")
  if (!title && !processName) return false
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RpaForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
}
'@
$handle = [RpaForegroundWindow]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][RpaForegroundWindow]::GetWindowText($handle, $builder, $builder.Capacity)
[uint32]$pidValue = 0
[void][RpaForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$pidValue)
$foregroundProcess = ''
try { $foregroundProcess = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}
$titleMatch = ('${title}' -ne '' -and $builder.ToString().IndexOf('${title}', [StringComparison]::OrdinalIgnoreCase) -ge 0)
$processMatch = ('${processName}' -ne '' -and $foregroundProcess -ieq '${processName}')
if ($titleMatch -or $processMatch) { 'OK' } else { 'MISMATCH' }
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  return stdout.trim().includes('OK')
}

export async function inspectDesktopPoint(target?: { x?: number; y?: number }): Promise<DesktopPointDiagnostic | null> {
  if (process.platform !== 'win32') return null
  const hasPoint = Number.isFinite(target?.x) && Number.isFinite(target?.y)
  const pointAssignment = hasPoint
    ? `$point.X = ${Math.round(Number(target?.x))}; $point.Y = ${Math.round(Number(target?.y))}`
    : '[void][RpaPointInspect]::GetCursorPos([ref]$point)'
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RpaPointInspect {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr handle);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void EnablePerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} } }
}

'@
[RpaPointInspect]::EnablePerMonitorDpi()
$point = New-Object RpaPointInspect+POINT
${pointAssignment}
$elementName = ''; $automationId = ''; $controlType = ''; $processName = ''; $windowTitle = ''
try {
  $automationPoint = New-Object System.Windows.Point($point.X, $point.Y)
  $element = [System.Windows.Automation.AutomationElement]::FromPoint($automationPoint)
  if ($null -ne $element) {
    $elementName = $element.Current.Name; $automationId = $element.Current.AutomationId
    $controlType = $element.Current.ControlType.ProgrammaticName
    try { $processName = (Get-Process -Id $element.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
    $root = $element
    while ($null -ne $root) {
      if ($root.Current.ControlType.ProgrammaticName -eq 'ControlType.Window') { $windowTitle = $root.Current.Name; break }
      $root = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($root)
    }
  }
} catch {}
$foreground = [RpaPointInspect]::GetForegroundWindow()
$foregroundBuilder = New-Object System.Text.StringBuilder 512
[void][RpaPointInspect]::GetWindowText($foreground, $foregroundBuilder, $foregroundBuilder.Capacity)
[uint32]$foregroundPid = 0
[void][RpaPointInspect]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
$foregroundProcess = ''
try { $foregroundProcess = (Get-Process -Id $foregroundPid -ErrorAction Stop).ProcessName } catch {}
$monitor = [RpaPointInspect]::MonitorFromPoint($point, 2)
$monitorInfo = New-Object RpaPointInspect+MONITORINFO
$monitorInfo.Size = [Runtime.InteropServices.Marshal]::SizeOf([type][RpaPointInspect+MONITORINFO])
[void][RpaPointInspect]::GetMonitorInfo($monitor, [ref]$monitorInfo)
$dpi = 96
try { $dpiValue = [RpaPointInspect]::GetDpiForWindow($foreground); if ($dpiValue -gt 0) { $dpi = $dpiValue } } catch {}
[pscustomobject]@{
  x = $point.X; y = $point.Y; elementName = $elementName; automationId = $automationId
  controlType = $controlType; processName = $processName; windowTitle = $windowTitle
  foregroundProcess = $foregroundProcess; foregroundTitle = $foregroundBuilder.ToString()
  displayBounds = [pscustomobject]@{
    left = $monitorInfo.Monitor.Left; top = $monitorInfo.Monitor.Top
    width = ($monitorInfo.Monitor.Right - $monitorInfo.Monitor.Left); height = ($monitorInfo.Monitor.Bottom - $monitorInfo.Monitor.Top)
    primary = (($monitorInfo.Flags -band 1) -ne 0)
  }
  dpi = $dpi; scaleFactor = [Math]::Round(($dpi / 96.0), 2)
} | ConvertTo-Json -Compress -Depth 3
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  try {
    return JSON.parse(stdout.trim() || 'null') as DesktopPointDiagnostic | null
  } catch {
    return null
  }
}

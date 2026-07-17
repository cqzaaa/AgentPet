import { screen } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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

export async function captureDesktopTarget(delayMs = 1500): Promise<DesktopTargetSnapshot> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, delayMs))))
  const point = screen.getCursorScreenPoint()
  if (process.platform !== 'win32') return { x: point.x, y: point.y }

  const script = `
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
  try { semantic = JSON.parse(stdout.trim() || '{}') } catch {}
  return { x: point.x, y: point.y, ...semantic } as DesktopTargetSnapshot
}

export async function invokeDesktopElement(target: Pick<DesktopTargetSnapshot, 'automationId' | 'name' | 'processId'>): Promise<boolean> {
  if (process.platform !== 'win32' || (!target.automationId && !target.name)) return false
  const automationId = String(target.automationId || '').replace(/'/g, "''")
  const name = String(target.name || '').replace(/'/g, "''")
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
$root = [System.Windows.Automation.AutomationElement]::RootElement
$conditions = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
${processCondition}
${elementCondition}
$condition = if ($conditions.Count -eq 1) { $conditions[0] } else { New-Object System.Windows.Automation.AndCondition($conditions.ToArray()) }
$element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
if ($null -eq $element) { 'NOT_FOUND'; exit }
$pattern = $null
if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); 'OK'; exit }
'NO_PATTERN'
`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 })
  return stdout.trim().includes('OK')
}

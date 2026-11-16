import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ILLUSTRATOR_CONNECTOR_ID, isIllustratorConnector } from '../../../preload/illustrator-connector'
import { nodeRuntimeManager } from '../interaction/node-runtime-manager'
import { mcpManager } from './mcp-manager'

const execFileAsync = promisify(execFile)

export interface LocalConnectorDetectionResult {
  connectorId: string
  platformSupported: boolean
  installed: boolean
  running: boolean
  appName: string
  versionLabel?: string
  executablePath?: string
  detectionSource?: 'registry' | 'filesystem' | 'process'
  nodeReady: boolean
  nodeVersion?: string
  mcpConfigured: boolean
  mcpEnabled: boolean
  mcpConnected: boolean
  toolsCount: number
  checkedAt: number
}

const REGISTRY_LOCATIONS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Illustrator.exe',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Illustrator.exe',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Illustrator.exe'
]

async function queryRegistryExecutable(keyPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', keyPath, '/ve'], {
      windowsHide: true,
      timeout: 3000
    })
    const match = stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/m)
    if (!match?.[1]) return null
    const raw = match[1].trim().replace(/^"(.*)"$/, '$1')
    return raw && fs.existsSync(raw) ? raw : null
  } catch {
    return null
  }
}

async function queryIllustratorProgIdInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCR\\Illustrator.Application\\CLSID', '/ve'], {
      windowsHide: true,
      timeout: 2500
    })
    return /\{[0-9A-Fa-f-]+\}/.test(stdout)
  } catch {
    return false
  }
}

function findIllustratorInStandardDirs(): { path: string; versionLabel?: string } | null {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'D:\\Program Files'
  ].filter((item, index, arr): item is string => Boolean(item) && arr.indexOf(item) === index)

  const candidates: Array<{ path: string; versionLabel?: string; sortKey: number }> = []
  for (const root of roots) {
    const adobeDir = join(root, 'Adobe')
    if (!fs.existsSync(adobeDir)) continue
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(adobeDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/illustrator/i.test(entry.name)) continue
      const exePath = join(adobeDir, entry.name, 'Support Files', 'Contents', 'Windows', 'Illustrator.exe')
      const directExePath = join(adobeDir, entry.name, 'Illustrator.exe')
      const resolved = fs.existsSync(exePath) ? exePath : fs.existsSync(directExePath) ? directExePath : null
      if (!resolved) continue
      const yearMatch = entry.name.match(/(20\d{2})/)
      const versionLabel = yearMatch ? yearMatch[1] : entry.name.replace(/^Adobe\s+Illustrator\s*/i, '').trim() || undefined
      candidates.push({
        path: resolved,
        versionLabel,
        sortKey: yearMatch ? Number(yearMatch[1]) : 0
      })
    }
  }
  candidates.sort((a, b) => b.sortKey - a.sortKey)
  return candidates[0] ? { path: candidates[0].path, versionLabel: candidates[0].versionLabel } : null
}

async function isIllustratorProcessRunning(): Promise<{ running: boolean; executablePath?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq Illustrator.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 3000 }
    )
    const running = /"Illustrator\.exe"/i.test(stdout)
    return { running }
  } catch {
    return { running: false }
  }
}

function extractVersionLabel(executablePath?: string): string | undefined {
  if (!executablePath) return undefined
  const match = executablePath.match(/Adobe\s+Illustrator\s+([^\\/]+)/i)
  return match?.[1]?.trim() || undefined
}

export async function detectLocalConnector(connectorId: string): Promise<LocalConnectorDetectionResult> {
  if (connectorId !== ILLUSTRATOR_CONNECTOR_ID) {
    throw new Error(`未知的本地连接器: ${connectorId}`)
  }

  const serverConfig = mcpManager.systemMcpConfig.servers.find(isIllustratorConnector)
  const activeServer = serverConfig
    ? mcpManager.getActiveServers().find(item => item.id === serverConfig.id)
    : undefined
  const nodeStatus = await nodeRuntimeManager.getStatus()

  if (process.platform !== 'win32') {
    return {
      connectorId,
      platformSupported: false,
      installed: false,
      running: false,
      appName: 'Adobe Illustrator',
      nodeReady: nodeStatus.ready,
      nodeVersion: nodeStatus.version,
      mcpConfigured: Boolean(serverConfig),
      mcpEnabled: Boolean(serverConfig?.enabled),
      mcpConnected: activeServer?.status === 'connected',
      toolsCount: activeServer?.toolsCount || 0,
      checkedAt: Date.now()
    }
  }

  const [regResults, progIdInstalled, processInfo] = await Promise.all([
    Promise.all(REGISTRY_LOCATIONS.map(queryRegistryExecutable)),
    queryIllustratorProgIdInstalled(),
    isIllustratorProcessRunning()
  ])

  const regPath = regResults.find((p): p is string => Boolean(p))
  const fsHit = regPath ? null : findIllustratorInStandardDirs()
  const executablePath = regPath || fsHit?.path
  const versionLabel = fsHit?.versionLabel || extractVersionLabel(executablePath)
  const installed = Boolean(executablePath || progIdInstalled || processInfo.running)
  const detectionSource = executablePath
    ? (regPath ? 'registry' : 'filesystem')
    : (processInfo.running ? 'process' : progIdInstalled ? 'registry' : undefined)

  return {
    connectorId,
    platformSupported: true,
    installed,
    running: processInfo.running,
    appName: 'Adobe Illustrator',
    versionLabel,
    executablePath,
    detectionSource,
    nodeReady: nodeStatus.ready,
    nodeVersion: nodeStatus.version,
    mcpConfigured: Boolean(serverConfig),
    mcpEnabled: Boolean(serverConfig?.enabled),
    mcpConnected: activeServer?.status === 'connected',
    toolsCount: activeServer?.toolsCount || 0,
    checkedAt: Date.now()
  }
}

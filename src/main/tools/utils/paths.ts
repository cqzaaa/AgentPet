import { app } from 'electron'
import * as fs from 'fs'
import { isAbsolute, join, parse, relative, resolve } from 'path'
import type { ToolContext } from '../core/types'

export function readConfig(): any {
  try {
    const configPath = join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8')
      return JSON.parse(data)
    }
  } catch (e) {
    console.error('[PathsUtil] 读取 config.json 失败', e)
  }
  return {}
}

export function getActiveStorageDir(): string {
  const config = readConfig()
  const customStoragePath = config.storagePath || ''
  if (customStoragePath) {
    try {
      if (!fs.existsSync(customStoragePath)) {
        fs.mkdirSync(customStoragePath, { recursive: true })
      }
      return customStoragePath
    } catch (e) {
      console.error('[PathsUtil] 自定义存储路径无效，退回默认路径', e)
    }
  }
  return app.getPath('userData')
}

export function resolveLocalPath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') return filePath
  let resolved = filePath
  const normalizedAlias = resolved.trim().toLowerCase()
  const aliasMap: Record<string, string> = {
    desktop: app.getPath('desktop'),
    '桌面': app.getPath('desktop'),
    downloads: app.getPath('downloads'),
    '下载': app.getPath('downloads'),
    '下载目录': app.getPath('downloads'),
    documents: app.getPath('documents'),
    '文档': app.getPath('documents'),
    home: app.getPath('home'),
    '~': app.getPath('home')
  }
  if (aliasMap[normalizedAlias]) return aliasMap[normalizedAlias]
  if (resolved.startsWith('~/') || resolved.startsWith('~\\')) {
    return join(app.getPath('home'), resolved.slice(2))
  }
  if (resolved.startsWith('local-file:///')) {
    resolved = resolved.replace('local-file:///', '')
    if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1)
    resolved = decodeURIComponent(resolved)
  } else if (resolved.startsWith('local-file://')) {
    resolved = resolved.replace('local-file://', '')
    if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1)
    resolved = decodeURIComponent(resolved)
  } else if (resolved.startsWith('wechat-file://')) {
    const relativePath = decodeURIComponent(resolved.replace('wechat-file://', '').replace(/^\/+/, ''))
    const segments = relativePath.split('/')
    if (segments.length >= 3 && segments[0] === 'local') {
      // 新格式：wechat-file://local/<safeSessionId>/<fileName>
      const safeSessionId = segments[1]
      const fileName = segments.slice(2).join('/')
      resolved = join(getActiveStorageDir(), 'chat', safeSessionId, 'wechat_files', fileName)
    } else if (segments.length >= 2 && segments[0] === 'local') {
      // 旧格式：wechat-file://local/<fileName>
      const fileName = segments.slice(1).join('/')
      resolved = join(getActiveStorageDir(), 'wechat_files', fileName)
    }
  }
  return resolved
}

export function getGeneratedFilesDir(sessionId?: string): string {
  const base = getActiveStorageDir()
  let dir: string
  if (sessionId) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    dir = join(base, 'chat', safeSessionId, 'generated_files')
  } else {
    dir = join(base, 'generated_files')
  }
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {
      console.error('[PathsUtil] 创建 generated_files 文件夹失败', e)
    }
  }
  return dir
}

export function getSessionFilesDir(sessionId?: string): string {
  const safeSessionId = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = join(getActiveStorageDir(), 'chat', safeSessionId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Resolve a tool-provided path against the current conversation directory.
 * Explicit paths and supported aliases/URIs remain unchanged.
 */
export function resolveSessionPath(filePath: string, sessionId?: string): string {
  const localPath = resolveLocalPath(filePath)
  if (!localPath || typeof localPath !== 'string') return localPath
  if (isAbsolute(localPath) || localPath.includes(':')) return localPath
  return join(getSessionFilesDir(sessionId), localPath)
}

/** Paths the user has explicitly placed in scope for this conversation. */
export function getAllowedFileRoots(context: ToolContext): string[] {
  const roots = [getSessionFilesDir(context.sessionId), getGeneratedFilesDir(context.sessionId)]
  if (context.workspacePath && fs.existsSync(context.workspacePath)) roots.push(context.workspacePath)
  roots.push(...getLocalFileSystemRoots())
  return [...new Set(roots.map(path => resolve(path)))]
}

function getLocalFileSystemRoots(): string[] {
  if (process.platform === 'win32') {
    const roots: string[] = []
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`
      if (fs.existsSync(root)) roots.push(root)
    }
    return roots
  }

  return [parse(app.getPath('home')).root || '/']
}

export function isPathWithinRoots(targetPath: string, roots: string[]): boolean {
  const target = resolve(targetPath).toLowerCase()
  return roots.some(root => {
    const rel = relative(resolve(root).toLowerCase(), target)
    return rel === '' || (!rel.startsWith('..') && !rel.includes(':'))
  })
}

export const sessionLastXlsxMap = new Map<string, string>()


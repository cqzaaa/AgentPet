import { app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'

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

export const sessionLastXlsxMap = new Map<string, string>()


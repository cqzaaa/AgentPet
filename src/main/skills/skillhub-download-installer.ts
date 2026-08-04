import type { DownloadItem, WebContents } from 'electron'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import JSZip from 'jszip'
import { getActiveStorageDir } from '../tools/utils/paths'
import { skillRegistry } from './skill-registry'

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 150 * 1024 * 1024
const MAX_FILES = 2500

export type SkillHubInstallEvent = {
  status: 'downloading' | 'validating' | 'installed' | 'failed'
  filename: string
  receivedBytes?: number
  totalBytes?: number
  skillName?: string
  error?: string
}

function emit(target: WebContents, payload: SkillHubInstallEvent): void {
  if (!target.isDestroyed()) target.send('api:skillhub-install-event', payload)
}

function safeArchiveName(value: string): string {
  const original = basename(value || 'skill.zip')
  const stem = original.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80)
  return `${stem || `skill-${Date.now()}`}.zip`
}

function isSkillHubPageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && (host === 'skillhub.cn' || host === 'www.skillhub.cn')
  } catch {
    return false
  }
}

function safeEntryPath(filename: string): string | null {
  const normalized = filename.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return null
  return parts.join(sep)
}

async function pathExists(path: string): Promise<boolean> {
  try { await fs.promises.access(path); return true } catch { return false }
}

async function uniqueInstallPaths(skillsDir: string, archiveName: string): Promise<{ archivePath: string; folderPath: string; skillName: string }> {
  const baseName = archiveName.replace(/\.zip$/i, '')
  for (let index = 1; index <= 999; index += 1) {
    const skillName = index === 1 ? baseName : `${baseName}-${index}`
    const archivePath = join(skillsDir, `${skillName}.zip`)
    const folderPath = join(skillsDir, skillName)
    if (!(await pathExists(archivePath)) && !(await pathExists(folderPath))) return { archivePath, folderPath, skillName }
  }
  throw new Error('同名 Skill 过多，无法创建安全安装目录')
}

async function validateAndExtract(zipPath: string, stagingDir: string): Promise<void> {
  const archive = await fs.promises.readFile(zipPath)
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ZIP 包超过 50 MB 限制')
  const zip = await JSZip.loadAsync(archive, { createFolders: false })
  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error('ZIP 文件数量异常')

  let declaredSize = 0
  let hasSkillDefinition = false
  for (const entry of entries) {
    const relativePath = safeEntryPath(entry.name)
    if (!relativePath) throw new Error(`ZIP 包含不安全路径：${entry.name}`)
    if (basename(relativePath).toLowerCase() === 'skill.md') hasSkillDefinition = true
    const uncompressedSize = Number((entry as any)._data?.uncompressedSize || 0)
    declaredSize += uncompressedSize
    if (declaredSize > MAX_EXTRACTED_BYTES) throw new Error('ZIP 解压后超过 150 MB 限制')
  }
  if (!hasSkillDefinition) throw new Error('ZIP 中没有找到 SKILL.md')

  await fs.promises.mkdir(stagingDir, { recursive: true })
  let extractedSize = 0
  const stagingRoot = `${resolve(stagingDir)}${sep}`
  for (const entry of entries) {
    const relativePath = safeEntryPath(entry.name)!
    const targetPath = resolve(stagingDir, relativePath)
    if (!targetPath.startsWith(stagingRoot)) throw new Error(`ZIP 路径越界：${entry.name}`)
    if (entry.dir) {
      await fs.promises.mkdir(targetPath, { recursive: true })
      continue
    }
    const content = await entry.async('nodebuffer')
    extractedSize += content.byteLength
    if (extractedSize > MAX_EXTRACTED_BYTES) throw new Error('ZIP 解压后超过 150 MB 限制')
    await fs.promises.mkdir(dirname(targetPath), { recursive: true })
    await fs.promises.writeFile(targetPath, content, { flag: 'wx' })
  }
}

async function installArchive(downloadPath: string, archiveName: string): Promise<string> {
  const skillsDir = join(getActiveStorageDir(), 'skills')
  await fs.promises.mkdir(skillsDir, { recursive: true })
  const paths = await uniqueInstallPaths(skillsDir, archiveName)
  const stagingDir = join(skillsDir, `.installing-${randomUUID()}`)
  try {
    await validateAndExtract(downloadPath, stagingDir)
    await fs.promises.copyFile(downloadPath, paths.archivePath, fs.constants.COPYFILE_EXCL)
    await fs.promises.rename(stagingDir, paths.folderPath)
    await skillRegistry.indexArchive(`${paths.skillName}.zip`, paths.folderPath, { type: 'skillhub' })
    return paths.skillName
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.promises.rm(paths.folderPath, { recursive: true, force: true }).catch(() => undefined)
    await fs.promises.rm(paths.archivePath, { force: true }).catch(() => undefined)
    await skillRegistry.removeIndex(paths.skillName).catch(() => undefined)
    throw error
  }
}

export function handleSkillHubDownload(item: DownloadItem, target: WebContents, source: WebContents): void {
  const sourceFilename = item.getFilename()
  const archiveName = safeArchiveName(sourceFilename)
  if (!isSkillHubPageUrl(source.getURL())) {
    item.cancel()
    emit(target, { status: 'failed', filename: archiveName, error: '下载请求不是由内嵌 SkillHub 页面发起' })
    return
  }

  const advertisedSize = item.getTotalBytes()
  if (advertisedSize > MAX_ARCHIVE_BYTES) {
    item.cancel()
    emit(target, { status: 'failed', filename: archiveName, error: 'ZIP 包超过 50 MB 限制' })
    return
  }

  const tempDir = fs.mkdtempSync(join(app.getPath('temp'), 'agentpet-skillhub-'))
  const downloadPath = join(tempDir, archiveName)
  item.setSavePath(downloadPath)
  emit(target, { status: 'downloading', filename: archiveName, receivedBytes: 0, totalBytes: advertisedSize })

  item.on('updated', (_event, state) => {
    if (state === 'interrupted') return
    const receivedBytes = item.getReceivedBytes()
    if (receivedBytes > MAX_ARCHIVE_BYTES) {
      item.cancel()
      return
    }
    emit(target, { status: 'downloading', filename: archiveName, receivedBytes, totalBytes: item.getTotalBytes() })
  })

  item.once('done', (_event, state) => {
    void (async () => {
      try {
        if (state !== 'completed') throw new Error(state === 'cancelled' ? '下载已取消或文件超过限制' : 'ZIP 下载失败')
        emit(target, { status: 'validating', filename: archiveName })
        const skillName = await installArchive(downloadPath, archiveName)
        emit(target, { status: 'installed', filename: archiveName, skillName })
      } catch (error: any) {
        emit(target, { status: 'failed', filename: archiveName, error: error?.message || String(error) })
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    })()
  })
}

import { app } from 'electron'
import * as fs from 'fs'
import { dirname, join, relative, resolve } from 'path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import JSZip from 'jszip'

const PPT_MASTER_REF = 'main'
const PPT_MASTER_RELEASE_VERSION = 'v2.8.0'
const PPT_MASTER_CACHE_VERSION = 'gitcode-main'
const PPT_MASTER_ARCHIVE_URL = `https://github.com/hugohe3/ppt-master/releases/download/${PPT_MASTER_RELEASE_VERSION}/ppt-master-skill-${PPT_MASTER_RELEASE_VERSION}.zip`
const PPT_MASTER_GITCODE_URL = 'https://gitcode.com/hugohe3/ppt-master.git'
const PPT_MASTER_CODELOAD_URL = `https://codeload.github.com/hugohe3/ppt-master/zip/refs/tags/${PPT_MASTER_RELEASE_VERSION}`
let pptMasterInstallPromise: Promise<string> | null = null

export type ManagedPptMasterPreparation = {
  operationId: 'ppt-master-install'
  status: 'installed' | 'preparing' | 'failed'
  root: string
  startedAt?: string
  error?: string
}

let pptMasterPreparation: ManagedPptMasterPreparation | null = null

export function getManagedSkillRoot(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '')
  const version = safeName === 'ppt-master' ? PPT_MASTER_CACHE_VERSION : 'current'
  return join(app.getPath('userData'), 'managed-skills', safeName, version)
}

function isValidPptMasterInstall(root: string): boolean {
  const requiredFiles = [
    'SKILL.md',
    'requirements.txt',
    'LICENSE',
    join('scripts', 'attribution_guard.py')
  ]
  return requiredFiles.every(path => fs.existsSync(join(root, path)))
}

async function downloadArchive(source: string): Promise<JSZip> {
  const failures: string[] = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3 * 60 * 1000)
    try {
      const response = await fetch(source, { redirect: 'follow', signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await JSZip.loadAsync(await response.arrayBuffer())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`第 ${attempt} 次：${message}`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`${new URL(source).hostname} 下载失败：${failures.join('；')}`)
}

async function extractSkillArchive(archive: JSZip, targetRoot: string): Promise<void> {
  const skillMdCandidates = Object.keys(archive.files)
    .filter(name => /(^|\/)SKILL\.md$/i.test(name) && !archive.files[name].dir)
    .sort((a, b) => a.length - b.length)
  if (skillMdCandidates.length === 0) throw new Error('PPT Master 下载包缺少 SKILL.md')

  const archiveRoot = dirname(skillMdCandidates[0]).replace(/\\/g, '/')
  const prefix = archiveRoot === '.' ? '' : `${archiveRoot}/`
  const resolvedTargetRoot = resolve(targetRoot)
  for (const [entryName, entry] of Object.entries(archive.files)) {
    if (entry.dir || !entryName.startsWith(prefix)) continue
    const relativePath = entryName.slice(prefix.length).replace(/\//g, '\\')
    if (!relativePath) continue
    const outputPath = resolve(targetRoot, relativePath)
    const pathFromRoot = relative(resolvedTargetRoot, outputPath)
    if (pathFromRoot.startsWith('..') || pathFromRoot.includes(':')) {
      throw new Error(`PPT Master 下载包包含不安全路径：${entryName}`)
    }
    await fs.promises.mkdir(dirname(outputPath), { recursive: true })
    await fs.promises.writeFile(outputPath, await entry.async('nodebuffer'))
  }
}

async function cloneSkillFromGitCode(targetRoot: string): Promise<void> {
  const repositoryRoot = `${targetRoot}.gitcode-repository`
  await fs.promises.rm(repositoryRoot, { recursive: true, force: true })
  try {
    await git.clone({
      fs,
      http,
      dir: repositoryRoot,
      url: PPT_MASTER_GITCODE_URL,
      ref: PPT_MASTER_REF,
      singleBranch: true,
      depth: 1
    })
    const skillRoot = join(repositoryRoot, 'skills', 'ppt-master')
    if (!fs.existsSync(skillRoot)) throw new Error('GitCode 仓库缺少 skills/ppt-master')
    await fs.promises.cp(skillRoot, targetRoot, { recursive: true })
    if (!fs.existsSync(join(targetRoot, 'LICENSE')) && fs.existsSync(join(repositoryRoot, 'LICENSE'))) {
      await fs.promises.copyFile(join(repositoryRoot, 'LICENSE'), join(targetRoot, 'LICENSE'))
    }
  } finally {
    await fs.promises.rm(repositoryRoot, { recursive: true, force: true })
  }
}

async function populatePptMaster(targetRoot: string): Promise<string> {
  const failures: string[] = []
  try {
    await cloneSkillFromGitCode(targetRoot)
    return PPT_MASTER_GITCODE_URL
  } catch (error) {
    failures.push(`GitCode：${error instanceof Error ? error.message : String(error)}`)
  }

  await fs.promises.rm(targetRoot, { recursive: true, force: true })
  await fs.promises.mkdir(targetRoot, { recursive: true })
  try {
    await extractSkillArchive(await downloadArchive(PPT_MASTER_ARCHIVE_URL), targetRoot)
    return PPT_MASTER_ARCHIVE_URL
  } catch (error) {
    failures.push(`GitHub Release：${error instanceof Error ? error.message : String(error)}`)
  }

  await fs.promises.rm(targetRoot, { recursive: true, force: true })
  await fs.promises.mkdir(targetRoot, { recursive: true })
  try {
    await extractSkillArchive(await downloadArchive(PPT_MASTER_CODELOAD_URL), targetRoot)
    return PPT_MASTER_CODELOAD_URL
  } catch (error) {
    failures.push(`GitHub codeload：${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`所有 PPT Master 下载源均失败：${failures.join('；')}`)
}

async function installPptMaster(): Promise<string> {
  const root = getManagedSkillRoot('ppt-master')
  if (await isValidPptMasterInstall(root)) return root

  const partialRoot = `${root}.partial`
  await fs.promises.rm(partialRoot, { recursive: true, force: true })
  await fs.promises.mkdir(partialRoot, { recursive: true })

  try {
    const source = await populatePptMaster(partialRoot)
    if (!(await isValidPptMasterInstall(partialRoot))) {
      throw new Error('PPT Master 下载包不完整')
    }
    await fs.promises.mkdir(dirname(root), { recursive: true })
    await fs.promises.rm(root, { recursive: true, force: true })
    await fs.promises.rename(partialRoot, root)
    await fs.promises.writeFile(
      join(root, '.agentpet-install.json'),
      JSON.stringify({ version: PPT_MASTER_CACHE_VERSION, ref: PPT_MASTER_REF, source, installedAt: new Date().toISOString() }, null, 2),
      'utf8'
    )
    return root
  } catch (error) {
    await fs.promises.rm(partialRoot, { recursive: true, force: true })
    throw error
  }
}

export async function ensureManagedPptMaster(): Promise<string> {
  const preparation = startManagedPptMasterPreparation()
  if (preparation.status === 'installed') return preparation.root
  const installPromise = pptMasterInstallPromise
  if (!installPromise) {
    throw new Error(preparation.error || 'PPT Master installation did not start')
  }
  return await installPromise
}

export function getManagedPptMasterPreparation(): ManagedPptMasterPreparation {
  const root = getManagedSkillRoot('ppt-master')
  if (isValidPptMasterInstall(root)) {
    pptMasterPreparation = {
      operationId: 'ppt-master-install',
      status: 'installed',
      root
    }
  }
  return pptMasterPreparation || {
    operationId: 'ppt-master-install',
    status: 'failed',
    root,
    error: 'PPT Master has not been prepared'
  }
}

export function startManagedPptMasterPreparation(): ManagedPptMasterPreparation {
  const root = getManagedSkillRoot('ppt-master')
  if (isValidPptMasterInstall(root)) {
    pptMasterPreparation = {
      operationId: 'ppt-master-install',
      status: 'installed',
      root
    }
    return pptMasterPreparation
  }

  if (!pptMasterInstallPromise) {
    const startedAt = new Date().toISOString()
    pptMasterPreparation = {
      operationId: 'ppt-master-install',
      status: 'preparing',
      root,
      startedAt
    }
    const installPromise = installPptMaster()
    pptMasterInstallPromise = installPromise
    void installPromise.then(installedRoot => {
      pptMasterPreparation = {
        operationId: 'ppt-master-install',
        status: 'installed',
        root: installedRoot,
        startedAt
      }
    }, error => {
      pptMasterPreparation = {
        operationId: 'ppt-master-install',
        status: 'failed',
        root,
        startedAt,
        error: error instanceof Error ? error.message : String(error)
      }
    }).finally(() => {
      if (pptMasterInstallPromise === installPromise) pptMasterInstallPromise = null
    })
  }
  return getManagedPptMasterPreparation()
}

export async function waitForManagedPptMasterPreparation(options: {
  timeoutMs: number
  abortSignal?: AbortSignal
}): Promise<ManagedPptMasterPreparation> {
  const preparation = startManagedPptMasterPreparation()
  if (preparation.status === 'installed') return preparation

  const installPromise = pptMasterInstallPromise
  if (!installPromise) return getManagedPptMasterPreparation()

  let timer: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined
  const waiters: Promise<unknown>[] = [installPromise]
  if (options.timeoutMs > 0) {
    waiters.push(new Promise(resolve => {
      timer = setTimeout(resolve, options.timeoutMs)
    }))
  }
  if (options.abortSignal) {
    waiters.push(new Promise((_, reject) => {
      abortHandler = () => reject(new Error('UserAborted'))
      options.abortSignal!.addEventListener('abort', abortHandler!, { once: true })
      if (options.abortSignal!.aborted) abortHandler()
    }))
  }

  try {
    await Promise.race(waiters)
  } catch (error) {
    if (error instanceof Error && error.message === 'UserAborted') throw error
    return getManagedPptMasterPreparation()
  } finally {
    if (timer) clearTimeout(timer)
    if (abortHandler && options.abortSignal) {
      options.abortSignal.removeEventListener('abort', abortHandler)
    }
  }
  return getManagedPptMasterPreparation()
}

import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import type { RpaTaskFlow, RpaTaskManifest } from './domain/types'

export type { RpaTaskFlow, RpaTaskManifest } from './domain/types'

const getRpaDir = (): string => {
  return join(app.getPath('userData'), 'rpa')
}

const getTasksDir = (): string => {
  return join(getRpaDir(), 'tasks')
}

// 确保目录存在
const ensureDirs = (): void => {
  const rpaDir = getRpaDir()
  const tasksDir = getTasksDir()
  if (!fs.existsSync(rpaDir)) {
    fs.mkdirSync(rpaDir, { recursive: true })
  }
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true })
  }
}

/**
 * 加载任务列表索引清单
 */
export async function loadManifest(): Promise<RpaTaskManifest[]> {
  ensureDirs()
  const filePath = join(getRpaDir(), 'manifest.json')
  if (!fs.existsSync(filePath)) {
    return []
  }
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    return JSON.parse(content) as RpaTaskManifest[]
  } catch (error) {
    console.error('Failed to load RPA manifest:', error)
    return []
  }
}

/**
 * 保存任务列表索引清单
 */
export async function saveManifest(manifest: RpaTaskManifest[]): Promise<boolean> {
  ensureDirs()
  const filePath = join(getRpaDir(), 'manifest.json')
  try {
    await fs.promises.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('Failed to save RPA manifest:', error)
    return false
  }
}

/**
 * 加载单个任务的流程图数据
 */
export async function loadTaskFlow(taskId: string): Promise<RpaTaskFlow | null> {
  ensureDirs()
  const filePath = join(getTasksDir(), `task_${taskId}.json`)
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    return JSON.parse(content) as RpaTaskFlow
  } catch (error) {
    console.error(`Failed to load RPA task flow for ${taskId}:`, error)
    return null
  }
}

/**
 * 保存单个任务的流程图数据
 */
export async function saveTaskFlow(taskId: string, flowData: RpaTaskFlow): Promise<boolean> {
  ensureDirs()
  const filePath = join(getTasksDir(), `task_${taskId}.json`)
  try {
    await fs.promises.writeFile(filePath, JSON.stringify(flowData, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error(`Failed to save RPA task flow for ${taskId}:`, error)
    return false
  }
}

/**
 * 删除单个任务及其流程图数据
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  ensureDirs()
  
  // 1. 删除具体的流程图 JSON 文件
  const taskFilePath = join(getTasksDir(), `task_${taskId}.json`)
  if (fs.existsSync(taskFilePath)) {
    try {
      await fs.promises.unlink(taskFilePath)
    } catch (error) {
      console.error(`Failed to delete task file ${taskFilePath}:`, error)
    }
  }

  // 2. 从 manifest 索引中移除
  const manifest = await loadManifest()
  const updatedManifest = manifest.filter(t => t.id !== taskId)
  await saveManifest(updatedManifest)
  return true
}

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..', '..')
const queueRoot = path.join(projectRoot, '.agent-handoff')
const instruction = process.argv.slice(2).join(' ').trim()

if (!instruction) {
  console.error('用法: npm run handoff:submit -- "需要执行的任务"')
  process.exit(1)
}

const id = `task-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
const stagingDir = path.join(queueRoot, 'staging', id)
const incomingDir = path.join(queueRoot, 'incoming', id)
const manifest = {
  version: 1,
  id,
  createdAt: new Date().toISOString(),
  workspace: projectRoot,
  instruction,
  inputs: [],
  acceptance: []
}

await mkdir(stagingDir, { recursive: true })
await mkdir(path.dirname(incomingDir), { recursive: true })
await writeFile(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(path.join(stagingDir, 'task.md'), `# 任务\n\n${instruction}\n`, 'utf8')
await rename(stagingDir, incomingDir)

console.log(`任务已提交: ${id}`)
console.log(incomingDir)

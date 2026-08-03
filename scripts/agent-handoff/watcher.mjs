import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..', '..')
const configPath = path.join(import.meta.dirname, 'handoff.config.json')
const once = process.argv.includes('--once')
const dryRun = process.argv.includes('--dry-run')
let stopping = false

const config = JSON.parse(await readFile(configPath, 'utf8'))
const queueRoot = path.resolve(projectRoot, config.queueRoot)
const queueDirs = {
  incoming: path.join(queueRoot, 'incoming'),
  running: path.join(queueRoot, 'running'),
  completed: path.join(queueRoot, 'completed'),
  failed: path.join(queueRoot, 'failed')
}
const allowedWorkspaces = config.allowedWorkspaces.map((entry) => path.resolve(projectRoot, entry))

for (const directory of Object.values(queueDirs)) {
  await mkdir(directory, { recursive: true })
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveWorkspace(value) {
  const workspace = path.resolve(projectRoot, value || '.')
  if (!allowedWorkspaces.some((allowed) => isInside(allowed, workspace))) {
    throw new Error(`workspace 不在允许范围内: ${workspace}`)
  }
  return workspace
}

function replaceTokens(value, context) {
  return value.replace(/\{(workspace|taskDir|outputFile)\}/g, (_, key) => context[key])
}

async function buildPrompt(taskDir, manifest, workspace) {
  const sections = [
    '你正在处理一个由外部 Agent 提交的自动化交接任务。',
    `任务 ID: ${manifest.id}`,
    `工作目录: ${workspace}`,
    `任务要求:\n${manifest.instruction}`
  ]

  const taskFile = path.join(taskDir, 'task.md')
  try {
    sections.push(`task.md:\n${await readFile(taskFile, 'utf8')}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (Array.isArray(manifest.inputs) && manifest.inputs.length > 0) {
    const inputDescriptions = []
    for (const input of manifest.inputs) {
      if (typeof input !== 'string' || path.isAbsolute(input) || input.includes('..')) {
        throw new Error(`非法输入文件路径: ${String(input)}`)
      }
      const inputPath = path.resolve(taskDir, input)
      if (!isInside(taskDir, inputPath)) throw new Error(`输入文件越界: ${input}`)
      await access(inputPath)
      inputDescriptions.push(`- ${inputPath}`)
    }
    sections.push(`输入文件（请按需读取）:\n${inputDescriptions.join('\n')}`)
  }

  if (Array.isArray(manifest.acceptance) && manifest.acceptance.length > 0) {
    sections.push(`验收条件:\n${manifest.acceptance.map((item) => `- ${item}`).join('\n')}`)
  }

  sections.push('仅在上述工作目录内操作。完成后总结修改文件、验证结果和仍存在的风险。')
  return `${sections.join('\n\n')}\n`
}

async function runCommand(taskDir, workspace, prompt) {
  const outputFile = path.join(taskDir, 'output.md')
  const context = { workspace, taskDir, outputFile }
  const command = process.env.HANDOFF_RUNNER_COMMAND || config.runner.command
  const configuredArgs = process.env.HANDOFF_RUNNER_ARGS_JSON
    ? JSON.parse(process.env.HANDOFF_RUNNER_ARGS_JSON)
    : config.runner.args
  const args = configuredArgs.map((arg) => replaceTokens(arg, context))

  if (dryRun) {
    await writeFile(outputFile, `# Dry run\n\n执行器: ${command}\n\n参数:\n${args.map((arg) => `- ${arg}`).join('\n')}\n\n## Prompt\n\n${prompt}`, 'utf8')
    return { exitCode: 0, signal: null, timedOut: false, command, args }
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, config.timeoutMs)

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', async (exitCode, signal) => {
      clearTimeout(timer)
      await writeFile(path.join(taskDir, 'runner.stdout.log'), Buffer.concat(stdout))
      await writeFile(path.join(taskDir, 'runner.stderr.log'), Buffer.concat(stderr))
      resolve({ exitCode, signal, timedOut, command, args })
    })
    child.stdin.end(prompt)
  })
}

async function writeResult(taskDir, result) {
  const target = path.join(taskDir, 'result.json')
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

async function moveTask(source, destinationRoot, id) {
  let destination = path.join(destinationRoot, id)
  try {
    await access(destination)
    destination = path.join(destinationRoot, `${id}-${Date.now()}`)
  } catch {}
  await rename(source, destination)
  return destination
}

async function processOneTask() {
  const entries = (await readdir(queueDirs.incoming, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    const incomingPath = path.join(queueDirs.incoming, entry.name)
    const runningPath = path.join(queueDirs.running, entry.name)
    try {
      await rename(incomingPath, runningPath)
    } catch {
      continue
    }

    const startedAt = new Date().toISOString()
    try {
      const manifest = JSON.parse(await readFile(path.join(runningPath, 'manifest.json'), 'utf8'))
      if (manifest.version !== 1 || manifest.id !== entry.name || typeof manifest.instruction !== 'string' || !manifest.instruction.trim()) {
        throw new Error('manifest.json 格式无效，或目录名与任务 ID 不一致')
      }
      const workspace = resolveWorkspace(manifest.workspace)
      const prompt = await buildPrompt(runningPath, manifest, workspace)
      const execution = await runCommand(runningPath, workspace, prompt)
      const succeeded = execution.exitCode === 0 && !execution.timedOut
      const result = {
        version: 1,
        id: manifest.id,
        status: succeeded ? 'completed' : 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        execution
      }
      await writeResult(runningPath, result)
      const finalPath = await moveTask(runningPath, succeeded ? queueDirs.completed : queueDirs.failed, manifest.id)
      console.log(`[${result.status}] ${manifest.id} -> ${finalPath}`)
    } catch (error) {
      const result = {
        version: 1,
        id: entry.name,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      }
      await writeResult(runningPath, result).catch(() => {})
      const finalPath = await moveTask(runningPath, queueDirs.failed, entry.name)
      console.error(`[failed] ${entry.name}: ${result.error} -> ${finalPath}`)
    }
    return true
  }
  return false
}

process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})

console.log(`Agent handoff watcher 已启动: ${queueRoot}`)
console.log(dryRun ? '当前为 dry-run，不会调用执行器。' : `执行器: ${config.runner.command}`)

do {
  const processed = await processOneTask()
  if (once) break
  if (!processed) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs))
} while (!stopping)

console.log('Agent handoff watcher 已停止。')

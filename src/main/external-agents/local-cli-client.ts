import readline from 'node:readline'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { ExternalAgentDefinition, ExternalAgentProtocolEvent, ExternalAgentProbeResult, ExternalAgentRunResult } from './types'
import { classifyAgentError, killProcessTree, resolveExecutable, spawnAgentProcess } from './process-utils'

const OUTPUT_LIMIT = 32_768
const PROMPT_TIMEOUT_MS = 30 * 60_000

function collectEditedFile(toolName: unknown, parameters: any, cwd: string, artifacts: Set<string>): void {
  if (!/(?:^|[_-])(?:write|edit|replace|patch|create)(?:$|[_-])|(?:multi|notebook).?edit|(?:write|edit|replace|patch|create).*(?:file|content)/i.test(String(toolName || ''))) return
  const candidate = parameters?.TargetFile || parameters?.target_file || parameters?.file_path || parameters?.filePath || parameters?.path
  if (typeof candidate !== 'string' || !candidate.trim()) return
  artifacts.add(path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate))
}

async function captureVersion(definition: ExternalAgentDefinition, cwd: string): Promise<{ version: string; resolved: string }> {
  const resolved = await resolveExecutable(definition.executable, definition.executableAliases)
  if (!resolved) throw new Error(`未找到 ${definition.executable}，请先安装并加入 PATH，或在自定义 Agent 中填写完整路径`)
  const child = spawnAgentProcess(resolved, ['--version'], { cwd, env: definition.env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-OUTPUT_LIMIT) })
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-OUTPUT_LIMIT) })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { void killProcessTree(child); reject(new Error(`${definition.name} 版本检测超时`)) }, 15_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  if (code !== 0) throw new Error(stderr.trim() || `${definition.executable} --version 退出码 ${code}`)
  return { version: stdout.trim() || stderr.trim() || '已安装', resolved }
}

async function checkClaudeAuth(definition: ExternalAgentDefinition, cwd: string, resolved: string): Promise<void> {
  const child = spawnAgentProcess(resolved, ['auth', 'status'], { cwd, env: definition.env })
  let output = ''
  child.stdout.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT) })
  child.stderr.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT) })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { void killProcessTree(child); reject(new Error('Claude Code 登录状态检测超时')) }, 15_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  let loggedIn = false
  try { loggedIn = JSON.parse(output).loggedIn === true } catch { loggedIn = /logged.?in\D+true/i.test(output) }
  if (code !== 0 || !loggedIn) throw new Error('Claude Code 尚未登录，请先运行 claude auth login')
}

export class LocalCliAgentClient {
  public async isInstalled(definition: ExternalAgentDefinition): Promise<boolean> {
    return Boolean(await resolveExecutable(definition.executable, definition.executableAliases))
  }

  public async probe(definition: ExternalAgentDefinition, cwd: string): Promise<ExternalAgentProbeResult> {
    const startedAt = Date.now()
    try {
      const result = await captureVersion(definition, cwd)
      if (definition.protocol === 'claude-stream-json') await checkClaudeAuth(definition, cwd, result.resolved)
      if (definition.protocol === 'antigravity-json') await this.listAntigravityModels(definition, cwd)
      return {
        agentId: definition.id,
        status: 'ready',
        installed: true,
        agentInfo: { name: definition.name, version: result.version },
        capabilities: { execution: 'automated', outputFormat: definition.protocol === 'antigravity-json' ? 'json' : 'stream-json', resolvedExecutable: result.resolved },
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now()
      }
    } catch (error) {
      const missing = !await this.isInstalled(definition)
      return {
        agentId: definition.id,
        status: missing ? 'missing' : classifyAgentError(error),
        installed: !missing,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  public async runClaude(
    definition: ExternalAgentDefinition,
    cwd: string,
    prompt: string,
    onUpdate?: (update: unknown) => void,
    model?: string
  ): Promise<ExternalAgentRunResult> {
    const resolved = await resolveExecutable(definition.executable, definition.executableAliases)
    if (!resolved) throw new Error('未找到 Claude Code CLI')
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'acceptEdits'
    ]
    if (model && model !== 'default') args.push('--model', model)
    const child = spawnAgentProcess(resolved, args, { cwd, env: definition.env })
    child.stdin.end(prompt)
    let stderr = ''
    let resultText = ''
    let streamedText = ''
    let sessionId = ''
    const artifactPaths = new Set<string>()
    child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-OUTPUT_LIMIT) })
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as any
        onUpdate?.(event)
        if (typeof event.session_id === 'string') sessionId = event.session_id
        if (event.type === 'result' && typeof event.result === 'string') resultText = event.result
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          event.message.content.forEach((block: any) => {
            if (block?.type === 'tool_use') collectEditedFile(block.name, block.input, cwd, artifactPaths)
          })
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && typeof event.event.delta?.text === 'string') {
          streamedText += event.event.delta.text
        }
      } catch {
        onUpdate?.({ type: 'raw_output', text: line })
      }
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        void killProcessTree(child)
        reject(new Error('Claude Code 任务执行超时'))
      }, PROMPT_TIMEOUT_MS)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', value => { clearTimeout(timer); resolve(value) })
    })
    if (code !== 0) throw new Error(stderr.trim() || `Claude Code 退出码 ${code}`)
    return {
      agentId: definition.id,
      sessionId: sessionId || `claude-${Date.now()}`,
      text: resultText || streamedText,
      stopReason: 'completed',
      artifactPaths: [...artifactPaths]
    }
  }

  public async listAntigravityModels(definition: ExternalAgentDefinition, cwd: string): Promise<Array<{ id: string; name: string; source: 'cli' }>> {
    const resolved = await resolveExecutable(definition.executable, definition.executableAliases)
    if (!resolved) throw new Error('未找到 agy CLI')
    const child = spawnAgentProcess(resolved, ['models'], { cwd, env: definition.env })
    let output = ''
    child.stdout.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT) })
    child.stderr.on('data', chunk => { output = `${output}\n${String(chunk)}`.slice(-OUTPUT_LIMIT) })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { void killProcessTree(child); reject(new Error('Antigravity CLI 模型检测超时')) }, 30_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', value => { clearTimeout(timer); resolve(value) })
    })
    if (code !== 0 || /please sign in|not logged|login/i.test(output)) throw new Error(output.trim() || `agy models 退出码 ${code}`)
    return output.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/fetching available models/i.test(line))
      .map(line => {
        const id = line.split(/\s{2,}|\t/)[0].replace(/^[-*]\s*/, '').trim()
        return { id, name: line.replace(/^[-*]\s*/, ''), source: 'cli' as const }
      }).filter(model => model.id)
  }

  public async runAntigravity(
    definition: ExternalAgentDefinition,
    cwd: string,
    prompt: string,
    onUpdate?: (update: unknown) => void,
    model?: string,
    onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void
  ): Promise<ExternalAgentRunResult> {
    const resolved = await resolveExecutable(definition.executable, definition.executableAliases)
    if (!resolved) throw new Error('未找到 agy CLI')
    // agy otherwise falls back to its global scratch workspace even when the
    // child process cwd points at the user's project. Register cwd as the
    // project for every one-shot collaboration run so file tools edit the
    // selected working directory.
    const args = ['--new-project', '--output-format', 'stream-json', '--mode', 'accept-edits', '--dangerously-skip-permissions', '--print-timeout', '30m']
    if (definition.args && definition.args.length > 0) {
      for (const arg of definition.args) {
        if (!args.includes(arg)) args.push(arg)
      }
    }
    if (model && model !== 'default') args.push('--model', model)
    const executionPrompt = `${prompt}\n\n[AgentPet 协作执行要求]\n- 只修改当前工作区内完成任务所必需的源码文件。\n- 不要额外创建计划、分析或交付说明文档；将说明写在最终回复中。\n- 即使某个检查工具无法获得权限或执行失败，也必须在结束前返回最终正文，明确已完成内容、修改文件和未完成检查。`
    args.push(`--print=${executionPrompt}`)
    const child = spawnAgentProcess(resolved, args, { cwd, env: definition.env })
    const launchPayload = { executable: resolved, args, cwd, inputFormat: 'command-line argument', outputFormat: 'stream-json' }
    onProtocolEvent?.({
      protocol: 'antigravity-json',
      direction: 'client_to_agent',
      messageType: 'request',
      method: 'agy/print',
      byteLength: Buffer.byteLength(JSON.stringify(launchPayload)),
      payload: launchPayload
    })
    let stdout = ''
    let stderr = ''
    let finalResult: any
    const completedTools: string[] = []
    const failedTools: Array<{ name: string; message: string }> = []
    const artifactPaths = new Set<string>()
    let completedAgentTurns = 0
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (!line.trim()) return
      stdout = `${stdout}${line}\n`.slice(-OUTPUT_LIMIT)
      try {
        const event = JSON.parse(line)
        const isResult = event?.event === 'result'
        onProtocolEvent?.({
          protocol: 'antigravity-json',
          direction: 'agent_to_client',
          messageType: isResult ? 'response' : 'notification',
          method: isResult ? 'agy/result' : String(event?.event || event?.step_update?.step_type || 'agy/event'),
          byteLength: Buffer.byteLength(line),
          payload: event
        })
        onUpdate?.(event)
        const update = event?.step_update
        if (update?.step_type === 'agent_response' && update?.state === 'DONE') completedAgentTurns += 1
        if (update?.step_type === 'tool' && update?.state === 'DONE' && update?.tool_name) {
          completedTools.push(String(update.tool_name))
          collectEditedFile(update.tool_name, update?.tool_info?.parameters, cwd, artifactPaths)
        }
        if (update?.step_type === 'tool' && update?.state === 'ERROR') {
          failedTools.push({
            name: String(update?.tool_name || update?.tool_info?.name || 'tool'),
            message: String(update?.tool_info?.error?.message || '执行失败')
          })
        }
        if (event?.event === 'result') finalResult = event.result
      } catch {
        onProtocolEvent?.({
          protocol: 'antigravity-json',
          direction: 'agent_to_client',
          messageType: 'invalid',
          method: 'agy/stdout',
          byteLength: Buffer.byteLength(line),
          payload: { raw: line }
        })
        onUpdate?.({ event: 'raw_output', text: line })
      }
    })
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderr = `${stderr}${text}`.slice(-OUTPUT_LIMIT)
      onProtocolEvent?.({
        protocol: 'antigravity-json',
        direction: 'agent_to_client',
        messageType: 'notification',
        method: 'agy/stderr',
        byteLength: Buffer.byteLength(text),
        payload: { text }
      })
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { void killProcessTree(child); reject(new Error('Antigravity CLI 任务执行超时')) }, PROMPT_TIMEOUT_MS)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', value => { clearTimeout(timer); resolve(value) })
    })
    onProtocolEvent?.({
      protocol: 'antigravity-json',
      direction: 'agent_to_client',
      messageType: 'notification',
      method: 'process/exit',
      byteLength: 0,
      payload: { exitCode: code }
    })
    let result: any = finalResult
    if (!result) {
      try {
        const parsed = JSON.parse(stdout.trim())
        result = parsed?.event === 'result' ? parsed.result : parsed
      } catch { result = null }
    }
    const processError = String(result?.error || stderr.trim() || (code !== 0 ? `agy 退出码 ${code}` : '')).trim()
    const response = String(result?.response || '').trim()
    const toolNames = [...new Set(completedTools)]
    const existingArtifactPaths = [...artifactPaths].filter(artifactPath => existsSync(artifactPath))
    const diagnostics = [
      completedAgentTurns ? `Agent 响应轮次 ${completedAgentTurns}` : '',
      toolNames.length ? `已完成工具：${toolNames.join('、')}` : '',
      failedTools.length ? `失败工具：${failedTools.map(item => `${item.name}（${item.message}）`).join('；')}` : '',
      processError ? `CLI 警告：${processError}` : ''
    ].filter(Boolean).join('；')
    const hasTerminalError = code !== 0 || result?.status === 'ERROR'

    // Antigravity may finish workspace edits and then fail while producing its final
    // response (for example a denied verification command or a profile-picture TLS
    // request). Keep the verified on-disk edits as a usable checkpoint so one
    // non-essential tail error does not block every dependent DAG node.
    if (existingArtifactPaths.length > 0 && (!response || hasTerminalError)) {
      const fileList = existingArtifactPaths.map(artifactPath => `- ${artifactPath}`).join('\n')
      return {
        agentId: definition.id,
        sessionId: String(result?.conversation_id || `antigravity-${Date.now()}`),
        text: `Antigravity 已完成工作区文件修改，但 CLI 未能返回完整的最终说明。后续节点应基于实际文件继续检查和集成。\n\n已修改文件：\n${fileList}${diagnostics ? `\n\n执行警告：${diagnostics}` : ''}`,
        stopReason: 'completed_with_warnings',
        artifactPaths: existingArtifactPaths
      }
    }

    if (hasTerminalError) throw new Error(processError || `agy 退出码 ${code}`)
    if (!response) {
      throw new Error(`Antigravity CLI 未返回最终正文，节点不能标记为完成${diagnostics ? `（${diagnostics}）` : ''}`)
    }
    return {
      agentId: definition.id,
      sessionId: String(result?.conversation_id || `antigravity-${Date.now()}`),
      text: response,
      stopReason: String(result?.status || 'completed').toLowerCase(),
      artifactPaths: existingArtifactPaths
    }
  }

}

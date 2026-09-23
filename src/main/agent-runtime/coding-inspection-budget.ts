import { resolve, normalize } from 'path'

type InspectionResult = {
  toolName: string
  toolArgs: unknown
  toolSuccess: boolean
  inspection: boolean
  mutation: boolean
  toolState?: any
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

// Count model round trips, not individual tools: independent reads in one
// response should not exhaust the budget. This advises, never denies a read.
export class CodingInspectionBudget {
  private rounds = 0
  private nextReminder = 3
  private seen = new Set<string>()

  constructor(private workspacePath = process.cwd()) {}

  private normalizeArgs(value: unknown, key = ''): unknown {
    if (typeof value === 'string' && ['file_path', 'scope', 'directory_path', 'path'].includes(key)) {
      const path = normalize(resolve(this.workspacePath, value))
      return process.platform === 'win32' ? path.toLowerCase() : path
    }
    if (Array.isArray(value)) return value.map(item => this.normalizeArgs(item))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'question')
        .map(([name, item]) => [name, this.normalizeArgs(item, name)]))
    }
    return value
  }

  observe(results: InspectionResult[]): string | undefined {
    let inspected = false
    let repeated = false
    for (const result of results) {
      if (!result.toolSuccess) continue
      if (result.mutation) {
        this.rounds = 0
        this.nextReminder = 3
        // Versioned file reads survive unrelated edits. Unversioned searches do not.
        for (const key of this.seen) if (!key.startsWith('read_file:versioned:')) this.seen.delete(key)
        inspected = false
        repeated = false
      } else if (result.inspection) {
        inspected = true
        const evidence = result.toolState?.readEvidence
        const args = evidence ? { path: evidence.path, version: evidence.version, ranges: evidence.ranges } : result.toolArgs
        const key = `${result.toolName}:${evidence ? 'versioned:' : ''}${stableKey(this.normalizeArgs(args))}`
        repeated ||= evidence
          ? evidence.unchanged && !evidence.truncated && (evidence.overlap > 0 || this.seen.has(key))
          : this.seen.has(key)
        this.seen.add(key)
        if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
      }
    }
    if (!inspected) return
    this.rounds++
    if (!repeated && this.rounds < this.nextReminder) return
    this.nextReminder = this.rounds + 3
    return `[Coding 检索提示] 自上次成功修改以来已进行 ${this.rounds} 轮检索。` +
      (repeated ? '检测到重复查询或已读区间重叠；若文件版本未变且上次结果完整，请直接复用已有证据。' : '') +
      '若修改位置、相关约束和验证方式已明确，请进入修改；诊断/审查任务可直接给出结论。' +
      '仍需检索时，先明确尚未解决的具体问题；独立搜索用 grep_content 的 queries 批量提交，默认返回匹配上下文；同文件用 line_ranges 合并未读区间。' +
      '不要重复扫描目录、把同一文件拆成多次微小读取，或仅为减少检索次数而草率修改。必要的进一步调查仍然允许。'
  }
}

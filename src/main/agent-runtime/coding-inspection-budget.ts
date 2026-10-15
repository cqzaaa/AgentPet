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
  private stalledRounds = 0
  private targets = new Set<string>()

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
    let progressed = false
    for (const result of results) {
      if (!result.toolSuccess && !result.toolState?.readEvidences?.length && !result.toolState?.searchEvidence?.some((item: any) => item.status !== 'failed')) continue
      if (result.mutation) {
        this.rounds = 0
        this.nextReminder = 3
        this.stalledRounds = 0
        this.targets.clear()
        // Versioned file reads survive unrelated edits. Unversioned searches do not.
        for (const key of this.seen) if (!key.startsWith('read_file:versioned:')) this.seen.delete(key)
        inspected = false
        repeated = false
        progressed = false
      } else if (result.inspection) {
        inspected = true
        const reads = result.toolState?.readEvidences || (result.toolState?.readEvidence ? [result.toolState.readEvidence] : [])
        const entries = reads.length ? reads : [undefined]
        for (const evidence of entries) {
          const args = evidence ? { path: evidence.path, version: evidence.version, ranges: evidence.ranges } : result.toolArgs
          const key = `${result.toolName}:${evidence ? 'versioned:' : ''}${stableKey(this.normalizeArgs(args))}`
          const lineCount = evidence?.ranges?.reduce((sum: number, range: any) => sum + range.end - range.start + 1, 0) || 0
          const duplicate = evidence
            ? evidence.unchanged && !evidence.truncated && lineCount > 0 && (evidence.overlap >= lineCount || this.seen.has(key))
            : this.seen.has(key)
          repeated ||= duplicate
          progressed ||= !duplicate
          this.seen.add(key)
          const target = evidence?.path || (result.toolArgs as any)?.file_path || (result.toolArgs as any)?.scope
          if (typeof target === 'string') {
            this.targets.delete(target)
            this.targets.add(target)
            if (this.targets.size > 6) this.targets.delete(this.targets.values().next().value!)
          }
          if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
        }
      }
    }
    if (!inspected) return
    this.rounds++
    this.stalledRounds = progressed ? 0 : this.stalledRounds + 1
    if (!repeated && this.rounds < this.nextReminder) return
    this.nextReminder = this.rounds + 3
    const recovery = this.stalledRounds >= 2 || this.rounds >= 6
      ? `调查需要收敛。已访问位置：${[...this.targets].join('、') || '见前面的工具结果'}。下一轮先说明仍缺少的具体证据；将已知独立问题放入一次 grep_content.queries，或将相关文件放入一次 read_file.files。不要仅换关键词继续扫描已明确的链路；证据足够时开始修改或给出诊断结论。`
      : ''
    return `[Coding 检索提示] 自上次成功修改以来已进行 ${this.rounds} 轮检索。` + recovery +
      (repeated ? '检测到重复查询或已读区间重叠；若文件版本未变且上次结果完整，请直接复用已有证据。' : '') +
      '若修改位置、相关约束和验证方式已明确，请进入修改；诊断/审查任务可直接给出结论。' +
      '仍需检索时，先明确尚未解决的具体问题；独立搜索用 grep_content 的 queries 批量提交，默认返回匹配上下文；跨文件用 read_file.files，同文件用 line_ranges 合并未读区间。' +
      '不要重复扫描目录、把同一文件拆成多次微小读取，或仅为减少检索次数而草率修改。必要的进一步调查仍然允许。'
  }
}

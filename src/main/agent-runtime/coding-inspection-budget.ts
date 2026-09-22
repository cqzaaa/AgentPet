type InspectionResult = {
  toolName: string
  toolArgs: unknown
  toolSuccess: boolean
  inspection: boolean
  mutation: boolean
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

  observe(results: InspectionResult[]): string | undefined {
    let inspected = false
    let repeated = false
    for (const result of results) {
      if (!result.toolSuccess) continue
      if (result.mutation) {
        this.rounds = 0
        this.nextReminder = 3
        this.seen.clear()
        inspected = false
        repeated = false
      } else if (result.inspection) {
        inspected = true
        const key = `${result.toolName}:${stableKey(result.toolArgs)}`
        repeated ||= this.seen.has(key)
        this.seen.add(key)
      }
    }
    if (!inspected) return
    this.rounds++
    if (!repeated && this.rounds < this.nextReminder) return
    this.nextReminder = this.rounds + 3
    return `[Coding 检索提示] 自上次成功修改以来已进行 ${this.rounds} 轮检索。` +
      (repeated ? '检测到相同工具和参数的重复读取；若文件未变且上次结果完整，请直接复用已有证据。' : '') +
      '若修改位置、相关约束和验证方式已明确，请进入修改；诊断/审查任务可直接给出结论。' +
      '仍需检索时，先明确尚未解决的具体问题，将已知且独立的搜索/读取放入同一轮工具调用，限定文件、符号和上下文范围。' +
      '不要重复扫描目录、把同一文件拆成多次微小读取，或仅为减少检索次数而草率修改。必要的进一步调查仍然允许。'
  }
}

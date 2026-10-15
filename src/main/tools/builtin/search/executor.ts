import * as fs from 'fs'
import { execFile } from 'child_process'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { getAllowedFileRoots, getDefaultWorkingDirectory, isPathWithinRoots, resolveSessionPath } from '../../utils/paths'
const { rgPath } = require('vscode-ripgrep')

export class SearchExecutor implements IToolExecutor {
  public async execute(api: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (api !== 'grep_content') return { content: `未知的操作类型: ${api}`, success: false }
    if (args.queries !== undefined) {
      if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 6 || args.pattern !== undefined) {
        return { content: '错误：请提供 pattern 或包含 1–6 项的 queries，不能同时提供。', success: false }
      }
      const results: ToolResult[] = new Array(args.queries.length)
      let next = 0
      await Promise.all(Array.from({ length: Math.min(3, args.queries.length) }, async () => {
        while (next < args.queries.length) {
          const index = next++
          results[index] = await this.search(args.queries[index], context, Math.floor(24000 / args.queries.length))
        }
      }))
      return {
        success: results.every(result => result.success),
        content: results.map((result, index) => `[查询 ${index + 1} | ${result.success ? '成功' : '失败'}]\n${result.content}`).join('\n\n'),
        state: { searchEvidence: results.flatMap(result => result.state?.searchEvidence || []) }
      }
    }
    return this.search(args, context, 24000)
  }

  private async search(args: Record<string, any>, context: ToolContext, maxChars: number): Promise<ToolResult> {
    const question = typeof args?.question === 'string' ? args.question.slice(0, 300) : undefined
    const pattern = typeof args?.pattern === 'string' ? args.pattern : ''
    const failure = (message: string): ToolResult => ({
      success: false, content: message,
      state: { searchEvidence: [{ question, pattern: pattern.slice(0, 300), status: 'failed', unresolved: message.slice(0, 500) }] }
    })
    try {
      if (!pattern.trim()) return failure('错误：每项查询必须提供非空 pattern')
      if (context.abortSignal?.aborted) return failure('搜索已取消')
      if (args.scope !== undefined && typeof args.scope !== 'string') return failure('错误：scope 必须是本地路径字符串')
      if (args.glob !== undefined && typeof args.glob !== 'string') return failure('错误：glob 必须是字符串')
      const outputMode = args.output_mode || 'content'
      if (!['content', 'files_with_matches', 'count'].includes(outputMode)) return failure('错误：无效的 output_mode')
      for (const [key, max] of [['context_lines', 80], ['max_results', 300]] as const) {
        if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < (key === 'context_lines' ? 0 : 1) || args[key] > max)) {
          return failure(`错误：${key} 超出允许范围`)
        }
      }
      const searchDir = args.scope ? resolveSessionPath(args.scope, context.sessionId, context.workspacePath) : getDefaultWorkingDirectory(context)
      const roots = getAllowedFileRoots(context)
      if (!isPathWithinRoots(searchDir, roots)) return failure('错误：搜索范围不在当前会话已授权的文件夹内。')
      const realSearchDir = await fs.promises.realpath(searchDir)
      if (!isPathWithinRoots(realSearchDir, roots)) return failure('错误：搜索范围经真实路径解析后不在已授权文件夹内。')
      const singleFile = (await fs.promises.stat(realSearchDir)).isFile()
      const execArgs = ['--color', 'never']
      if (args.case_insensitive) execArgs.push('-i')
      if (args.fixed_strings) execArgs.push('-F')
      if (args.glob) execArgs.push('-g', args.glob)
      if (outputMode === 'files_with_matches') execArgs.push('-l')
      else if (outputMode === 'count') execArgs.push('--count', '-H')
      else execArgs.push('--json', '-m', '200', '-C', String(args.context_lines ?? (singleFile ? 12 : 3)))
      execArgs.push('-e', pattern, '--', realSearchDir)
      const timeout = Math.min(Math.max(Number(args.timeout_seconds) || 30, 1), 120) * 1000
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(rgPath, execArgs, { maxBuffer: 10 * 1024 * 1024, timeout, signal: context.abortSignal }, (error, out, stderr) => {
          if (error && error.code !== 1) reject(new Error(`${stderr || error.message}；请缩小搜索范围。`))
          else resolve(out)
        })
      })
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
      const paths = new Set<string>()
      let rows: string[] = []
      const contentRows: Array<{ file: string; line: number; text: string; match: boolean }> = []
      let matchCount = 0
      let limited = false
      if (outputMode === 'content') {
        const counts = new Map<string, number>()
        for (const line of lines) {
          const event = JSON.parse(line)
          if (!['match', 'context'].includes(event.type)) continue
          const file = event.data.path.text || '[非 UTF-8 文件名]'
          const body = event.data.lines.text || '[非 UTF-8 内容]'
          paths.add(file)
          const text = body.replace(/\r?\n$/, '')
          contentRows.push({ file, line: event.data.line_number, text, match: event.type === 'match' })
          rows.push(`${file}:${event.data.line_number}:${event.type === 'match' ? '>' : ' '} ${text}`)
          if (event.type === 'match') {
            matchCount++
            counts.set(file, (counts.get(file) || 0) + 1)
          }
        }
        limited = [...counts.values()].some(count => count >= 200)
      } else if (outputMode === 'files_with_matches') {
        rows = lines
        lines.forEach(file => paths.add(file))
      } else {
        rows = lines
        for (const line of lines) {
          const match = line.match(/^(.*):(\d+)$/)
          if (!match) continue
          paths.add(match[1])
          matchCount += Number(match[2])
        }
      }
      const maxRows = args.max_results ?? (singleFile ? 200 : 100)
      let selected = ''
      let delivered = 0
      let previousFile = ''
      let previousLine = 0
      const deliveredLocations: string[] = []
      for (let index = 0; index < Math.min(rows.length, maxRows); index++) {
        const row = contentRows[index]
        const section = outputMode === 'content'
          ? `${row.file !== previousFile ? `${selected ? '\n' : ''}[文件: ${row.file}]\n` : row.line > previousLine + 1 ? '...\n' : ''}${row.line}:${row.match ? '>' : ' '} ${row.text}\n`
          : `${rows[index]}\n`
        if (selected.length + section.length > maxChars) break
        selected += section
        delivered++
        if (row) {
          previousFile = row.file
          previousLine = row.line
          if (row.match && deliveredLocations.length < 6) deliveredLocations.push(`${row.file}:${row.line}: ${row.text}`.slice(0, 250))
        }
      }
      const truncated = limited || delivered < rows.length
      const status = paths.size === 0 ? 'no_matches' : truncated ? 'truncated' : 'complete'
      const heading = outputMode === 'count'
        ? `共 ${matchCount} 个匹配行，分布在 ${paths.size} 个文件（按行计数）`
        : `命中 ${paths.size} 个文件${outputMode === 'content' ? `，${matchCount} 个匹配行${limited ? '（已达单文件上限）' : ''}` : ''}`
      const notice = truncated ? '\n[结果已截断或达到单文件 200 个匹配行上限；请按已知文件、符号缩小范围。未展示部分不能视为无匹配。]' : ''
      return {
        success: true,
        content: `[搜索结果] ${heading}\n${selected || (paths.size ? '(匹配内容超过输出预算，请缩小范围或使用字符分页读取对应文件)' : '(无匹配)')}${notice}`,
        state: { searchEvidence: [{
          question, pattern: pattern.slice(0, 300), scope: realSearchDir, status,
          files: [...paths].slice(0, 12), locations: outputMode === 'content' ? deliveredLocations : rows.slice(0, Math.min(delivered, 6)).map(row => row.slice(0, 250)),
          unresolved: truncated ? '缩小范围查看未展示的匹配' : paths.size === 0 ? '此范围无匹配；检查关键词或逐级扩大范围' : undefined
        }] }
      }
    } catch (error: any) {
      return failure(`搜索出错：${error.message || error}`)
    }
  }

  public getApiNames(): string[] { return ['grep_content'] }
}

export const searchExecutor = new SearchExecutor()

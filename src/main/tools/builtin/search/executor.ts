import * as fs from 'fs'
import { execFile } from 'child_process'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { resolveLocalPath, getAllowedFileRoots, getSessionFilesDir, isPathWithinRoots } from '../../utils/paths'
const { rgPath } = require('vscode-ripgrep')

export class SearchExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      if (api === 'grep_content') {
        const { pattern, scope, glob, output_mode, case_insensitive } = args
        if (!pattern) return { content: '错误：缺少必要参数 pattern', success: false }

        // 解析可能的相对路径
        const resolvedScope = scope ? resolveLocalPath(scope) : undefined
        const searchDir = resolvedScope || (context.workspacePath || getSessionFilesDir(context.sessionId))
        if (!isPathWithinRoots(searchDir, getAllowedFileRoots(context))) {
          return { content: '错误：搜索范围不在当前会话已授权的文件夹内。请先上传文件，或在设置中选择允许访问的文件夹。', success: false }
        }
        const realSearchDir = await fs.promises.realpath(searchDir)
        if (!isPathWithinRoots(realSearchDir, getAllowedFileRoots(context))) {
          return { content: '错误：搜索范围经真实路径解析后不在已授权文件夹内。', success: false }
        }

        const execArgs: string[] = []
        execArgs.push('-n') // Line numbers
        execArgs.push('-H') // Always print filename
        execArgs.push('--no-heading') // Don't group by file
        if (case_insensitive) {
          execArgs.push('-i')
        }
        if (glob) {
          execArgs.push('-g', glob)
        }
        execArgs.push('-m', '200') // Max 200 matches per file to avoid huge output per file
        execArgs.push('-e', pattern)
        execArgs.push(realSearchDir)

        const timeout = Math.min(Math.max(Number(args.timeout_seconds) || 30, 1), 120) * 1000
        return new Promise<ToolResult>((resolve) => {
          execFile(rgPath, execArgs, { maxBuffer: 10 * 1024 * 1024, timeout, signal: context.abortSignal }, (error, stdout, stderr) => {
            // ripgrep exits with 1 if no matches found, 2 if error
            if (error && error.code === 2) {
              resolve({
                content: `搜索出错: ${stderr || error.message}`,
                success: false
              })
              return
            }

            if (!stdout.trim()) {
              resolve({ content: `[搜索结果]\n(无匹配)`, success: true })
              return
            }

            const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
            const MAX_TOTAL_MATCHES = 300
            const truncatedLines = lines.slice(0, MAX_TOTAL_MATCHES)
            const wasTruncated = lines.length > MAX_TOTAL_MATCHES

            if (output_mode === 'count') {
              resolve({ content: `[搜索结果] 找到 ${lines.length} 处匹配`, success: true })
            } else if ((output_mode || 'files_with_matches') === 'files_with_matches') {
              const files = new Set<string>()
              lines.forEach(line => {
                // ripgrep outputs FilePath:LineNumber:Content
                // Use a non-greedy match up to the first colon. 
                // Note: Windows paths have colon like C:\, ripgrep handles it but the format is C:\path:line:content
                // Actually ripgrep on windows format is C:\path\to\file.js:12:content
                // We split by ':' but preserve the drive letter.
                const match = line.match(/^([a-zA-Z]:[^:]+|[^:]+):/)
                if (match) files.add(match[1])
              })
              resolve({ content: `[搜索结果] 在 ${files.size} 个文件中找到匹配\n${Array.from(files).join('\n')}`, success: true })
            } else {
              let resultStr = truncatedLines.join('\n')
              if (wasTruncated) {
                resultStr += `\n... (共发现 ${lines.length} 条匹配，已截断显示前 ${MAX_TOTAL_MATCHES} 条)`
              }
              resolve({ content: `[搜索结果]\n${resultStr}`, success: true })
            }
          })
        })
      }

      return { content: `未知的操作类型: ${api}`, success: false }
    } catch (err: any) {
      return {
        content: `搜索操作异常: ${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    }
  }

  public getApiNames(): string[] {
    return ['grep_content']
  }
}

export const searchExecutor = new SearchExecutor()

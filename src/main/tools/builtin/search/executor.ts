import * as os from 'os'
import { basename } from 'path'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { shellManager } from '../terminal/shell-manager'

export class SearchExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. search_files
      if (api === 'search_files') {
        const { keywords, scope, file_types, limit } = args
        if (!keywords) return { content: '错误：缺少必要参数 keywords', success: false }

        const searchDir = scope || context.workspacePath || os.homedir()
        const keywordList = keywords.split(/\s+/).filter(Boolean)

        // 使用 find 命令搜索文件名
        let cmd = `find "${searchDir}" -type f`
        if (file_types && file_types.length > 0) {
          const extFilter = file_types.map((t: string) => `-name "*.${t}"`).join(' -o ')
          cmd += ` \\( ${extFilter} \\)`
        }

        const { stdout } = await shellManager.execWithBash(cmd, { timeout: 30000 })
        let files = stdout.split('\n').filter(Boolean)

        // 过滤包含所有关键词的文件
        files = files.filter(file => {
          const fileName = basename(file).toLowerCase()
          return keywordList.every((kw: string) => fileName.includes(kw.toLowerCase()))
        })

        if (limit && limit > 0) {
          files = files.slice(0, limit)
        }

        return {
          content: `[搜索结果] 找到 ${files.length} 个文件\n${files.join('\n')}`,
          success: true
        }
      }

      // 2. grep_content
      if (api === 'grep_content') {
        const { pattern, scope, glob, output_mode, case_insensitive } = args
        if (!pattern) return { content: '错误：缺少必要参数 pattern', success: false }

        const searchDir = scope || context.workspacePath || os.homedir()
        let cmd = `grep -r`

        if (case_insensitive) cmd += 'i'
        if (output_mode === 'content') cmd += 'n'

        cmd += ` "${pattern}"`

        if (glob) {
          cmd += ` --include="${glob}"`
        }

        cmd += ` "${searchDir}"`

        const { stdout } = await shellManager.execWithBash(cmd, { timeout: 30000 })

        if (output_mode === 'count') {
          const count = stdout.split('\n').filter(Boolean).length
          return { content: `[搜索结果] 找到 ${count} 处匹配`, success: true }
        } else if (output_mode === 'files_with_matches') {
          const files = [...new Set(stdout.split('\n').filter(Boolean).map(line => line.split(':')[0]))]
          return { content: `[搜索结果] 在 ${files.length} 个文件中找到匹配\n${files.join('\n')}`, success: true }
        } else {
          return { content: `[搜索结果]\n${stdout || '(无匹配)'}`, success: true }
        }
      }

      // 3. glob_files
      if (api === 'glob_files') {
        const { pattern, scope } = args
        if (!pattern) return { content: '错误：缺少必要参数 pattern', success: false }

        const searchDir = scope || context.workspacePath || os.homedir()
        const cmd = `find "${searchDir}" -name "${pattern}" -type f | head -100`

        const { stdout } = await shellManager.execWithBash(cmd, { timeout: 30000 })
        const files = stdout.split('\n').filter(Boolean)

        return {
          content: `[搜索结果] 找到 ${files.length} 个文件\n${files.join('\n')}`,
          success: true
        }
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
    return ['search_files', 'grep_content', 'glob_files']
  }
}

export const searchExecutor = new SearchExecutor()

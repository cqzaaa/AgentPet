import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'

// 需要忽略的开发与构建庞大文件夹，保证遍历速度
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.vscode',
  '.idea',
  'dist',
  'build',
  'out',
  '.electron',
  'tmp',
  'temp'
])

/**
 * 跨平台高效 JS 递归文件遍历方法 (最大深度限制为 12 级)
 * 使用 withFileTypes 一次性获取文件类型，省去每个文件的 stat() 系统调用
 */
async function findFiles(
  dir: string,
  filterFn: (filePath: string) => boolean,
  limit = 100,
  currentDepth = 0,
  maxDepth = 12
): Promise<string[]> {
  const results: string[] = []
  if (currentDepth > maxDepth) return results

  try {
    const list = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of list) {
      if (results.length >= limit) break

      const fullPath = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          // 忽略无关的大型开发目录
          if (IGNORE_DIRS.has(entry.name.toLowerCase())) continue
          const subResults = await findFiles(fullPath, filterFn, limit - results.length, currentDepth + 1, maxDepth)
          results.push(...subResults)
        } else if (entry.isFile()) {
          if (filterFn(fullPath)) {
            results.push(fullPath)
          }
        }
      } catch (e) {
        // 忽略系统保护文件或无读权限文件的异常
      }
    }
  } catch (e) {
    // 忽略无权限读取的目录异常
  }
  return results
}

export class SearchExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. grep_content
      if (api === 'grep_content') {
        const { pattern, scope, glob, output_mode, case_insensitive } = args
        if (!pattern) return { content: '错误：缺少必要参数 pattern', success: false }

        const searchDir = scope || context.workspacePath || os.homedir()
        const matchPattern = case_insensitive ? pattern.toLowerCase() : pattern

        const matchedResults: { file: string; line: number; content: string }[] = []
        const maxMatches = 200

        // 判定文件是否是常见可读文本文件，过滤常见二进制大文件
        const isTextFile = (filePath: string) => {
          const ext = path.extname(filePath).toLowerCase()
          const binaryExtensions = new Set([
            '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz',
            '.mp3', '.mp4', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf'
          ])
          return !binaryExtensions.has(ext)
        }

        // 支持简易的 glob 规则过滤
        const checkGlob = (filePath: string) => {
          if (!glob) return true
          const fileName = path.basename(filePath)
          const regexStr = '^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
          try {
            const regex = new RegExp(regexStr, 'i')
            return regex.test(fileName)
          } catch (e) {
            return true
          }
        }

        // 首先检索目标目录下的全部文本文件 (限制扫入前 500 个文本文件)
        const files = await findFiles(searchDir, (filePath) => {
          return isTextFile(filePath) && checkGlob(filePath)
        }, 500)

        // 逐个文件内查找匹配行
        for (const file of files) {
          if (matchedResults.length >= maxMatches) break
          try {
            const fileContent = await fs.promises.readFile(file, 'utf-8')
            const lines = fileContent.split(/\r?\n/)
            lines.forEach((line, index) => {
              const checkLine = case_insensitive ? line.toLowerCase() : line
              if (checkLine.includes(matchPattern)) {
                matchedResults.push({
                  file,
                  line: index + 1,
                  content: line.trim()
                })
              }
            })
          } catch (e) {
            // 忽略读取单个文件的失败
          }
        }

        if (output_mode === 'count') {
          return { content: `[搜索结果] 找到 ${matchedResults.length} 处匹配`, success: true }
        } else if (output_mode === 'files_with_matches') {
          const filesWithMatch = [...new Set(matchedResults.map(r => r.file))]
          return { content: `[搜索结果] 在 ${filesWithMatch.length} 个文件中找到匹配\n${filesWithMatch.join('\n')}`, success: true }
        } else {
          const content = matchedResults.map(r => `${r.file}:${r.line}:${r.content}`).join('\n')
          return { content: `[搜索结果]\n${content || '(无匹配)'}`, success: true }
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
    return ['grep_content']
  }
}

export const searchExecutor = new SearchExecutor()

import * as fs from 'fs'
import { dirname, basename, join, extname, relative } from 'path'
import { shell } from 'electron'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { resolveLocalPath, resolveSessionPath, getActiveStorageDir, getAllowedFileRoots, getSessionFilesDir, isPathWithinRoots } from '../../utils/paths'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_ROWS = 2000

async function assertAllowedPath(filePath: string, context: ToolContext, allowMissing = false): Promise<string> {
  const absolutePath = resolveFilePath(filePath, context)
  const targetExists = fs.existsSync(absolutePath)
  const checkPath = allowMissing && !targetExists ? dirname(absolutePath) : absolutePath
  if (!isPathWithinRoots(checkPath, getAllowedFileRoots(context))) {
    throw new Error('该路径不在当前会话已授权的文件夹内。请先上传文件，或在设置中选择允许访问的文件夹。')
  }
  if (targetExists) return fs.promises.realpath(absolutePath)

  // Creating a nested path must not follow a pre-existing directory symlink out
  // of an approved root. Validate the nearest existing ancestor's real path.
  let existingAncestor = checkPath
  while (!fs.existsSync(existingAncestor) && dirname(existingAncestor) !== existingAncestor) {
    existingAncestor = dirname(existingAncestor)
  }
  const realAncestor = await fs.promises.realpath(existingAncestor)
  if (!isPathWithinRoots(realAncestor, getAllowedFileRoots(context))) {
    throw new Error('该路径的实际父目录不在当前会话已授权的文件夹内。')
  }
  return absolutePath
}

function resolveFilePath(filePath: string, context: ToolContext): string {
  const resolved = resolveLocalPath(filePath)
  if (!resolved || typeof resolved !== 'string') return resolved

  // 1. 处理 web_fetch 生成的相对缓存路径
  if (resolved.startsWith('.agentpet_cache/') || resolved.startsWith('.agentpet_cache\\')) {
    const safeSessionId = context.sessionId ? context.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') : 'default_session'
    const cacheDir = join(getActiveStorageDir(), 'chat', safeSessionId, '.agentpet_cache')
    const fileName = basename(resolved)
    return join(cacheDir, fileName)
  }

  // 2. All relative file-tool paths share the same base as list_directory:
  // the current conversation directory. Explicit paths and aliases remain available.
  return resolveSessionPath(resolved, context.sessionId)
}

export class FileExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. read_file
      if (api === 'read_file') {
        let { file_path } = args
        if (!file_path) return { content: '错误：缺少必要参数 file_path', success: false }
        file_path = resolveFilePath(file_path, context)

        // 兼容记忆提纯重命名：如果原 md 文件不存在，检查是否存在带 '_已更新.md' 后缀的同名文件
        if (!fs.existsSync(file_path)) {
          if (file_path.toLowerCase().endsWith('.md') && !file_path.toLowerCase().endsWith('_已更新.md')) {
            const updatedPath = file_path.replace(/\.md$/i, '_已更新.md')
            if (fs.existsSync(updatedPath)) {
              file_path = updatedPath
            }
          }
        }

        if (!fs.existsSync(file_path)) return { content: `错误：文件不存在：${file_path}`, success: false }
        file_path = await assertAllowedPath(file_path, context)

        const stat = await fs.promises.stat(file_path)
        if (!stat.isFile()) return { content: `错误：该路径不是文件：${file_path}`, success: false }
        if (stat.size > MAX_FILE_BYTES) {
          return { content: `错误：文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），单次读取上限为 ${MAX_FILE_BYTES / 1024 / 1024} MB。请缩小文件或使用 grep_content 定位内容。`, success: false }
        }

        const ext = file_path.split('.').pop()?.toLowerCase() || ''
        let content = ''

        if (ext === 'pdf') {
          const pdf = require('pdf-parse')
          const buffer = await fs.promises.readFile(file_path)
          const data = await pdf(buffer)
          content = data.text || ''
          if (!content.trim()) content = '[PDF 文件已加载，但未能提取到文本内容（可能是扫描件或纯图片 PDF）]'
        } else if (ext === 'docx') {
          const mammoth = require('mammoth')
          const buffer = await fs.promises.readFile(file_path)
          const result = await mammoth.extractRawText({ buffer })
          content = result.value || ''
          if (!content.trim()) content = '[Word 文档已加载，但内容为空]'
        } else if (ext === 'xlsx' || ext === 'xls') {
          const XLSX = require('xlsx')
          // Row/column visibility metadata is only populated by SheetJS when
          // styles are read. Without it, skipHidden silently includes template
          // helper rows and machine-only field identifiers.
          const workbook = XLSX.readFile(file_path, { cellStyles: true })
          const sheets: string[] = []
          const requestedSheets = args.sheet_name ? [args.sheet_name] : workbook.SheetNames
          const rowLimit = Math.min(Math.max(Number(args.max_rows) || 500, 1), MAX_ROWS)
          for (const sheetName of requestedSheets) {
            const sheet = workbook.Sheets[sheetName]
            if (!sheet) return { content: `错误：未找到工作表 ${sheetName}`, success: false }
            const csv = XLSX.utils.sheet_to_csv(sheet, {
              skipHidden: true,
              ...(args.cell_range ? { range: args.cell_range } : {})
            })
            if (csv.trim()) {
              const cleaned = csv.split(/\r?\n/).slice(0, rowLimit).join('\n').replace(/\$\{[^}]*\}/g, '').replace(/,{2,}/g, ',').replace(/^,+|,+$/gm, '')
              sheets.push(`[工作表: ${sheetName}]\n${cleaned}`)
            }
          }
          content = sheets.join('\n\n') || '[Excel 文件已加载，但内容为空]'
        } else if (ext === 'csv') {
          const Papa = require('papaparse')
          const csvContent = await fs.promises.readFile(file_path, 'utf-8')
          const parsed = Papa.parse(csvContent, { header: true })
          if (parsed.data && parsed.data.length > 0) {
            const headers = parsed.meta.fields || []
            const rowLimit = Math.min(Math.max(Number(args.max_rows) || 500, 1), MAX_ROWS)
            const rows = parsed.data.slice(0, rowLimit) as any[]
            content = `列名: ${headers.join(', ')}\n\n`
            content += rows.map((row, i) => `第${i + 1}行: ${headers.map(h => `${h}=${row[h] ?? ''}`).join(', ')}`).join('\n')
            if ((parsed.data as any[]).length > rowLimit) content += `\n\n... 共 ${parsed.data.length} 行，已截取前 ${rowLimit} 行`
          } else {
            content = '[CSV 文件已加载，但内容为空]'
          }
        } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
          content = `[图片文件: ${basename(file_path)}，路径: ${file_path}]`
        } else {
          content = await fs.promises.readFile(file_path, 'utf-8')
        }

        let finalContent = content
        const { start_line, end_line } = args

        const DEFAULT_LIMIT_LINES = 800
        const lines = content.split(/\r?\n/)
        let s = Number.isInteger(start_line) ? start_line : undefined
        let e = Number.isInteger(end_line) ? end_line : undefined

        // 如果是 md 文件，且未指定行范围，默认全量读取；其它类型文件依然保持 800 行安全保护
        if (s === undefined && e === undefined) {
          s = 1
          e = ext === 'md' ? lines.length : Math.min(lines.length, DEFAULT_LIMIT_LINES)
        } else {
          s = s ? Math.max(1, s) : 1
          e = e ? Math.min(lines.length, e) : lines.length
        }

        if (s > lines.length) {
          finalContent = `[提示] 起始行号 ${s} 超出文件总行数 ${lines.length}`
        } else if (e < s) {
          finalContent = '[错误] end_line 必须大于或等于 start_line'
        } else {
          const sliced = lines.slice(s - 1, e)
          finalContent = `[读取文件 ${basename(file_path)}，第 ${s} 行 到 第 ${e} 行，总行数: ${lines.length}]\n` +
            sliced.map((line, idx) => `${s + idx}: ${line}`).join('\n')
          
          if (lines.length > e && end_line === undefined) {
            finalContent += `\n\n... [系统提示：文件较长，已默认截取展示前 ${DEFAULT_LIMIT_LINES} 行。如果需要阅读剩余内容，请在下一次工具参数中指定 start_line（例如 ${e + 1}）和 end_line 范围进行精确的分页读取]`
          }
        }

        const MAX_READ_LEN = 30000
        if (finalContent.length > MAX_READ_LEN) {
          finalContent = finalContent.slice(0, MAX_READ_LEN) + `\n\n... [警告：内容过长已自动截断，仅展示前 ${MAX_READ_LEN} 个字符。如需阅读后续部分，请在参数中使用 start_line 和 end_line 进行精确的分页读取。]`
        }
        return { content: finalContent, success: true }
      }

      if (api === 'get_file_metadata') {
        if (!args.file_path) return { content: '错误：缺少必要参数 file_path', success: false }
        const filePath = await assertAllowedPath(args.file_path, context)
        const stat = await fs.promises.stat(filePath)
        return {
          content: JSON.stringify({ path: filePath, name: basename(filePath), extension: extname(filePath).toLowerCase(), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), isFile: stat.isFile(), isDirectory: stat.isDirectory() }, null, 2),
          success: true
        }
      }

      if (api === 'list_directory') {
        const directoryPath = args.directory_path ? await assertAllowedPath(args.directory_path, context) : getSessionFilesDir(context.sessionId)
        const stat = await fs.promises.stat(directoryPath)
        if (!stat.isDirectory()) return { content: `错误：该路径不是目录：${directoryPath}`, success: false }
        const recursive = Boolean(args.recursive)
        const allEntries: string[] = []
        const walk = async (directory: string): Promise<void> => {
          for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
            const fullPath = join(directory, entry.name)
            allEntries.push(`${entry.isDirectory() ? '[目录]' : '[文件]'} ${relative(directoryPath, fullPath) || entry.name}`)
            if (recursive && entry.isDirectory() && allEntries.length < 2000) await walk(fullPath)
          }
        }
        await walk(directoryPath)
        const cursor = Math.max(0, Number(args.cursor) || 0)
        const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500)
        const page = allEntries.slice(cursor, cursor + limit)
        const nextCursor = cursor + page.length < allEntries.length ? cursor + page.length : null
        return { content: `[目录列表] 共 ${allEntries.length} 项\n${page.join('\n')}${nextCursor === null ? '' : `\n\n下一页 cursor: ${nextCursor}`}`, success: true }
      }

      if (api === 'find_files') {
        if (!args.file_name || typeof args.file_name !== 'string') return { content: '错误：缺少必要参数 file_name', success: false }
        const directoryPath = args.directory_path ? await assertAllowedPath(args.directory_path, context) : getSessionFilesDir(context.sessionId)
        const stat = await fs.promises.stat(directoryPath)
        if (!stat.isDirectory()) return { content: `错误：该路径不是目录：${directoryPath}`, success: false }

        const targetName = args.file_name.trim().toLocaleLowerCase()
        const maxDepth = Math.min(Math.max(Number(args.max_depth) || 4, 0), 8)
        const maxResults = Math.min(Math.max(Number(args.max_results) || 20, 1), 100)
        const maxVisited = 10000
        const matches: string[] = []
        let visited = 0
        let wasLimited = false

        const walk = async (directory: string, depth: number): Promise<void> => {
          if (depth > maxDepth || matches.length >= maxResults || visited >= maxVisited) {
            if (visited >= maxVisited) wasLimited = true
            return
          }
          for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
            if (matches.length >= maxResults || visited >= maxVisited) {
              wasLimited = true
              return
            }
            visited++
            const fullPath = join(directory, entry.name)
            if (entry.isFile() && entry.name.toLocaleLowerCase() === targetName) matches.push(fullPath)
            if (entry.isDirectory()) await walk(fullPath, depth + 1)
          }
        }

        await walk(directoryPath, 0)
        const limitHint = wasLimited ? '\n\n[提示] 搜索达到安全上限，结果不完整。请缩小到更具体的上级目录后重试；不要自动切换到其他磁盘。' : ''
        return { content: matches.length ? `[文件查找] 找到 ${matches.length} 个候选：\n${matches.join('\n')}${limitHint}` : `[文件查找] 在已授权目录中未找到 ${args.file_name}。${limitHint || '请确认文件名，或提供更可能的上级目录。'}`, success: true }
      }

      // 2. write_file
      if (api === 'write_file') {
        let { file_path, content, append } = args
        if (!file_path || content === undefined) {
          return { content: '错误：缺少必要参数 file_path 或 content', success: false }
        }
        file_path = await assertAllowedPath(file_path, context, true)
        const parentDir = dirname(file_path)
        if (!fs.existsSync(parentDir)) {
          await fs.promises.mkdir(parentDir, { recursive: true })
        }
        if (append) {
          await fs.promises.appendFile(file_path, content, 'utf-8')
        } else {
          await fs.promises.writeFile(file_path, content, 'utf-8')
        }
        return { content: `成功：已${append ? '追加' : '写入'}到文件 ${file_path}`, success: true }
      }

      // 3. edit_file
      if (api === 'edit_file') {
        let { file_path, old_string, new_string, replace_all } = args
        if (!file_path || old_string === undefined || new_string === undefined) {
          return { content: '错误：缺少参数 file_path, old_string 或 new_string', success: false }
        }
        file_path = await assertAllowedPath(file_path, context)
        if (!fs.existsSync(file_path)) return { content: `错误：文件不存在：${file_path}`, success: false }
        
        let fileContent = await fs.promises.readFile(file_path, 'utf-8')
        if (!fileContent.includes(old_string)) {
          return { content: `错误：文件中未找到指定的 old_string`, success: false }
        }

        if (replace_all) {
          fileContent = fileContent.split(old_string).join(new_string)
        } else {
          fileContent = fileContent.replace(old_string, new_string)
        }

        await fs.promises.writeFile(file_path, fileContent, 'utf-8')
        return { content: `成功：已修改文件 ${file_path}`, success: true }
      }

      // 4. move_file
      if (api === 'move_file') {
        let { source_path, destination_path } = args
        if (!source_path || !destination_path) {
          return { content: '错误：缺少参数 source_path 或 destination_path', success: false }
        }
        source_path = await assertAllowedPath(source_path, context)
        destination_path = await assertAllowedPath(destination_path, context, true)
        if (!fs.existsSync(source_path)) {
          return { content: `错误：源文件不存在: ${source_path}`, success: false }
        }
        const parentDir = dirname(destination_path)
        if (!fs.existsSync(parentDir)) {
          await fs.promises.mkdir(parentDir, { recursive: true })
        }
        await fs.promises.rename(source_path, destination_path)
        return { content: `成功：文件已从 ${source_path} 移动到 ${destination_path}`, success: true }
      }

      // 5. delete_file
      if (api === 'delete_file') {
        let { file_path } = args
        if (!file_path) return { content: '错误：缺少参数 file_path', success: false }
        file_path = await assertAllowedPath(file_path, context)
        if (!fs.existsSync(file_path)) {
          return { content: `错误：文件或目录不存在: ${file_path}`, success: false }
        }
        await shell.trashItem(file_path)
        return { content: `成功：已将 ${file_path} 移入回收站`, success: true }
      }

      return { content: `未知的操作类型: ${api}`, success: false }
    } catch (err: any) {
      return {
        content: `文件操作异常: ${err.message || err}`,
        success: false,
        error: { message: err.message || String(err) }
      }
    }
  }

  public getApiNames(): string[] {
    return ['read_file', 'list_directory', 'get_file_metadata', 'find_files', 'write_file', 'edit_file', 'move_file', 'delete_file']
  }
}

export const fileExecutor = new FileExecutor()

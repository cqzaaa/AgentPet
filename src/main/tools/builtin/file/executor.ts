import * as fs from 'fs'
import { dirname, basename } from 'path'
import { shell } from 'electron'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { resolveLocalPath } from '../../utils/paths'

export class FileExecutor implements IToolExecutor {
  public async execute(
    api: string,
    args: Record<string, any>,
    _context: ToolContext
  ): Promise<ToolResult> {
    try {
      // 1. read_file
      if (api === 'read_file') {
        let { file_path } = args
        if (!file_path) return { content: '错误：缺少必要参数 file_path', success: false }
        file_path = resolveLocalPath(file_path)

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
          const workbook = XLSX.readFile(file_path)
          const sheets: string[] = []
          for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName]
            const csv = XLSX.utils.sheet_to_csv(sheet)
            if (csv.trim()) {
              const cleaned = csv.replace(/\$\{[^}]*\}/g, '').replace(/,{2,}/g, ',').replace(/^,+|,+$/gm, '')
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
            const rows = parsed.data.slice(0, 500) as any[]
            content = `列名: ${headers.join(', ')}\n\n`
            content += rows.map((row, i) => `第${i + 1}行: ${headers.map(h => `${h}=${row[h] ?? ''}`).join(', ')}`).join('\n')
            if ((parsed.data as any[]).length > 500) content += `\n\n... 共 ${parsed.data.length} 行，已截取前 500 行`
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
        let s = start_line
        let e = end_line

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

      // 2. write_file
      if (api === 'write_file') {
        let { file_path, content, append } = args
        if (!file_path || content === undefined) {
          return { content: '错误：缺少必要参数 file_path 或 content', success: false }
        }
        file_path = resolveLocalPath(file_path)
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
        file_path = resolveLocalPath(file_path)
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
        source_path = resolveLocalPath(source_path)
        destination_path = resolveLocalPath(destination_path)
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
        file_path = resolveLocalPath(file_path)
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
    return ['read_file', 'write_file', 'edit_file', 'move_file', 'delete_file']
  }
}

export const fileExecutor = new FileExecutor()

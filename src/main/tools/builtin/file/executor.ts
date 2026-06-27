import * as fs from 'fs'
import { join, dirname, basename } from 'path'
import { IToolExecutor, ToolContext, ToolResult } from '../../core/types'
import { resolveLocalPath, getActiveStorageDir } from '../../utils/paths'

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
        file_path = resolveLocalPath(file_path)
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

        const MAX_READ_LEN = 30000
        if (content.length > MAX_READ_LEN) {
          content = content.slice(0, MAX_READ_LEN) + `\n\n... [警告：内容过长已自动截断，仅展示前 ${MAX_READ_LEN} 个字符。如需阅读后续部分，请通过命令拆分读取或使用其他方式。]`
        }
        return { content, success: true }
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
        let { file_path, recursive } = args
        if (!file_path) return { content: '错误：缺少参数 file_path', success: false }
        file_path = resolveLocalPath(file_path)
        if (!fs.existsSync(file_path)) {
          return { content: `错误：文件或目录不存在: ${file_path}`, success: false }
        }
        const stat = await fs.promises.stat(file_path)
        if (stat.isDirectory()) {
          await fs.promises.rm(file_path, { recursive: !!recursive, force: true })
        } else {
          await fs.promises.unlink(file_path)
        }
        return { content: `成功：已删除 ${file_path}`, success: true }
      }

      // 工作空间默认路径处理
      let workspacePath = context.workspacePath
      if (!workspacePath) {
        workspacePath = join(getActiveStorageDir(), 'workspace')
        if (!fs.existsSync(workspacePath)) {
          try { fs.mkdirSync(workspacePath, { recursive: true }) } catch (e) {}
        }
      }

      if (!fs.existsSync(workspacePath)) {
        return { content: `错误：工作空间路径不存在：${workspacePath}`, success: false }
      }

      // 6. list_workspace_files
      if (api === 'list_workspace_files') {
        const files = await fs.promises.readdir(workspacePath)
        const listInfo: any[] = []
        for (const file of files) {
          const fullPath = join(workspacePath, file)
          const stat = await fs.promises.stat(fullPath)
          listInfo.push({
            name: file,
            isDirectory: stat.isDirectory(),
            size: stat.isFile() ? stat.size : undefined
          })
        }
        return { content: JSON.stringify(listInfo, null, 2), success: true }
      }

      // 7. read_workspace_file
      if (api === 'read_workspace_file') {
        const { relative_path } = args
        const fullPath = join(workspacePath, relative_path)
        if (!fullPath.startsWith(workspacePath)) {
          return { content: '错误：安全限制，无法读取工作空间外部的文件。', success: false }
        }
        if (!fs.existsSync(fullPath)) {
          return { content: `错误：文件不存在：${relative_path}`, success: false }
        }
        const stat = await fs.promises.stat(fullPath)
        if (stat.isDirectory()) {
          return { content: `错误：${relative_path} 是一个目录，不能读取为文本文件。`, success: false }
        }
        let content = await fs.promises.readFile(fullPath, 'utf-8')
        const MAX_READ_LEN = 30000
        if (content.length > MAX_READ_LEN) {
          content = content.slice(0, MAX_READ_LEN) + `\n\n... [警告：内容过长已自动截断，仅展示前 ${MAX_READ_LEN} 个字符。如需阅读后续部分，请通过命令拆分读取或使用其他方式。]`
        }
        return { content, success: true }
      }

      // 8. write_workspace_file
      if (api === 'write_workspace_file') {
        const { relative_path, content } = args
        const fullPath = join(workspacePath, relative_path)
        if (!fullPath.startsWith(workspacePath)) {
          return { content: '错误：安全限制，无法写入到工作空间外部。', success: false }
        }
        const parentDir = dirname(fullPath)
        if (!fs.existsSync(parentDir)) {
          await fs.promises.mkdir(parentDir, { recursive: true })
        }
        await fs.promises.writeFile(fullPath, content, 'utf-8')
        return { content: `成功：文件已写入到相对路径 ${relative_path}`, success: true }
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
    return [
      'read_file', 'write_file', 'edit_file', 'move_file', 'delete_file',
      'list_workspace_files', 'read_workspace_file', 'write_workspace_file'
    ]
  }
}

export const fileExecutor = new FileExecutor()

import { ToolManifest } from '../../core/types'

export const fileManifest: ToolManifest = {
  identifier: 'agentpet-file',
  category: 'file',
  meta: {
    title: '文件操作',
    description: '读取、写入、修改、重命名、移动和删除文件',
    avatar: '📂'
  },
  api: [
    {
      name: 'read_file',
      description: '读取文件的语义文本。支持 PDF、Word、Excel、CSV 及文本文件，但不保留 Office/PDF 的字体、颜色、坐标和版式；格式或版式任务应加载 office Skill。支持使用 start_line 和 end_line 分页读取，默认最多返回 30000 字符。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件路径；可使用绝对路径，或相对于当前工作区的路径'
          },
          start_line: {
            type: 'number',
            description: '起始行号 (1-indexed)，可选'
          },
          end_line: {
            type: 'number',
            description: '结束行号 (1-indexed)，可选'
          },
          sheet_name: {
            type: 'string',
            description: 'Excel 工作表名称（可选；未填时读取全部工作表）'
          },
          cell_range: {
            type: 'string',
            description: 'Excel 单元格范围，例如 A1:F50（可选）'
          },
          max_rows: {
            type: 'number',
            description: 'CSV 或 Excel 最多读取行数（默认 500，上限 2000）'
          }
        },
        required: ['file_path']
      }
    },
    {
      name: 'list_directory',
      description: '列出当前会话已授权目录内的文件和子目录；支持分页，不读取文件内容。',
      parameters: {
        type: 'object',
        properties: {
          directory_path: { type: 'string', description: '目录路径；省略时优先列出当前工作区，未绑定工作区时列出会话附件目录' },
          recursive: { type: 'boolean', description: '是否递归列出子目录，默认 false' },
          limit: { type: 'number', description: '最多返回条目数，默认 100，上限 500' },
          cursor: { type: 'number', description: '分页起始偏移量，默认 0' }
        },
        required: []
      }
    },
    {
      name: 'get_file_metadata',
      description: '获取已授权文件的大小、修改时间和类型，不读取文件正文。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径；可使用绝对路径，或相对于当前工作区的路径' }
        },
        required: ['file_path']
      }
    },
    {
      name: 'find_files',
      description: '在明确位置或当前会话已授权目录内按文件名查找文件。用户说明桌面、文档或下载目录时直接传 location；不要询问 Windows 用户名，也不要用终端解析这些系统目录。',
      parameters: {
        type: 'object',
        properties: {
          file_name: { type: 'string', description: '文件名、文件主名或部分名称；可以省略扩展名' },
          location: {
            type: 'string',
            enum: ['desktop', 'documents', 'downloads', 'workspace', 'session'],
            description: '常用起始位置。用户已说明位置时优先使用；directory_path 优先级更高'
          },
          directory_path: { type: 'string', description: '已授权的起始目录；省略时按 location 解析，二者都省略则优先使用当前工作区' },
          match_mode: {
            type: 'string',
            enum: ['auto', 'exact', 'contains', 'glob'],
            description: '匹配方式，默认 auto；auto 支持省略扩展名和部分名称'
          },
          max_depth: { type: 'number', description: '最大递归层级，默认 4，上限 8' },
          max_results: { type: 'number', description: '最多返回结果数，默认 20，上限 100' }
        },
        required: ['file_name']
      }
    },
    {
      name: 'write_file',
      description: '向指定路径写入文件。',
      humanIntervention: 'never',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '目标文件路径；可使用相对于当前工作区的路径'
          },
          content: {
            type: 'string',
            description: '写入文件的内容'
          },
          append: {
            type: 'boolean',
            description: '是否是追加模式（默认为覆盖）'
          }
        },
        required: ['file_path', 'content']
      }
    },
    {
      name: 'edit_file',
      description: '编辑替换文件中的字符串（old_string -> new_string）。',
      humanIntervention: 'required',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件路径；可使用相对于当前工作区的路径'
          },
          old_string: {
            type: 'string',
            description: '需要替换的原文'
          },
          new_string: {
            type: 'string',
            description: '替换后的新文本'
          },
          replace_all: {
            type: 'boolean',
            description: '是否替换所有匹配项（默认为 false）'
          }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    },
    {
      name: 'move_file',
      description: '重命名或移动文件/目录。',
      humanIntervention: 'required',
      parameters: {
        type: 'object',
        properties: {
          source_path: {
            type: 'string',
            description: '源文件路径；可使用相对于当前工作区的路径'
          },
          destination_path: {
            type: 'string',
            description: '目标文件路径；可使用相对于当前工作区的路径'
          }
        },
        required: ['source_path', 'destination_path']
      }
    },
    {
      name: 'delete_file',
      description: '删除文件或目录。',
      humanIntervention: 'required',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '要删除的文件或目录路径；可使用相对于当前工作区的路径'
          },
          recursive: {
            type: 'boolean',
            description: '若为目录，是否递归删除'
          }
        },
        required: ['file_path']
      }
    },
  ]
}

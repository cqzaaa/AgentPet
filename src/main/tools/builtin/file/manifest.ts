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
      description: '读取任意文件内容。支持 PDF、Word、Excel、CSV 及文本文件。支持使用 start_line 和 end_line 进行精确分页按行读取（对于文本和长网页 markdown 非常有用）。默认对大文件只读取前 30000 字符。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件绝对路径'
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
          directory_path: { type: 'string', description: '目录绝对路径；省略时列出当前会话附件目录' },
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
          file_path: { type: 'string', description: '文件绝对路径' }
        },
        required: ['file_path']
      }
    },
    {
      name: 'find_files',
      description: '在当前会话已授权目录内按文件名查找文件。用于“帮我找 xxx.txt”这类请求；搜索被限制在同一授权目录，不会自动切换磁盘。',
      parameters: {
        type: 'object',
        properties: {
          file_name: { type: 'string', description: '待查找的完整文件名，例如 erro.txt' },
          directory_path: { type: 'string', description: '已授权的起始目录；省略时使用当前会话附件目录' },
          max_depth: { type: 'number', description: '最大递归层级，默认 4，上限 8' },
          max_results: { type: 'number', description: '最多返回结果数，默认 20，上限 100' }
        },
        required: ['file_name']
      }
    },
    {
      name: 'write_file',
      description: '向指定路径写入文件。',
      humanIntervention: 'required',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '目标文件绝对路径'
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
            description: '绝对路径'
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
            description: '源文件绝对路径'
          },
          destination_path: {
            type: 'string',
            description: '目标文件绝对路径'
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
            description: '要删除的文件或目录绝对路径'
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

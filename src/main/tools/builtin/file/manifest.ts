import { ToolManifest } from '../../core/types'

export const fileManifest: ToolManifest = {
  identifier: 'agentpet-file',
  category: 'file',
  meta: {
    title: '文件操作',
    description: '读取、写入、修改、重命名、移动和删除文件，或操作工作区文件',
    avatar: '📂'
  },
  api: [
    {
      name: 'read_file',
      description: '读取任意文件内容。支持 PDF、Word、Excel、CSV 及文本文件。对大文件只读取前 30000 字符。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件绝对路径'
          }
        },
        required: ['file_path']
      }
    },
    {
      name: 'write_file',
      description: '向指定路径写入文件。',
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
    {
      name: 'list_workspace_files',
      description: '列出当前工作空间根目录下的所有文件和文件夹列表。',
      parameters: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'read_workspace_file',
      description: '读取工作空间内的相对路径文本文件。',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: '工作空间内的相对路径（如 src/main.js）'
          }
        },
        required: ['relative_path']
      }
    },
    {
      name: 'write_workspace_file',
      description: '向工作空间内的指定相对路径写入文本文件。',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: '工作空间内的相对路径'
          },
          content: {
            type: 'string',
            description: '写入文件的内容'
          }
        },
        required: ['relative_path', 'content']
      }
    }
  ]
}

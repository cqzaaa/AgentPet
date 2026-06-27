import { ToolManifest } from '../../core/types'

export const searchManifest: ToolManifest = {
  identifier: 'agentpet-search',
  category: 'search',
  meta: {
    title: '检索查询',
    description: '搜索文件和检索文件内容',
    avatar: '🔍'
  },
  api: [
    {
      name: 'search_files',
      description: '按关键词搜索文件名',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'string',
            description: '搜索关键词（空格分隔，所有词都必须出现）'
          },
          scope: {
            type: 'string',
            description: '搜索范围目录（可选，默认为当前工作区或用户主目录）'
          },
          file_types: {
            type: 'array',
            items: { type: 'string' },
            description: '文件类型过滤（可选）'
          },
          limit: {
            type: 'number',
            description: '返回结果数量限制（可选）'
          }
        },
        required: ['keywords']
      }
    },
    {
      name: 'grep_content',
      description: '在文件内容中搜索正则表达式',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '正则表达式模式'
          },
          scope: {
            type: 'string',
            description: '搜索范围目录（可选）'
          },
          glob: {
            type: 'string',
            description: '文件过滤的 glob 模式（可选，如 "*.js"）'
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: '输出模式（可选，默认为 files_with_matches）'
          },
          case_insensitive: {
            type: 'boolean',
            description: '是否忽略大小写（可选）'
          }
        },
        required: ['pattern']
      }
    },
    {
      name: 'glob_files',
      description: '按 glob 模式查找文件',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'glob 模式（如 "**/*.js", "src/**/*.ts"）'
          },
          scope: {
            type: 'string',
            description: '搜索范围目录（可选）'
          }
        },
        required: ['pattern']
      }
    }
  ]
}

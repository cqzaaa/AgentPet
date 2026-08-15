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
            description: '搜索范围目录或文件路径（可选）；可使用相对于当前工作区的路径，省略时优先搜索当前工作区。必须是本地路径，不能是 URL。'
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
          },
          timeout_seconds: {
            type: 'number',
            description: '可选。检索的最长超时秒数（在超大工程大范围搜索时可设置，默认为 30 秒）。'
          }
        },
        required: ['pattern']
      }
    }
  ]
}

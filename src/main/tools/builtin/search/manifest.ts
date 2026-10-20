import { ToolManifest } from '../../core/types'

export const queryProperties = {
  pattern: { type: 'string', description: '正则表达式；fixed_strings=true 时按字面字符串搜索' },
  scope: { type: 'string', description: '本地文件或目录，默认当前工作区；优先指定最窄的已知范围' },
  path: { type: 'string', description: 'scope 的兼容别名；推荐使用 scope，同时提供时必须指向同一路径' },
  glob: { type: 'string', description: '文件过滤，例如 *.ts' },
  include_generated: { type: 'boolean', description: '默认 false，跳过 node_modules、dist/build/out、source map 和压缩文件。只有确需调查依赖或构建产物时设为 true，并指定具体文件或子目录；不用于普通源码检索' },
  output_mode: {
    type: 'string', enum: ['content', 'files_with_matches', 'count'],
    description: '默认 content，返回匹配行及上下文；只定位文件用 files_with_matches，只统计匹配行用 count'
  },
  context_lines: { type: 'integer', minimum: 0, maximum: 80, description: '匹配行前后上下文行数；目录默认 3，已知单文件默认 12，最多 80。需要理解代码块时直接增大，避免再次 read_file；重叠上下文自动合并。仅 content 模式' },
  max_results: { type: 'integer', minimum: 1, maximum: 300, description: '最多返回的内容行/文件数，目录默认 100、单文件默认 200；截断会明确标记' },
  fixed_strings: { type: 'boolean', description: '按字面字符串搜索，适合精确符号、错误或 UI 文案' },
  case_insensitive: { type: 'boolean', description: '忽略大小写，默认 false' },
  timeout_seconds: { type: 'number', minimum: 1, maximum: 120, description: '单项最长时间，默认 30 秒' },
  question: { type: 'string', description: '可选：本次查询需要解决的具体问题，用于保留会话调查检查点' }
}

export const searchManifest: ToolManifest = {
  identifier: 'agentpet-search', category: 'search',
  meta: { title: '检索查询', description: '搜索文件和检索文件内容', avatar: '🔍' },
  api: [{
    name: 'grep_content',
    description: '使用 ripgrep 检索源码，默认排除依赖、构建产物、source map 与压缩文件，按文件归并带行号的匹配及上下文。已知文件默认提供更完整上下文；可用 context_lines 扩展代码块，避免搜索后再零碎读取。多个独立问题用 queries 一次批量检索（最多 6 项），每项分别指定范围、关键词和输出模式。提供 pattern 或 queries，二选一。优先复用已知位置，不要反复全仓库扫描。',
    // Each query has its own bounded timeout; batches may need two worker waves.
    timeout: 0,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...queryProperties,
        queries: {
          type: 'array', minItems: 1, maxItems: 6,
          description: '独立查询列表，按输入顺序返回；各项参数独立，不继承顶层参数，单项失败不丢失其它结果',
          items: { type: 'object', properties: queryProperties, required: ['pattern'], additionalProperties: false }
        }
      },
      anyOf: [{ required: ['pattern'] }, { required: ['queries'] }]
    }
  }]
}

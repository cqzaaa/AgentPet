import { ToolManifest } from '../../core/types'

export const officeManifest: ToolManifest = {
  identifier: 'agentpet-office',
  category: 'office',
  meta: {
    title: 'Office文档操作',
    description: '生成与修改 Excel、Word、PDF 等 Office 文档',
    avatar: '📊'
  },
  api: [
    {
      name: 'generate_file',
      description: '从零生成新文件。支持 txt、md、js、xlsx、docx、pdf、pptx 等格式。对于 Excel/Word 等，内容支持结构化 JSON。',
      parameters: {
        type: 'object',
        properties: {
          file_name: {
            type: 'string',
            description: '生成的文件名（如 result.xlsx）'
          },
          content: {
            type: 'string',
            description: '文本内容，或用于 Excel/Word 的结构化 JSON 数据'
          },
          file_type: {
            type: 'string',
            enum: ['text', 'excel', 'word', 'pdf', 'powerpoint'],
            description: '目标文件类型'
          }
        },
        required: ['file_name', 'content', 'file_type']
      }
    },
    {
      name: 'modify_docx_file',
      description: '修改已有的 Word 文档，进行段落/文本精准替换，或插入图片，并保留原有样式。',
      parameters: {
        type: 'object',
        properties: {
          source_path: {
            type: 'string',
            description: '原始 DOCX 文件路径'
          },
          output_name: {
            type: 'string',
            description: '修改后输出的目标文件名'
          },
          modifications: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: '要寻找和被替换的文本' },
                replace: { type: 'string', description: '替换成的新文本（若省略则仅应用样式）' },
                paragraphStyle: { type: 'string', description: '指定只替换拥有特定样式的段落（可选）' },
                style: {
                  type: 'object',
                  properties: {
                    bold: { type: 'boolean' },
                    italic: { type: 'boolean' },
                    underline: { type: 'boolean' },
                    color: { type: 'string', description: 'RGB颜色值如 FF0000' },
                    fontSize: { type: 'number', description: '字号的半磅数，如 24 代表 12pt' },
                    highlight: { type: 'string', description: '突出显示颜色如 yellow' }
                  }
                }
              },
              required: ['search']
            },
            description: '文本替换和样式修改配置'
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search_text: { type: 'string', description: '要寻找并替换为图片的占位文本' },
                image_path: { type: 'string', description: '要插入的图片本地文件路径' },
                width: { type: 'number', description: '图片宽度（厘米），默认 10' },
                height: { type: 'number', description: '图片高度（厘米），默认 8' }
              },
              required: ['search_text', 'image_path']
            },
            description: '插入图片的配置'
          }
        },
        required: ['source_path', 'output_name']
      }
    },
    {
      name: 'modify_xlsx_file',
      description: '修改已有的 Excel 电子表格，支持更新单元格、批量追加新行、数据验证、多 Sheet 插入等，使用 worker 线程隔离防止崩溃。',
      parameters: {
        type: 'object',
        properties: {
          source_path: {
            type: 'string',
            description: '原始 XLSX 电子表格文件路径'
          },
          output_name: {
            type: 'string',
            description: '修改后输出的目标文件名'
          },
          modifications: {
            type: 'object',
            description: '在现有 Sheet 中修改单元格数据，格式如: {"Sheet1": {"A1": "新值", "B2": 123}}'
          },
          append_rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sheet_name: { type: 'string', description: '目标工作表名' },
                rows: {
                  type: 'array',
                  items: { type: 'array', items: {} },
                  description: '要追加的数据行列表，每行是一个数组'
                }
              },
              required: ['sheet_name', 'rows']
            },
            description: '向指定 Sheet 批量追加的新行'
          },
          merge_cells: {
            type: 'object',
            description: '合并单元格，格式如: {"Sheet1": ["A1:B2"]}'
          },
          add_sheet: {
            type: 'array',
            items: { type: 'string' },
            description: '要创建的新工作表名称列表'
          },
          column_widths: {
            type: 'object',
            description: '设置列宽，格式如: {"Sheet1": {"A": 15, "B": 20}}'
          },
          data_validations: {
            type: 'object',
            description: '添加数据验证规则（下拉框等），格式如: {"Sheet1": {"C1:C10": {"type": "list", "formulae": ["\\"男,女\\""]}}}'
          }
        },
        required: ['source_path', 'output_name']
      }
    }
  ]
}

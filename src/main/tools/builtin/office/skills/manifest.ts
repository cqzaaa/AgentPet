import type { ToolManifest } from '../../../core/types'

export const officeSkillManifest: ToolManifest = {
  identifier: 'agentpet-office-skills',
  category: 'office',
  meta: {
    title: 'Office 文档 Skills',
    description: '按需加载 DOCX、XLSX、PDF、PPTX 的独立创建和修改能力。',
    avatar: '📄'
  },
  api: [
    {
      name: 'run_office_skill',
      humanIntervention: 'auto',
      timeout: 2_400_000,
      description:
        '创建、检查、修改、验证、预览或转换 Office 文件的统一执行工具。先用 request_skill 加载 office 及所需格式 sections；严格使用返回的 action.inputSchema，修改后必须 validate 或 render。',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            enum: ['docx', 'xlsx', 'pdf', 'pptx']
          },
          action: {
            type: 'string',
            enum: ['create', 'inspect', 'modify', 'validate', 'render', 'convert', 'semantic_edit']
          },
          input: {
            type: 'object',
            description: '参数结构由 request_skill 返回的对应 action.inputSchema 决定'
          }
        },
        required: ['skill', 'action', 'input']
      }
    }
  ]
}

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
      name: 'load_office_skill',
      humanIntervention: 'never',
      description:
        '处理 DOCX、XLSX、PDF 或 PPTX 文件时必须先调用，加载对应 Office Skill 的详细操作说明。除非用户明确要求用脚本实现，否则不要改用终端、Python、pandas 或 openpyxl。',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            enum: ['docx', 'xlsx', 'pdf', 'pptx'],
            description: '要加载的文件 Skill'
          }
        },
        required: ['skill']
      }
    },
    {
      name: 'run_office_skill',
      humanIntervention: 'auto',
      timeout: 300000,
      description:
        '创建、检查、修改、验证或预览 Office 文件的首选执行工具。先用 load_office_skill 获取 input schema；修改已有文件时先 inspect，完成后必须 validate。',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            enum: ['docx', 'xlsx', 'pdf', 'pptx']
          },
          action: {
            type: 'string',
            enum: ['create', 'inspect', 'modify', 'validate', 'render', 'convert']
          },
          input: {
            type: 'object',
            description: '参数结构由 load_office_skill 返回的对应 action.inputSchema 决定'
          }
        },
        required: ['skill', 'action', 'input']
      }
    }
  ]
}

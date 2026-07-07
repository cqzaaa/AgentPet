import { ToolManifest } from '../../core/types'

export const systemManifest: ToolManifest = {
  identifier: 'agentpet-system',
  category: 'system',
  meta: {
    title: '系统工具',
    description: '获取系统硬件及物理定位状态，管理后台定时任务',
    avatar: '⚙️'
  },
  api: [
    {
      name: 'get_system_status',
      description: '获取系统状态信息（包括CPU型号、核心数、可用与总内存、操作系统平台与运行时间等）',
      parameters: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'get_location',
      description: '使用 Windows WinRT Geolocator 现代接口获取物理定位。',
      parameters: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'manage_cron_task',
      description: '创建或删除后台自动触发的定时任务。',
      parameters: {
        type: 'object',
        properties: {
          action_type: {
            type: 'string',
            enum: ['create', 'delete'],
            description: '操作类型：create (创建) 或 delete (删除)'
          },
          name: {
            type: 'string',
            description: '定时任务名称（创建时必填）'
          },
          interval: {
            type: 'number',
            description: '执行时间周期（秒，最少2秒）'
          },
          action: {
            type: 'string',
            description: '任务触发时需要执行的操作/指令'
          },
          taskId: {
            type: 'string',
            description: '要删除的定时任务ID（删除时必填）'
          }
        },
        required: ['action_type']
      }
    },

    {
      name: 'trigger_memory_purify',
      description: '主动触发后台的记忆整理与经验沉淀 Pipeline。适用场景：长任务或重要探索结束后，将学到的知识归档整理为长期记忆。调用后系统会自动收集所有未处理的对话摘要，合并更新全局人物画像，并提取避坑经验写入长期记忆库。',
      parameters: {
        type: 'object',
        properties: {}
      }
    },

    {
      name: 'append_memory_summary',
      description: '保存重要对话摘要或报错避坑总结。title 用作主题文件名归档，系统将自动去除其中非法字符并加入基础元数据。',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '记忆/摘要的主题或报错标题（如 Windows下Excel读取报错）'
          },
          content: {
            type: 'string',
            description: '总结后的 Markdown 格式内容'
          }
        },
        required: ['title', 'content']
      }
    }
  ]
}

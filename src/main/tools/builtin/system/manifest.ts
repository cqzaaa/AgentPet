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
    }
  ]
}

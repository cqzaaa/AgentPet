import { ToolManifest } from '../../core/types'

export const terminalManifest: ToolManifest = {
  identifier: 'agentpet-terminal',
  category: 'terminal',
  meta: {
    title: '终端命令',
    description: '异步或同步执行终端命令，终止和管理终端进程',
    avatar: '💻'
  },
  api: [
    {
      name: 'run_command',
      description: '异步执行终端命令，返回 shell_id。适用于长时间运行的命令。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的终端命令'
          },
          description: {
            type: 'string',
            description: '命令的简短描述（5-10字）'
          },
          cwd: {
            type: 'string',
            description: '工作目录（可选）'
          }
        },
        required: ['command']
      }
    },
    {
      name: 'get_command_output',
      description: '获取正在运行的命令的最新输出',
      parameters: {
        type: 'object',
        properties: {
          shell_id: {
            type: 'string',
            description: '由 run_command 返回的终端会话ID'
          },
          filter: {
            type: 'string',
            description: '输出过滤的正则表达式（可选）'
          }
        },
        required: ['shell_id']
      }
    },
    {
      name: 'kill_command',
      description: '终止正在运行的终端命令',
      parameters: {
        type: 'object',
        properties: {
          shell_id: {
            type: 'string',
            description: '由 run_command 返回的终端会话ID'
          }
        },
        required: ['shell_id']
      }
    },
    {
      name: 'run_terminal_command',
      description: '同步执行终端命令并返回结果。适用于快速命令（≤2分钟），超时自动终止。',
      timeout: 120000,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的终端命令'
          },
          timeout_seconds: {
            type: 'number',
            description: '可选。命令执行的超时秒数。如果是如拉取镜像、编译打包等长耗时操作，请传入合适的值（例如 600 代表10分钟，或传入 0 代表无超时限制）。默认 120。'
          }
        },
        required: ['command']
      }
    }
  ],
  systemRole: `<tool_instructions>
你有一组终端工具可以执行系统命令。
<rules>
- 对于 ≤2分钟的快速命令，优先使用 run_terminal_command
- 对于长时间运行的命令（如服务器启动、打包编译），必须使用 run_command 异步执行
- 异步命令执行后，使用 get_command_output 跟踪最新的输出进度
- 使用 kill_command 终止不再需要的挂起或超时进程
</rules>
</tool_instructions>`
}

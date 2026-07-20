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
          },
          shell: {
            type: 'string',
            enum: ['powershell', 'bash', 'cmd'],
            description: '执行命令的 shell。本机默认 powershell；仅在需要 POSIX 语法时使用 bash；SSH 远程主机默认 bash。'
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
          shell: {
            type: 'string',
            enum: ['powershell', 'bash', 'cmd'],
            description: '执行命令的 shell。本机默认 powershell；仅在需要 POSIX 语法时使用 bash；SSH 远程主机默认 bash。'
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
- 创建、读取、修改或验证 DOCX、XLSX、PDF、PPTX 时，必须先使用 load_office_skill，再使用 run_office_skill；除非用户明确要求 Python 或终端脚本实现，否则禁止用 pandas、openpyxl 或自写脚本替代 Office Skill
- 禁止把多行程序或较长程序塞进 python -c、node -e 等单行命令；用户明确要求脚本实现时，应先写入脚本文件，再执行并检查产物
- 命令 exit_code 为 0 但预期输出或文件不存在时仍视为失败；应检查 stderr、目标路径和文件存在性并改变方案，不要重复执行近似命令
- 对于 ≤2分钟的快速命令，优先使用 run_terminal_command
- 对于长时间运行的命令（如服务器启动、打包编译），必须使用 run_command 异步执行
- 启动数据库、Web 服务、开发服务器、守护进程等常驻进程时，即使命令本身看似很短，也必须使用 run_command；禁止使用 run_terminal_command 等待常驻进程
- 异步命令执行后，使用 get_command_output 跟踪最新的输出进度
- 使用 kill_command 终止不再需要的挂起或超时进程
- 本机 Windows 默认使用 shell=powershell。PowerShell 命令示例：Get-Date、Get-ChildItem、Get-Process。
- PowerShell 中调用传统系统程序时使用完整可执行名，例如 sc.exe、where.exe，避免 sc、where 等别名冲突
- 命令返回非零 exit_code 不一定代表执行器异常：findstr/Select-String/grep 没有匹配、状态检查发现目标未运行时都可能返回非零。应结合 stdout、stderr 和命令语义判断
- 遇到 Access is denied、拒绝访问、System error 5、UnauthorizedAccess 等权限错误后，立即停止使用等价命令重复尝试；明确告知用户需要管理员权限或提升应用权限
- Windows 服务启动失败且确认是权限问题时，禁止绕过服务管理器直接启动其底层守护进程，除非用户明确要求临时手动启动并理解服务状态不会同步
- 验证数据库端口是否可用时优先使用 Test-NetConnection 或数据库自带的 readiness 工具；不要直接运行可能等待密码输入的交互式客户端
- 仅在需要 POSIX 语法或 Unix 工具链时显式使用 shell=bash，例如 date +"%Y-%m-%d"、grep、sed、awk。
- shell=cmd 仅用于 .bat 文件或明确的传统 CMD 命令。不要依赖命令文本自动猜测 shell。
- git、node、npm、python、rg（ripgrep）是可执行程序；它们可在不同 shell 中运行，但变量、引号和管道语法必须符合所选 shell。
- SSH 远程会话默认 shell=bash；除非远程主机明确是 Windows，才指定 shell=powershell 或 shell=cmd。
</rules>
</tool_instructions>`
}

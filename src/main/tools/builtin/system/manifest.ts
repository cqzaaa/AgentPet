import { ToolManifest } from '../../core/types'

export const systemManifest: ToolManifest = {
  identifier: 'agentpet-system',
  category: 'system',
  meta: {
    title: '系统工具',
    description: '获取系统硬件及物理定位状态，管理后台定时任务',
    avatar: '⚙️'
  },
  systemRole: `<task_plan_policy>
Never create a plan for a single-file, single-mutation, low-risk task without delegation. For substantial work, call update_task_plan exactly once before starting. Plan step ids and step count are immutable after creation. Copy step ids exactly from the update_task_plan result for every update_task_step call; never rename or expand an id. If update_task_step reports unknown_task_step, retry it with an exact id from validSteps and never call update_task_plan again. Keep one step in_progress at a time, then use update_task_step for status, result, artifact, or blocker updates; never resend the complete plan. The runtime advances the next step and closes a successfully finished plan automatically. Never send an empty plan update. Continue doing the work after every plan or step update.
</task_plan_policy>
<skill_policy>
The available skill catalog contains metadata only. Call request_skill only with exact ids from that catalog and only when the current request needs the full instructions. If a Skill advertises sections, do not request its overview: wait until the relevant file type or operation is known, then request all sections needed for the workflow in one call. Loading a skill activates only its declared tools for the current turn; it never bypasses approvals, sandboxing, or higher-priority safety rules. Load no more than three skills per turn.
</skill_policy>`,
  api: [
    {
      name: 'update_task_plan',
      description: 'Create the visible task plan once for a substantial multi-step task. Never use for a single-file, single-mutation, low-risk task. Use update_task_step afterward.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'A concise user-facing task title'
          },
          explanation: {
            type: 'string',
            description: 'Optional short note explaining a plan change or blocker'
          },
          steps: {
            type: 'array',
            minItems: 2,
            maxItems: 12,
            description: 'The complete ordered plan. Keep exactly one step in_progress while work is active.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable short identifier reused in later updates' },
                title: { type: 'string', description: 'Concise user-facing step title' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'blocked']
                },
                detail: { type: 'string', description: 'Optional progress, output, or blocker detail' },
                goal: { type: 'string', description: 'Concrete outcome this step must achieve' },
                dependencies: { type: 'array', items: { type: 'string' }, description: 'Step ids that must complete first' },
                acceptanceCriteria: { type: 'string', description: 'How completion will be verified' },
                resultSummary: { type: 'string', description: 'Concise result when the step is complete' },
                artifactPaths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths produced by the step' },
                retryCount: { type: 'number', description: 'Number of attempts already made' }
              },
              required: ['id', 'title', 'status']
            }
          }
        },
        required: ['title', 'steps']
      }
    },
    {
      name: 'delegate_tasks',
      description: 'Delegate independent or dependency-linked work to durable sub-agents. Independent tasks run in parallel and dependent tasks wait for prerequisites. Returns only after the group reaches a terminal state.',
      timeout: 0,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Concise title for the delegated task group' },
          maxConcurrency: { type: 'number', minimum: 1, maximum: 6, description: 'Maximum sub-agents running at once; defaults to 3' },
          tasks: {
            type: 'array', minItems: 1, maxItems: 12,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable unique task id used by dependencies' },
                title: { type: 'string' },
                prompt: { type: 'string', description: 'Self-contained assignment and scope' },
                role: { type: 'string', enum: ['general', 'researcher', 'coder', 'reviewer'] },
                dependencies: { type: 'array', items: { type: 'string' } },
                acceptanceCriteria: { type: 'string' }
              },
              required: ['id', 'title', 'prompt']
            }
          }
        },
        required: ['title', 'tasks']
      }
    },
    {
      name: 'update_task_step',
      description: 'Update one existing plan step without resending or changing the plan structure. Completing a step automatically starts the next ready step and completing the last step closes the plan.',
      parameters: {
        type: 'object',
        properties: {
          taskRunId: { type: 'string', description: 'taskRunId returned by update_task_plan' },
          stepId: { type: 'string', description: 'Copy one exact step id returned by update_task_plan; never rename or expand it' },
          status: {
            type: 'string',
            enum: ['in_progress', 'completed', 'blocked'],
            description: 'New status for this step'
          },
          detail: { type: 'string', description: 'Optional concise progress or blocker detail' },
          resultSummary: { type: 'string', description: 'Concise verified result when completed' },
          artifactPaths: { type: 'array', items: { type: 'string' }, description: 'Absolute artifact paths produced by this step' }
        },
        required: ['taskRunId', 'stepId', 'status']
      }
    },
    {
      name: 'request_skill',
      description: 'Load instructions for enabled skills listed in <available_skills> and activate only their declared tools. A Skill that advertises sections must include them: wait until the file type is known, then request every section needed for that workflow in one call. Never request an overview first or invent ids or sections.',
      parameters: {
        type: 'object',
        properties: {
          skills: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Exact Skill id from <available_skills>' },
                sections: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string' },
                  description: 'Optional exact sections advertised by that Skill; omit for the normal full/overview load'
                }
              },
              required: ['id']
            },
            description: 'One to three Skill requests'
          },
          reason: {
            type: 'string',
            description: 'A short explanation of why these skills are needed for the current request'
          }
        },
        required: ['skills', 'reason']
      }
    },
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
      name: 'request_user_clarification',
      description: '当任务因信息不足、范围模糊或需要用户选择时，弹出补充信息窗口并暂停当前任务。用户提交后会把答案返回，必须据此继续当前任务；一次最多提出 3 个简短问题。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1 到 3 个需要用户补充的问题',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '问题的稳定标识，例如 search_scope' },
                question: { type: 'string', description: '展示给用户的简短问题' },
                options: {
                  type: 'array',
                  description: '可选的快捷选项；用户始终可自定义输入',
                  items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, description: { type: 'string', description: '选项的简短补充说明' } }, required: ['label', 'value'] }
                },
                placeholder: { type: 'string', description: '自定义输入的提示文字' }
              },
              required: ['id', 'question']
            }
          }
        },
        required: ['questions']
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

import type { ToolManifest } from '../../core/types'

export const rpaManifest: ToolManifest = {
  identifier: 'agentpet-rpa',
  category: 'rpa',
  meta: {
    title: 'RPA 工作流',
    description: '搜索、查看、运行和管理用户已经保存的自动化工作流',
    avatar: '▶️'
  },
  api: [
    {
      name: 'rpa_search_workflows',
      description:
        '按自然语言搜索用户已保存的 RPA 工作流。准备运行工作流前必须先搜索，禁止猜测 workflow_id。',
      humanIntervention: 'never',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '用户想完成的任务，例如“下载订单并导入财务系统”；留空返回全部工作流'
          },
          limit: {
            type: 'number',
            description: '最多返回多少条结果，范围 1 到 20，默认 10'
          }
        },
        required: []
      }
    },
    {
      name: 'rpa_describe_workflow',
      description: '读取一个已保存 RPA 工作流的步骤摘要和需要提供的模板参数。',
      humanIntervention: 'never',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: {
            type: 'string',
            description: '由 rpa_search_workflows 返回的准确工作流 ID'
          }
        },
        required: ['workflow_id']
      }
    },
    {
      name: 'rpa_run_workflow',
      description:
        '启动一个已保存的 RPA 工作流。调用前必须先搜索并确认工作流，缺少模板参数时先向用户询问。',
      humanIntervention: 'required',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: {
            type: 'string',
            description: '由 rpa_search_workflows 返回的准确工作流 ID'
          },
          inputs: {
            type: 'object',
            description: '工作流模板参数，例如 {"date":"2026-07-16"}；没有参数时传空对象',
            additionalProperties: true
          }
        },
        required: ['workflow_id', 'inputs']
      }
    },
    {
      name: 'rpa_get_run_status',
      description: '根据 rpa_run_workflow 返回的 run_id 查询运行状态。',
      humanIntervention: 'never',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: 'RPA 运行 ID'
          }
        },
        required: ['run_id']
      }
    },
    {
      name: 'rpa_cancel_run',
      description: '取消仍在当前应用中运行或暂停的 RPA，并释放浏览器资源。',
      humanIntervention: 'never',
      parameters: {
        type: 'object',
        properties: {
          run_id: {
            type: 'string',
            description: '要取消的 RPA 运行 ID'
          }
        },
        required: ['run_id']
      }
    },
    {
      name: 'rpa_start_recording',
      description: '创建一个可恢复的 RPA 录制会话并可选立即打开起始网页。用于用户明确说“开始录制”时。真实系统默认使用 guided 模式，不允许 AI 自主探索。',
      humanIntervention: 'required',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工作流名称，例如“客户同步”' },
          objective: { type: 'string', description: '用户希望录制的业务目标' },
          start_url: { type: 'string', description: '浏览器录制起始 URL；不知道时留空，工具会创建 preparing 会话' },
          mode: { type: 'string', enum: ['guided', 'collaborative', 'autonomous'], description: '默认 guided；生产系统禁止擅自使用 autonomous' }
        },
        required: ['name', 'objective']
      }
    },
    {
      name: 'rpa_pause_recording',
      description: '暂停录制并停止接收新的浏览器动作。',
      humanIntervention: 'never',
      parameters: { type: 'object', properties: { recording_session_id: { type: 'string' } }, required: ['recording_session_id'] }
    },
    {
      name: 'rpa_resume_recording',
      description: '恢复录制；preparing 会话首次恢复时必须提供 start_url。',
      humanIntervention: 'never',
      parameters: { type: 'object', properties: { recording_session_id: { type: 'string' }, start_url: { type: 'string' } }, required: ['recording_session_id'] }
    },
    {
      name: 'rpa_get_recording_status',
      description: '查询录制会话状态、动作数和缺失的凭据绑定数量。',
      humanIntervention: 'never',
      parameters: { type: 'object', properties: { recording_session_id: { type: 'string' } }, required: ['recording_session_id'] }
    },
    {
      name: 'rpa_finish_recording',
      description: '停止录制，将安全清洗后的动作编译成工作流并持久化保存。',
      humanIntervention: 'required',
      parameters: { type: 'object', properties: { recording_session_id: { type: 'string' } }, required: ['recording_session_id'] }
    },
    {
      name: 'rpa_bind_recording_secret',
      description: '为 reviewing 状态中的敏感输入绑定 secretRef。不得传递真实凭据值。',
      humanIntervention: 'never',
      parameters: {
        type: 'object',
        properties: {
          recording_session_id: { type: 'string' },
          selector: { type: 'string', description: '录制动作中的 DOM selector' },
          secret_ref: { type: 'string', description: '例如 secret.crm.password' }
        },
        required: ['recording_session_id', 'selector', 'secret_ref']
      }
    },
    {
      name: 'rpa_cancel_recording',
      description: '取消录制并关闭录制浏览器，不生成工作流。',
      humanIntervention: 'never',
      parameters: { type: 'object', properties: { recording_session_id: { type: 'string' } }, required: ['recording_session_id'] }
    }
  ],
  systemRole: `<rpa_tool_instructions>
- 当用户希望执行重复的自动化流程时，先调用 rpa_search_workflows 搜索已有工作流。
- 只能使用搜索结果返回的 workflow_id，禁止编造 ID。
- 找到多个相似工作流或缺少必要参数时，先请求用户澄清。
- 运行前使用 rpa_describe_workflow 检查步骤和模板参数。
- rpa_run_workflow 返回 run_id 后，可以用 rpa_get_run_status 跟踪结果。
- 用户明确说“开始录制”时调用 rpa_start_recording，不要把录制请求误判为运行已有流程。
- start_url 未知时允许先创建 preparing 会话，然后向用户询问 URL，再调用 rpa_resume_recording。
- reviewing 状态存在 missingSecretBindings 时，先使用 rpa_bind_recording_secret 绑定已有 secretRef，再结束保存。
- 真实 CRM/ERP 默认使用 guided 模式；不得自行选择 autonomous。
- 不要把“已启动”描述成“已完成”；只有状态为 success 或 recording status 为 completed 时才能声称完成。
</rpa_tool_instructions>`
}

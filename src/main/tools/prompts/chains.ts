export interface ChatPayload {
  messages: any[]
  temperature: number
}

export function compressContextChain(messages: any[]): ChatPayload {
  return {
    messages: [
      {
        role: 'system',
        content: `你是一个专业的对话历史压缩助手。将给定的用户与智能助手的对话历史进行高度提炼，压缩为简洁的摘要。
你必须保留以下关键信息：
1. 用户要达成的最终目标
2. 已经做出的重要技术/架构决策
3. 已经调用的关键工具、参数及其核心结果（如生成的文件路径、执行的命令）
4. 当前未完成的待办事项和下一步计划
<rules>
- 删除无意义的客套、确认、或者冗余的中间错误排查步骤
- 保持信息的高度准确度，特别是涉及到的文件路径、IP/端口、密码等硬编码关键值不能丢失
- 使用第三人称叙述（如“用户要求... 助手执行了... 并成功生成了...”）
- 整体控制在 500 Token 以内
</rules>`
      },
      {
        role: 'user',
        content: `<chat_history>
${messages.map(m => `<message role="${m.role}">${m.content || ''}</message>`).join('\n')}
</chat_history>

请压缩并输出该对话历史的最终摘要。`
      }
    ],
    temperature: 0.1
  }
}

export function summaryTitleChain(conversation: string): ChatPayload {
  return {
    messages: [
      {
        role: 'system',
        content: '为这段对话生成简洁的中文标题，不超过 20 个字，不需要加引号。'
      },
      {
        role: 'user',
        content: conversation
      }
    ],
    temperature: 0.3
  }
}

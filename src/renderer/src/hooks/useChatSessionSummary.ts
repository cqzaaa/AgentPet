/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback } from 'react'
import { formatDateTime } from '../utils/helpers'

interface ChatSummaryState {
  contextRounds: number
  llmConfig: any
}

interface ChatSessionSummaryOptions {
  getState: () => ChatSummaryState
  setSessions: (updater: (sessions: any[]) => any[]) => void
}

/** Summarises completed chat rounds without coupling the send pipeline to the aggregate app hook. */
export function useChatSessionSummary({ getState, setSessions }: ChatSessionSummaryOptions): {
  triggerSessionSummary: (sessionId: string, latestSessions: any[]) => Promise<void>
} {
  const triggerSessionSummary = useCallback(async (sessionId: string, latestSessions: any[]): Promise<void> => {
    const session = latestSessions.find(item => item.id === sessionId)
    if (!session) return

    const { contextRounds, llmConfig } = getState()
    const triggerCount = contextRounds * 2
    const completed = (session.messages || []).filter((message: any) =>
      (message.sender === 'user' || message.sender === 'agent') && !message.isThinking && !message.isError
    )
    const unsummarized = completed.filter((message: any) => !message.isSummarized)
    if (unsummarized.length < triggerCount) {
      console.log(`[Summary] 未总结消息条数 (${unsummarized.length}/${triggerCount})，暂不触发总结。`)
      return
    }

    const summaryBatch = unsummarized.slice(0, triggerCount)
    let chatLog = ''
    for (const message of summaryBatch) {
      const roleName = message.sender === 'user' ? '用户 (User)' : '助手 (Agent)'
      chatLog += `[${roleName}]：${message.text}\n`
      if (message.toolSteps?.length) {
        chatLog += '  工具调用过程:\n'
        for (const step of message.toolSteps) {
          if (step.type === 'call') {
            chatLog += `    - 尝试执行工具 [${step.name}]，参数: ${JSON.stringify(step.detail)}\n`
          } else if (step.type === 'result') {
            const detail = String(step.detail)
            const failed = message.isError || detail.toLowerCase().includes('error') || detail.toLowerCase().includes('fail')
            chatLog += `    - 工具 [${step.name}] 执行${failed ? '失败' : '成功'}，返回结果: ${detail.slice(0, 1000)}\n`
          }
        }
      }
      chatLog += '\n'
    }

    const systemPrompt = `你是一个经验丰富的 AI 对话与开发任务总结助手。
请你仔细阅读以下【一轮包含了用户提问、助手回答及本地系统工具调用的对话日志】，并为他们生成一段精炼、实用的 Markdown 摘要。

请遵循以下总结规则：
1. 用一到两句话提炼这部分对话中的核心任务或日常交流主题。
2. **非常重要**：请检索这部分对话中是否存在任何“工具调用（Terminal终端命令、MCP工具、文档读写等）执行失败或产生报错（Error）”的情况。
3. 如果有调用报错：
   - 提取出发生了什么错误，哪一步失败了。
   - 提取出最终是如何解决的（若已解决），或者总结出在此类任务中需要注意的“避坑教训/经验沉淀”。
   - 将这部分写在特定的“### 🛠 任务执行与避坑经验沉淀”标题下。
4. 如果没有报错，则不需要写避坑经验小节。
5. 不要包含过多的寒暄，直接输出 Markdown 总结内容。
6. **字数严格限制**：生成的摘要与避坑经验沉淀总字数必须严格控制在 300 字以内，简明扼要，直击重点，剔除任何修饰性词汇。
7. **精准 Wiki 溯源**：如果对话日志中助手参考了特定的本地文件或缓存文档路径（日志中可能已有 \`<!-- 关联文件: ... -->\` 注释），在总结对应要点时，请务必在这句话的末尾**原样保留或加上**该 HTML 注释文件引用，以实现知识到文件的精准溯源。

以下是对话日志：
----------------------
${chatLog}
----------------------`

    try {
      console.log(`[Summary] 开始生成 ${summaryBatch.length} 条消息的记忆摘要与纠错沉淀...`)
      const result = await window.api.callLLM(
        { ...llmConfig, temperature: 0.3, sessionId: 'system:summary' },
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请为以上对话日志生成 Markdown 摘要与经验沉淀。' }
        ]
      )

      const time = formatDateTime()
      let backup = '\n\n---\n<details>\n<summary>展开查看本次对话原始备份</summary>\n\n'
      for (const message of summaryBatch) {
        const roleName = message.sender === 'user' ? '用户 (User)' : '助手 (Agent)'
        backup += `**${roleName}**:\n${message.text || ''}\n\n`
      }
      backup += '</details>'
      const markdown = `## [${time}] 记忆摘要与纠错沉淀\n${result.trim()}${backup}`
      if (!(await window.api.appendMemorySummary(sessionId, markdown))) return

      const batchIds = new Set(summaryBatch.map((message: any) => message.id))
      const savedMessages: any[] = []
      let contextSummary = ''
      setSessions(previous => previous.map(item => {
        if (item.id !== sessionId) return item
        const messages = item.messages.map((message: any) => {
          if (!batchIds.has(message.id)) return message
          const updated = { ...message, isSummarized: true }
          savedMessages.push(updated)
          return updated
        })
        contextSummary = item.contextSummary ? `${item.contextSummary}\n\n${markdown}` : markdown
        return { ...item, messages, contextSummary }
      }))

      if (savedMessages.length > 0) {
        window.api.saveMessages(savedMessages.map(message => ({ ...message, sessionId }))).catch(console.error)
      }
      if (contextSummary) {
        window.api.updateSession(sessionId, { contextSummary }).catch(error =>
          console.error('[Summary] 持久化 contextSummary 到 DB 失败:', error)
        )
      }
    } catch (error) {
      console.error('[Summary] 生成对话总结失败:', error)
    }
  }, [getState, setSessions])

  return { triggerSessionSummary }
}

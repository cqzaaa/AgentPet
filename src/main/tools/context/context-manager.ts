import { countTokens, countMessagesTokens } from './token-counter'

export class ContextManager {
  private maxTokens: number
  private compressThreshold: number

  constructor(maxTokens = 32000, compressThreshold = 0.75) {
    this.maxTokens = maxTokens
    this.compressThreshold = compressThreshold
  }

  /**
   * 判断当前上下文是否需要触发压缩
   */
  public shouldTriggerCompress(messages: any[], systemRole: string): boolean {
    const systemTokens = countTokens(systemRole)
    const msgTokens = countMessagesTokens(messages)
    return (systemTokens + msgTokens) > (this.maxTokens * this.compressThreshold)
  }

  /**
   * 分组感知截断：过滤掉超出 Token 预算的旧消息，但保证“用户消息+工具调用+工具返回”作为一个完整周期被成组保留/舍弃
   */
  public truncateWithGroups(messages: any[], systemRole: string): any[] {
    const systemTokens = countTokens(systemRole)
    const budget = this.maxTokens * 0.9 - systemTokens

    const groups: any[][] = []
    let currentGroup: any[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (currentGroup.length > 0) {
          groups.push(currentGroup)
        }
        currentGroup = [msg]
      } else {
        currentGroup.push(msg)
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup)
    }

    const selected: any[][] = []
    let usedTokens = 0

    // 从后往前（从新到旧）遍历
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]
      const groupTokens = countMessagesTokens(group)
      if (usedTokens + groupTokens > budget) {
        // 超出剩余预算，截断较老的组
        break
      }
      selected.unshift(group)
      usedTokens += groupTokens
    }

    return selected.flat()
  }
}

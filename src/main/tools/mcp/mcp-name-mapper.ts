import * as crypto from 'crypto'

export class McpNameMapper {
  // 运行时内存映射表：hashName -> originalName
  private static hashToOriginalMap = new Map<string, string>()

  /**
   * 混淆/哈希工具名称（给模型看）
   * 如果长度 >= 64 或包含不合规字符，将其转换为合规的 MD5 格式
   */
  public static toSafeModelName(originalName: string): string {
    const isCompliant = /^[a-zA-Z0-9_-]+$/.test(originalName)

    // 如果名字合规且长度小于 55（预留部分余量），不需要哈希
    if (isCompliant && originalName.length < 55) {
      return originalName
    }

    // 否则，将其哈希化为 64 字节以内：mcp_[md5]
    const md5 = crypto.createHash('md5').update(originalName).digest('hex')
    const safeName = `mcp_${md5}`

    // 写入双向映射表
    this.hashToOriginalMap.set(safeName, originalName)
    return safeName
  }

  /**
   * 反向还原工具名称（执行时看）
   * 如果是大模型返回的哈希名称，将其还原为真实的 MCP 工具名称
   */
  public static toOriginalName(modelName: string): string {
    return this.hashToOriginalMap.get(modelName) || modelName
  }
}

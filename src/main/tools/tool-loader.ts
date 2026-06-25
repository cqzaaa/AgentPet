import * as fs from 'fs'
import { join } from 'path'
import { app } from 'electron'

// 工具定义接口
interface ToolParameter {
  type: string
  description: string
  enum?: string[]
  items?: any
  properties?: Record<string, any>
  required?: string[]
  additionalProperties?: any
}

interface ToolDefinition {
  name: string
  category: string
  description: string
  parameters: {
    type: string
    properties: Record<string, ToolParameter>
    required: string[]
  }
  returns?: Record<string, string>
  usage?: string
}

interface ToolCategory {
  name: string
  description: string
  tools: string[]
}

interface ToolDefinitionsFile {
  version: string
  lastUpdated: string
  categories: Record<string, ToolCategory>
  tools: Record<string, ToolDefinition>
}

// 工具加载器类
export class ToolLoader {
  private tools: Map<string, ToolDefinition> = new Map()
  private categories: Map<string, ToolCategory> = new Map()
  private version: string = ''
  private lastUpdated: string = ''

  constructor() {
    this.loadTools()
  }

  // 加载工具定义
  private loadTools(): void {
    try {
      // 获取应用根目录，支持开发和生产环境
      const appPath = app.getAppPath()
      const toolDefsPath = join(appPath, 'src', 'main', 'tools', 'tool-definitions.json')
      const content = fs.readFileSync(toolDefsPath, 'utf-8')
      const data: ToolDefinitionsFile = JSON.parse(content)

      this.version = data.version
      this.lastUpdated = data.lastUpdated

      // 加载分类
      for (const [key, category] of Object.entries(data.categories)) {
        this.categories.set(key, category)
      }

      // 加载工具
      for (const [key, tool] of Object.entries(data.tools)) {
        this.tools.set(key, tool)
      }

      console.log(`[ToolLoader] 加载了 ${this.tools.size} 个工具，${this.categories.size} 个分类`)
    } catch (error) {
      console.error('[ToolLoader] 加载工具定义失败:', error)
    }
  }

  // 获取所有工具定义（转换为 LLM 格式）
  getToolDefinitions(): any[] {
    const definitions: any[] = []

    for (const [, tool] of this.tools.entries()) {
      definitions.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      })
    }

    return definitions
  }

  // 获取工具信息（包含使用说明）
  getToolInfo(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName)
  }

  // 获取所有工具信息
  getAllToolsInfo(): Record<string, ToolDefinition> {
    const result: Record<string, ToolDefinition> = {}
    for (const [name, tool] of this.tools.entries()) {
      result[name] = tool
    }
    return result
  }

  // 获取分类信息
  getCategories(): Record<string, ToolCategory> {
    const result: Record<string, ToolCategory> = {}
    for (const [name, category] of this.categories.entries()) {
      result[name] = category
    }
    return result
  }

  // 获取工具摘要（用于提示词）
  getToolsSummary(): string {
    let summary = `# 可用工具列表\n\n`
    summary += `版本: ${this.version}\n`
    summary += `更新时间: ${this.lastUpdated}\n\n`

    // 按分类组织
    for (const [, category] of this.categories.entries()) {
      summary += `## ${category.name}\n`
      summary += `${category.description}\n\n`

      for (const toolName of category.tools) {
        const tool = this.tools.get(toolName)
        if (tool) {
          summary += `### ${tool.name}\n`
          summary += `${tool.description}\n`
          if (tool.usage) {
            summary += `**使用场景**: ${tool.usage}\n`
          }
          summary += `\n`
        }
      }
    }

    return summary
  }

  // 获取工具的详细文档
  getToolDocumentation(toolName: string): string {
    const tool = this.tools.get(toolName)
    if (!tool) {
      return `工具 ${toolName} 不存在`
    }

    let doc = `# ${tool.name}\n\n`
    doc += `${tool.description}\n\n`

    if (tool.usage) {
      doc += `## 使用场景\n${tool.usage}\n\n`
    }

    doc += `## 参数\n`
    for (const [paramName, param] of Object.entries(tool.parameters.properties)) {
      const required = tool.parameters.required?.includes(paramName) ? '(必填)' : '(可选)'
      doc += `- **${paramName}** ${required}: ${param.description}\n`
      if (param.enum) {
        doc += `  可选值: ${param.enum.join(', ')}\n`
      }
    }

    if (tool.returns) {
      doc += `\n## 返回值\n`
      for (const [key, desc] of Object.entries(tool.returns)) {
        doc += `- **${key}**: ${desc}\n`
      }
    }

    return doc
  }

  // 重新加载工具定义（支持热更新）
  reload(): void {
    this.tools.clear()
    this.categories.clear()
    this.loadTools()
  }

  // 获取工具数量
  getToolCount(): number {
    return this.tools.size
  }

  // 检查工具是否存在
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName)
  }
}

// 创建单例实例
export const toolLoader = new ToolLoader()

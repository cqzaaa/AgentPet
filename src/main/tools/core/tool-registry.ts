import { ToolManifest, IToolExecutor } from './types'

export class ToolRegistry {
  private static instance: ToolRegistry
  private manifestMap = new Map<string, ToolManifest>()
  private executorMap = new Map<string, IToolExecutor>()

  private constructor() {}

  public static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry()
    }
    return ToolRegistry.instance
  }

  public register(manifest: ToolManifest, executor: IToolExecutor): void {
    for (const api of manifest.api) {
      this.manifestMap.set(api.name, manifest)
      this.executorMap.set(api.name, executor)
    }
  }

  public getManifest(apiName: string): ToolManifest | undefined {
    return this.manifestMap.get(apiName)
  }

  public getExecutor(apiName: string): IToolExecutor | undefined {
    return this.executorMap.get(apiName)
  }

  public getAllManifests(): ToolManifest[] {
    const uniqueManifests = new Set<ToolManifest>()
    for (const manifest of this.manifestMap.values()) {
      uniqueManifests.add(manifest)
    }
    return Array.from(uniqueManifests)
  }

  public getToolsSummary(): string {
    let summary = `# 可用工具列表\n\n`
    summary += `版本: 2.0.0 (重构版)\n`
    summary += `更新时间: 2026-06-27\n\n`

    const categories: Record<string, { name: string; description: string; tools: string[] }> = {
      terminal: { name: '终端命令', description: '执行和管理终端命令', tools: [] },
      file: { name: '文件操作', description: '读取、写入、编辑文件', tools: [] },
      search: { name: '搜索查找', description: '搜索文件和内容', tools: [] },
      office: { name: 'Office 文档', description: '处理 Excel、Word、PDF 等文档', tools: [] },
      system: { name: '系统工具', description: '系统状态和任务管理', tools: [] },
      rpa: { name: 'RPA 工作流', description: '搜索并执行持久化自动化流程', tools: [] }
    }

    for (const manifest of this.getAllManifests()) {
      const cat = manifest.category
      if (categories[cat]) {
        for (const api of manifest.api) {
          categories[cat].tools.push(api.name)
        }
      }
    }

    for (const [_key, cat] of Object.entries(categories)) {

      if (cat.tools.length === 0) continue
      summary += `## ${cat.name}\n`
      summary += `${cat.description}\n\n`
      for (const toolName of cat.tools) {
        const manifest = this.getManifest(toolName)
        const api = manifest?.api.find(a => a.name === toolName)
        if (api && !api.hidden) {
          summary += `### ${api.name}\n`
          summary += `${api.description}\n\n`
        }
      }
    }
    return summary
  }

  public getToolDocumentation(toolName: string): string {
    const manifest = this.getManifest(toolName)
    const api = manifest?.api.find(a => a.name === toolName)
    if (!api) {
      return `工具 ${toolName} 不存在`
    }

    let doc = `# ${api.name}\n\n`
    doc += `${api.description}\n\n`

    doc += `## 参数\n`
    const props = api.parameters.properties || {}
    for (const [paramName, param] of Object.entries(props as Record<string, any>)) {
      const required = api.parameters.required?.includes(paramName) ? '(必填)' : '(可选)'
      doc += `- **${paramName}** ${required}: ${param.description || ''}\n`
      if (param.enum) {
        doc += `  可选值: ${param.enum.join(', ')}\n`
      }
    }

    return doc
  }

  public getAllToolsInfo(): Record<string, any> {
    const result: Record<string, any> = {}
    for (const [apiName, manifest] of this.manifestMap.entries()) {
      const api = manifest.api.find(a => a.name === apiName)
      if (api && !api.hidden) {
        result[apiName] = {
          name: api.name,
          category: manifest.category,
          description: api.description,
          parameters: api.parameters
        }
      }
    }
    return result
  }

  public getCategories(): Record<string, any> {
    const categories: Record<string, { name: string; description: string; tools: string[] }> = {
      terminal: { name: '终端命令', description: '执行和管理终端命令', tools: [] },
      file: { name: '文件操作', description: '读取、写入、编辑文件', tools: [] },
      search: { name: '搜索查找', description: '搜索文件和内容', tools: [] },
      office: { name: 'Office 文档', description: '处理 Excel、Word、PDF 等文档', tools: [] },
      system: { name: '系统工具', description: '系统状态和任务管理', tools: [] },
      rpa: { name: 'RPA 工作流', description: '搜索并执行持久化自动化流程', tools: [] }
    }

    for (const [apiName, manifest] of this.manifestMap.entries()) {
      const cat = manifest.category
      const api = manifest.api.find(item => item.name === apiName)
      if (categories[cat] && api && !api.hidden && !categories[cat].tools.includes(apiName)) {
        categories[cat].tools.push(apiName)
      }
    }
    return categories
  }

  public getToolCount(): number {
    let count = 0
    for (const [apiName, manifest] of this.manifestMap.entries()) {
      const api = manifest.api.find(item => item.name === apiName)
      if (api && !api.hidden) count++
    }
    return count
  }

  public reload(): void {
    // 兼容接口，无操作
    console.log('[ToolRegistry] 触发重新加载（重构版，无需重新读取文件）')
  }

  public clear(): void {
    this.manifestMap.clear()
    this.executorMap.clear()
  }
}

export const toolRegistry = ToolRegistry.getInstance()

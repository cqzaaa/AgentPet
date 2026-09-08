import type { WorkflowCondition, WorkflowDraft } from '../../preload/workflow-types'

export function evaluateWorkflowCondition(condition: WorkflowCondition, summary: string): boolean {
  let value: unknown = summary
  if (condition.path.trim()) {
    try {
      value = JSON.parse(summary.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
    } catch {
      throw new Error('条件判断需要 JSON 输出，请让前置 Agent 返回有效 JSON')
    }
    for (const key of condition.path.split('.')) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('不支持的字段路径')
      value =
        value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined
    }
  }
  switch (condition.operator) {
    case 'exists':
      return value !== undefined && value !== null
    case 'equals':
      return String(value) === condition.value
    case 'not_equals':
      return String(value) !== condition.value
    case 'contains':
      return String(value ?? '').includes(condition.value)
    case 'greater':
      return (
        Number.isFinite(Number(value)) &&
        Number.isFinite(Number(condition.value)) &&
        Number(value) > Number(condition.value)
      )
    default:
      throw new Error('不支持的条件运算符')
  }
}

export function validateWorkflow(draft: WorkflowDraft): void {
  if (!draft.title?.trim()) throw new Error('请填写工作流名称')
  if (!Array.isArray(draft.nodes) || !draft.nodes.length || draft.nodes.length > 12)
    throw new Error('工作流需要 1–12 个节点')
  if (!Array.isArray(draft.edges)) throw new Error('流程连线无效')
  const ids = new Set(draft.nodes.map((node) => node.id))
  if (ids.size !== draft.nodes.length) throw new Error('节点 ID 不能重复')
  for (const node of draft.nodes) {
    if (!node.data.title.trim()) throw new Error('请填写节点名称')
    const control = node.data.control
    if (control?.kind === 'condition') {
      const condition = control.condition
      if (
        !condition ||
        !ids.has(condition.source) ||
        !draft.edges.some((edge) => edge.source === condition.source && edge.target === node.id)
      )
        throw new Error('条件节点需要连接并选择一个前置节点')
      if (!['equals', 'not_equals', 'contains', 'greater', 'exists'].includes(condition.operator))
        throw new Error('条件运算符无效')
    } else if (control?.kind === 'rpa') {
      if (!control.rpaTaskId) throw new Error('请选择 RPA 子流程')
    } else if (!node.data.prompt.trim()) throw new Error('Agent 节点需要任务指令')
    if (
      control?.repeat !== undefined &&
      (!Number.isInteger(control.repeat) || control.repeat < 1 || control.repeat > 20)
    )
      throw new Error('循环次数必须为 1–20 的整数')
  }
  for (const edge of draft.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error('连线引用了不存在的节点')
    if (
      draft.nodes.find((node) => node.id === edge.source)?.data.control?.kind === 'condition' &&
      !['true', 'false'].includes(edge.sourceHandle || '')
    )
      throw new Error('请从条件节点的是 / 否端点连接分支')
  }
  const remaining = new Set(ids)
  while (remaining.size) {
    const ready = [...remaining].filter((id) =>
      draft.edges.filter((edge) => edge.target === id).every((edge) => !remaining.has(edge.source))
    )
    if (!ready.length) throw new Error('请使用节点的循环次数配置，流程连线不能形成循环依赖')
    ready.forEach((id) => remaining.delete(id))
  }
}

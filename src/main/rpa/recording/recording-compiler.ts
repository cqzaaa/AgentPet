import type { BrowserRecordedAction, RpaEdge, RpaNode } from '../domain/types'

export interface CompiledRecording {
  nodes: RpaNode[]
  edges: RpaEdge[]
  missingSecretBindings: number
}

export function compileBrowserRecording(actions: BrowserRecordedAction[]): CompiledRecording {
  const nodes: RpaNode[] = [
    { id: 'start', type: 'start', data: { label: '开始' }, position: { x: 280, y: 40 } }
  ]
  let missingSecretBindings = 0
  actions.slice(0, 1000).forEach((action, index) => {
    const id = `recorded_${index + 1}`
    const position = { x: 280, y: 150 + index * 120 }
    if (action.type === 'open_url') {
      nodes.push({ id, type: 'open_url', position, data: { label: '打开网页', url: action.url } })
    } else if (action.type === 'click') {
      nodes.push({ id, type: 'click', position, data: { label: action.label || '点击元素', selector: action.selector } })
    } else if (action.valueSource?.type === 'secretRef') {
      nodes.push({
        id,
        type: 'fill',
        position,
        data: {
          label: action.label || '敏感输入',
          selector: action.selector,
          value: `\${${action.valueSource.ref}}`,
          valueSource: action.valueSource
        }
      })
    } else if (action.sensitive) {
      missingSecretBindings += 1
      nodes.push({
        id,
        type: 'fill',
        position,
        data: { label: action.label || '敏感输入', selector: action.selector, value: '', requiresCredentialBinding: true }
      })
    } else {
      nodes.push({
        id,
        type: 'fill',
        position,
        data: { label: action.label || '输入文本', selector: action.selector, value: action.value || '' }
      })
    }
  })
  nodes.push({ id: 'end', type: 'end', position: { x: 280, y: 150 + actions.length * 120 }, data: { label: '结束' } })
  const edges = nodes.slice(0, -1).map((node, index) => ({
    id: `edge_${index}`,
    source: node.id,
    target: nodes[index + 1].id
  }))
  return { nodes, edges, missingSecretBindings }
}

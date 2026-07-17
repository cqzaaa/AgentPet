import type { JsonValue, RpaAction, RpaNode, RpaRiskLevel } from '../domain/types'

const toText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value)

const sanitizeUrl = (value: unknown): string => {
  const rawUrl = toText(value)
  try {
    const parsed = new URL(rawUrl)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return rawUrl.split(/[?#]/, 1)[0]
  }
}

const metadataFor = (node: RpaNode): Record<string, JsonValue> => ({
  legacyNodeType: node.type,
  label: toText(node.data?.label)
})

const riskFor = (nodeType: string): RpaRiskLevel => {
  if (nodeType === 'extract' || nodeType === 'start' || nodeType === 'end') return 'read'
  if (nodeType === 'ai_node') return 'external'
  if (nodeType === 'manual_confirm') return 'critical'
  return 'write'
}

/** Converts the current visual-editor node format into the durable action model. */
export function legacyNodeToAction(node: RpaNode): RpaAction {
  const base = {
    id: node.id,
    risk: riskFor(node.type),
    metadata: metadataFor(node)
  } as const

  switch (node.type) {
    case 'start':
      return { ...base, kind: 'workflow.start', surface: 'system' }
    case 'end':
      return { ...base, kind: 'workflow.end', surface: 'system' }
    case 'open_url':
      return {
        ...base,
        kind: 'browser.open',
        surface: 'browser',
        input: { url: sanitizeUrl(node.data?.url) }
      }
    case 'click':
      return {
        ...base,
        kind: 'browser.click',
        surface: 'browser',
        target: { selector: toText(node.data?.selector) }
      }
    case 'fill': {
      const value = toText(node.data?.value)
      return {
        ...base,
        kind: 'browser.fill',
        surface: 'browser',
        target: { selector: toText(node.data?.selector) },
        input: {
          valueSource: value.includes('{{') ? 'variable' : 'literal',
          valueLength: value.length
        }
      }
    }
    case 'desktop_focus':
      return {
        ...base,
        kind: 'desktop.focus',
        surface: 'desktop',
        target: {
          windowTitle: toText(node.data?.windowTitle),
          processName: toText(node.data?.processName)
        }
      }
    case 'desktop_click':
      return {
        ...base,
        kind: 'desktop.click',
        surface: 'desktop',
        target: {
          automationId: toText(node.data?.automationId),
          controlType: toText(node.data?.controlType),
          name: toText(node.data?.name),
          x: Number(node.data?.x) || undefined,
          y: Number(node.data?.y) || undefined
        }
      }
    case 'desktop_type': {
      const value = toText(node.data?.value)
      return {
        ...base,
        kind: 'desktop.type',
        surface: 'desktop',
        input: {
          valueSource: node.data?.valueSource?.type || (value.includes('${secret.') ? 'secretRef' : 'literal'),
          valueLength: value.includes('${secret.') ? 0 : value.length
        }
      }
    }
    case 'desktop_hotkey':
      return { ...base, kind: 'desktop.hotkey', surface: 'desktop', input: { keys: toText(node.data?.keys) } }
    case 'desktop_scroll':
      return {
        ...base,
        kind: 'desktop.scroll',
        surface: 'desktop',
        input: { direction: toText(node.data?.direction), amount: Number(node.data?.amount) || 0 }
      }
    case 'extract':
      return {
        ...base,
        kind: 'browser.extract',
        surface: 'browser',
        target: { selector: toText(node.data?.selector) },
        input: {
          extractType: toText(node.data?.extractType || 'text'),
          variableName: toText(node.data?.varName)
        }
      }
    case 'wait':
      return {
        ...base,
        kind: 'system.wait',
        surface: 'system',
        input: { milliseconds: Number.parseInt(toText(node.data?.ms || '1000'), 10) || 0 }
      }
    case 'condition':
      return {
        ...base,
        kind: 'system.condition',
        surface: 'system',
        input: { expression: toText(node.data?.expression) }
      }
    case 'manual_confirm':
      return {
        ...base,
        kind: 'system.approval',
        surface: 'system',
        input: { prompt: toText(node.data?.prompt) }
      }
    case 'ai_node': {
      const prompt = toText(node.data?.prompt)
      return {
        ...base,
        kind: 'agent.resolve',
        surface: 'agent',
        input: {
          promptLength: prompt.length,
          variableName: toText(node.data?.varName)
        }
      }
    }
    default:
      return { ...base, kind: 'agent.resolve', surface: 'agent' }
  }
}

/** Persist shape only, never the potentially sensitive value itself. */
export function summarizeRpaValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return { type: 'string', length: value.length }
  if (typeof value === 'number' || typeof value === 'boolean') return { type: typeof value }
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).slice(0, 50) }
  }
  return { type: typeof value }
}

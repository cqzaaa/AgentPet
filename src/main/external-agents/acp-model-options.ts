import type { ExternalAgentModel } from './types'

type UnknownRecord = Record<string, unknown>

function recordOf(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {}
}

export function findAcpModelOption(configOptions: unknown): UnknownRecord | undefined {
  if (!Array.isArray(configOptions)) return undefined
  const options = configOptions.map(recordOf)
  return (
    options.find((option) => String(option.category || '').toLowerCase() === 'model') ||
    options.find((option) => /model/i.test(String(option.id || option.name || '')))
  )
}

export function listAcpModelChoices(modelOption: UnknownRecord | undefined): ExternalAgentModel[] {
  const rawOptions = Array.isArray(modelOption?.options)
    ? modelOption.options
    : Array.isArray(modelOption?.values)
      ? modelOption.values
      : []
  const choices = rawOptions.flatMap((value) => {
    const option = recordOf(value)
    return Array.isArray(option.options) ? option.options : [value]
  })
  return choices
    .map((value) => {
      const choice = recordOf(value)
      const id = String(choice.value || choice.id || choice.name || '').trim()
      return {
        id,
        name: String(choice.name || choice.label || choice.value || choice.id || '').trim(),
        description: typeof choice.description === 'string' ? choice.description : undefined,
        source: 'acp' as const
      }
    })
    .filter((model) => model.id)
}

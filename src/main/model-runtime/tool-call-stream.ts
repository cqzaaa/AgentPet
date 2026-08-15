function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeStreamingMetadata(current: any, delta: any): any {
  if (typeof delta === 'string') {
    return typeof current === 'string' ? current + delta : delta
  }

  if (isPlainObject(delta)) {
    const merged: Record<string, any> = isPlainObject(current) ? { ...current } : {}
    for (const [key, value] of Object.entries(delta)) {
      merged[key] = mergeStreamingMetadata(merged[key], value)
    }
    return merged
  }

  return delta
}

/**
 * Applies an OpenAI-compatible streaming tool-call delta without dropping
 * provider-specific metadata. Gemini stores the required thought signature at
 * `extra_content.google.thought_signature`, and that value must be echoed back
 * unchanged with the assistant tool call on the next request.
 */
export function mergeStreamingToolCall(toolCalls: any[], partial: any): void {
  const index = partial.index ?? toolCalls.length
  const current = toolCalls[index] || (toolCalls[index] = {
    id: '',
    type: 'function',
    function: { name: '', arguments: '' }
  })

  if (partial.id) current.id = partial.id
  if (partial.type) current.type = partial.type
  if (partial.function?.name) current.function.name += partial.function.name
  if (partial.function?.arguments) current.function.arguments += partial.function.arguments

  if (partial.extra_content !== undefined) {
    current.extra_content = mergeStreamingMetadata(current.extra_content, partial.extra_content)
  }
}

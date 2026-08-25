export function repairUnescapedJsonQuotes(value: string): string {
  let result = ''
  let insideString = false

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character !== '"') {
      result += character
      continue
    }

    let precedingBackslashes = 0
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
      precedingBackslashes++
    }
    if (precedingBackslashes % 2 === 1) {
      result += character
      continue
    }

    if (!insideString) {
      insideString = true
      result += character
      continue
    }

    let nextIndex = index + 1
    while (nextIndex < value.length && /\s/.test(value[nextIndex])) nextIndex++
    const next = value[nextIndex]
    const closesJsonString =
      next === ':' || next === ',' || next === '}' || next === ']' || next === undefined
    if (closesJsonString) {
      insideString = false
      result += character
    } else {
      result += '\\"'
    }
  }

  return result
}

export function parseOfficeSkillInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('input 必须是对象，或是内容为 JSON 对象的字符串')
  }

  const source = value.trim()
  let firstError: unknown
  for (const candidate of [source, repairUnescapedJsonQuotes(source)]) {
    try {
      const parsed = JSON.parse(candidate)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('解析结果不是对象')
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      firstError ??= error
    }
  }

  const detail = firstError instanceof Error ? firstError.message : String(firstError)
  throw new Error(
    `input 字符串不是有效的 JSON 对象：${detail}；请直接传入对象，不要把 input 整体序列化成字符串`
  )
}

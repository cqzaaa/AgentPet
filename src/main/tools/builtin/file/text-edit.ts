type NormalizedText = {
  text: string
  starts: number[]
  ends: number[]
}

function normalizeLineEndingsWithOffsets(value: string): NormalizedText {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  for (let index = 0; index < value.length; index++) {
    const isCrLf = value[index] === '\r' && value[index + 1] === '\n'
    const isCr = value[index] === '\r'
    text += isCr ? '\n' : value[index]
    starts.push(index)
    ends.push(index + (isCrLf ? 2 : 1))
    if (isCrLf) index++
  }
  return { text, starts, ends }
}

function replacementForMatchedText(newString: string, matchedText: string): string {
  const newline = matchedText.includes('\r\n') ? '\r\n' : matchedText.includes('\r') ? '\r' : '\n'
  return newString.replace(/\r\n|\r|\n/g, newline)
}

function buildMissingMatchMessage(content: string, oldString: string): string {
  const normalizedContent = content.replace(/\r\n|\r/g, '\n')
  const anchor = oldString
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)
  if (!anchor) return '未找到指定的 old_string'

  const exactAnchorIndex = normalizedContent.indexOf(anchor)
  if (exactAnchorIndex < 0) return '未找到指定的 old_string；文件中也未找到首个非空锚点，请重新读取目标附近内容'
  const line = normalizedContent.slice(0, exactAnchorIndex).split('\n').length
  const excerpt = normalizedContent.slice(exactAnchorIndex, exactAnchorIndex + 160).replace(/\n/g, '\\n')
  return `未找到指定的 old_string；最接近的锚点位于第 ${line} 行：${excerpt}`
}

export function replaceExactText(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (!oldString) throw new Error('old_string 不能为空')
  const index = content.indexOf(oldString)
  if (index >= 0) {
    if (replaceAll) return content.split(oldString).join(newString)
    if (content.indexOf(oldString, index + 1) >= 0) {
      throw new Error('old_string 匹配多处；请补充唯一上下文，或明确设置 replace_all')
    }
    // Preserve literal replacement text, including JavaScript replacement patterns.
    return content.slice(0, index) + newString + content.slice(index + oldString.length)
  }

  // Tool arguments often use LF while Windows workspace files use CRLF (or vice
  // versa). Fall back to line-ending-insensitive matching without normalizing
  // the rest of the file.
  if (/\r|\n/.test(oldString)) {
    const normalizedContent = normalizeLineEndingsWithOffsets(content)
    const normalizedOldString = oldString.replace(/\r\n|\r/g, '\n')
    const normalizedMatches: number[] = []
    let matchIndex = normalizedContent.text.indexOf(normalizedOldString)
    while (matchIndex >= 0) {
      normalizedMatches.push(matchIndex)
      matchIndex = normalizedContent.text.indexOf(normalizedOldString, matchIndex + normalizedOldString.length)
    }
    if (normalizedMatches.length > 1 && !replaceAll) {
      throw new Error('old_string 忽略换行格式后匹配多处；请补充唯一上下文，或明确设置 replace_all')
    }
    if (normalizedMatches.length > 0) {
      let result = content
      for (const normalizedStart of normalizedMatches.reverse()) {
        const normalizedEnd = normalizedStart + normalizedOldString.length
        const originalStart = normalizedContent.starts[normalizedStart]
        const originalEnd = normalizedContent.ends[normalizedEnd - 1]
        const matchedText = content.slice(originalStart, originalEnd)
        const replacement = replacementForMatchedText(newString, matchedText)
        result = result.slice(0, originalStart) + replacement + result.slice(originalEnd)
      }
      return result
    }
  }

  throw new Error(buildMissingMatchMessage(content, oldString))
}

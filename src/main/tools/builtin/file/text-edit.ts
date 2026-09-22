export function replaceExactText(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (!oldString) throw new Error('old_string 不能为空')
  const index = content.indexOf(oldString)
  if (index < 0) throw new Error('未找到指定的 old_string')
  if (replaceAll) return content.split(oldString).join(newString)
  if (content.indexOf(oldString, index + 1) >= 0) {
    throw new Error('old_string 匹配多处；请补充唯一上下文，或明确设置 replace_all')
  }
  // Preserve literal replacement text, including JavaScript replacement patterns.
  return content.slice(0, index) + newString + content.slice(index + oldString.length)
}

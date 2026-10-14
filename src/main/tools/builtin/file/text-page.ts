export const MAX_TEXT_PAGE_CHARS = 30000

/** Character pagination also works for minified JSON and other single-line files. */
export function readTextPage(content: string, start: unknown, length: unknown): string {
  const offset = start === undefined ? 0 : Number(start)
  const requested = length === undefined ? MAX_TEXT_PAGE_CHARS : Number(length)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) {
    throw new Error(`start_char 必须是 0 到 ${content.length} 之间的整数`)
  }
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('max_chars 必须是正整数')
  const end = Math.min(content.length, offset + Math.min(requested, MAX_TEXT_PAGE_CHARS))
  return `[字符范围 ${offset}–${end}（从 0 开始，结束位置不含），总字符数 ${content.length}]\n${content.slice(offset, end)}\n\n` +
    (end < content.length ? `[后续内容：使用 start_char=${end} 继续读取；每次最多 ${MAX_TEXT_PAGE_CHARS} 字符。]` : '[已到文件末尾]')
}

const PREVIEWABLE_LOCAL_FILE_EXTENSIONS = new Set([
  'bmp', 'c', 'cpp', 'css', 'csv', 'doc', 'docx', 'gif', 'go', 'h', 'hpp',
  'html', 'jfif', 'jpeg', 'jpg', 'js', 'json', 'jsx', 'log', 'md', 'pdf',
  'png', 'ppt', 'pptx', 'ps1', 'py', 'rs', 'scss', 'sh', 'svg', 'tiff',
  'ts', 'tsx', 'txt', 'webp', 'xls', 'xlsx', 'xml', 'yaml', 'yml'
])

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function normalizeLocalFileUrl(value: string): string {
  const trimmed = value.trim()
  const destination = trimmed.startsWith('<') && trimmed.endsWith('>')
    ? trimmed.slice(1, -1).trim()
    : trimmed
  if (destination.startsWith('file:///')) {
    return destination.replace('file:///', 'local-file:///')
  }
  if (/^[A-Za-z]:[/\\]/.test(destination)) {
    return 'local-file:///' + destination.replace(/\\/g, '/')
  }
  return destination
}

export function isLocalFileReference(value: string): boolean {
  const normalized = normalizeLocalFileUrl(value)
  return normalized.startsWith('local-file://') || normalized.startsWith('wechat-file://')
}

export function localFileDisplayName(value: string): string {
  const withoutScheme = safeDecodeURIComponent(
    value.replace(/^local-file:\/\/\/?/i, '').replace(/^file:\/\/\/?/i, '')
  )
  return withoutScheme.replace(/\\/g, '/').split('/').filter(Boolean).pop() || value
}

export function localFileSystemPath(value: string): string {
  let path = safeDecodeURIComponent(value.trim())
  path = path.replace(/^local-file:\/\/\/?/i, '').replace(/^file:\/\/\/?/i, '')
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  return path.replace(/\//g, '\\')
}

export function isPreviewableLocalFile(value: string): boolean {
  const path = localFileSystemPath(value).replace(/[?#].*$/, '')
  const extension = path.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase()
  return Boolean(extension && PREVIEWABLE_LOCAL_FILE_EXTENSIONS.has(extension))
}

export function isStandaloneLocalFilePath(value: string): boolean {
  const trimmed = value.trim()
  return (
    (/^[A-Za-z]:[\\/].+\.[A-Za-z0-9]{1,12}$/s.test(trimmed) ||
      /^local-file:\/\/\/.+\.[A-Za-z0-9]{1,12}$/is.test(trimmed) ||
      /^file:\/\/\/.+\.[A-Za-z0-9]{1,12}$/is.test(trimmed)) &&
    !trimmed.includes('\n')
  )
}

export function createMessageLinkRegex(): RegExp {
  return /(!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\))|((?:https?:\/\/[^\s\])<>"'\x60*，。！？；：（）]+)|(?:(?:file|local-file):\/\/\/[^<>"|?*\r\n，。！？；：、'\x60\]]+)|(?:[A-Za-z]:[\\/][^<>:"|?*\r\n，。！？；：、'\x60\]]+))/g
}

export function trimDetectedFileReference(value: string): { reference: string; suffix: string } {
  let end = value.length
  while (end > 0 && /\s/.test(value[end - 1])) end -= 1
  while (end > 0 && /[.,;!?]/.test(value[end - 1])) end -= 1
  return { reference: value.slice(0, end), suffix: value.slice(end) }
}

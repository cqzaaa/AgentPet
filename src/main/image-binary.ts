import { join } from 'path'

/** Preserve image bytes while repairing JPEGs that only lack the required EOI marker. */
export function ensureCompleteJpeg(buffer: Buffer): Buffer {
  const isJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8
  const hasEndMarker =
    buffer.length >= 2 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  return isJpeg && !hasEndMarker
    ? Buffer.concat([buffer, Buffer.from([0xff, 0xd9])])
    : buffer
}

/**
 * Resolve local file protocol URLs (local-file://, file://, wechat-file://) or raw filesystem paths
 * to absolute OS paths. Robustly handles Chromium standard scheme normalization where drive letters
 * become hosts without colons (e.g. local-file://c/Users/...).
 */
export function resolveLocalFilePath(filePath: string, storageDir?: string): string {
  if (!filePath || typeof filePath !== 'string') return filePath
  let resolved = filePath.trim()

  if (resolved.startsWith('local-file://')) {
    try {
      const parsed = new URL(resolved)
      const pathname = decodeURIComponent(parsed.pathname)
      if (parsed.host && /^[A-Za-z]$/.test(parsed.host)) {
        // e.g. local-file://c/Users/... -> C:/Users/...
        return `${parsed.host.toUpperCase()}:${pathname}`
      }
      if (/^\/[A-Za-z]:\//.test(pathname)) {
        // e.g. local-file:///C:/Users/... -> C:/Users/...
        return pathname.slice(1)
      }
      if (parsed.host && /^[A-Za-z]:$/i.test(parsed.host)) {
        return `${parsed.host.toUpperCase()}${pathname}`
      }
      if (parsed.host) {
        return `//${parsed.host}${pathname}`
      }
    } catch {
      // ignore URL parsing error and fallback to string replace
    }
    resolved = resolved.replace(/^local-file:\/\/+/i, '')
    resolved = decodeURIComponent(resolved)
    if (/^\/[A-Za-z]:\//.test(resolved)) {
      resolved = resolved.slice(1)
    } else if (/^[A-Za-z]\//.test(resolved)) {
      resolved = `${resolved[0].toUpperCase()}:${resolved.slice(1)}`
    }
    return resolved
  }

  if (resolved.startsWith('file://')) {
    try {
      const parsed = new URL(resolved)
      const pathname = decodeURIComponent(parsed.pathname)
      if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1)
      return pathname
    } catch {
      resolved = resolved.replace(/^file:\/\/+/i, '')
      resolved = decodeURIComponent(resolved)
      if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1)
      return resolved
    }
  }

  if (resolved.startsWith('wechat-file://')) {
    const relativePath = decodeURIComponent(
      resolved.replace('wechat-file://', '').replace(/^\/+/, '')
    )
    const segments = relativePath.split('/')
    if (segments.length >= 3 && segments[0] === 'local') {
      const safeSessionId = segments[1]
      const fileName = segments.slice(2).join('/')
      return storageDir
        ? join(storageDir, 'chat', safeSessionId, 'wechat_files', fileName)
        : relativePath
    } else if (segments.length >= 2 && segments[0] === 'local') {
      const fileName = segments.slice(1).join('/')
      return storageDir ? join(storageDir, 'wechat_files', fileName) : relativePath
    }
    return relativePath
  }

  return resolved
}

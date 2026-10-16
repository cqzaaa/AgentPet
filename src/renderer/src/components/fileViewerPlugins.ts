import { imagePlugin, pdfPlugin, officePlugin, textPlugin } from '@open-file-viewer/core'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'

// Keep Wiki and chat previews on the same local rendering configuration.
export function createFileViewerPlugins() {
  return [imagePlugin(), pdfPlugin({ workerSrc: pdfWorkerSrc }), officePlugin(), textPlugin()]
}

export function localFilePreviewUrl(path: string): string {
  // Chromium treats this registered standard scheme like a file URL: the
  // Windows drive separator must stay literal, while filename characters
  // such as #, ?, % and spaces must be escaped.
  const encodedPath = path.replace(/\\/g, '/').split('/').map((segment, index) =>
    index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
  ).join('/')
  return `local-file:///${encodedPath}`
}

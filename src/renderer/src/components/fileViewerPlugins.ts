import { imagePlugin, pdfPlugin, officePlugin, textPlugin } from '@open-file-viewer/core'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import './fileViewerPerformance.css'

// Keep Wiki and chat previews on the same local rendering configuration.
export function createFileViewerPlugins(
  options: { onPdfRotationChange?: (rotation: number) => void } = {}
): ReturnType<typeof pdfPlugin>[] {
  const pdf = pdfPlugin({ workerSrc: pdfWorkerSrc })
  const trackedPdf: typeof pdf = options.onPdfRotationChange
    ? {
        ...pdf,
        async render(context) {
          const instance = await pdf.render(context)
          let rotation = 0
          options.onPdfRotationChange?.(rotation)
          return {
            ...instance,
            command(command) {
              const result = instance.command?.(command)
              if (result !== false && (command === 'rotate-right' || command === 'rotate-left')) {
                rotation = (rotation + (command === 'rotate-right' ? 90 : 270)) % 360
                options.onPdfRotationChange?.(rotation)
              }
              return result
            }
          }
        }
      }
    : pdf
  return [imagePlugin(), trackedPdf, officePlugin(), textPlugin()]
}

export function localFilePreviewUrl(path: string): string {
  // Chromium treats this registered standard scheme like a file URL: the
  // Windows drive separator must stay literal, while filename characters
  // such as #, ?, % and spaces must be escaped.
  const encodedPath = path
    .replace(/\\/g, '/')
    .split('/')
    .map((segment, index) =>
      index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/')
  return `local-file:///${encodedPath}`
}

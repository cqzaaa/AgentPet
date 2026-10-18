import { readFile } from 'node:fs/promises'
import type { Plugin } from 'vite'

const viewerModule = /[/\\]@open-file-viewer[/\\]core[/\\]dist[/\\].*\.js$/

/** Compatibility fix for the pinned @open-file-viewer/core 1.0.0.
 * Keep the existing PDF renderer, but batch text-layer DOM writes and reads.
 * Applied in memory in both dev prebundling and production, never node_modules.
 * The exact-match guards make upstream changes fail visibly instead of emitting
 * a partly patched renderer. Remove when the upstream renderer batches layout.
 */
export function batchPdfTextLayout(code: string): string {
  if (!code.includes('textLayer.className = "ofv-pdf-text-layer"')) return code
  const replaceOnce = (before: string, after: string): void => {
    if (code.split(before).length !== 2) {
      throw new Error(
        'PDF text layout patch no longer matches @open-file-viewer/core; review its renderer before upgrading.'
      )
    }
    code = code.replace(before, after)
  }
  replaceOnce(
    'for (const item of textContent.items) {',
    `const textFragment = document.createDocumentFragment();
        const textMeasurements = [];
        for (const item of textContent.items) {`
  )
  replaceOnce(
    `textLayer.appendChild(span);
          if (item.width) {
            const itemWidth = item.width * scale;
            const actualWidth = span.offsetWidth || span.getBoundingClientRect().width;
            if (actualWidth > 0 && Math.abs(actualWidth - itemWidth) > 1) {
              span.style.transform = \`scaleX(\${itemWidth / actualWidth})\`;
            }
          }`,
    `textFragment.appendChild(span);
          if (item.width) textMeasurements.push({ span, itemWidth: item.width * scale });`
  )
  replaceOnce(
    'if (textLayer.childElementCount === 0 && isCanvasVisuallyBlank(canvas, context)) {',
    `textLayer.appendChild(textFragment);
        const textWidths = textMeasurements.map(({ span }) => span.offsetWidth || span.getBoundingClientRect().width);
        textMeasurements.forEach(({ span, itemWidth }, index) => {
          const actualWidth = textWidths[index];
          if (actualWidth > 0 && Math.abs(actualWidth - itemWidth) > 1) {
            span.style.transform = \`scaleX(\${itemWidth / actualWidth})\`;
          }
        });
        if (textLayer.childElementCount === 0 && isCanvasVisuallyBlank(canvas, context)) {`
  )
  return code
}

export function pdfViewerPerformance(): Plugin {
  return {
    name: 'agentpet-pdf-text-layout',
    enforce: 'pre',
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [
              {
                name: 'agentpet-pdf-text-layout',
                setup(build) {
                  build.onLoad({ filter: viewerModule }, async ({ path }) => ({
                    contents: batchPdfTextLayout(await readFile(path, 'utf8')),
                    loader: 'js'
                  }))
                }
              }
            ]
          }
        }
      }
    },
    transform(code, id) {
      if (!viewerModule.test(id)) return null
      const patched = batchPdfTextLayout(code)
      return patched === code ? null : { code: patched, map: null }
    }
  }
}

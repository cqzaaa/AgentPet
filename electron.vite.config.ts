import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync } from 'fs'
import { pdfViewerPerformance } from './scripts/pdf-viewer-performance'

export default defineConfig({
  main: {
    plugins: [
      {
        name: 'copy-xlsx-worker',
        closeBundle() {
          try {
            mkdirSync('out/main', { recursive: true })
            copyFileSync('src/main/xlsx-worker.js', 'out/main/xlsx-worker.js')
            console.log('[copy-xlsx-worker] xlsx-worker.js 已复制到 out/main/')
          } catch (e) {
            console.warn('[copy-xlsx-worker] 复制 xlsx-worker.js 失败:', e)
          }
        }
      }
    ]
  },
  preload: {},
  renderer: {
    optimizeDeps: { exclude: ['emf-converter'] },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      sourcemap: false,
      rollupOptions: { external: ['@napi-rs/canvas'] }
    },
    plugins: [react(), pdfViewerPerformance()]
  }
})

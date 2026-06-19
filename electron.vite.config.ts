import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync } from 'fs'

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
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})

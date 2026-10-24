// 只构建界面（不含 Electron），用于浏览器里预览演示数据，将来也用于安卓版（Capacitor）。
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [
    react(),
    {
      name: 'moyer-csp-web',
      transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '')
    }
  ],
  server: { port: 5199, strictPort: true },
  build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true }
})

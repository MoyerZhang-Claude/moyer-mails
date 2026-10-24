import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

/** 界面的内容安全策略。开发模式需要放开内联脚本（React 热更新） */
function csp(dev: boolean) {
  return [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline' https: http:",
    "img-src 'self' data: blob: https: http: cid:",
    "font-src 'self' data: https:",
    `connect-src 'self'${dev ? ' ws: http://localhost:*' : ''}`,
    "media-src 'self' data: https:",
    "object-src 'none'"
  ].join('; ')
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: { alias: { '@shared': shared } },
    build: { minify: true },
    plugins: [
      react(),
      {
        name: 'moyer-csp',
        transformIndexHtml(html, ctx) {
          return html.replace('%CSP%', csp(!!ctx.server))
        }
      }
    ]
  }
})

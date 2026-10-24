// 把收发信引擎单独打包成 Node 模块，供自动化测试使用（不依赖 Electron）。
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  build: {
    ssr: true,
    outDir: resolve(__dirname, 'out/core'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/core/engine.ts'),
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'imapflow', 'nodemailer', /^nodemailer\//, 'mailparser', 'socks'],
      output: { format: 'cjs', entryFileNames: 'engine.cjs' }
    }
  }
})

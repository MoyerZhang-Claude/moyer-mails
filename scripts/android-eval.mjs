// 开发调试：在手机上运行中的 Moyer Mail（debug 版）里执行一段 JavaScript，打印结果。
// 用法：node scripts/android-eval.mjs <脚本文件>
// 需要先：adb forward tcp:9222 localabstract:webview_devtools_remote_<进程号>
import { readFileSync } from 'node:fs'

const expression = readFileSync(process.argv[2], 'utf8')
const pages = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost')) ?? pages[0]
if (!page) throw new Error('没有找到 WebView 页面')

const ws = new WebSocket(page.webSocketDebuggerUrl)
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id !== 1) return
  const r = msg.result?.result
  if (msg.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails))
  else console.log(typeof r?.value === 'string' ? r.value : JSON.stringify(r?.value ?? r))
  ws.close()
}
ws.onerror = (e) => {
  console.error('ws error', e.message)
  process.exit(1)
}

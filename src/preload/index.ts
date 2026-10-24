import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Listener = (name: string, payload: unknown) => void

contextBridge.exposeInMainWorld('moyer', {
  async call(method: string, ...args: unknown[]) {
    const r = (await ipcRenderer.invoke('api', method, args)) as { ok: boolean; result?: unknown; error?: string }
    if (!r.ok) throw new Error(r.error ?? '未知错误')
    return r.result
  },
  on(cb: Listener) {
    const h = (_e: unknown, name: string, payload: unknown) => cb(name, payload)
    ipcRenderer.on('engine-event', h)
    return () => ipcRenderer.removeListener('engine-event', h)
  },
  pathForFile(file: File) {
    return webUtils.getPathForFile(file)
  },
  platform: process.platform
})

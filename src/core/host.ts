import type { EngineEventName, EngineEvents, PickedFile, Settings } from '@shared/types'

/**
 * 引擎需要的“宿主能力”。桌面版由 Electron 主进程提供，安卓版将来由
 * nodejs-mobile + Capacitor 提供。引擎本身不直接依赖 Electron。
 */
export interface Host {
  dataDir: string
  appVersion: string
  /** 用系统级密钥加密（Windows 上是 DPAPI） */
  encrypt(plain: string): string
  decrypt(cipher: string): string
  /** 走代理设置的 HTTP 请求 */
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** 返回系统代理的 PAC 结果，例如 "PROXY 127.0.0.1:7890; DIRECT" */
  resolveSystemProxy(url: string): Promise<string>
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  saveDialog(defaultName: string): Promise<string | null>
  pickFiles(): Promise<PickedFile[]>
  notify(title: string, body: string, onClick: () => void): void
  emit<K extends EngineEventName>(name: K, payload: EngineEvents[K]): void
  applySettings(settings: Settings): void
  log(...args: unknown[]): void
}

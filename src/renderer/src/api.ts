import { registerPlugin } from '@capacitor/core'
import type { MailApi } from '@shared/api'
import type { EngineEventName, EngineEvents } from '@shared/types'
import { createMockApi, mockOn } from './mock'

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>
  on(cb: (name: string, payload: unknown) => void): () => void
  pathForFile(file: File): string
  platform: string
}

interface MailEnginePlugin {
  call(opts: { method: string; args: unknown[] }): Promise<{ result: unknown }>
  addListener(event: 'engine-event', cb: (e: { name: string; payload: unknown }) => void): Promise<{ remove: () => Promise<void> }>
}

/** 安卓版：引擎是原生插件（android/app/src/main/java/com/moyer/mail/engine），接口和电脑版完全一样 */
function capacitorBridge(): Bridge | undefined {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor
  if (!cap?.isNativePlatform?.()) return undefined
  const plugin = registerPlugin<MailEnginePlugin>('MailEngine')
  return {
    async call(method, ...args) {
      try {
        // undefined 在 JSON 里会丢失，统一转成 null，保证参数位置不错位
        return (await plugin.call({ method, args: args.map((a) => (a === undefined ? null : a)) })).result
      } catch (err) {
        throw new Error((err as Error)?.message || String(err))
      }
    },
    on(cb) {
      let handle: { remove: () => Promise<void> } | null = null
      let removed = false
      void plugin
        .addListener('engine-event', (e) => cb(e.name, e.payload))
        .then((h) => {
          if (removed) void h.remove()
          else handle = h
        })
      return () => {
        removed = true
        void handle?.remove()
      }
    },
    pathForFile: () => '',
    platform: cap.getPlatform?.() ?? 'android'
  }
}

const bridge = (window as unknown as { moyer?: Bridge }).moyer ?? capacitorBridge()

/** 既不是电脑版也不是手机 App（普通浏览器预览）时使用演示数据 */
export const isDemo = !bridge

export const api: MailApi = bridge
  ? (new Proxy(
      {},
      {
        get: (_t, method: string) =>
          (...args: unknown[]) =>
            bridge.call(method, ...args)
      }
    ) as MailApi)
  : createMockApi()

export type EventHandler = <K extends EngineEventName>(name: K, payload: EngineEvents[K]) => void

export function onEngineEvent(cb: EventHandler): () => void {
  if (bridge) return bridge.on(cb as (name: string, payload: unknown) => void)
  return mockOn(cb as (name: string, payload: unknown) => void)
}

export function pathForFile(file: File): string {
  return bridge?.pathForFile(file) ?? ''
}

export const platform = bridge?.platform ?? 'web'

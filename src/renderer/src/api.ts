import type { MailApi } from '@shared/api'
import type { EngineEventName, EngineEvents } from '@shared/types'
import { createMockApi, mockOn } from './mock'

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>
  on(cb: (name: string, payload: unknown) => void): () => void
  pathForFile(file: File): string
  platform: string
}

const bridge = (window as unknown as { moyer?: Bridge }).moyer

/** 没有 Electron 时（浏览器预览）使用演示数据 */
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

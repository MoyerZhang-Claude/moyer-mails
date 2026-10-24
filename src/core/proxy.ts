import type { Settings } from '@shared/types'
import type { Host } from './host'

/** 把 PAC 结果（"PROXY 127.0.0.1:7890; DIRECT"）转换成代理 URL */
export function pacToUrl(pac: string): string | undefined {
  for (const part of pac.split(';')) {
    const [kind, addr] = part.trim().split(/\s+/)
    if (!kind || !addr) continue
    const k = kind.toUpperCase()
    if (k === 'PROXY' || k === 'HTTP') return `http://${addr}`
    if (k === 'HTTPS') return `https://${addr}`
    if (k === 'SOCKS' || k === 'SOCKS5') return `socks5://${addr}`
    if (k === 'SOCKS4') return `socks4://${addr}`
  }
  return undefined
}

/** 计算连接某个邮件服务器时应使用的代理 */
export async function proxyFor(settings: Settings, host: Host, serverHost: string, useProxy: boolean): Promise<string | undefined> {
  if (!useProxy) return undefined
  const { mode, url } = settings.proxy
  if (mode === 'off') return undefined
  if (mode === 'custom') return url.trim() || undefined
  try {
    return pacToUrl(await host.resolveSystemProxy(`https://${serverHost}`))
  } catch {
    return undefined
  }
}

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Settings } from '@shared/types'
import type { OAuthTokens } from './accounts'
import type { Host } from './host'
import { UserError } from './util'

interface ProviderDef {
  authorize: string
  token: string
  scope: string
  extra: Record<string, string>
}

const PROVIDERS: Record<'microsoft' | 'google', ProviderDef> = {
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    extra: { prompt: 'select_account' }
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email profile',
    extra: { access_type: 'offline', prompt: 'consent' }
  }
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Moyer Mail</title>
<body style="font-family:system-ui,'Microsoft YaHei';display:grid;place-items:center;height:100vh;margin:0;background:#eef2f7;color:#1d1d1f">
<div style="text-align:center"><div style="font-size:42px">✓</div><h2>授权完成</h2><p>可以关闭这个页面，回到 Moyer Mail。</p></div></body>`

function b64url(buf: Buffer) {
  return buf.toString('base64url')
}

function decodeJwt(token: string | undefined): Record<string, any> {
  if (!token) return {}
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function clientFor(provider: 'microsoft' | 'google', settings: Settings) {
  if (provider === 'microsoft') {
    const id = settings.oauth.microsoftClientId.trim()
    if (!id) throw new UserError('还没有配置微软应用 ID。请先到 设置 → 账号登录 里填写（只需配置一次）。')
    return { clientId: id, clientSecret: '' }
  }
  const id = settings.oauth.googleClientId.trim()
  if (!id) throw new UserError('还没有配置 Google OAuth 客户端。Gmail 建议直接用“应用专用密码”登录。')
  return { clientId: id, clientSecret: settings.oauth.googleClientSecret.trim() }
}

async function postForm(host: Host, url: string, form: Record<string, string>) {
  const res = await host.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok) throw new UserError(`授权服务器返回错误：${json.error_description || json.error || res.status}`)
  return json
}

/**
 * 浏览器授权（PKCE + 本机回调）。返回令牌和邮箱地址。
 */
export async function oauthInteractive(
  provider: 'microsoft' | 'google',
  settings: Settings,
  host: Host,
  loginHint?: string
): Promise<{ tokens: OAuthTokens; email: string; name?: string }> {
  const def = PROVIDERS[provider]
  const { clientId, clientSecret } = clientFor(provider, settings)
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  let server: Server | undefined
  try {
    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new UserError('等待授权超时（5 分钟），请重试。')), 5 * 60_000)
      let redirectUri = ''
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/') {
          res.writeHead(404).end()
          return
        }
        const err = url.searchParams.get('error')
        const gotState = url.searchParams.get('state')
        const gotCode = url.searchParams.get('code')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE)
        clearTimeout(timer)
        if (err) reject(new UserError(`授权被拒绝：${url.searchParams.get('error_description') || err}`))
        else if (gotState !== state || !gotCode) reject(new UserError('授权回调无效，请重试。'))
        else resolve({ code: gotCode, redirectUri })
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as { port: number }).port
        redirectUri = `http://localhost:${port}`
        const params = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: redirectUri,
          scope: def.scope,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          ...def.extra
        })
        if (loginHint) params.set('login_hint', loginHint)
        host.openExternal(`${def.authorize}?${params}`).catch(reject)
      })
    })

    const form: Record<string, string> = {
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: def.scope
    }
    if (clientSecret) form.client_secret = clientSecret
    const json = await postForm(host, def.token, form)
    if (!json.refresh_token) throw new UserError('没有拿到长期令牌（refresh token），请重试。')
    const claims = decodeJwt(json.id_token)
    const email = String(claims.email || claims.preferred_username || loginHint || '').toLowerCase()
    return {
      tokens: {
        provider,
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000
      },
      email,
      name: claims.name
    }
  } finally {
    server?.close()
  }
}

export async function refreshTokens(tokens: OAuthTokens, settings: Settings, host: Host): Promise<OAuthTokens> {
  const def = PROVIDERS[tokens.provider]
  const { clientId, clientSecret } = clientFor(tokens.provider, settings)
  const form: Record<string, string> = {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken
  }
  if (tokens.provider === 'microsoft') form.scope = def.scope
  if (clientSecret) form.client_secret = clientSecret
  const json = await postForm(host, def.token, form)
  return {
    provider: tokens.provider,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000
  }
}

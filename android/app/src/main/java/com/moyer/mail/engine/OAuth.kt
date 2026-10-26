package com.moyer.mail.engine

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

/** OAuth 令牌（存到 secrets 表里，键名 "<账号id>:oauth"） */
data class OAuthTokens(val provider: String, val accessToken: String, val refreshToken: String, val expiresAt: Long) {
    fun toJson() = jobj("provider" to provider, "accessToken" to accessToken, "refreshToken" to refreshToken, "expiresAt" to expiresAt)

    companion object {
        fun from(o: JSONObject) = OAuthTokens(o.getString("provider"), o.getString("accessToken"), o.getString("refreshToken"), o.getLong("expiresAt"))
    }
}

private class ProviderDef(val authorize: String, val token: String, val scope: String, val extra: Map<String, String>)

private val PROVIDERS = mapOf(
    "microsoft" to ProviderDef(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile",
        mapOf("prompt" to "select_account")
    ),
    "google" to ProviderDef(
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        "https://mail.google.com/ openid email profile",
        mapOf("access_type" to "offline", "prompt" to "consent")
    )
)

/** 授权完成后浏览器里显示的页面；按钮通过 moyermail:// 链接跳回应用 */
private const val DONE_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moyer Mail</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#eef2f7;color:#1d1d1f">
<div style="text-align:center;padding:24px"><div style="font-size:44px">✓</div><h2>授权完成</h2><p>回到 Moyer Mail 继续添加邮箱。</p>
<a href="moyermail://oauth-done" style="display:inline-block;margin-top:12px;padding:12px 28px;border-radius:12px;background:#3d7bf5;color:#fff;text-decoration:none;font-size:17px">返回 Moyer Mail</a></div>
<script>setTimeout(function(){location.href='moyermail://oauth-done'},300)</script></body>"""

private const val FAIL_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moyer Mail</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#eef2f7;color:#1d1d1f">
<div style="text-align:center;padding:24px"><h2>授权没有完成</h2><p>回到 Moyer Mail 查看原因后重试。</p>
<a href="moyermail://oauth-done" style="display:inline-block;margin-top:12px;padding:12px 28px;border-radius:12px;background:#3d7bf5;color:#fff;text-decoration:none;font-size:17px">返回 Moyer Mail</a></div></body>"""

/**
 * 浏览器授权（PKCE + 本机回调），和电脑版 src/core/oauth.ts 一样：
 * 应用在 127.0.0.1 上临时开一个端口，打开系统浏览器登录，登录完成后浏览器跳回 http://localhost:端口。
 * 所以手机上可以直接用电脑版注册的同一个微软应用 ID（重定向地址 http://localhost）。
 */
object OAuth {
    class Result(val tokens: OAuthTokens, val email: String, val name: String?)

    /** 一次授权尝试：本机回调端口 + 是否已被新的尝试取消 */
    private class Attempt(val server: ServerSocket) {
        @Volatile var cancelled = false
    }

    /**
     * 正在等浏览器回调的那次尝试。用户再点一次登录按钮时取消它，换新的端口重新打开浏览器。
     * （不能在“回到应用”时自动取消：一加等手机把浏览器开成小窗，应用一直显示在后面，会被当成已经回来了）
     */
    @Volatile private var current: Attempt? = null

    private fun cancelCurrent() {
        val a = current ?: return
        a.cancelled = true
        runCatching { a.server.close() }
    }

    private fun b64url(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun random(n: Int) = ByteArray(n).also { SecureRandom().nextBytes(it) }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun formOf(m: Map<String, String>) = m.entries.joinToString("&") { "${enc(it.key)}=${enc(it.value)}" }

    private fun clientFor(provider: String, settings: JSONObject): Pair<String, String> {
        val o = settings.optJSONObject("oauth") ?: JSONObject()
        if (provider == "microsoft") {
            val id = o.optString("microsoftClientId").trim()
            if (id.isEmpty()) throw UserError("还没有配置微软应用 ID。请先到 设置 → 账号登录 里填写（和电脑版用同一个就行）。")
            return id to ""
        }
        val id = o.optString("googleClientId").trim()
        if (id.isEmpty()) throw UserError("还没有配置 Google OAuth 客户端。Gmail 建议直接用“应用专用密码”登录。")
        return id to o.optString("googleClientSecret").trim()
    }

    private fun postForm(url: String, form: Map<String, String>): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            conn.outputStream.use { it.write(formOf(form).toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            val json = runCatching { JSONObject(body) }.getOrElse { JSONObject() }
            if (code !in 200..299) throw UserError("授权服务器返回错误：${json.optStr("error_description") ?: json.optStr("error") ?: code}")
            return json
        } finally {
            conn.disconnect()
        }
    }

    private fun decodeJwt(token: String?): JSONObject {
        if (token.isNullOrEmpty()) return JSONObject()
        return runCatching {
            JSONObject(String(Base64.decode(token.split('.')[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8))
        }.getOrElse { JSONObject() }
    }

    private fun respond(s: Socket, status: Int, html: String) {
        val body = html.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status ${if (status == 200) "OK" else "Not Found"}\r\nContent-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        s.getOutputStream().apply { write(head.toByteArray(Charsets.US_ASCII)); write(body); flush() }
    }

    /** 处理一次浏览器请求；是授权回调就返回 code，其他请求（比如 favicon）返回 null */
    private fun handle(s: Socket, state: String): String? {
        s.soTimeout = 10_000
        val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
        val first = reader.readLine() ?: return null
        while (true) {
            val h = reader.readLine() ?: break
            if (h.isEmpty()) break
        }
        val target = first.split(' ').getOrNull(1) ?: "/"
        val uri = Uri.parse("http://localhost$target")
        if (!uri.path.isNullOrEmpty() && uri.path != "/") {
            respond(s, 404, "")
            return null
        }
        val err = uri.getQueryParameter("error")
        val code = uri.getQueryParameter("code")
        if (err != null) {
            respond(s, 200, FAIL_PAGE)
            throw UserError("授权被拒绝：${uri.getQueryParameter("error_description") ?: err}")
        }
        if (uri.getQueryParameter("state") != state || code.isNullOrEmpty()) {
            respond(s, 200, FAIL_PAGE)
            throw UserError("授权回调无效，请重试。")
        }
        respond(s, 200, DONE_PAGE)
        return code
    }

    /** 打开浏览器登录，最多等 5 分钟。会阻塞当前线程，要在后台线程里调用。 */
    fun interactive(ctx: Context, provider: String, settings: JSONObject, loginHint: String?): Result {
        val def = PROVIDERS[provider] ?: throw UserError("不支持的登录方式")
        val (clientId, clientSecret) = clientFor(provider, settings)
        val verifier = b64url(random(32))
        val challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        val state = b64url(random(16))

        cancelCurrent()
        val (code, redirectUri) = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 5 * 60_000
            val attempt = Attempt(server)
            current = attempt
            val redirectUri = "http://localhost:${server.localPort}"
            val params = LinkedHashMap<String, String>()
            params["client_id"] = clientId
            params["response_type"] = "code"
            params["redirect_uri"] = redirectUri
            params["scope"] = def.scope
            params["state"] = state
            params["code_challenge"] = challenge
            params["code_challenge_method"] = "S256"
            params.putAll(def.extra)
            if (!loginHint.isNullOrBlank()) params["login_hint"] = loginHint
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${def.authorize}?${formOf(params)}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            try {
                var got: String? = null
                while (got == null) {
                    val sock = try {
                        server.accept()
                    } catch (e: SocketTimeoutException) {
                        throw UserError("等待授权超时（5 分钟），请重试。")
                    } catch (e: SocketException) {
                        if (attempt.cancelled) throw UserError("已重新打开浏览器登录。")
                        throw e
                    }
                    got = sock.use { handle(it, state) }
                }
                got to redirectUri
            } finally {
                if (current === attempt) current = null
            }
        }

        val form = linkedMapOf(
            "client_id" to clientId, "grant_type" to "authorization_code", "code" to code,
            "redirect_uri" to redirectUri, "code_verifier" to verifier, "scope" to def.scope
        )
        if (clientSecret.isNotEmpty()) form["client_secret"] = clientSecret
        val json = postForm(def.token, form)
        val refresh = json.optStr("refresh_token") ?: throw UserError("没有拿到长期令牌（refresh token），请重试。")
        val claims = decodeJwt(json.optStr("id_token"))
        val email = (claims.optStr("email") ?: claims.optStr("preferred_username") ?: loginHint ?: "").lowercase()
        return Result(
            OAuthTokens(provider, json.getString("access_token"), refresh, System.currentTimeMillis() + json.optLong("expires_in", 3600) * 1000),
            email,
            claims.optStr("name")
        )
    }

    /** 用长期令牌换新的访问令牌 */
    fun refresh(t: OAuthTokens, settings: JSONObject): OAuthTokens {
        val def = PROVIDERS[t.provider] ?: throw UserError("不支持的登录方式")
        val (clientId, clientSecret) = clientFor(t.provider, settings)
        val form = linkedMapOf("client_id" to clientId, "grant_type" to "refresh_token", "refresh_token" to t.refreshToken)
        if (t.provider == "microsoft") form["scope"] = def.scope
        if (clientSecret.isNotEmpty()) form["client_secret"] = clientSecret
        val json = try {
            postForm(def.token, form)
        } catch (e: UserError) {
            throw UserError("登录已失效，请编辑账号重新授权。（${e.message}）")
        }
        return OAuthTokens(
            t.provider, json.getString("access_token"), json.optStr("refresh_token") ?: t.refreshToken,
            System.currentTimeMillis() + json.optLong("expires_in", 3600) * 1000
        )
    }
}

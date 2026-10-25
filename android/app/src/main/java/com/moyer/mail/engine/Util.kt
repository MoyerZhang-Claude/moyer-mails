package com.moyer.mail.engine

import org.json.JSONArray
import org.json.JSONObject
import javax.mail.AuthenticationFailedException
import javax.mail.MessagingException

/** 给用户看的错误（直接显示原文，不再翻译） */
class UserError(message: String) : Exception(message)

// ---------------- JSON 小工具 ----------------
fun jobj(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) o.put(k, v ?: JSONObject.NULL)
    return o
}

fun jarr(items: Iterable<Any?>): JSONArray {
    val a = JSONArray()
    for (it in items) a.put(it ?: JSONObject.NULL)
    return a
}

fun JSONObject.optStr(key: String): String? = if (has(key) && !isNull(key)) optString(key) else null

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

fun JSONArray.longs(): List<Long> = (0 until length()).map { optLong(it) }

fun JSONArray.strings(): List<String> = (0 until length()).map { optString(it) }

/** 深度合并：patch 里的字段覆盖 base（对象递归合并） */
fun deepMerge(base: JSONObject, patch: JSONObject): JSONObject {
    val out = JSONObject(base.toString())
    for (k in patch.keys()) {
        val pv = patch.get(k)
        val bv = out.opt(k)
        if (pv is JSONObject && bv is JSONObject) out.put(k, deepMerge(bv, pv)) else out.put(k, pv)
    }
    return out
}

fun addrJson(name: String?, address: String?): JSONObject = jobj("name" to name?.takeIf { it.isNotBlank() }, "address" to (address ?: ""))

// ---------------- 文本处理 ----------------
private val ENTITIES = mapOf("nbsp" to " ", "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "#39" to "'")

/** HTML 粗略转纯文本（用于摘要和搜索） */
fun htmlToText(html: String): String {
    var s = html
    s = Regex("<(style|script|head|title)[\\s\\S]*?</\\1>", RegexOption.IGNORE_CASE).replace(s, " ")
    s = Regex("<!--[\\s\\S]*?-->").replace(s, " ")
    s = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE).replace(s, "\n")
    s = Regex("</(p|div|tr|li|h\\d|blockquote|table)>", RegexOption.IGNORE_CASE).replace(s, "\n")
    s = Regex("<[^>]+>").replace(s, " ")
    s = Regex("&(#\\d+|#x[0-9a-fA-F]+|\\w+);").replace(s) { m ->
        val e = m.groupValues[1]
        if (e.startsWith("#")) {
            val code = if (e.length > 1 && (e[1] == 'x' || e[1] == 'X')) e.substring(2).toIntOrNull(16) else e.substring(1).toIntOrNull()
            if (code != null && code in 1..0x10FFFF) String(Character.toChars(code)) else m.value
        } else ENTITIES[e.lowercase()] ?: m.value
    }
    s = Regex("[ \\t\\u00a0\\u200b\\u200c\\u200d\\ufeff]+").replace(s, " ")
    s = Regex("\\n\\s*\\n+").replace(s, "\n\n")
    return s.trim()
}

fun makeSnippet(text: String): String =
    Regex("\\s+").replace(Regex("(?m)^>.*$").replace(text, ""), " ").trim().take(200)

/** 把底层错误翻译成用户看得懂的中文 */
fun friendlyError(err: Throwable): String {
    if (err is UserError) return err.message ?: "出错了"
    val chain = generateSequence(err) { it.cause }.take(5).toList()
    val raw = chain.mapNotNull { it.message }.joinToString(" | ")
    val msg = raw.lowercase()
    val type = chain.joinToString(" ") { it.javaClass.simpleName.lowercase() }
    return when {
        msg.contains("unsafe login") -> "网易邮箱拒绝了登录（Unsafe Login）。请确认填写的是授权码，而不是登录密码。"
        msg.contains("application-specific password") || msg.contains("534-5.7.9") -> "Gmail 需要使用“应用专用密码”登录（需先开启两步验证）。"
        msg.contains("basicauthblocked") || msg.contains("basic authentication is disabled") -> "微软已禁用这个账号的密码登录，请改用“用微软账号登录”。"
        chain.any { it is AuthenticationFailedException } || msg.contains("authenticationfailed") || msg.contains("invalid credentials") ||
            msg.contains("authentication failed") || msg.contains("login fail") || msg.contains("535") ->
            "登录失败：授权码/密码不正确，或这个邮箱还没有开启 IMAP/SMTP 服务。"
        type.contains("unknownhost") -> "找不到服务器，请检查服务器地址或网络连接。"
        type.contains("sockettimeout") || msg.contains("timed out") || msg.contains("timeout") -> "连接超时。如果是 Gmail 等境外邮箱，需要手机能访问外网。"
        type.contains("connect") && msg.contains("refused") -> "服务器拒绝连接，请检查端口和加密方式。"
        type.contains("ssl") || msg.contains("certificate") || msg.contains("trust anchor") -> "服务器证书校验失败。"
        chain.any { it is MessagingException } && raw.isNotBlank() -> "出错了：${raw.take(300)}"
        raw.isNotBlank() -> "出错了：${raw.take(300)}"
        else -> "未知错误（${err.javaClass.simpleName}）"
    }
}

// ---------------- 语言识别（和电脑版 src/shared/langs.ts 的 detectLang 一致） ----------------
private val STOP = mapOf(
    "en" to setOf("the", "and", "you", "your", "for", "with", "this", "that", "are", "have", "will", "from", "please", "our", "is", "to", "of"),
    "fr" to setOf("le", "la", "les", "des", "vous", "est", "pour", "avec", "une", "dans", "nous", "votre", "et", "que"),
    "de" to setOf("der", "die", "das", "und", "sie", "ist", "mit", "für", "nicht", "ein", "eine", "ihre", "wir", "zu"),
    "es" to setOf("el", "la", "los", "las", "que", "por", "para", "con", "una", "usted", "su", "es", "del", "y"),
    "pt" to setOf("o", "os", "as", "que", "para", "com", "uma", "você", "não", "seu", "sua", "do", "da", "é"),
    "it" to setOf("il", "la", "che", "per", "con", "una", "non", "sono", "del", "della", "gli", "è", "di"),
    "nl" to setOf("de", "het", "een", "en", "van", "je", "u", "uw", "met", "voor", "niet", "is", "zijn")
)

fun detectLang(input: String): String? {
    val text = input.take(3000)
    var han = 0; var kana = 0; var hangul = 0; var cyr = 0; var arabic = 0; var thai = 0; var latin = 0
    var i = 0
    while (i < text.length) {
        val c = text.codePointAt(i)
        i += Character.charCount(c)
        when (c) {
            in 0x4e00..0x9fff -> han++
            in 0x3040..0x30ff -> kana++
            in 0xac00..0xd7af -> hangul++
            in 0x0400..0x04ff -> cyr++
            in 0x0600..0x06ff -> arabic++
            in 0x0e00..0x0e7f -> thai++
            in 0x41..0x5a, in 0x61..0x7a, in 0xc0..0x24f -> latin++
        }
    }
    val total = han + kana + hangul + cyr + arabic + thai + latin
    if (total < 4) return null
    if (kana > 5 && kana + han > total * 0.3) return "ja"
    if (hangul > total * 0.2) return "ko"
    if (han > total * 0.15 || (han > 20 && han * 3 > latin)) return "zh"
    if (cyr > total * 0.3) return "ru"
    if (arabic > total * 0.3) return "ar"
    if (thai > total * 0.3) return "th"
    val words = Regex("\\p{L}+").findAll(text.lowercase()).map { it.value }.toList()
    if (words.isEmpty()) return null
    var best = "en"; var bestScore = 0
    for ((lang, set) in STOP) {
        val s = words.count { it in set }
        if (s > bestScore) { best = lang; bestScore = s }
    }
    return best
}

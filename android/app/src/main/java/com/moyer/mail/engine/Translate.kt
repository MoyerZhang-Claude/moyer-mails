package com.moyer.mail.engine

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * 翻译：和电脑版一样支持 Google（免费）、微软 Azure、大模型（OpenAI 兼容接口，如 DeepSeek）、DeepL，
 * 按 设置 → 翻译 里选的服务来。
 */
object Translator {
    private data class Lang(val ms: String, val google: String, val deepl: String?, val en: String)

    private val LANGS = mapOf(
        "zh" to Lang("zh-Hans", "zh-CN", "ZH-HANS", "Simplified Chinese"),
        "zh-TW" to Lang("zh-Hant", "zh-TW", "ZH-HANT", "Traditional Chinese"),
        "en" to Lang("en", "en", "EN-US", "English"),
        "ja" to Lang("ja", "ja", "JA", "Japanese"),
        "ko" to Lang("ko", "ko", "KO", "Korean"),
        "fr" to Lang("fr", "fr", "FR", "French"),
        "de" to Lang("de", "de", "DE", "German"),
        "es" to Lang("es", "es", "ES", "Spanish"),
        "pt" to Lang("pt", "pt", "PT-BR", "Portuguese"),
        "it" to Lang("it", "it", "IT", "Italian"),
        "ru" to Lang("ru", "ru", "RU", "Russian"),
        "ar" to Lang("ar", "ar", "AR", "Arabic"),
        "th" to Lang("th", "th", null, "Thai"),
        "vi" to Lang("vi", "vi", null, "Vietnamese"),
        "id" to Lang("id", "id", "ID", "Indonesian"),
        "tr" to Lang("tr", "tr", "TR", "Turkish"),
        "nl" to Lang("nl", "nl", "NL", "Dutch"),
        "pl" to Lang("pl", "pl", "PL", "Polish"),
        "uk" to Lang("uk", "uk", "UK", "Ukrainian"),
        "hi" to Lang("hi", "hi", null, "Hindi")
    )

    private fun normalize(code: String?): String? = when {
        code.isNullOrBlank() -> null
        code.equals("zh-TW", true) || code.equals("zh-Hant", true) -> "zh-TW"
        code.lowercase().startsWith("zh") -> "zh"
        else -> code.substringBefore('-').lowercase()
    }

    /** 按字符数分组，避免单次请求太大 */
    private fun groups(texts: List<String>, maxChars: Int, maxItems: Int): List<List<Int>> {
        val out = ArrayList<List<Int>>()
        var cur = ArrayList<Int>()
        var size = 0
        texts.forEachIndexed { i, t ->
            if (t.isBlank()) return@forEachIndexed
            if (cur.isNotEmpty() && (size + t.length > maxChars || cur.size >= maxItems)) {
                out.add(cur); cur = ArrayList(); size = 0
            }
            cur.add(i); size += t.length
        }
        if (cur.isNotEmpty()) out.add(cur)
        return out
    }

    private fun http(url: String, body: String, contentType: String, headers: Map<String, String> = emptyMap(), service: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", contentType)
            for ((k, v) in headers) conn.setRequestProperty(k, v)
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = runCatching { conn.errorStream?.bufferedReader()?.readText() }.getOrNull()?.take(200) ?: ""
                val hint = if (service == "Google" && code == 429) "Google 限制了你当前网络的访问次数，请在 设置 → 翻译 换成大模型（如 DeepSeek）或微软翻译。" else err
                throw UserError("$service 翻译出错（$code）。$hint")
            }
            return conn.inputStream.bufferedReader(Charsets.UTF_8).readText()
        } catch (e: UserError) {
            throw e
        } catch (e: Exception) {
            throw UserError("连不上 $service 翻译（${e.message}）。")
        } finally {
            conn.disconnect()
        }
    }

    fun translate(texts: List<String>, to: String, html: Boolean, settings: JSONObject): JSONObject {
        val tr = settings.optJSONObject("translate") ?: JSONObject()
        val out = texts.toMutableList()
        val detected = HashMap<String, Int>()
        val lang = LANGS[to] ?: Lang(to, to, null, to)
        fun det(code: String?) = normalize(code)?.let { detected[it] = (detected[it] ?: 0) + 1 }

        when (tr.optString("provider", "google")) {
            "llm" -> {
                val llm = tr.optJSONObject("llm") ?: JSONObject()
                val key = llm.optString("apiKey")
                if (key.isBlank()) throw UserError("还没有填写大模型的 API Key（设置 → 翻译）。")
                val system = "You are a professional translator. Translate every string in the JSON array sent by the user into ${lang.en}. " +
                    "Rules: return a JSON array with exactly the same length and order; " +
                    (if (html) "strings may contain HTML tags — keep every tag and attribute unchanged and translate only the human-readable text; " else "") +
                    "keep URLs, email addresses, numbers, code and product names unchanged; keep the original tone and formatting; " +
                    "if a string is already in ${lang.en}, return it unchanged. Reply with the JSON array only, no explanations."
                for (g in groups(texts, 3000, 60)) {
                    val body = jobj(
                        "model" to llm.optString("model", "deepseek-chat"),
                        "temperature" to 0.2,
                        "messages" to jarr(listOf(jobj("role" to "system", "content" to system), jobj("role" to "user", "content" to jarr(g.map { texts[it] }).toString())))
                    )
                    val res = JSONObject(
                        http(llm.optString("baseUrl", "https://api.deepseek.com/v1").trimEnd('/') + "/chat/completions", body.toString(), "application/json",
                            mapOf("Authorization" to "Bearer $key"), "大模型")
                    )
                    var content = res.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: ""
                    content = content.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
                    val arr = runCatching { JSONArray(content) }.getOrNull()
                    if (arr != null && arr.length() == g.size) g.forEachIndexed { k, i -> out[i] = arr.optString(k, texts[i]) }
                    else if (g.size == 1) out[g[0]] = content
                    else throw UserError("大模型返回的格式不对，请换个模型或重试。")
                }
            }
            "azure" -> {
                val az = tr.optJSONObject("azure") ?: JSONObject()
                val key = az.optString("key").trim()
                if (key.isBlank()) throw UserError("还没有填写 Azure 翻译的密钥（设置 → 翻译）。")
                val headers = HashMap<String, String>().apply {
                    put("Ocp-Apim-Subscription-Key", key)
                    az.optString("region").trim().takeIf { it.isNotEmpty() }?.let { put("Ocp-Apim-Subscription-Region", it) }
                }
                for (g in groups(texts, 40_000, 900)) {
                    val body = jarr(g.map { jobj("Text" to texts[it]) }).toString()
                    val res = JSONArray(
                        http("https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${lang.ms}&textType=${if (html) "html" else "plain"}",
                            body, "application/json", headers, "微软")
                    )
                    g.forEachIndexed { k, i ->
                        val r = res.optJSONObject(k)
                        out[i] = r?.optJSONArray("translations")?.optJSONObject(0)?.optString("text") ?: texts[i]
                        det(r?.optJSONObject("detectedLanguage")?.optString("language"))
                    }
                }
            }
            "deepl" -> {
                val key = tr.optJSONObject("deepl")?.optString("apiKey")?.trim() ?: ""
                if (key.isBlank()) throw UserError("还没有填写 DeepL API Key（设置 → 翻译）。")
                val target = lang.deepl ?: throw UserError("DeepL 不支持这个目标语言，请换一个翻译服务。")
                val base = if (key.endsWith(":fx")) "https://api-free.deepl.com" else "https://api.deepl.com"
                for (g in groups(texts, 100_000, 50)) {
                    val body = jobj("text" to jarr(g.map { texts[it] }), "target_lang" to target).apply { if (html) put("tag_handling", "html") }
                    val res = JSONObject(http("$base/v2/translate", body.toString(), "application/json", mapOf("Authorization" to "DeepL-Auth-Key $key"), "DeepL"))
                    val arr = res.optJSONArray("translations") ?: JSONArray()
                    g.forEachIndexed { k, i ->
                        out[i] = arr.optJSONObject(k)?.optString("text") ?: texts[i]
                        det(arr.optJSONObject(k)?.optString("detected_source_language"))
                    }
                }
            }
            else -> {
                for (g in groups(texts, 4000, 50)) {
                    val body = g.joinToString("&") { "q=" + URLEncoder.encode(texts[it], "UTF-8") }
                    val text = http("https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${lang.google}&format=${if (html) "html" else "text"}",
                        body, "application/x-www-form-urlencoded;charset=UTF-8", service = "Google")
                    val arr = if (text.trimStart().startsWith("[")) JSONArray(text) else JSONArray().put(text)
                    g.forEachIndexed { k, i ->
                        when (val item = arr.opt(k)) {
                            is JSONArray -> {
                                out[i] = item.optString(0, texts[i]); det(item.optString(1))
                            }
                            is String -> out[i] = item
                        }
                    }
                }
            }
        }
        val best = detected.maxByOrNull { it.value }?.key ?: detectLang(texts.joinToString(" ").replace(Regex("<[^>]+>"), " "))
        return jobj("texts" to jarr(out), "detected" to best)
    }
}

package com.moyer.mail.engine

import android.content.Context
import android.content.Intent
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.mail.Flags

private const val DEFAULT_SETTINGS = """{"theme":"system","palette":"mist","orbs":true,"density":"comfortable","threading":true,
"loadRemoteImages":true,"markReadOnOpen":true,"notifications":true,"backgroundSync":true,"closeToTray":true,"launchAtLogin":false,"syncIntervalMin":5,
"proxy":{"mode":"off","url":""},
"translate":{"provider":"google","targetLang":"zh","autoTranslate":false,"listSubjects":true,"display":"replace",
"llm":{"baseUrl":"https://api.deepseek.com/v1","apiKey":"","model":"deepseek-chat"},"deepl":{"apiKey":""},"azure":{"key":"","region":""}},
"oauth":{"microsoftClientId":"","googleClientId":"","googleClientSecret":""}}"""

private val ACCOUNT_COLORS = listOf("#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#64748b")
private val UNIFIED_BOXES = listOf("inbox", "unread", "flagged", "snoozed", "sent", "drafts", "trash", "junk", "all")

private val NO_THREAD_BOXES = setOf("drafts", "trash", "junk", "snoozed")

/**
 * 手机端引擎：实现和电脑版 src/core/engine.ts 一样的 MailApi，界面代码不用改。
 */
class Engine private constructor(private val ctx: Context) {
    companion object {
        @Volatile private var instance: Engine? = null
        fun get(ctx: Context): Engine = instance ?: synchronized(this) { instance ?: Engine(ctx.applicationContext).also { instance = it } }
    }

    val db = Db(ctx)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessions = ConcurrentHashMap<String, AccountSession>()
    @Volatile var listener: ((String, Any?) -> Unit)? = null
    private var started = false
    private var countsJob: Job? = null

    fun emit(name: String, payload: Any?) {
        runCatching { listener?.invoke(name, payload) }.onFailure { Log.w("MoyerEngine", "emit $name", it) }
    }

    @Synchronized
    fun start() {
        if (started) return
        started = true
        for (acc in db.listAccounts()) if (acc.optBoolean("enabled", true)) startSession(acc)
        // 定时检查其他文件夹（收件箱靠 IDLE 实时推送）
        scope.launch {
            while (true) {
                delay(settings().optInt("syncIntervalMin", 5).coerceAtLeast(1) * 60_000L)
                for (s in sessions.values) s.syncAllAsync()
            }
        }
        // 上次被关掉时正在发送的定时邮件，重新排队；之后每 30 秒检查一次到点的提醒和定时邮件
        db.exec("UPDATE outbox SET status = 'pending' WHERE status = 'sending'")
        scope.launch {
            delay(5_000)
            while (true) {
                runCatching { tick() }.onFailure { Log.w("MoyerEngine", "tick", it) }
                delay(30_000)
            }
        }
        Alarms.reschedule(ctx, db)
    }

    private fun startSession(acc: JSONObject) {
        val s = AccountSession(this, acc)
        sessions[acc.getString("id")] = s
        s.start()
    }

    private fun restartSession(id: String) {
        sessions.remove(id)?.stop()
        db.getAccount(id)?.takeIf { it.optBoolean("enabled", true) }?.let { startSession(it) }
    }

    private fun session(id: String): AccountSession = sessions[id] ?: throw UserError("这个账号已停用或不存在")

    private fun enabledIds(): List<String> = db.listAccounts().filter { it.optBoolean("enabled", true) }.map { it.getString("id") }

    // ======================= 回调（来自同步线程） =======================
    fun onChanged(accountId: String, folders: List<String>) {
        if (folders.isNotEmpty()) emit("messages-changed", jobj("accountId" to accountId, "folders" to jarr(folders)))
        emitCounts()
    }

    /** 界面是否正显示在屏幕上（由插件在 onResume / onPause 时更新） */
    @Volatile var appVisible = false

    /** 新邮件到达（在同步线程里调用）：先执行收信规则，再弹通知 */
    fun onNewMessages(accountId: String, ids: List<Long>) {
        emitCounts()
        // 规则里的标记 / 移动要排到同步线程上执行，所以另起协程，不能在这里等
        scope.launch {
            val quiet = runCatching { applyRules(ids, null).second }.getOrElse {
                Log.w("MoyerEngine", "rules", it)
                emptySet()
            }
            // 正开着应用时列表会直接刷新出来，不用再弹系统通知
            if (appVisible || !settings().optBoolean("notifications", true)) return@launch
            val rows = db.messagesByIds(ids).filter { !it.seen && it.id !in quiet }
            val label = db.getAccount(accountId)?.optString("label") ?: ""
            runCatching { Notifier.newMail(ctx, label, rows) }.onFailure { Log.w("MoyerEngine", "notify", it) }
        }
    }

    private fun emitFolders(rows: List<MessageRow>) {
        for ((acc, list) in rows.groupBy { it.accountId }) emit("messages-changed", jobj("accountId" to acc, "folders" to jarr(list.map { it.folder }.distinct())))
    }

    // ======================= 收信规则 =======================
    private fun listRules(): JSONArray = jarr(db.query("SELECT json FROM rules ORDER BY sort, rowid") { JSONObject(it.getString(0)) })

    private fun saveRule(rule: JSONObject): JSONObject {
        val r = JSONObject(rule.toString())
        val id = r.optStr("id")?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString().take(12)
        r.put("id", id)
        r.put("name", r.optString("name").trim().ifEmpty { "未命名规则" })
        val sort = db.query("SELECT sort FROM rules WHERE id = ?", listOf(id)) { it.getInt(0) }.firstOrNull()
            ?: db.scalarLong("SELECT COUNT(*) FROM rules").toInt()
        db.exec("INSERT OR REPLACE INTO rules (id, json, sort) VALUES (?, ?, ?)", listOf(id, r.toString(), sort))
        return r
    }

    private fun ruleMatches(rule: JSONObject, r: MessageRow): Boolean {
        val conditions = rule.optJSONArray("conditions")?.objects() ?: emptyList()
        if (!rule.optBoolean("enabled", true) || conditions.isEmpty()) return false
        rule.optStr("accountId")?.let { if (it != r.accountId) return false }
        val recips = (JSONArray(r.toJson).objects() + JSONArray(r.ccJson).objects()).flatMap { listOf(it.optString("address"), it.optString("name")) }
        fun test(c: JSONObject): Boolean {
            val want = c.optString("value").trim().lowercase()
            if (want.isEmpty()) return false
            val candidates = when (c.optString("field")) {
                "subject" -> listOf(r.subject)
                "from" -> listOf(r.fromAddr ?: "", r.fromName ?: "")
                else -> recips
            }
            val vals = candidates.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            return when (c.optString("op")) {
                "contains" -> vals.any { it.contains(want) }
                "notContains" -> vals.none { it.contains(want) }
                "equals" -> vals.any { it == want }
                "startsWith" -> vals.any { it.startsWith(want) }
                "endsWith" -> vals.any { it.endsWith(want) }
                else -> false
            }
        }
        return if (rule.optString("match") == "any") conditions.any(::test) else conditions.all(::test)
    }

    /** 对一批邮件执行规则；返回（命中的邮件数，不需要弹通知的邮件） */
    private suspend fun applyRules(ids: List<Long>, only: String?): Pair<Int, Set<Long>> {
        val rules = listRules().objects().filter { it.optBoolean("enabled", true) && (only == null || it.optString("id") == only) }
        val quiet = HashSet<Long>()
        if (rules.isEmpty() || ids.isEmpty()) return 0 to quiet
        val markRead = ArrayList<Long>()
        val flag = ArrayList<Long>()
        val moves = LinkedHashMap<String, MutableList<Long>>()
        var matched = 0
        for (row in db.messagesByIds(ids)) {
            var hit = false
            var moved = false
            for (rule in rules) {
                if (!ruleMatches(rule, row)) continue
                hit = true
                val a = rule.optJSONObject("actions") ?: JSONObject()
                if (a.optBoolean("markRead")) markRead.add(row.id)
                if (a.optBoolean("flag")) flag.add(row.id)
                if (a.optBoolean("silent") || a.optBoolean("markRead")) quiet.add(row.id)
                val move = a.optStr("move")
                if (move != null && !moved) {
                    moved = true
                    quiet.add(row.id)
                    moves.getOrPut(move) { ArrayList() }.add(row.id)
                }
            }
            if (hit) matched++
        }
        if (markRead.isNotEmpty()) runCatching { setFlags(markRead, jobj("seen" to true)) }.onFailure { Log.w("MoyerEngine", "rule markRead", it) }
        if (flag.isNotEmpty()) runCatching { setFlags(flag, jobj("flagged" to true)) }.onFailure { Log.w("MoyerEngine", "rule flag", it) }
        for ((target, list) in moves) runCatching { moveMessages(list, target) }.onFailure { Log.w("MoyerEngine", "rule move", it) }
        return matched to quiet
    }

    private suspend fun runRules(ruleId: String?): Int {
        val ids = enabledIds()
        if (ids.isEmpty()) return 0
        val rows = db.query("SELECT id FROM messages WHERE role = 'inbox' AND account_id IN (${ids.joinToString(",") { "?" }})", ids) { it.getLong(0) }
        return applyRules(rows, ruleId).first
    }

    // ======================= 稍后提醒 =======================
    private fun snooze(ids: List<Long>, until: Long?): Any? {
        val rows = db.messagesByIds(ids)
        db.tx { for (r in rows) db.exec("UPDATE messages SET snooze_until = ? WHERE id = ?", listOf(until, r.id)) }
        emitFolders(rows)
        emitCounts()
        Alarms.reschedule(ctx, db)
        return null
    }

    // ======================= 定时发送 =======================
    private fun emitScheduled() {
        emit("scheduled-changed", jobj("count" to db.scalarLong("SELECT COUNT(*) FROM outbox WHERE status IN ('pending', 'failed')")))
    }

    /** 定时邮件的附件从缓存目录复制到应用自己的目录，免得到点前被系统清理掉 */
    private fun stashAttachments(d: JSONObject) {
        val dir = File(ctx.filesDir, "outbox/${UUID.randomUUID()}")
        (d.optJSONArray("attachments")?.objects() ?: emptyList()).forEachIndexed { i, a ->
            val path = a.optStr("path") ?: return@forEachIndexed
            val src = File(path)
            if (!src.exists()) throw UserError("附件“${a.optString("filename")}”已经不存在了，请重新添加")
            val dst = File(dir, "$i/${src.name}")
            dst.parentFile?.mkdirs()
            src.copyTo(dst, overwrite = true)
            a.put("path", dst.absolutePath)
        }
        d.put("_stash", dir.absolutePath)
    }

    /** 定时邮件发出或取消后清理暂存的附件；取消时挪回缓存目录，让写信窗口还能用 */
    private fun releaseAttachments(d: JSONObject, backToComposer: Boolean) {
        val stash = d.optStr("_stash")?.let { File(it) }
        d.remove("_stash")
        if (stash == null) return
        if (backToComposer) {
            for (a in d.optJSONArray("attachments")?.objects() ?: emptyList()) {
                val f = File(a.optStr("path") ?: continue)
                if (!f.exists() || !f.absolutePath.startsWith(stash.absolutePath)) continue
                val dst = File(ctx.cacheDir, "outgoing/${UUID.randomUUID()}/${f.name}")
                dst.parentFile?.mkdirs()
                f.copyTo(dst, overwrite = true)
                a.put("path", dst.absolutePath)
            }
        }
        stash.deleteRecursively()
    }

    private fun scheduleSend(draft: JSONObject, sendAt: Long): Any? {
        val d = JSONObject(draft.toString())
        val accountId = d.getString("accountId")
        db.getAccount(accountId) ?: throw UserError("发件账号不存在")
        val recipients = listOf("to", "cc", "bcc").flatMap { d.optJSONArray(it)?.objects() ?: emptyList() }.filter { it.optString("address").isNotBlank() }
        if (recipients.isEmpty()) throw UserError("请填写收件人")
        stashAttachments(d)
        val now = System.currentTimeMillis()
        db.exec(
            "INSERT INTO outbox (account_id, draft_json, send_at, status, created) VALUES (?, ?, ?, 'pending', ?)",
            listOf(accountId, d.toString(), maxOf(sendAt, now), now)
        )
        emitScheduled()
        Alarms.reschedule(ctx, db)
        if (sendAt <= now + 1000) scope.launch { delay(200); tick() }
        return null
    }

    private fun listScheduled(): JSONArray = jarr(
        db.query("SELECT id, account_id, draft_json, send_at, status, error FROM outbox WHERE status IN ('pending', 'failed') ORDER BY send_at") { c ->
            val d = runCatching { JSONObject(c.getString(2)) }.getOrElse { JSONObject() }
            jobj(
                "id" to c.getLong(0), "accountId" to c.getString(1), "subject" to d.optString("subject"),
                "to" to (d.optJSONArray("to") ?: JSONArray()), "sendAt" to c.getLong(3), "status" to c.getString(4),
                "error" to (if (c.isNull(5)) null else c.getString(5))
            )
        }
    )

    private fun cancelScheduled(id: Long): JSONObject {
        val row = db.query("SELECT draft_json, status FROM outbox WHERE id = ?", listOf(id)) { it.getString(0) to it.getString(1) }.firstOrNull()
            ?: throw UserError("这封定时邮件已经发出或不存在")
        if (row.second == "sending") throw UserError("正在发送中，无法取消")
        db.exec("DELETE FROM outbox WHERE id = ?", listOf(id))
        emitScheduled()
        Alarms.reschedule(ctx, db)
        val d = JSONObject(row.first)
        releaseAttachments(d, backToComposer = true)
        return d
    }

    private suspend fun sendScheduledNow(id: Long): Any? {
        db.exec("UPDATE outbox SET send_at = ?, status = 'pending', error = NULL WHERE id = ? AND status != 'sending'", listOf(System.currentTimeMillis(), id))
        tick(wait = true)
        val err = db.query("SELECT error FROM outbox WHERE id = ? AND status = 'failed'", listOf(id)) { if (it.isNull(0)) "发送失败" else it.getString(0) }.firstOrNull()
        if (err != null) throw UserError(err)
        return null
    }

    // ======================= 定时任务：到点的提醒和定时邮件 =======================
    private val tickLock = Mutex()

    /** 每 30 秒执行一次，闹钟响时也会调用。wait = true 时如果正在执行就等它做完再来一遍 */
    suspend fun tick(wait: Boolean = false) {
        if (wait) tickLock.lock() else if (!tickLock.tryLock()) return
        try {
            val now = System.currentTimeMillis()
            // 稍后提醒到点：重新标为未读并提醒
            val due = db.messages("SELECT * FROM messages WHERE snooze_until IS NOT NULL AND snooze_until <= ?", listOf(now))
            if (due.isNotEmpty()) {
                db.tx { for (r in due) db.exec("UPDATE messages SET snooze_until = NULL WHERE id = ?", listOf(r.id)) }
                runCatching { setFlags(due.map { it.id }, jobj("seen" to false)) }.onFailure { Log.w("MoyerEngine", "unsnooze", it) }
                emitFolders(due)
                emitCounts()
                if (settings().optBoolean("notifications", true)) runCatching { Notifier.reminder(ctx, due) }
            }
            // 定时发送
            val jobs = db.query("SELECT id, draft_json FROM outbox WHERE status = 'pending' AND send_at <= ?", listOf(now)) { it.getLong(0) to it.getString(1) }
            for ((jobId, json) in jobs) {
                db.exec("UPDATE outbox SET status = 'sending' WHERE id = ?", listOf(jobId))
                val d = JSONObject(json)
                val subject = d.optString("subject").ifBlank { "（无主题）" }
                try {
                    send(d)
                    db.exec("DELETE FROM outbox WHERE id = ?", listOf(jobId))
                    releaseAttachments(d, backToComposer = false)
                    emit("toast", jobj("text" to "定时邮件已发送：$subject", "kind" to "ok"))
                } catch (e: Exception) {
                    val msg = friendlyError(e)
                    db.exec("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", listOf(msg, jobId))
                    runCatching { Notifier.scheduledFailed(ctx, subject, msg) }
                }
            }
            if (jobs.isNotEmpty()) emitScheduled()
        } finally {
            tickLock.unlock()
            Alarms.reschedule(ctx, db)
        }
    }

    fun storeParsed(row: MessageRow, p: ParsedBody) {
        if (db.messageById(row.id) == null) return
        db.setBody(row.id, p.html, p.text, p.meta, p.attachments, p.lang, p.snippet, p.attachments.length() > 0)
    }

    private fun emitCounts() {
        countsJob?.cancel()
        countsJob = scope.launch {
            delay(150)
            emit("counts", counts())
        }
    }

    // ======================= 设置 =======================
    /** 这些设置项（各种 API Key）加密后再存 */
    private val secretPaths = listOf(listOf("translate", "llm", "apiKey"), listOf("translate", "deepl", "apiKey"), listOf("translate", "azure", "key"), listOf("oauth", "googleClientSecret"))

    private fun mapSecrets(o: JSONObject, f: (String) -> String): JSONObject {
        val out = JSONObject(o.toString())
        for (path in secretPaths) {
            var node: JSONObject? = out
            for (k in path.dropLast(1)) node = node?.optJSONObject(k)
            val leaf = path.last()
            val v = node?.optStr(leaf)
            if (!v.isNullOrEmpty()) node!!.put(leaf, f(v))
        }
        return out
    }

    fun settings(): JSONObject {
        val stored = db.getKv("settings")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        val plain = mapSecrets(stored) { v -> if (v.startsWith("enc:")) runCatching { Secrets.decrypt(v.removePrefix("enc:")) }.getOrDefault("") else v }
        return deepMerge(JSONObject(DEFAULT_SETTINGS), plain)
    }

    // ======================= 分发：界面调用的每个方法 =======================
    suspend fun dispatch(method: String, a: JSONArray): Any? = when (method) {
        "listAccounts" -> jarr(db.listAccounts())
        "testAccount" -> testAccount(a.getJSONObject(0))
        "saveAccount" -> saveAccount(a.getJSONObject(0))
        "removeAccount" -> removeAccount(a.getString(0))
        "reorderAccounts" -> reorderAccounts(a.getJSONArray(0).strings())
        "oauthLogin" -> oauthLogin(a.getString(0), a.optStr(1))
        "listFolders" -> listFolders()
        "listMessages" -> listMessages(a.getJSONObject(0))
        "getMessage" -> getMessage(a.getLong(0))
        "getCounts" -> counts()
        "getSyncStatus" -> jarr(sessions.values.map { it.statusJson() })
        "setFlags" -> setFlags(a.getJSONArray(0).longs(), a.getJSONObject(1))
        "moveMessages" -> moveMessages(a.getJSONArray(0).longs(), a.get(1))
        "deleteForever" -> moveMessages(a.getJSONArray(0).longs(), "trash")
        "syncNow" -> syncNow(a.optStr(0))
        "openFolder" -> sessions[a.getString(0)]?.schedule(a.getString(1)).let { null }
        "loadOlder" -> loadOlder(a.getJSONObject(0))
        "markAllRead" -> markAllRead(a.getJSONObject(0))
        "searchServer" -> searchServer(a.getString(0), a.getJSONObject(1))
        "getThread" -> getThread(a.getLong(0))
        "snooze" -> snooze(a.getJSONArray(0).longs(), if (a.length() < 2 || a.isNull(1)) null else a.getLong(1))
        "listRules" -> listRules()
        "saveRule" -> saveRule(a.getJSONObject(0))
        "removeRule" -> db.exec("DELETE FROM rules WHERE id = ?", listOf(a.getString(0))).let { null }
        "runRules" -> runRules(a.optStr(0))
        "scheduleSend" -> scheduleSend(a.getJSONObject(0), a.getLong(1))
        "listScheduled" -> listScheduled()
        "cancelScheduled" -> cancelScheduled(a.getLong(0))
        "sendScheduledNow" -> sendScheduledNow(a.getLong(0))
        "openAttachment" -> openAttachment(a.getLong(0), a.getInt(1))
        "saveAttachment" -> saveAttachment(a.getLong(0), a.getInt(1))
        "pickFiles" -> JSONArray()
        "send" -> send(a.getJSONObject(0))
        "suggestContacts" -> suggestContacts(a.optString(0))
        "translate" -> translate(a.getJSONObject(0))
        "getSettings" -> settings()
        "setSettings" -> setSettings(a.getJSONObject(0))
        "testProxy" -> jobj("ok" to true)
        "openExternal" -> openExternal(a.getString(0))
        "setWindowTheme" -> null
        "appInfo" -> jobj(
            "version" to runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull(),
            "dataDir" to ctx.filesDir.absolutePath,
            "platform" to "android"
        )
        else -> throw UserError("未知操作：$method")
    }

    private fun JSONArray.optStr(i: Int): String? = if (length() > i && !isNull(i)) optString(i) else null

    // ======================= 账号 =======================
    private fun draftToConfig(d: JSONObject, existing: JSONObject?): JSONObject {
        val email = d.getString("email").trim()
        val count = db.listAccounts().size
        return jobj(
            "id" to (existing?.getString("id") ?: d.optStr("id") ?: UUID.randomUUID().toString().take(12)),
            "email" to email,
            "name" to (d.optStr("name")?.trim()?.takeIf { it.isNotEmpty() } ?: email.substringBefore('@')),
            "label" to (d.optStr("label")?.trim()?.takeIf { it.isNotEmpty() } ?: existing?.optStr("label") ?: email),
            "provider" to d.optString("provider", "custom"),
            "color" to (d.optStr("color") ?: existing?.optStr("color") ?: ACCOUNT_COLORS[count % ACCOUNT_COLORS.size]),
            "authType" to d.optString("authType", "password"),
            "username" to (d.optStr("username")?.trim()?.takeIf { it.isNotEmpty() } ?: email),
            "imap" to d.getJSONObject("imap").apply { put("host", getString("host").trim()) },
            "smtp" to d.getJSONObject("smtp").apply { put("host", getString("host").trim()) },
            "useProxy" to d.optBoolean("useProxy", false),
            "appendSent" to d.optBoolean("appendSent", true),
            "signature" to (d.optStr("signature") ?: existing?.optStr("signature") ?: ""),
            "enabled" to (existing?.optBoolean("enabled", true) ?: true),
            "createdAt" to (existing?.optLong("createdAt") ?: System.currentTimeMillis()),
            "sortOrder" to (existing?.optInt("sortOrder") ?: count)
        )
    }

    // ---------------- 凭据 ----------------
    /** 授权登录（OAuth）后、点“保存”之前，暂存拿到的令牌 */
    private val pendingOAuth = ConcurrentHashMap<String, OAuthTokens>()
    private val refreshLocks = ConcurrentHashMap<String, Any>()

    /** 登录用的用户名和密码 / 访问令牌。令牌快过期时自动换新（会联网，要在后台线程调用） */
    fun credentials(acc: JSONObject): Creds {
        val id = acc.getString("id")
        val user = acc.optString("username").ifBlank { acc.getString("email") }
        if (acc.optString("authType", "password") == "password") {
            val pass = db.getSecret("$id:password") ?: throw UserError("缺少授权码/密码，请编辑账号重新填写。")
            return Creds(user, pass, false)
        }
        synchronized(refreshLocks.getOrPut(id) { Any() }) {
            var t = db.getSecret("$id:oauth")?.let { runCatching { OAuthTokens.from(JSONObject(it)) }.getOrNull() }
                ?: throw UserError("登录已失效，请编辑账号重新授权。")
            if (t.expiresAt < System.currentTimeMillis() + 120_000) {
                t = OAuth.refresh(t, settings())
                db.setSecret("$id:oauth", t.toJson().toString())
            }
            return Creds(user, t.accessToken, true)
        }
    }

    /** 添加 / 编辑账号时测试连接用的凭据 */
    private fun draftCreds(d: JSONObject, acc: JSONObject): Creds {
        val user = acc.getString("username")
        if (d.optString("authType", "password") == "password") {
            val pass = d.optStr("password")?.takeIf { it.isNotEmpty() } ?: d.optStr("id")?.let { db.getSecret("$it:password") }
                ?: throw UserError("请填写授权码/密码")
            return Creds(user, pass, false)
        }
        d.optStr("oauthHandle")?.let { h ->
            val t = pendingOAuth[h] ?: throw UserError("授权已过期，请重新登录")
            return Creds(user, t.accessToken, true)
        }
        if (d.optStr("id") != null) return credentials(acc)
        throw UserError("请先完成账号授权")
    }

    private suspend fun oauthLogin(provider: String, loginHint: String?): JSONObject {
        // 在浏览器里登录时应用在后台，一加等手机会很快把后台应用冻结，收不到浏览器的回调。
        // 没开“后台收信”的话，登录期间临时开一下前台服务保活，结束后关掉
        val tempService = !settings().optBoolean("backgroundSync", true)
        if (tempService) MailService.start(ctx)
        val r = try {
            withContext(Dispatchers.IO) { OAuth.interactive(ctx, provider, settings(), loginHint) }
        } finally {
            if (tempService && !settings().optBoolean("backgroundSync", true)) MailService.stop(ctx)
        }
        val handle = UUID.randomUUID().toString()
        pendingOAuth[handle] = r.tokens
        scope.launch {
            delay(30 * 60_000L)
            pendingOAuth.remove(handle)
        }
        return jobj("handle" to handle, "email" to r.email, "name" to r.name)
    }

    private suspend fun testAccount(d: JSONObject): JSONObject {
        val existing = d.optStr("id")?.let { db.getAccount(it) }
        val acc = draftToConfig(d, existing)
        val cred = try {
            withContext(Dispatchers.IO) { draftCreds(d, acc) }
        } catch (e: Exception) {
            return jobj("ok" to false, "error" to friendlyError(e))
        }
        val imap = acc.getJSONObject("imap")
        val smtp = acc.getJSONObject("smtp")
        val results = listOf(
            scope.async { runCatching { connectImap(imap.getString("host"), imap.getInt("port"), imap.getBoolean("secure"), cred.user, cred.secret, cred.oauth).close() } },
            scope.async { runCatching { verifySmtp(smtp.getString("host"), smtp.getInt("port"), smtp.getBoolean("secure"), cred.user, cred.secret, cred.oauth) } }
        ).awaitAll()
        val imapErr = results[0].exceptionOrNull()?.let { friendlyError(it) }
        val smtpErr = results[1].exceptionOrNull()?.let { friendlyError(it) }
        if (imapErr == null && smtpErr == null) return jobj("ok" to true)
        return jobj(
            "ok" to false, "imap" to imapErr, "smtp" to smtpErr,
            "error" to (imapErr?.let { "收信（IMAP）：$it" } ?: "发信（SMTP）：$smtpErr")
        )
    }

    private fun saveAccount(d: JSONObject): JSONObject {
        val existing = d.optStr("id")?.let { db.getAccount(it) }
        if (existing == null && db.listAccounts().any { it.getString("email").equals(d.getString("email").trim(), true) })
            throw UserError("这个邮箱已经添加过了")
        val acc = draftToConfig(d, existing)
        db.saveAccount(acc)
        if (acc.getString("authType") == "password") d.optStr("password")?.takeIf { it.isNotEmpty() }?.let { db.setSecret("${acc.getString("id")}:password", it) }
        d.optStr("oauthHandle")?.let { h ->
            pendingOAuth.remove(h)?.let { db.setSecret("${acc.getString("id")}:oauth", it.toJson().toString()) }
        }
        restartSession(acc.getString("id"))
        emit("accounts-changed", jarr(db.listAccounts()))
        return acc
    }

    private fun removeAccount(id: String): Any? {
        sessions.remove(id)?.stop()
        db.removeAccount(id)
        emit("accounts-changed", jarr(db.listAccounts()))
        emitCounts()
        return null
    }

    private fun reorderAccounts(ids: List<String>): Any? {
        ids.forEachIndexed { i, id ->
            db.getAccount(id)?.let { acc ->
                acc.put("sortOrder", i)
                db.saveAccount(acc)
                sessions[id]?.account = acc
            }
        }
        emit("accounts-changed", jarr(db.listAccounts()))
        return null
    }

    // ======================= 文件夹与列表 =======================
    private fun listFolders(): JSONArray {
        val order = enabledIds().withIndex().associate { it.value to it.index }
        return jarr(db.folders().filter { it.accountId in order }.sortedWith(compareBy({ order[it.accountId] }, { it.sort }, { it.path })).map { it.toJson() })
    }

    private data class Where(val where: MutableList<String>, val params: MutableList<Any?>, val dedup: Boolean)

    private fun viewWhere(view: JSONObject, widen: Boolean): Where {
        val where = mutableListOf<String>()
        val params = mutableListOf<Any?>()
        var dedup = false
        val ids = enabledIds()
        where.add(if (ids.isEmpty()) "account_id IN ('')" else "account_id IN (${ids.joinToString(",") { "?" }})")
        params.addAll(ids)
        when (view.getString("kind")) {
            "unified" -> when (val box = view.getString("box")) {
                "inbox", "unread", "all" -> if (widen || box == "all") {
                    where.add("role NOT IN ('trash', 'junk')")
                    if (box == "unread") where.add("seen = 0")
                    dedup = true
                } else {
                    where.add("role = 'inbox'")
                    if (box == "unread") where.add("seen = 0")
                }
                "flagged" -> {
                    where.add("flagged = 1 AND role NOT IN ('trash', 'junk')"); dedup = true
                }
                "snoozed" -> where.add("snooze_until IS NOT NULL")
                else -> {
                    where.add("role = ?"); params.add(box)
                }
            }
            "account" -> {
                where.add("account_id = ? AND role = 'inbox'"); params.add(view.getString("accountId"))
            }
            else -> {
                where.add("account_id = ? AND folder = ?"); params.add(view.getString("accountId")); params.add(view.getString("path"))
            }
        }
        return Where(where, params, dedup)
    }

    private fun listMessages(q: JSONObject): JSONObject {
        val search = q.optString("search", "").trim()
        val view = q.getJSONObject("view")
        val w = viewWhere(view, search.isNotEmpty())
        val snoozedView = view.getString("kind") == "unified" && view.optString("box") == "snoozed"
        // 稍后提醒的邮件到点之前只出现在“稍后处理”里
        if (!snoozedView && search.isEmpty()) {
            w.where.add("(snooze_until IS NULL OR snooze_until <= ?)")
            w.params.add(System.currentTimeMillis())
        }
        if (q.optBoolean("unreadOnly", false)) w.where.add("seen = 0")
        for (term in search.split(Regex("\\s+")).filter { it.isNotEmpty() }.take(6)) {
            val like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            w.where.add("(subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\')")
            repeat(4) { w.params.add(like) }
        }
        var cond = w.where.joinToString(" AND ")
        if (w.dedup) cond = "id IN (SELECT MAX(id) FROM messages WHERE $cond GROUP BY account_id, COALESCE(message_id, 'id:' || id))"
        val limit = q.optInt("limit", 100).coerceIn(1, 500)
        val offset = q.optInt("offset", 0).coerceAtLeast(0)
        val threaded = q.optBoolean("threads", false) && !(view.getString("kind") == "unified" && view.optString("box") in NO_THREAD_BOXES)

        if (!threaded) {
            val order = if (snoozedView) "snooze_until ASC" else "date DESC"
            val rows = db.messages("SELECT * FROM messages WHERE $cond ORDER BY $order LIMIT $limit OFFSET $offset", w.params)
            val total = db.scalarLong("SELECT COUNT(*) FROM messages WHERE $cond", w.params)
            return jobj("items" to jarr(rows.map { it.toSummary() }), "total" to total)
        }

        // 会话模式：每个会话只显示最新的一封，带上会话里的其他邮件编号。
        // 安卓 11 以下的 SQLite 没有窗口函数，这里用 GROUP BY + MAX(date)：查询里只有一个 MAX 时，
        // SQLite 会让其余列取 date 最大的那一行（所以其他汇总都用 SUM，不能再出现 MAX/MIN）
        val group = "account_id, COALESCE(thread_key, 'id:' || id)"
        val items = db.query(
            """SELECT *, MAX(date) AS t_date, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS t_unread, SUM(flagged) AS t_flag,
                 SUM(has_att) AS t_att, group_concat(id) AS t_ids
               FROM messages WHERE $cond GROUP BY $group ORDER BY t_date DESC LIMIT $limit OFFSET $offset""",
            w.params
        ) { c ->
            val r = db.messageFrom(c)
            val s = r.toSummary()
            s.put("seen", c.getInt(c.getColumnIndexOrThrow("t_unread")) == 0)
            s.put("flagged", c.getInt(c.getColumnIndexOrThrow("t_flag")) > 0)
            s.put("hasAttachments", c.getInt(c.getColumnIndexOrThrow("t_att")) > 0)
            s.put("threadIds", jarr(c.getString(c.getColumnIndexOrThrow("t_ids")).split(',').mapNotNull { it.trim().toLongOrNull() }))
            r.threadKey to s
        }.map { (key, s) ->
            val count = if (key == null) 1L else db.scalarLong(
                "SELECT COUNT(DISTINCT COALESCE(message_id, 'id:' || id)) FROM messages WHERE account_id = ? AND thread_key = ? AND role NOT IN ('trash', 'junk')",
                listOf(s.getString("accountId"), key)
            ).coerceAtLeast(1)
            s.put("threadCount", count)
        }
        val total = db.scalarLong("SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE $cond GROUP BY $group)", w.params)
        return jobj("items" to jarr(items), "total" to total)
    }

    /** 会话里的全部邮件（同一封在多个文件夹里只保留一份），按时间从旧到新 */
    private fun getThread(id: Long): JSONArray {
        val row = db.messageById(id) ?: throw UserError("邮件不存在（可能已被删除）")
        val key = row.threadKey ?: return jarr(listOf(row.toSummary()))
        val rows = db.messages(
            "SELECT * FROM messages WHERE account_id = ? AND thread_key = ? AND (role NOT IN ('trash', 'junk') OR id = ?) ORDER BY date DESC LIMIT 100",
            listOf(row.accountId, key, id)
        )
        fun rank(r: MessageRow) = if (r.id == id) 0 else if (r.role == "all") 3 else if (r.bodyState != 0) 1 else 2
        val byMid = LinkedHashMap<String, MessageRow>()
        for (r in rows) {
            val k = r.messageId ?: "id:${r.id}"
            val prev = byMid[k]
            if (prev == null || rank(r) < rank(prev)) byMid[k] = r
        }
        return jarr(byMid.values.sortedBy { it.date }.map { it.toSummary() })
    }

    // ---------------- 加载更早的邮件 / 服务器搜索 ----------------
    private suspend fun loadOlder(view: JSONObject): Int {
        val kind = view.getString("kind")
        if (kind == "folder") return session(view.getString("accountId")).let { s -> s.onWorker { s.loadOlder(view.getString("path")) } }
        val box = view.optString("box")
        if (kind == "unified" && box == "snoozed") return 0
        val role = if (kind == "account" || box in setOf("unread", "flagged", "all", "inbox")) "inbox" else box
        val ids = if (kind == "account") listOf(view.getString("accountId")) else enabledIds()
        return ids.map { id ->
            scope.async {
                val f = db.folderByRole(id, role) ?: return@async 0
                val s = sessions[id] ?: return@async 0
                runCatching { s.onWorker { s.loadOlder(f.path) } }.getOrDefault(0)
            }
        }.awaitAll().sum()
    }

    private suspend fun searchServer(query: String, view: JSONObject): Int {
        val q = query.trim()
        if (q.isEmpty()) return 0
        val targets: List<Pair<String, String>> = if (view.getString("kind") == "folder") listOf(view.getString("accountId") to view.getString("path"))
        else {
            val ids = if (view.getString("kind") == "account") listOf(view.getString("accountId")) else enabledIds()
            ids.flatMap { id ->
                // Gmail 搜“所有邮件”就能覆盖归档和已发送
                val all = if (db.getAccount(id)?.optString("provider") == "gmail") db.folderByRole(id, "all") else null
                if (all != null) listOf(id to all.path)
                else listOf("inbox", "sent", "archive").mapNotNull { r -> db.folderByRole(id, r)?.let { id to it.path } }
            }
        }
        val results = targets.map { (acc, path) ->
            scope.async { runCatching { sessions[acc]?.let { s -> s.onWorker { s.searchServer(path, q) } } ?: emptyList() } }
        }.awaitAll()
        val found = results.sumOf { it.getOrNull()?.size ?: 0 }
        if (found == 0 && results.isNotEmpty() && results.all { it.isFailure })
            throw UserError("服务器搜索失败：${friendlyError(results[0].exceptionOrNull()!!)}")
        return found
    }

    private fun counts(): JSONObject {
        val ids = enabledIds().toSet()
        val unified = JSONObject()
        UNIFIED_BOXES.forEach { unified.put(it, 0) }
        val folders = JSONObject()
        val accounts = JSONObject()
        var inbox = 0; var junk = 0; var drafts = 0
        for (f in db.folders()) {
            if (f.accountId !in ids) continue
            folders.put("${f.accountId}\n${f.path}", f.unread)
            when (f.role) {
                "inbox" -> { inbox += f.unread; accounts.put(f.accountId, accounts.optInt(f.accountId) + f.unread) }
                "junk" -> junk += f.unread
                "drafts" -> drafts += f.total
            }
        }
        unified.put("inbox", inbox); unified.put("unread", inbox); unified.put("junk", junk); unified.put("drafts", drafts)
        if (ids.isNotEmpty()) {
            val inList = ids.joinToString(",") { "?" }
            unified.put("snoozed", db.scalarLong("SELECT COUNT(*) FROM messages WHERE snooze_until IS NOT NULL AND account_id IN ($inList)", ids.toList()))
            unified.put(
                "flagged",
                db.scalarLong(
                    "SELECT COUNT(*) FROM (SELECT 1 FROM messages WHERE flagged = 1 AND role NOT IN ('trash','junk') AND account_id IN ($inList) GROUP BY account_id, COALESCE(message_id, 'id:' || id))",
                    ids.toList()
                )
            )
        }
        return jobj("unified" to unified, "folders" to folders, "accounts" to accounts)
    }

    private suspend fun syncNow(accountId: String?): Any? {
        val list = if (accountId != null) listOf(session(accountId)) else sessions.values.toList()
        list.map { s -> scope.async { s.onWorker { s.syncAll() } } }.awaitAll()
        return null
    }

    // ======================= 读信 =======================
    private suspend fun getMessage(id: Long): JSONObject {
        val row = db.messageById(id) ?: throw UserError("邮件不存在（可能已被删除）")
        var body = db.getBody(id)
        if (body == null) {
            val s = session(row.accountId)
            val parsed = s.onWorker { s.fetchBody(row) } ?: throw UserError("这封邮件在服务器上已不存在")
            storeParsed(row, parsed)
            body = db.getBody(id) ?: throw UserError("邮件读取失败")
        }
        val fresh = db.messageById(id) ?: row
        val d = fresh.toSummary()
        val meta = body.meta
        meta.optJSONArray("to")?.takeIf { it.length() > 0 }?.let { d.put("to", it) }
        meta.optJSONArray("cc")?.takeIf { it.length() > 0 }?.let { d.put("cc", it) }
        d.put("replyTo", meta.optJSONArray("replyTo") ?: JSONArray())
        d.put("bcc", meta.optJSONArray("bcc") ?: JSONArray())
        d.put("inReplyTo", meta.optStr("inReplyTo") ?: fresh.inReplyTo ?: JSONObject.NULL)
        d.put("references", meta.optStr("references") ?: JSONObject.NULL)
        d.put("messageId", meta.optStr("messageId") ?: fresh.messageId ?: JSONObject.NULL)
        d.put("html", body.html ?: JSONObject.NULL)
        d.put("text", body.text ?: JSONObject.NULL)
        d.put("attachments", jarr(body.attachments.objects().filter { !it.optBoolean("inline") }))
        d.put("lang", body.lang ?: JSONObject.NULL)
        d.put("remoteImages", settings().optBoolean("loadRemoteImages", true))
        return d
    }

    // ======================= 旗标与移动 =======================
    private fun groups(ids: List<Long>): Map<Pair<String, String>, List<MessageRow>> =
        db.messagesByIds(ids).groupBy { it.accountId to it.folder }

    private suspend fun setFlags(ids: List<Long>, flags: JSONObject): Any? {
        val seen = if (flags.has("seen")) flags.getBoolean("seen") else null
        val flagged = if (flags.has("flagged")) flags.getBoolean("flagged") else null
        val gs = groups(ids)
        // 先改本地，界面立刻生效
        db.tx {
            for ((key, rows) in gs) {
                for (r in rows) {
                    if (seen != null) db.exec("UPDATE messages SET seen = ? WHERE id = ?", listOf(if (seen) 1 else 0, r.id))
                    if (flagged != null) db.exec("UPDATE messages SET flagged = ? WHERE id = ?", listOf(if (flagged) 1 else 0, r.id))
                }
                if (seen != null) {
                    val delta = rows.count { it.seen != seen } * (if (seen) -1 else 1)
                    if (delta != 0) db.exec("UPDATE folders SET unread = MAX(0, unread + ?) WHERE account_id = ? AND path = ?", listOf(delta, key.first, key.second))
                }
            }
        }
        emitCounts()
        val errors = gs.map { (key, rows) ->
            scope.async {
                val s = sessions[key.first] ?: return@async null
                runCatching {
                    s.onWorker {
                        val uids = rows.map { it.uid }
                        if (seen != null) s.setFlags(key.second, uids, Flags.Flag.SEEN, seen)
                        if (flagged != null) s.setFlags(key.second, uids, Flags.Flag.FLAGGED, flagged)
                    }
                }.exceptionOrNull()?.also { s.schedule(key.second) }
            }
        }.awaitAll().filterNotNull()
        if (errors.isNotEmpty()) throw UserError("同步到服务器失败：${friendlyError(errors[0])}")
        return null
    }

    private fun destFor(accountId: String, sourceRole: String, target: Any): String? {
        if (target is JSONObject) return target.getString("path")
        val t = target.toString()
        if (t == "archive") {
            val acc = db.getAccount(accountId)
            return if (acc?.optString("provider") == "gmail") db.folderByRole(accountId, "all")?.path else db.folderByRole(accountId, "archive")?.path
        }
        if (t == "trash" && sourceRole == "trash") return null
        return db.folderByRole(accountId, t)?.path
    }

    private suspend fun moveMessages(ids: List<Long>, target: Any): Any? {
        val gs = groups(ids)
        val plans = gs.map { (key, rows) -> Triple(key, rows, destFor(key.first, rows.first().role, target)) }
        for ((_, rows, dest) in plans) {
            if (dest == null && !(target == "trash" && rows.first().role == "trash")) {
                val what = when (target) { "archive" -> "归档"; "junk" -> "垃圾邮件"; "trash" -> "废纸篓"; else -> "目标" }
                throw UserError("这个邮箱没有“$what”文件夹")
            }
        }
        db.tx {
            for ((key, rows, _) in plans) {
                val unseen = rows.count { !it.seen }
                rows.forEach { db.deleteMessage(it.id) }
                if (unseen > 0) db.exec("UPDATE folders SET unread = MAX(0, unread - ?) WHERE account_id = ? AND path = ?", listOf(unseen, key.first, key.second))
            }
        }
        for ((key, _, _) in plans) emit("messages-changed", jobj("accountId" to key.first, "folders" to jarr(listOf(key.second))))
        emitCounts()
        val errors = plans.map { (key, rows, dest) ->
            scope.async {
                val s = sessions[key.first] ?: return@async null
                runCatching {
                    s.onWorker {
                        val uids = rows.map { it.uid }
                        if (dest != null) s.move(key.second, uids, dest) else s.deleteForever(key.second, uids)
                    }
                    if (dest != null) s.schedule(dest)
                }.exceptionOrNull()?.also { s.schedule(key.second) }
            }
        }.awaitAll().filterNotNull()
        if (errors.isNotEmpty()) throw UserError("操作失败：${friendlyError(errors[0])}")
        return null
    }

    private suspend fun markAllRead(view: JSONObject): Int {
        val kind = view.getString("kind")
        val role = when (kind) {
            "account" -> "inbox"
            "folder" -> null
            else -> when (val b = view.getString("box")) { "inbox", "unread" -> "inbox"; "flagged", "snoozed", "all" -> null; else -> b }
        }
        val targets: List<Pair<String, String>> = when {
            kind == "folder" -> listOf(view.getString("accountId") to view.getString("path"))
            role == null -> emptyList()
            else -> (if (kind == "account") listOf(view.getString("accountId")) else enabledIds()).mapNotNull { id -> db.folderByRole(id, role)?.let { id to it.path } }
        }
        if (targets.isEmpty()) {
            val ids = listMessages(jobj("view" to view, "unreadOnly" to true, "limit" to 500)).getJSONArray("items").objects().map { it.getLong("id") }
            if (ids.isNotEmpty()) setFlags(ids, jobj("seen" to true))
            return if (ids.isEmpty()) 0 else 1
        }
        db.tx {
            for ((acc, path) in targets) {
                db.exec("UPDATE messages SET seen = 1 WHERE account_id = ? AND folder = ?", listOf(acc, path))
                db.exec("UPDATE folders SET unread = 0 WHERE account_id = ? AND path = ?", listOf(acc, path))
            }
        }
        for ((acc, path) in targets) emit("messages-changed", jobj("accountId" to acc, "folders" to jarr(listOf(path))))
        emitCounts()
        val errors = targets.map { (acc, path) ->
            scope.async { sessions[acc]?.let { s -> runCatching { s.onWorker { s.markFolderSeen(path) } }.exceptionOrNull() } }
        }.awaitAll().filterNotNull()
        if (errors.isNotEmpty()) throw UserError("部分邮箱同步到服务器失败：${friendlyError(errors[0])}")
        return targets.size
    }

    // ======================= 其他 =======================
    private fun suggestContacts(query: String): JSONArray {
        val q = "%${query.trim().lowercase()}%"
        if (q == "%%") return JSONArray()
        return jarr(
            db.query("SELECT address, name FROM contacts WHERE address LIKE ? OR lower(name) LIKE ? ORDER BY score DESC, last_used DESC LIMIT 8", listOf(q, q)) {
                addrJson(it.getString(1), it.getString(0))
            }
        )
    }

    private fun translate(req: JSONObject): JSONObject =
        Translator.translate(req.getJSONArray("texts").strings(), req.optString("to", "zh"), req.optString("format") == "html", settings())

    private fun setSettings(patch: JSONObject): JSONObject {
        val before = settings()
        val merged = deepMerge(before, patch)
        db.setKv("settings", mapSecrets(merged) { v -> "enc:" + Secrets.encrypt(v) }.toString())
        if (before.optBoolean("backgroundSync", true) != merged.optBoolean("backgroundSync", true)) {
            if (merged.optBoolean("backgroundSync", true)) MailService.start(ctx) else MailService.stop(ctx)
        }
        emit("settings-changed", merged)
        return merged
    }

    private fun openExternal(url: String): Any? {
        if (!Regex("^(https?|mailto):", RegexOption.IGNORE_CASE).containsMatchIn(url)) throw UserError("不支持的链接")
        ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return null
    }

    // ======================= 附件 =======================
    private suspend fun attachmentContent(id: Long, index: Int): AttachmentData {
        val row = db.messageById(id) ?: throw UserError("邮件不存在")
        val s = session(row.accountId)
        return s.onWorker { s.fetchAttachment(row, index) } ?: throw UserError("附件不存在（邮件可能已在服务器上被删除）")
    }

    private fun safeName(name: String) = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "附件" }

    private suspend fun openAttachment(id: Long, index: Int): Any? {
        val a = attachmentContent(id, index)
        val ext = a.filename.substringAfterLast('.', "").lowercase()
        if (ext in setOf("apk", "apks", "xapk", "exe", "bat", "cmd", "scr", "js", "vbs", "jar"))
            throw UserError("为了安全，安装包和可执行文件不能直接打开。可以先“另存为”，确认来源可靠后再自己打开。")
        val dir = File(ctx.cacheDir, "attachments/$id").apply { mkdirs() }
        val file = File(dir, safeName(a.filename))
        file.writeBytes(a.bytes)
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, a.contentType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            ctx.startActivity(Intent.createChooser(view, "打开附件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (e: ActivityNotFoundException) {
            throw UserError("手机上没有能打开这种文件的应用，可以先“另存为”。")
        }
        return null
    }

    /** 保存到“下载/Moyer Mail”文件夹 */
    private suspend fun saveAttachment(id: Long, index: Int): Boolean {
        val a = attachmentContent(id, index)
        val name = safeName(a.filename)
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, a.contentType)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Moyer Mail")
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw UserError("保存失败")
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(a.bytes) } ?: throw UserError("保存失败")
        } else {
            val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: throw UserError("保存失败")
            File(dir, name).writeBytes(a.bytes)
        }
        emit("toast", jobj("text" to "已保存到 下载/Moyer Mail", "kind" to "ok"))
        return false
    }

    // ======================= 发信 =======================
    private suspend fun send(d: JSONObject): Any? {
        val acc = db.getAccount(d.getString("accountId")) ?: throw UserError("发件账号不存在")
        val accId = acc.getString("id")
        val recipients = listOf("to", "cc", "bcc").flatMap { d.optJSONArray(it)?.objects() ?: emptyList() }.filter { it.optString("address").isNotBlank() }
        if (recipients.isEmpty()) throw UserError("请填写收件人")
        val cred = withContext(Dispatchers.IO) { credentials(acc) }
        // 转发时要带上的原邮件附件，先取下来
        val forwarded = HashMap<Pair<Long, Int>, AttachmentData>()
        for (att in d.optJSONArray("attachments")?.objects() ?: emptyList()) {
            val from = att.optJSONObject("fromMessage") ?: continue
            val key = from.getLong("id") to from.getInt("index")
            forwarded[key] = attachmentContent(key.first, key.second)
        }
        val msg = try {
            buildMessage(acc, d) { id, index -> forwarded[id to index] }
        } catch (e: UserError) {
            throw e
        } catch (e: Exception) {
            throw UserError("邮件生成失败：${friendlyError(e)}")
        }
        try {
            withContext(Dispatchers.IO) { sendMessage(acc, cred, msg) }
        } catch (e: Exception) {
            throw UserError("发送失败：${friendlyError(e)}")
        }
        for (r in recipients) db.touchContact(r.optStr("name"), r.optString("address"), 3)
        val s = sessions[accId]
        val sent = db.folderByRole(accId, "sent")
        if (s != null && sent != null) {
            // 存“已发送”的那份在后台慢慢传，先把整封信复制到内存里：附件文件可能马上就被清理掉（比如定时邮件的暂存附件）
            val copy = if (acc.optBoolean("appendSent", true)) runCatching { javax.mail.internet.MimeMessage(msg) }.getOrNull() else null
            scope.launch {
                if (copy != null) {
                    runCatching { s.onWorker { markSeenForAppend(copy); s.append(sent.path, copy) } }.onFailure { Log.w("MoyerEngine", "append sent", it) }
                    delay(800)
                } else delay(4000)
                s.schedule(sent.path)
            }
        }
        val replyId = if (d.has("replyToLocalId") && !d.isNull("replyToLocalId")) d.getLong("replyToLocalId") else null
        replyId?.let { db.messageById(it) }?.let { row ->
            db.exec("UPDATE messages SET answered = 1 WHERE id = ?", listOf(row.id))
            emit("messages-changed", jobj("accountId" to row.accountId, "folders" to jarr(listOf(row.folder))))
            sessions[row.accountId]?.let { rs -> scope.launch { runCatching { rs.onWorker { rs.setFlags(row.folder, listOf(row.uid), Flags.Flag.ANSWERED, true) } } } }
        }
        return null
    }
}

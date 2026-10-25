package com.moyer.mail.engine

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.mail.Flags

private const val DEFAULT_SETTINGS = """{"theme":"system","palette":"mist","orbs":true,"density":"comfortable","threading":true,
"loadRemoteImages":true,"markReadOnOpen":true,"notifications":true,"closeToTray":true,"launchAtLogin":false,"syncIntervalMin":5,
"proxy":{"mode":"off","url":""},
"translate":{"provider":"google","targetLang":"zh","autoTranslate":false,"listSubjects":true,"display":"replace",
"llm":{"baseUrl":"https://api.deepseek.com/v1","apiKey":"","model":"deepseek-chat"},"deepl":{"apiKey":""},"azure":{"key":"","region":""}},
"oauth":{"microsoftClientId":"","googleClientId":"","googleClientSecret":""}}"""

private val ACCOUNT_COLORS = listOf("#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#64748b")
private val UNIFIED_BOXES = listOf("inbox", "unread", "flagged", "snoozed", "sent", "drafts", "trash", "junk", "all")

/**
 * 手机端引擎：实现和电脑版 src/core/engine.ts 一样的 MailApi，界面代码不用改。
 * 目前完成：账号、收信同步、读信、已读/星标、移动/删除、翻译。发信、附件、规则等在后续步骤加上。
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

    fun onNewMessages(accountId: String, ids: List<Long>) {
        // 系统通知在下一步（后台常驻服务）里加上；现在先刷新未读数
        emitCounts()
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

    private fun settings(): JSONObject {
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
        "oauthLogin" -> throw UserError("手机版暂时不支持微软/Google 授权登录。Gmail 可以用应用专用密码；Outlook 请先在电脑版使用。")
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
        "loadOlder" -> 0
        "markAllRead" -> markAllRead(a.getJSONObject(0))
        "searchServer" -> 0
        "getThread" -> jarr(listOfNotNull(db.messageById(a.getLong(0))?.toSummary()))
        "snooze" -> throw UserError("手机版暂时还不支持稍后提醒，后续会加上。")
        "listRules" -> JSONArray()
        "saveRule", "removeRule" -> throw UserError("手机版暂时还不支持收信规则，后续会加上。")
        "runRules" -> 0
        "scheduleSend", "cancelScheduled", "sendScheduledNow" -> throw UserError("手机版暂时还不支持定时发送，后续会加上。")
        "listScheduled" -> JSONArray()
        "openAttachment", "saveAttachment" -> throw UserError("手机版下一步支持打开附件。")
        "pickFiles" -> JSONArray()
        "send" -> throw UserError("手机版下一步支持发信，现在请先用电脑版回复。")
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

    private fun draftPassword(d: JSONObject): String? =
        d.optStr("password")?.takeIf { it.isNotEmpty() } ?: d.optStr("id")?.let { db.getSecret("$it:password") }

    private suspend fun testAccount(d: JSONObject): JSONObject {
        if (d.optString("authType", "password") != "password") return jobj("ok" to false, "error" to "手机版暂时不支持授权登录，请用授权码/应用专用密码。")
        val pass = draftPassword(d) ?: return jobj("ok" to false, "error" to "请填写授权码/密码")
        val user = d.optStr("username")?.trim()?.takeIf { it.isNotEmpty() } ?: d.getString("email").trim()
        val imap = d.getJSONObject("imap")
        val smtp = d.getJSONObject("smtp")
        val results = listOf(
            scope.async { runCatching { connectImap(imap.getString("host").trim(), imap.getInt("port"), imap.getBoolean("secure"), user, pass).close() } },
            scope.async { runCatching { verifySmtp(smtp.getString("host").trim(), smtp.getInt("port"), smtp.getBoolean("secure"), user, pass) } }
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
        if (d.optString("authType", "password") != "password") throw UserError("手机版暂时不支持授权登录，请用授权码/应用专用密码。")
        if (existing == null && db.listAccounts().any { it.getString("email").equals(d.getString("email").trim(), true) })
            throw UserError("这个邮箱已经添加过了")
        val acc = draftToConfig(d, existing)
        db.saveAccount(acc)
        d.optStr("password")?.takeIf { it.isNotEmpty() }?.let { db.setSecret("${acc.getString("id")}:password", it) }
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
                "snoozed" -> where.add("0 = 1")
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
        val w = viewWhere(q.getJSONObject("view"), search.isNotEmpty())
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
        val rows = db.messages("SELECT * FROM messages WHERE $cond ORDER BY date DESC LIMIT $limit OFFSET $offset", w.params)
        val total = db.scalarLong("SELECT COUNT(*) FROM messages WHERE $cond", w.params)
        return jobj("items" to jarr(rows.map { it.toSummary() }), "total" to total)
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
        val merged = deepMerge(settings(), patch)
        db.setKv("settings", mapSecrets(merged) { v -> "enc:" + Secrets.encrypt(v) }.toString())
        emit("settings-changed", merged)
        return merged
    }

    private fun openExternal(url: String): Any? {
        if (!Regex("^(https?|mailto):", RegexOption.IGNORE_CASE).containsMatchIn(url)) throw UserError("不支持的链接")
        ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return null
    }
}

package com.moyer.mail.engine

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

data class FolderRow(
    val accountId: String,
    val path: String,
    val name: String,
    val delimiter: String,
    val role: String,
    val parentPath: String,
    val noSelect: Boolean,
    val uidValidity: String?,
    val total: Int,
    val unread: Int,
    val sort: Int
) {
    fun toJson() = jobj(
        "accountId" to accountId, "path" to path, "name" to name, "delimiter" to delimiter, "role" to role,
        "parentPath" to parentPath, "noSelect" to noSelect, "unread" to unread, "total" to total
    )
}

data class MessageRow(
    val id: Long,
    val accountId: String,
    val folder: String,
    val role: String,
    val uid: Long,
    val messageId: String?,
    val inReplyTo: String?,
    val subject: String,
    val fromName: String?,
    val fromAddr: String?,
    val toJson: String,
    val ccJson: String,
    val date: Long,
    val seen: Boolean,
    val flagged: Boolean,
    val answered: Boolean,
    val hasAtt: Boolean,
    val size: Long,
    val snippet: String,
    val bodyState: Int,
    val threadKey: String?,
    val snoozeUntil: Long?
) {
    fun toSummary(): JSONObject = jobj(
        "id" to id, "accountId" to accountId, "folder" to folder, "role" to role, "uid" to uid, "messageId" to messageId,
        "subject" to subject,
        "from" to (if (fromAddr != null || fromName != null) addrJson(fromName, fromAddr) else null),
        "to" to JSONArray(toJson), "cc" to JSONArray(ccJson),
        "date" to date, "seen" to seen, "flagged" to flagged, "answered" to answered, "hasAttachments" to hasAtt,
        "snippet" to snippet, "size" to size, "snoozeUntil" to snoozeUntil
    )
}

private val REPLY_PREFIXES = Regex("^\\s*((re|fw|fwd|aw|wg|sv|vs|antw|tr|rif|回复|答复|回覆|转发|轉寄|转寄)\\s*(\\[\\d+]|\\(\\d+\\))?\\s*[:：]\\s*)+", RegexOption.IGNORE_CASE)
private val REPLY_ONLY = Regex("^\\s*(re|aw|sv|vs|antw|回复|答复|回覆)\\s*(\\[\\d+]|\\(\\d+\\))?\\s*[:：]", RegexOption.IGNORE_CASE)

/** 去掉“回复：”“Fwd:”等前缀，用来判断是不是同一个话题 */
fun normalizeSubject(s: String): String = s.replace(REPLY_PREFIXES, "").replace(Regex("\\s+"), " ").trim().lowercase()

fun isReplySubject(s: String): Boolean = REPLY_ONLY.containsMatchIn(s)

private const val DB_VERSION = 2

data class NewMessage(
    val accountId: String,
    val folder: String,
    val role: String,
    val uid: Long,
    val messageId: String?,
    val inReplyTo: String?,
    val subject: String,
    val fromName: String?,
    val fromAddr: String?,
    val to: JSONArray,
    val cc: JSONArray,
    val date: Long,
    val seen: Boolean,
    val flagged: Boolean,
    val answered: Boolean,
    val hasAtt: Boolean,
    val size: Long
)

/** 本地数据库：账号、文件夹、邮件信头、正文缓存。结构和电脑版基本一致（没有全文索引，搜索用 LIKE） */
class Db(context: Context) : SQLiteOpenHelper(context, "moyer-mail.db", null, DB_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execSQL("CREATE TABLE accounts (id TEXT PRIMARY KEY, json TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execSQL(
            """CREATE TABLE folders (
              account_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, delimiter TEXT NOT NULL DEFAULT '/',
              role TEXT NOT NULL DEFAULT 'other', parent_path TEXT NOT NULL DEFAULT '', no_select INTEGER NOT NULL DEFAULT 0,
              uid_validity TEXT, total INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, last_sync INTEGER,
              sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, path))"""
        )
        db.execSQL(
            """CREATE TABLE messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, folder TEXT NOT NULL, role TEXT NOT NULL,
              uid INTEGER NOT NULL, message_id TEXT, in_reply_to TEXT, subject TEXT NOT NULL DEFAULT '', from_name TEXT, from_addr TEXT,
              to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', date INTEGER NOT NULL,
              seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0,
              has_att INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, snippet TEXT NOT NULL DEFAULT '',
              body_state INTEGER NOT NULL DEFAULT 0, UNIQUE (account_id, folder, uid))"""
        )
        db.execSQL("CREATE INDEX idx_msg_role_date ON messages (role, date DESC)")
        db.execSQL("CREATE INDEX idx_msg_folder_date ON messages (account_id, folder, date DESC)")
        db.execSQL("CREATE INDEX idx_msg_flagged ON messages (flagged, date DESC)")
        db.execSQL(
            """CREATE TABLE bodies (
              message_id INTEGER PRIMARY KEY, html TEXT, text TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
              attachments_json TEXT NOT NULL DEFAULT '[]', lang TEXT)"""
        )
        db.execSQL("CREATE TABLE contacts (address TEXT PRIMARY KEY, name TEXT, score INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0)")
        upgrade(db, 1)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = upgrade(db, oldVersion)

    /**
     * 数据库升级：每一步把版本号加一。只能往后追加，已经发布的步骤不要再改。
     * （安卓会把整个升级放在一个事务里，失败会自动回滚，旧数据不会坏）
     */
    private fun upgrade(db: SQLiteDatabase, from: Int) {
        // v2：邮件会话、稍后提醒、定时发送、收信规则
        if (from < 2) {
            val cols = db.rawQuery("PRAGMA table_info(messages)", null).use { c -> buildSet { while (c.moveToNext()) add(c.getString(1)) } }
            if ("thread_key" !in cols) db.execSQL("ALTER TABLE messages ADD COLUMN thread_key TEXT")
            if ("subject_norm" !in cols) db.execSQL("ALTER TABLE messages ADD COLUMN subject_norm TEXT")
            if ("snooze_until" !in cols) db.execSQL("ALTER TABLE messages ADD COLUMN snooze_until INTEGER")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages (account_id, thread_key)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_msg_mid ON messages (account_id, message_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_msg_irt ON messages (account_id, in_reply_to)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_msg_subj ON messages (account_id, subject_norm)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_msg_snooze ON messages (snooze_until)")
            db.execSQL(
                """CREATE TABLE IF NOT EXISTS outbox (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, draft_json TEXT NOT NULL,
                  send_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created INTEGER NOT NULL)"""
            )
            db.execSQL("CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, json TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)")
            // 给已有邮件补上会话编号（按时间从旧到新）
            db.rawQuery("SELECT id, account_id, message_id, in_reply_to, subject, date FROM messages ORDER BY date ASC", null).use { c ->
                while (c.moveToNext()) assignThread(db, c.getLong(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4) ?: "", c.getLong(5))
            }
        }
    }

    /** 给一封邮件分配会话编号（和电脑版 db.ts 的 assignThread 一样的规则） */
    private fun assignThread(db: SQLiteDatabase, id: Long, accountId: String, messageId: String?, inReplyTo: String?, subject: String, date: Long) {
        val norm = normalizeSubject(subject)
        fun keyOf(sql: String, vararg args: Any): String? =
            db.rawQuery(sql, args.map { it.toString() }.toTypedArray()).use { if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null }
        var key: String? = null
        // 同一封邮件在别的文件夹里已经有会话
        if (messageId != null)
            key = keyOf("SELECT thread_key FROM messages WHERE account_id = ? AND message_id = ? AND id != ? AND thread_key IS NOT NULL LIMIT 1", accountId, messageId, id)
        val parentKey = inReplyTo?.let { keyOf("SELECT thread_key FROM messages WHERE account_id = ? AND message_id = ? AND thread_key IS NOT NULL LIMIT 1", accountId, it) }
        if (key == null) key = parentKey
        if (key == null && norm.isNotEmpty() && isReplySubject(subject))
            key = keyOf(
                "SELECT thread_key FROM messages WHERE account_id = ? AND subject_norm = ? AND id != ? AND thread_key IS NOT NULL AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT 1",
                accountId, norm, id, date - 120 * 86_400_000L, date + 86_400_000L
            )
        val k = key ?: "m:$id"
        db.execSQL("UPDATE messages SET thread_key = ?, subject_norm = ? WHERE id = ?", arrayOf<Any>(k, norm, id))
        // 合并：上级邮件在别的会话里，或者先到的回复各自成了会话
        fun merge(other: String?) {
            if (other != null && other != k && !other.startsWith("x:"))
                db.execSQL("UPDATE messages SET thread_key = ? WHERE account_id = ? AND thread_key = ?", arrayOf(k, accountId, other))
        }
        merge(parentKey)
        if (messageId != null) {
            val others = db.rawQuery(
                "SELECT DISTINCT thread_key FROM messages WHERE account_id = ? AND in_reply_to = ? AND thread_key IS NOT NULL",
                arrayOf(accountId, messageId)
            ).use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
            others.forEach { merge(it) }
        }
    }

    private val w: SQLiteDatabase get() = writableDatabase

    fun <T> tx(block: () -> T): T {
        val db = w
        db.beginTransaction()
        try {
            val r = block()
            db.setTransactionSuccessful()
            return r
        } finally {
            db.endTransaction()
        }
    }

    fun <T> query(sql: String, args: List<Any?> = emptyList(), map: (Cursor) -> T): List<T> {
        w.rawQuery(sql, args.map { it?.toString() }.toTypedArray()).use { c ->
            val out = ArrayList<T>(c.count)
            while (c.moveToNext()) out.add(map(c))
            return out
        }
    }

    fun scalarLong(sql: String, args: List<Any?> = emptyList()): Long =
        query(sql, args) { if (it.isNull(0)) 0L else it.getLong(0) }.firstOrNull() ?: 0L

    fun exec(sql: String, args: List<Any?> = emptyList()) = w.execSQL(sql, args.toTypedArray())

    // ---------------- kv ----------------
    fun getKv(key: String): String? = query("SELECT value FROM kv WHERE key = ?", listOf(key)) { it.getString(0) }.firstOrNull()

    fun setKv(key: String, value: String) = exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", listOf(key, value))

    // ---------------- 账号 ----------------
    fun listAccounts(): List<JSONObject> = query("SELECT json FROM accounts ORDER BY sort, rowid") { JSONObject(it.getString(0)) }

    fun getAccount(id: String): JSONObject? = query("SELECT json FROM accounts WHERE id = ?", listOf(id)) { JSONObject(it.getString(0)) }.firstOrNull()

    fun saveAccount(acc: JSONObject) =
        exec("INSERT OR REPLACE INTO accounts (id, json, sort) VALUES (?, ?, ?)", listOf(acc.getString("id"), acc.toString(), acc.optInt("sortOrder")))

    fun removeAccount(id: String) = tx {
        exec("DELETE FROM bodies WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)", listOf(id))
        exec("DELETE FROM messages WHERE account_id = ?", listOf(id))
        exec("DELETE FROM folders WHERE account_id = ?", listOf(id))
        exec("DELETE FROM accounts WHERE id = ?", listOf(id))
        exec("DELETE FROM secrets WHERE key LIKE ?", listOf("$id:%"))
        exec("DELETE FROM outbox WHERE account_id = ?", listOf(id))
    }

    fun setSecret(key: String, value: String) = exec("INSERT OR REPLACE INTO secrets (key, value) VALUES (?, ?)", listOf(key, Secrets.encrypt(value)))

    fun getSecret(key: String): String? = query("SELECT value FROM secrets WHERE key = ?", listOf(key)) { it.getString(0) }.firstOrNull()?.let {
        runCatching { Secrets.decrypt(it) }.getOrNull()
    }

    // ---------------- 文件夹 ----------------
    private fun folder(c: Cursor) = FolderRow(
        accountId = c.getString(c.getColumnIndexOrThrow("account_id")),
        path = c.getString(c.getColumnIndexOrThrow("path")),
        name = c.getString(c.getColumnIndexOrThrow("name")),
        delimiter = c.getString(c.getColumnIndexOrThrow("delimiter")),
        role = c.getString(c.getColumnIndexOrThrow("role")),
        parentPath = c.getString(c.getColumnIndexOrThrow("parent_path")),
        noSelect = c.getInt(c.getColumnIndexOrThrow("no_select")) == 1,
        uidValidity = c.getString(c.getColumnIndexOrThrow("uid_validity")),
        total = c.getInt(c.getColumnIndexOrThrow("total")),
        unread = c.getInt(c.getColumnIndexOrThrow("unread")),
        sort = c.getInt(c.getColumnIndexOrThrow("sort"))
    )

    fun folders(accountId: String? = null): List<FolderRow> =
        if (accountId == null) query("SELECT * FROM folders ORDER BY sort, path") { folder(it) }
        else query("SELECT * FROM folders WHERE account_id = ? ORDER BY sort, path", listOf(accountId)) { folder(it) }

    fun getFolder(accountId: String, path: String): FolderRow? =
        query("SELECT * FROM folders WHERE account_id = ? AND path = ?", listOf(accountId, path)) { folder(it) }.firstOrNull()

    fun folderByRole(accountId: String, role: String): FolderRow? =
        query("SELECT * FROM folders WHERE account_id = ? AND role = ? ORDER BY sort LIMIT 1", listOf(accountId, role)) { folder(it) }.firstOrNull()

    fun upsertFolder(accountId: String, path: String, name: String, delimiter: String, role: String, parentPath: String, noSelect: Boolean, sort: Int) {
        // 不用 ON CONFLICT DO UPDATE：安卓 11 以下的 SQLite 不支持
        val v = ContentValues().apply {
            put("name", name); put("delimiter", delimiter); put("role", role); put("parent_path", parentPath)
            put("no_select", if (noSelect) 1 else 0); put("sort", sort)
        }
        if (w.update("folders", v, "account_id = ? AND path = ?", arrayOf(accountId, path)) == 0) {
            v.put("account_id", accountId); v.put("path", path)
            w.insert("folders", null, v)
        }
    }

    fun deleteFolder(accountId: String, path: String) = tx {
        deleteFolderMessages(accountId, path)
        exec("DELETE FROM folders WHERE account_id = ? AND path = ?", listOf(accountId, path))
    }

    fun updateFolderMeta(accountId: String, path: String, uidValidity: String, total: Int, unread: Int) =
        exec(
            "UPDATE folders SET uid_validity = ?, total = ?, unread = ?, last_sync = ? WHERE account_id = ? AND path = ?",
            listOf(uidValidity, total, unread, System.currentTimeMillis(), accountId, path)
        )

    // ---------------- 邮件 ----------------
    private fun message(c: Cursor) = MessageRow(
        id = c.getLong(c.getColumnIndexOrThrow("id")),
        accountId = c.getString(c.getColumnIndexOrThrow("account_id")),
        folder = c.getString(c.getColumnIndexOrThrow("folder")),
        role = c.getString(c.getColumnIndexOrThrow("role")),
        uid = c.getLong(c.getColumnIndexOrThrow("uid")),
        messageId = c.getString(c.getColumnIndexOrThrow("message_id")),
        inReplyTo = c.getString(c.getColumnIndexOrThrow("in_reply_to")),
        subject = c.getString(c.getColumnIndexOrThrow("subject")) ?: "",
        fromName = c.getString(c.getColumnIndexOrThrow("from_name")),
        fromAddr = c.getString(c.getColumnIndexOrThrow("from_addr")),
        toJson = c.getString(c.getColumnIndexOrThrow("to_json")) ?: "[]",
        ccJson = c.getString(c.getColumnIndexOrThrow("cc_json")) ?: "[]",
        date = c.getLong(c.getColumnIndexOrThrow("date")),
        seen = c.getInt(c.getColumnIndexOrThrow("seen")) == 1,
        flagged = c.getInt(c.getColumnIndexOrThrow("flagged")) == 1,
        answered = c.getInt(c.getColumnIndexOrThrow("answered")) == 1,
        hasAtt = c.getInt(c.getColumnIndexOrThrow("has_att")) == 1,
        size = c.getLong(c.getColumnIndexOrThrow("size")),
        snippet = c.getString(c.getColumnIndexOrThrow("snippet")) ?: "",
        bodyState = c.getInt(c.getColumnIndexOrThrow("body_state")),
        threadKey = c.getString(c.getColumnIndexOrThrow("thread_key")),
        snoozeUntil = c.getColumnIndexOrThrow("snooze_until").let { if (c.isNull(it)) null else c.getLong(it) }
    )

    /** 给 query() 用：把当前行读成 MessageRow（查询里要包含 messages 的全部列） */
    fun messageFrom(c: Cursor) = message(c)

    fun messages(sql: String, args: List<Any?> = emptyList()): List<MessageRow> = query(sql, args) { message(it) }

    fun messageById(id: Long): MessageRow? = messages("SELECT * FROM messages WHERE id = ?", listOf(id)).firstOrNull()

    fun messagesByIds(ids: List<Long>): List<MessageRow> =
        if (ids.isEmpty()) emptyList() else messages("SELECT * FROM messages WHERE id IN (${ids.joinToString(",")})")

    fun folderUids(accountId: String, folder: String): List<Long> =
        query("SELECT uid FROM messages WHERE account_id = ? AND folder = ? ORDER BY uid", listOf(accountId, folder)) { it.getLong(0) }

    fun insertMessage(m: NewMessage): Long? {
        val v = ContentValues().apply {
            put("account_id", m.accountId); put("folder", m.folder); put("role", m.role); put("uid", m.uid)
            put("message_id", m.messageId); put("in_reply_to", m.inReplyTo); put("subject", m.subject)
            put("from_name", m.fromName); put("from_addr", m.fromAddr)
            put("to_json", m.to.toString()); put("cc_json", m.cc.toString()); put("date", m.date)
            put("seen", if (m.seen) 1 else 0); put("flagged", if (m.flagged) 1 else 0); put("answered", if (m.answered) 1 else 0)
            put("has_att", if (m.hasAtt) 1 else 0); put("size", m.size)
        }
        val id = w.insertWithOnConflict("messages", null, v, SQLiteDatabase.CONFLICT_IGNORE)
        if (id <= 0) return null
        assignThread(w, id, m.accountId, m.messageId, m.inReplyTo, m.subject, m.date)
        return id
    }

    fun deleteMessage(id: Long) {
        exec("DELETE FROM bodies WHERE message_id = ?", listOf(id))
        exec("DELETE FROM messages WHERE id = ?", listOf(id))
    }

    fun deleteMessagesByUid(accountId: String, folder: String, uids: Collection<Long>) = tx {
        for (uid in uids) {
            val id = scalarLong("SELECT id FROM messages WHERE account_id = ? AND folder = ? AND uid = ?", listOf(accountId, folder, uid))
            if (id > 0) deleteMessage(id)
        }
    }

    fun deleteFolderMessages(accountId: String, folder: String) {
        exec("DELETE FROM bodies WHERE message_id IN (SELECT id FROM messages WHERE account_id = ? AND folder = ?)", listOf(accountId, folder))
        exec("DELETE FROM messages WHERE account_id = ? AND folder = ?", listOf(accountId, folder))
    }

    /** 返回是否有变化 */
    fun updateFlags(accountId: String, folder: String, uid: Long, seen: Boolean, flagged: Boolean, answered: Boolean): Boolean {
        val v = ContentValues().apply { put("seen", if (seen) 1 else 0); put("flagged", if (flagged) 1 else 0); put("answered", if (answered) 1 else 0) }
        return w.update(
            "messages", v, "account_id = ? AND folder = ? AND uid = ? AND (seen != ? OR flagged != ? OR answered != ?)",
            arrayOf(accountId, folder, uid.toString(), if (seen) "1" else "0", if (flagged) "1" else "0", if (answered) "1" else "0")
        ) > 0
    }

    fun setBody(id: Long, html: String?, text: String?, meta: JSONObject, attachments: JSONArray, lang: String?, snippet: String, hasAtt: Boolean) = tx {
        exec(
            "INSERT OR REPLACE INTO bodies (message_id, html, text, meta_json, attachments_json, lang) VALUES (?, ?, ?, ?, ?, ?)",
            listOf(id, html, text, meta.toString(), attachments.toString(), lang)
        )
        exec("UPDATE messages SET snippet = ?, body_state = 1, has_att = ? WHERE id = ?", listOf(snippet, if (hasAtt) 1 else 0, id))
    }

    data class Body(val html: String?, val text: String?, val meta: JSONObject, val attachments: JSONArray, val lang: String?)

    fun getBody(id: Long): Body? = query("SELECT html, text, meta_json, attachments_json, lang FROM bodies WHERE message_id = ?", listOf(id)) {
        Body(it.getString(0), it.getString(1), JSONObject(it.getString(2) ?: "{}"), JSONArray(it.getString(3) ?: "[]"), it.getString(4))
    }.firstOrNull()

    // ---------------- 联系人 ----------------
    fun touchContact(name: String?, address: String?, weight: Int) {
        if (address.isNullOrBlank()) return
        val addr = address.lowercase()
        val now = System.currentTimeMillis()
        exec(
            "UPDATE contacts SET score = score + ?, last_used = ?, name = CASE WHEN ? != '' THEN ? ELSE name END WHERE address = ?",
            listOf(weight, now, name ?: "", name ?: "", addr)
        )
        exec("INSERT OR IGNORE INTO contacts (address, name, score, last_used) VALUES (?, ?, ?, ?)", listOf(addr, name ?: "", weight, now))
    }
}

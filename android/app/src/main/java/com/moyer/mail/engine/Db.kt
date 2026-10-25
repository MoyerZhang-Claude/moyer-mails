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
    val bodyState: Int
) {
    fun toSummary(): JSONObject = jobj(
        "id" to id, "accountId" to accountId, "folder" to folder, "role" to role, "uid" to uid, "messageId" to messageId,
        "subject" to subject,
        "from" to (if (fromAddr != null || fromName != null) addrJson(fromName, fromAddr) else null),
        "to" to JSONArray(toJson), "cc" to JSONArray(ccJson),
        "date" to date, "seen" to seen, "flagged" to flagged, "answered" to answered, "hasAttachments" to hasAtt,
        "snippet" to snippet, "size" to size, "snoozeUntil" to null
    )
}

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
class Db(context: Context) : SQLiteOpenHelper(context, "moyer-mail.db", null, 1) {

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
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // 以后改结构时在这里按版本追加升级步骤，不要删表
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
        bodyState = c.getInt(c.getColumnIndexOrThrow("body_state"))
    )

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
        return if (id > 0) id else null
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

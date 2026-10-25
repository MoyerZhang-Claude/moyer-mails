package com.moyer.mail.engine

import android.util.Log
import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPMessage
import com.sun.mail.imap.IMAPStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.Properties
import java.util.concurrent.Executors
import javax.mail.FetchProfile
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Message
import javax.mail.Session
import javax.mail.UIDFolder
import javax.mail.event.MessageChangedListener
import javax.mail.event.MessageCountAdapter
import javax.mail.event.MessageCountEvent
import javax.mail.internet.InternetAddress
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min

private const val TAG = "MoyerSync"
/** 首次同步每个文件夹拉取的邮件数（手机上比电脑少一些） */
private const val INITIAL_WINDOW = 200
private const val PREFETCH_INBOX = 25
private const val PREFETCH_OTHER = 8
private const val PREFETCH_MAX_SIZE = 1_000_000L
private val AUTO_SYNC = listOf("inbox", "sent", "drafts", "archive", "junk", "trash")
val ROLE_ORDER = mapOf("inbox" to 0, "drafts" to 1, "sent" to 2, "archive" to 3, "all" to 4, "flagged" to 5, "junk" to 6, "trash" to 7, "other" to 10)

private val NAME_ROLES = listOf(
    "sent" to listOf("sent", "sent messages", "sent items", "sent mail", "已发送", "已发送邮件", "已发信息", "发件箱"),
    "drafts" to listOf("drafts", "draft", "草稿箱", "草稿"),
    "trash" to listOf("trash", "deleted messages", "deleted items", "deleted", "已删除", "已删除邮件", "废纸篓", "垃圾箱"),
    "junk" to listOf("junk", "spam", "junk e-mail", "junk email", "垃圾邮件", "广告邮件", "垃圾"),
    "archive" to listOf("archive", "archives", "归档", "存档")
)

fun roleOf(path: String, name: String, attrs: Array<String>): String {
    if (path.equals("INBOX", ignoreCase = true)) return "inbox"
    for (a in attrs) when (a.lowercase()) {
        "\\sent" -> return "sent"
        "\\drafts" -> return "drafts"
        "\\trash" -> return "trash"
        "\\junk" -> return "junk"
        "\\archive" -> return "archive"
        "\\all" -> return "all"
        "\\flagged" -> return "flagged"
    }
    val n = name.lowercase()
    for ((role, names) in NAME_ROLES) if (n in names) return role
    return "other"
}

fun isLoopback(host: String) = host == "127.0.0.1" || host == "localhost" || host == "::1"

/** 建立 IMAP 连接用的参数。secure=true 直接 TLS（993），否则强制 STARTTLS */
fun imapSession(host: String, port: Int, secure: Boolean): Pair<Session, String> {
    val proto = if (secure) "imaps" else "imap"
    val p = Properties()
    p["mail.store.protocol"] = proto
    p["mail.$proto.host"] = host
    p["mail.$proto.port"] = port.toString()
    p["mail.$proto.connectiontimeout"] = "20000"
    p["mail.$proto.timeout"] = "90000"
    p["mail.$proto.writetimeout"] = "60000"
    p["mail.$proto.peek"] = "true"
    p["mail.$proto.fetchsize"] = "1048576"
    p["mail.$proto.ssl.checkserveridentity"] = "true"
    if (!secure) {
        p["mail.imap.starttls.enable"] = "true"
        p["mail.imap.starttls.required"] = "true"
    }
    // 只有连本机测试服务器（adb reverse 转到电脑）时才接受自签名证书
    if (isLoopback(host)) {
        p["mail.$proto.ssl.trust"] = "*"
        p["mail.$proto.ssl.checkserveridentity"] = "false"
    }
    return Session.getInstance(p) to proto
}

fun connectImap(host: String, port: Int, secure: Boolean, user: String, pass: String): IMAPStore {
    val (session, proto) = imapSession(host, port, secure)
    val store = session.getStore(proto) as IMAPStore
    store.connect(host, port, user, pass)
    // 163/126 等网易邮箱要求登录后发送 ID 命令，否则会报 Unsafe Login
    if (runCatching { store.hasCapability("ID") }.getOrDefault(false)) {
        runCatching { store.id(mapOf("name" to "Moyer Mail", "version" to "0.4.0", "vendor" to "Moyer", "os" to "Android")) }
    }
    return store
}

fun verifySmtp(host: String, port: Int, secure: Boolean, user: String, pass: String) {
    val proto = if (secure) "smtps" else "smtp"
    val p = Properties()
    p["mail.$proto.host"] = host
    p["mail.$proto.port"] = port.toString()
    p["mail.$proto.auth"] = "true"
    p["mail.$proto.connectiontimeout"] = "20000"
    p["mail.$proto.timeout"] = "60000"
    p["mail.$proto.localhost"] = "[127.0.0.1]"
    if (!secure) {
        p["mail.smtp.starttls.enable"] = "true"
        p["mail.smtp.starttls.required"] = "true"
    }
    if (isLoopback(host)) p["mail.$proto.ssl.trust"] = "*"
    val t = Session.getInstance(p).getTransport(proto)
    t.connect(host, port, user, pass)
    t.close()
}

class AccountSession(private val engine: Engine, @Volatile var account: JSONObject) {
    val id: String get() = account.getString("id")
    private val db get() = engine.db
    private val workerExec = Executors.newSingleThreadExecutor { r -> Thread(r, "imap-worker-$id") }
    private val worker = workerExec.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + worker)
    private var store: IMAPStore? = null
    @Volatile private var idleStore: IMAPStore? = null
    @Volatile private var stopped = false
    private var idleThread: Thread? = null
    private val pending = LinkedHashSet<String>()
    @Volatile private var primed = false

    @Volatile var phase = "idle"; private set
    @Volatile var error: String? = null; private set
    @Volatile var lastSync: Long? = null; private set

    private fun setPhase(p: String, err: String? = null) {
        phase = p
        error = err
        if (p == "idle") lastSync = System.currentTimeMillis()
        engine.emit("sync-status", statusJson())
    }

    fun statusJson() = jobj("accountId" to id, "phase" to phase, "error" to error, "lastSync" to lastSync)

    private fun password(): String = db.getSecret("$id:password") ?: throw UserError("缺少授权码/密码，请编辑账号重新填写。")

    private fun imapConf() = account.getJSONObject("imap")

    private fun newStore(): IMAPStore {
        val c = imapConf()
        return connectImap(c.getString("host"), c.getInt("port"), c.getBoolean("secure"), account.optString("username", account.getString("email")), password())
    }

    /** 工作连接：同步、取信、改旗标都在同一个线程里串行执行 */
    private fun ensureStore(): IMAPStore {
        store?.let { if (it.isConnected) return it }
        if (phase != "syncing") setPhase("connecting")
        val s = newStore()
        store = s
        return s
    }

    suspend fun <T> onWorker(block: () -> T): T = withContext(worker) { block() }

    fun start() {
        stopped = false
        scope.launch { syncAll() }
        startIdle()
    }

    fun stop() {
        stopped = true
        idleThread?.interrupt()
        runCatching { idleStore?.close() }
        scope.launch { runCatching { store?.close() }; store = null }
        workerExec.shutdown()
    }

    /** 安排同步一个文件夹（短时间内多次调用会合并） */
    fun schedule(path: String) {
        synchronized(pending) {
            if (!pending.add(path)) return
        }
        scope.launch {
            synchronized(pending) { pending.remove(path) }
            syncFolder(path)
        }
    }

    fun syncAllAsync() = scope.launch { syncAll() }

    fun syncAll() {
        try {
            setPhase("syncing")
            syncFolderList()
            val folders = db.folders(id).filter { it.role in AUTO_SYNC && !it.noSelect }.sortedBy { ROLE_ORDER[it.role] ?: 10 }
            for (f in folders) {
                if (stopped) return
                try {
                    syncFolder(f.path, quiet = true)
                } catch (e: Exception) {
                    if (f.role == "inbox") throw e
                    Log.w(TAG, "skip folder ${f.path}: ${e.message}")
                }
            }
            primed = true
            setPhase("idle")
        } catch (e: Exception) {
            Log.w(TAG, "syncAll failed", e)
            runCatching { store?.close() }
            store = null
            setPhase("error", friendlyError(e))
        }
    }

    private fun syncFolderList() {
        val s = ensureStore()
        val list = s.defaultFolder.list("*")
        val seen = HashSet<String>()
        db.tx {
            for (f in list) {
                val imf = f as IMAPFolder
                val path = imf.fullName
                seen.add(path)
                val attrs = runCatching { imf.attributes }.getOrNull() ?: emptyArray()
                val role = roleOf(path, imf.name, attrs)
                val noSelect = attrs.any { it.equals("\\Noselect", true) || it.equals("\\NonExistent", true) } || (imf.type and Folder.HOLDS_MESSAGES) == 0
                val parent = runCatching { imf.parent?.fullName }.getOrNull() ?: ""
                db.upsertFolder(id, path, imf.name, imf.separator.toString(), role, parent, noSelect, ROLE_ORDER[role] ?: 10)
            }
            for (f in db.folders(id)) if (f.path !in seen) db.deleteFolder(id, f.path)
        }
        engine.emit("folders-changed", jobj("accountId" to id))
    }

    private fun toNew(f: IMAPFolder, m: Message, path: String, role: String): NewMessage {
        val from = m.from?.firstOrNull() as? InternetAddress
        val flags = m.flags
        val ct = runCatching { m.contentType?.lowercase() }.getOrNull() ?: ""
        return NewMessage(
            accountId = id,
            folder = path,
            role = role,
            uid = f.getUID(m),
            messageId = (m as? IMAPMessage)?.messageID,
            inReplyTo = (m as? IMAPMessage)?.inReplyTo,
            subject = m.subject ?: "",
            fromName = from?.personal,
            fromAddr = from?.address,
            to = addressesJson(m.getRecipients(Message.RecipientType.TO)),
            cc = addressesJson(m.getRecipients(Message.RecipientType.CC)),
            date = (m.receivedDate ?: m.sentDate)?.time ?: System.currentTimeMillis(),
            seen = flags.contains(Flags.Flag.SEEN),
            flagged = flags.contains(Flags.Flag.FLAGGED),
            answered = flags.contains(Flags.Flag.ANSWERED),
            hasAtt = ct.startsWith("multipart/mixed"),
            size = m.size.toLong().coerceAtLeast(0)
        )
    }

    /** 同步一个文件夹：新邮件、旗标变化、服务器端删除，然后预下载正文 */
    fun syncFolder(path: String, quiet: Boolean = false) {
        val folder = db.getFolder(id, path) ?: return
        if (folder.noSelect) return
        if (!quiet) setPhase("syncing")
        var arrived: List<Long> = emptyList()
        try {
            val s = ensureStore()
            val f = s.getFolder(path) as IMAPFolder
            f.open(Folder.READ_ONLY)
            try {
                val uidValidity = f.uidValidity.toString()
                if (folder.uidValidity != null && folder.uidValidity != uidValidity) db.deleteFolderMessages(id, path)
                val known = db.folderUids(id, path)
                val wasEmpty = known.isEmpty()
                val count = f.messageCount
                val newIds = ArrayList<Long>()
                if (count == 0) {
                    if (known.isNotEmpty()) db.deleteFolderMessages(id, path)
                } else {
                    // 1. 新邮件
                    val maxUid = known.lastOrNull() ?: 0L
                    val msgs = if (wasEmpty) f.getMessages(max(1, count - INITIAL_WINDOW + 1), count) else f.getMessagesByUID(maxUid + 1, UIDFolder.LASTUID)
                    val full = FetchProfile().apply {
                        add(FetchProfile.Item.ENVELOPE); add(FetchProfile.Item.FLAGS); add(FetchProfile.Item.CONTENT_INFO); add(UIDFolder.FetchProfileItem.UID)
                    }
                    f.fetch(msgs, full)
                    if (stopped) return
                    db.tx {
                        for (m in msgs) {
                            val n = toNew(f, m, path, folder.role)
                            if (n.uid <= maxUid) continue
                            db.insertMessage(n)?.let { newId ->
                                newIds.add(newId)
                                if (folder.role != "sent") db.touchContact(n.fromName, n.fromAddr, 1)
                            }
                        }
                    }
                    // 2. 已缓存邮件的旗标变化与删除
                    if (!wasEmpty) {
                        val existing = f.getMessagesByUID(known.first(), UIDFolder.LASTUID)
                        f.fetch(existing, FetchProfile().apply { add(FetchProfile.Item.FLAGS); add(UIDFolder.FetchProfileItem.UID) })
                        val serverUids = HashSet<Long>()
                        db.tx {
                            for (m in existing) {
                                val uid = f.getUID(m)
                                serverUids.add(uid)
                                val fl = m.flags
                                db.updateFlags(id, path, uid, fl.contains(Flags.Flag.SEEN), fl.contains(Flags.Flag.FLAGGED), fl.contains(Flags.Flag.ANSWERED))
                            }
                        }
                        val gone = known.filter { it !in serverUids }
                        if (gone.isNotEmpty()) db.deleteMessagesByUid(id, path, gone)
                    }
                }
                db.updateFolderMeta(id, path, uidValidity, count, runCatching { f.unreadMessageCount }.getOrDefault(0))
                if (newIds.isNotEmpty() && folder.role == "inbox" && primed && !wasEmpty) arrived = newIds
            } finally {
                runCatching { f.close(false) }
            }
            if (arrived.isNotEmpty()) engine.onNewMessages(id, arrived)
            engine.onChanged(id, listOf(path))
            prefetch(path, if (folder.role == "inbox") PREFETCH_INBOX else PREFETCH_OTHER)
            if (!quiet) setPhase("idle")
        } catch (e: Exception) {
            Log.w(TAG, "syncFolder $path failed", e)
            if (!s_connected()) store = null
            if (!quiet) setPhase("error", friendlyError(e)) else throw e
        }
    }

    private fun s_connected() = runCatching { store?.isConnected == true }.getOrDefault(false)

    /** 预下载最新几封邮件的正文，点开时直接显示 */
    private fun prefetch(path: String, limit: Int) {
        val rows = db.messages(
            "SELECT * FROM messages WHERE account_id = ? AND folder = ? AND body_state = 0 AND size <= ? ORDER BY date DESC LIMIT $limit",
            listOf(id, path, PREFETCH_MAX_SIZE)
        )
        if (rows.isEmpty()) return
        var any = false
        withFolder(path, Folder.READ_ONLY) { f ->
            for (r in rows) {
                if (stopped) return@withFolder
                val m = f.getMessageByUID(r.uid) ?: continue
                runCatching { engine.storeParsed(r, parseMessage(m)); any = true }.onFailure { Log.w(TAG, "prefetch ${r.id}", it) }
            }
        }
        if (any) engine.onChanged(id, listOf(path))
    }

    fun <T> withFolder(path: String, mode: Int, block: (IMAPFolder) -> T): T {
        val f = ensureStore().getFolder(path) as IMAPFolder
        f.open(mode)
        try {
            return block(f)
        } finally {
            runCatching { f.close(false) }
        }
    }

    /** 读一封邮件的正文（只读方式打开文件夹，不会被服务器自动标为已读） */
    fun fetchBody(r: MessageRow): ParsedBody? = withFolder(r.folder, Folder.READ_ONLY) { f ->
        f.getMessageByUID(r.uid)?.let { parseMessage(it) }
    }

    fun setFlags(path: String, uids: List<Long>, flag: Flags.Flag, value: Boolean) = withFolder(path, Folder.READ_WRITE) { f ->
        val msgs = f.getMessagesByUID(uids.toLongArray()).filterNotNull().toTypedArray()
        if (msgs.isNotEmpty()) f.setFlags(msgs, Flags(flag), value)
    }

    fun markFolderSeen(path: String) = withFolder(path, Folder.READ_WRITE) { f ->
        val unseen = f.search(javax.mail.search.FlagTerm(Flags(Flags.Flag.SEEN), false))
        if (unseen.isNotEmpty()) f.setFlags(unseen, Flags(Flags.Flag.SEEN), true)
    }

    /** 移动邮件：服务器支持 MOVE 就直接移，否则复制后删除 */
    fun move(path: String, uids: List<Long>, dest: String) = withFolder(path, Folder.READ_WRITE) { f ->
        val msgs = f.getMessagesByUID(uids.toLongArray()).filterNotNull().toTypedArray()
        if (msgs.isEmpty()) return@withFolder
        val target = f.store.getFolder(dest)
        if (runCatching { (f.store as IMAPStore).hasCapability("MOVE") }.getOrDefault(false)) f.moveMessages(msgs, target)
        else {
            f.copyMessages(msgs, target)
            f.setFlags(msgs, Flags(Flags.Flag.DELETED), true)
            f.expunge(msgs)
        }
    }

    fun deleteForever(path: String, uids: List<Long>) = withFolder(path, Folder.READ_WRITE) { f ->
        val msgs = f.getMessagesByUID(uids.toLongArray()).filterNotNull().toTypedArray()
        if (msgs.isNotEmpty()) {
            f.setFlags(msgs, Flags(Flags.Flag.DELETED), true)
            f.expunge(msgs)
        }
    }

    // ---------------- 实时推送：另开一个连接停在收件箱上 IDLE ----------------
    private fun startIdle() {
        idleThread = thread(name = "imap-idle-$id", isDaemon = true) {
            var backoff = 5_000L
            while (!stopped) {
                var keepAlive: Thread? = null
                try {
                    val s = newStore()
                    idleStore = s
                    val inboxPath = db.folderByRole(id, "inbox")?.path ?: "INBOX"
                    val inbox = s.getFolder(inboxPath) as IMAPFolder
                    inbox.open(Folder.READ_ONLY)
                    inbox.addMessageCountListener(object : MessageCountAdapter() {
                        override fun messagesAdded(e: MessageCountEvent) = schedule(inboxPath)
                        override fun messagesRemoved(e: MessageCountEvent) = schedule(inboxPath)
                    })
                    inbox.addMessageChangedListener(MessageChangedListener { schedule(inboxPath) })
                    backoff = 5_000L
                    schedule(inboxPath)
                    // 每 8 分钟打断一次 IDLE，防止服务器或运营商网络把长连接断掉
                    keepAlive = thread(name = "imap-keepalive-$id", isDaemon = true) {
                        try {
                            while (!stopped && inbox.isOpen) {
                                Thread.sleep(8 * 60_000L)
                                runCatching { inbox.doCommand { p -> p.simpleCommand("NOOP", null); null } }
                            }
                        } catch (_: InterruptedException) {
                        }
                    }
                    while (!stopped && inbox.isOpen) inbox.idle(true)
                } catch (_: InterruptedException) {
                    break
                } catch (e: Exception) {
                    Log.w(TAG, "idle $id: ${e.message}")
                    if (friendlyError(e).startsWith("登录失败")) backoff = 10 * 60_000L
                } finally {
                    keepAlive?.interrupt()
                    runCatching { idleStore?.close() }
                    idleStore = null
                }
                if (stopped) break
                try {
                    Thread.sleep(backoff)
                } catch (_: InterruptedException) {
                    break
                }
                backoff = min(backoff * 2, 10 * 60_000L)
            }
        }
    }
}

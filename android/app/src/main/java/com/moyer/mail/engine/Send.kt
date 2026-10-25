package com.moyer.mail.engine

import android.util.Base64
import android.webkit.MimeTypeMap
import org.json.JSONObject
import java.io.File
import java.util.Date
import java.util.Properties
import java.util.UUID
import javax.activation.DataHandler
import javax.activation.FileDataSource
import javax.mail.Flags
import javax.mail.Message
import javax.mail.Session
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.internet.MimeUtility
import javax.mail.util.ByteArrayDataSource

fun smtpSession(host: String, port: Int, secure: Boolean): Pair<Session, String> {
    val proto = if (secure) "smtps" else "smtp"
    val p = Properties()
    p["mail.$proto.host"] = host
    p["mail.$proto.port"] = port.toString()
    p["mail.$proto.auth"] = "true"
    p["mail.$proto.connectiontimeout"] = "20000"
    p["mail.$proto.timeout"] = "120000"
    p["mail.$proto.writetimeout"] = "120000"
    p["mail.$proto.localhost"] = "[127.0.0.1]"
    p["mail.mime.splitlongparameters"] = "false"
    if (!secure) {
        p["mail.smtp.starttls.enable"] = "true"
        p["mail.smtp.starttls.required"] = "true"
    }
    if (isLoopback(host)) p["mail.$proto.ssl.trust"] = "*"
    return Session.getInstance(p) to proto
}

/** 固定 Message-ID，方便之后把对方的回复串到同一个会话里 */
private class OutgoingMessage(session: Session, private val messageId: String) : MimeMessage(session) {
    override fun updateMessageID() {
        setHeader("Message-ID", messageId)
    }
}

private fun internet(a: JSONObject) = InternetAddress(a.getString("address").trim(), a.optStr("name"), "UTF-8")

/**
 * 附件一律用 base64 编码。JavaMail 默认会把全是 ASCII 的文件（CSV、JSON、部分 PDF）按 7bit 原样发，
 * 发送和存“已发送”时换行会被改成 CRLF，对方收到的文件就和原文件不一样了。
 */
private const val CTE = "Content-Transfer-Encoding"

private fun guessType(name: String): String =
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

/**
 * 按界面提交的草稿生成邮件。attachmentLoader 用来取“转发时带上原邮件附件”的内容。
 */
fun buildMessage(acc: JSONObject, draft: JSONObject, attachmentLoader: (Long, Int) -> AttachmentData?): MimeMessage {
    val smtp = acc.getJSONObject("smtp")
    val (session, _) = smtpSession(smtp.getString("host"), smtp.getInt("port"), smtp.getBoolean("secure"))
    val email = acc.getString("email")
    val domain = email.substringAfter('@', "moyer.local")
    val msg = OutgoingMessage(session, "<${UUID.randomUUID().toString().replace("-", "")}@$domain>")
    msg.setFrom(InternetAddress(email, acc.optString("name").ifBlank { null }, "UTF-8"))
    msg.setRecipients(Message.RecipientType.TO, draft.optJSONArray("to")?.objects()?.map(::internet)?.toTypedArray())
    msg.setRecipients(Message.RecipientType.CC, draft.optJSONArray("cc")?.objects()?.map(::internet)?.toTypedArray())
    msg.setRecipients(Message.RecipientType.BCC, draft.optJSONArray("bcc")?.objects()?.map(::internet)?.toTypedArray())
    msg.setSubject(draft.optString("subject"), "UTF-8")
    msg.sentDate = Date()
    draft.optStr("inReplyTo")?.let { msg.setHeader("In-Reply-To", it) }
    draft.optStr("references")?.let { msg.setHeader("References", MimeUtility.fold(12, it)) }
    msg.setHeader("X-Mailer", "Moyer Mail (Android)")

    // 正文里粘贴的图片（data: 地址）改成内嵌附件，否则很多邮箱会把图片过滤掉
    val inline = ArrayList<MimeBodyPart>()
    val html = Regex("src=\"data:(image/[a-zA-Z0-9.+-]+);base64,([^\"]+)\"").replace(draft.optString("html")) { m ->
        val cid = UUID.randomUUID().toString().replace("-", "") + "@moyer"
        inline.add(MimeBodyPart().apply {
            dataHandler = DataHandler(ByteArrayDataSource(Base64.decode(m.groupValues[2], Base64.DEFAULT), m.groupValues[1]))
            setHeader(CTE, "base64")
            setHeader("Content-ID", "<$cid>")
            disposition = MimeBodyPart.INLINE
        })
        "src=\"cid:$cid\""
    }

    val alternative = MimeMultipart("alternative").apply {
        addBodyPart(MimeBodyPart().apply { setText(draft.optString("text"), "UTF-8") })
        val htmlPart = MimeBodyPart().apply { setContent(html, "text/html; charset=UTF-8") }
        if (inline.isEmpty()) addBodyPart(htmlPart)
        else addBodyPart(MimeBodyPart().apply {
            setContent(MimeMultipart("related").apply {
                addBodyPart(htmlPart)
                inline.forEach { addBodyPart(it) }
            })
        })
    }

    val files = draft.optJSONArray("attachments")?.objects() ?: emptyList()
    if (files.isEmpty()) {
        msg.setContent(alternative)
    } else {
        val mixed = MimeMultipart("mixed")
        mixed.addBodyPart(MimeBodyPart().apply { setContent(alternative) })
        for (a in files) {
            val part = MimeBodyPart()
            val from = a.optJSONObject("fromMessage")
            if (from != null) {
                val data = attachmentLoader(from.getLong("id"), from.getInt("index")) ?: throw UserError("原邮件里的附件“${a.optString("filename")}”取不到了")
                part.dataHandler = DataHandler(ByteArrayDataSource(data.bytes, data.contentType))
                part.fileName = MimeUtility.encodeText(data.filename, "UTF-8", null)
            } else {
                val path = a.optStr("path") ?: continue
                val file = File(path)
                if (!file.exists()) throw UserError("附件“${a.optString("filename")}”已经不存在了，请重新添加")
                val name = a.optString("filename").ifBlank { file.name }
                part.dataHandler = DataHandler(object : FileDataSource(file) {
                    override fun getContentType() = guessType(name)
                })
                part.fileName = MimeUtility.encodeText(name, "UTF-8", null)
            }
            part.disposition = MimeBodyPart.ATTACHMENT
            part.setHeader(CTE, "base64")
            mixed.addBodyPart(part)
        }
        msg.setContent(mixed)
    }
    msg.saveChanges()
    return msg
}

/** 通过 SMTP 发出去（密送地址只出现在信封里，不会写进对方收到的信头） */
fun sendMessage(acc: JSONObject, user: String, pass: String, msg: MimeMessage) {
    val smtp = acc.getJSONObject("smtp")
    val host = smtp.getString("host")
    val port = smtp.getInt("port")
    val (session, proto) = smtpSession(host, port, smtp.getBoolean("secure"))
    val t = session.getTransport(proto)
    try {
        t.connect(host, port, user, pass)
        t.sendMessage(msg, msg.allRecipients)
    } finally {
        runCatching { t.close() }
    }
}

fun markSeenForAppend(msg: MimeMessage) {
    msg.setFlag(Flags.Flag.SEEN, true)
}

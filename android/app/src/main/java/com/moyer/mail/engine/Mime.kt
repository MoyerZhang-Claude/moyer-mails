package com.moyer.mail.engine

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.UnsupportedEncodingException
import javax.mail.Address
import javax.mail.Message
import javax.mail.Multipart
import javax.mail.Part
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeUtility

class ParsedBody(
    val html: String?,
    val text: String,
    val attachments: JSONArray,
    val meta: JSONObject,
    val lang: String?,
    val snippet: String
)

fun addressesJson(list: Array<Address>?): JSONArray =
    jarr((list ?: emptyArray()).mapNotNull { a ->
        val ia = a as? InternetAddress ?: return@mapNotNull null
        if (ia.address.isNullOrBlank()) null else addrJson(ia.personal, ia.address)
    })

/** 读文本部件；遇到不认识的字符集时按 UTF-8 读，不至于整封信打不开 */
private fun readText(p: Part): String = try {
    when (val c = p.content) {
        is String -> c
        else -> String(p.inputStream.readBytes(), Charsets.UTF_8)
    }
} catch (e: UnsupportedEncodingException) {
    String(p.inputStream.readBytes(), Charsets.UTF_8)
}

fun decodeName(name: String?): String? = name?.let { runCatching { MimeUtility.decodeText(it) }.getOrDefault(it) }

private sealed class PartKind {
    object Html : PartKind()
    object Text : PartKind()
    class Inline(val cid: String) : PartKind()
    class Attachment(val fallbackName: String) : PartKind()
}

/**
 * 按固定顺序遍历邮件的每个部件。读信（parseMessage）和取附件（findAttachment）都用它，
 * 保证附件的编号前后一致。
 */
private fun walkParts(msg: Message, visit: (Part, PartKind) -> Unit) {
    fun walk(p: Part, depth: Int) {
        if (depth > 12) return
        when {
            p.isMimeType("multipart/*") -> {
                val mp = p.content as? Multipart ?: return
                for (i in 0 until mp.count) walk(mp.getBodyPart(i), depth + 1)
            }
            p.isMimeType("message/rfc822") -> visit(p, PartKind.Attachment("附件#.eml"))
            else -> {
                val disp = p.disposition?.lowercase()
                val isAttachment = disp == Part.ATTACHMENT || decodeName(p.fileName) != null
                val cid = (p as? MimeBodyPart)?.contentID?.trim('<', '>', ' ')
                when {
                    p.isMimeType("text/html") && !isAttachment -> visit(p, PartKind.Html)
                    p.isMimeType("text/plain") && !isAttachment -> visit(p, PartKind.Text)
                    p.isMimeType("image/*") && disp != Part.ATTACHMENT && !cid.isNullOrEmpty() -> visit(p, PartKind.Inline(cid))
                    else -> visit(p, PartKind.Attachment("附件#"))
                }
            }
        }
    }
    walk(msg, 0)
}

class AttachmentData(val filename: String, val contentType: String, val bytes: ByteArray)

/** 按编号取出附件内容（编号和读信时列出的一致） */
fun findAttachment(msg: Message, index: Int): AttachmentData? {
    var i = 0
    var found: AttachmentData? = null
    walkParts(msg) { p, kind ->
        if (found != null || kind !is PartKind.Attachment) return@walkParts
        if (i == index) {
            found = AttachmentData(
                filename = decodeName(p.fileName) ?: kind.fallbackName.replace("#", "${i + 1}"),
                contentType = p.contentType?.substringBefore(';')?.trim()?.lowercase() ?: "application/octet-stream",
                bytes = p.inputStream.readBytes()
            )
        }
        i++
    }
    return found
}

/** 把一封邮件拆成：HTML 正文、纯文本、内嵌图片（转成 data: 地址）、附件列表 */
fun parseMessage(msg: Message): ParsedBody {
    var html: String? = null
    var text: String? = null
    val inline = HashMap<String, String>()
    val atts = JSONArray()

    walkParts(msg) { p, kind ->
        when (kind) {
            PartKind.Html -> if (html == null) html = readText(p)
            PartKind.Text -> if (text == null) text = readText(p)
            is PartKind.Inline -> {
                val type = p.contentType.substringBefore(';').trim()
                inline[kind.cid] = "data:$type;base64," + Base64.encodeToString(p.inputStream.readBytes(), Base64.NO_WRAP)
            }
            is PartKind.Attachment -> {
                val idx = atts.length()
                val encoding = (p as? MimeBodyPart)?.encoding?.lowercase()
                val raw = p.size.toLong()
                val size = if (raw < 0) 0L else if (encoding == "base64") (raw * 0.74).toLong() else raw
                atts.put(
                    jobj(
                        "index" to idx,
                        "filename" to (decodeName(p.fileName) ?: kind.fallbackName.replace("#", "${idx + 1}")),
                        "contentType" to (p.contentType?.substringBefore(';')?.trim()?.lowercase() ?: "application/octet-stream"),
                        "size" to size,
                        "inline" to false
                    )
                )
            }
        }
    }

    var finalHtml = html
    if (finalHtml != null) for ((cid, uri) in inline) finalHtml = finalHtml!!.replace("cid:$cid", uri)
    val plain = text?.takeIf { it.isNotBlank() } ?: finalHtml?.let { htmlToText(it) } ?: ""
    val mm = msg as? MimeMessage
    val meta = jobj(
        "messageId" to mm?.messageID,
        "inReplyTo" to mm?.getHeader("In-Reply-To", null),
        "references" to mm?.getHeader("References", " "),
        "replyTo" to addressesJson(runCatching { msg.replyTo }.getOrNull()?.takeIf { r -> !r.contentEquals(msg.from) }),
        "bcc" to addressesJson(runCatching { msg.getRecipients(Message.RecipientType.BCC) }.getOrNull()),
        "to" to addressesJson(runCatching { msg.getRecipients(Message.RecipientType.TO) }.getOrNull()),
        "cc" to addressesJson(runCatching { msg.getRecipients(Message.RecipientType.CC) }.getOrNull())
    )
    return ParsedBody(
        html = finalHtml?.takeIf { it.isNotBlank() },
        text = plain,
        attachments = atts,
        meta = meta,
        lang = detectLang("${msg.subject ?: ""}\n$plain"),
        snippet = makeSnippet(plain)
    )
}

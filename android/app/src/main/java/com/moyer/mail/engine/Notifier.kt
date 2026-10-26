package com.moyer.mail.engine

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.moyer.mail.MainActivity
import com.moyer.mail.R

/** 系统通知：新邮件、稍后提醒，以及后台收信服务的常驻通知 */
object Notifier {
    const val CHANNEL_MAIL = "new_mail"
    const val CHANNEL_SERVICE = "background_sync"
    const val EXTRA_OPEN_MESSAGE = "com.moyer.mail.OPEN_MESSAGE"
    const val SERVICE_NOTIFICATION_ID = 1
    private const val MAIL_SUMMARY_ID = 2
    private const val GROUP_MAIL = "com.moyer.mail.NEW_MAIL"
    private const val GROUP_SERVICE = "com.moyer.mail.SERVICE"

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_MAIL, "新邮件", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "收到新邮件时提醒"
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "后台收信", NotificationManager.IMPORTANCE_MIN).apply {
            description = "让 Moyer Mail 在后台保持连接，及时收到新邮件"
            setShowBadge(false)
        })
    }

    private fun canPost(ctx: Context) =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openIntent(ctx: Context, messageId: Long?): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (messageId != null) putExtra(EXTRA_OPEN_MESSAGE, messageId)
        }
        return PendingIntent.getActivity(ctx, (messageId ?: 0L).toInt(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** 新邮件：一封时显示发件人和主题，多封时合并成一条 */
    fun newMail(ctx: Context, accountLabel: String, rows: List<MessageRow>) {
        if (rows.isEmpty() || !canPost(ctx)) return
        ensureChannels(ctx)
        val sorted = rows.sortedByDescending { it.date }
        val first = sorted.first()
        val sender = first.fromName?.takeIf { it.isNotBlank() } ?: first.fromAddr ?: "未知发件人"
        val b = NotificationCompat.Builder(ctx, CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setColor(0xFF3D7BF5.toInt())
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            // 自己指定分组：不然系统会把它和“正在接收邮件”的常驻通知自动合成一组，整组都划不掉
            .setGroup(GROUP_MAIL)
            .setContentIntent(openIntent(ctx, first.id))
        if (sorted.size == 1) {
            b.setContentTitle(sender)
                .setContentText(first.subject.ifBlank { "（无主题）" })
                .setStyle(NotificationCompat.BigTextStyle().bigText("${first.subject.ifBlank { "（无主题）" }}\n${first.snippet}"))
                .setSubText(accountLabel)
        } else {
            val inbox = NotificationCompat.InboxStyle()
            sorted.take(5).forEach { r -> inbox.addLine("${r.fromName ?: r.fromAddr ?: ""}：${r.subject}") }
            b.setContentTitle("收到 ${sorted.size} 封新邮件").setContentText(sorted.mapNotNull { it.fromName ?: it.fromAddr }.distinct().take(3).joinToString("、"))
                .setStyle(inbox).setSubText(accountLabel).setNumber(sorted.size)
        }
        post(ctx, ("mail:" + first.accountId).hashCode(), b)
    }

    /** 稍后提醒到点 */
    fun reminder(ctx: Context, rows: List<MessageRow>) {
        if (rows.isEmpty() || !canPost(ctx)) return
        ensureChannels(ctx)
        val first = rows.maxByOrNull { it.date }!!
        val sender = first.fromName?.takeIf { it.isNotBlank() } ?: first.fromAddr ?: ""
        val b = mailBuilder(ctx)
            .setContentTitle(if (rows.size == 1) "提醒：$sender" else "提醒：${rows.size} 封邮件")
            .setContentText(first.subject.ifBlank { "（无主题）" })
            .setContentIntent(openIntent(ctx, first.id))
        post(ctx, "reminder".hashCode(), b)
    }

    /** 定时邮件没发出去 */
    fun scheduledFailed(ctx: Context, subject: String, error: String) {
        if (!canPost(ctx)) return
        ensureChannels(ctx)
        val b = mailBuilder(ctx)
            .setContentTitle("定时邮件发送失败")
            .setContentText(subject.ifBlank { "（无主题）" })
            .setStyle(NotificationCompat.BigTextStyle().bigText("${subject.ifBlank { "（无主题）" }}\n$error"))
            .setContentIntent(openIntent(ctx, null))
        post(ctx, "outbox-failed".hashCode(), b)
    }

    private fun mailBuilder(ctx: Context) = NotificationCompat.Builder(ctx, CHANNEL_MAIL)
        .setSmallIcon(R.drawable.ic_stat_mail)
        .setColor(0xFF3D7BF5.toInt())
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_EMAIL)
        .setGroup(GROUP_MAIL)

    private fun post(ctx: Context, id: Int, b: NotificationCompat.Builder) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.notify(id, b.build())
        // 分组摘要：有了它，系统就不会把新邮件和常驻通知硬凑成一组；它自己不响铃，由上面那条负责提醒
        val summary = NotificationCompat.Builder(ctx, CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setColor(0xFF3D7BF5.toInt())
            .setContentTitle("新邮件")
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setGroup(GROUP_MAIL)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setContentIntent(openIntent(ctx, null))
            .build()
        nm.notify(MAIL_SUMMARY_ID, summary)
    }

    /** 打开应用后，之前的新邮件提醒就没用了，全部收起 */
    fun clearMail(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        runCatching {
            nm.activeNotifications.filter { it.notification.group == GROUP_MAIL }.forEach { nm.cancel(it.tag, it.id) }
        }
    }

    fun serviceNotification(ctx: Context): Notification {
        ensureChannels(ctx)
        return NotificationCompat.Builder(ctx, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setContentTitle("Moyer Mail 正在接收邮件")
            .setContentText("在设置 → 通用 里可以关闭后台收信")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setGroup(GROUP_SERVICE)
            .setContentIntent(openIntent(ctx, null))
            .build()
    }
}

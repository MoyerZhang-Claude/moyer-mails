package com.moyer.mail.engine

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * 后台收信：一个前台服务，让 App 退到后台后进程不被系统回收，
 * 收件箱的 IDLE 长连接因此能一直保持，新邮件到达时马上弹通知。
 */
class MailService : Service() {
    companion object {
        fun start(ctx: Context) {
            runCatching { ContextCompat.startForegroundService(ctx, Intent(ctx, MailService::class.java)) }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, MailService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, Notifier.SERVICE_NOTIFICATION_ID, Notifier.serviceNotification(this), type)
        // App 被系统回收后服务重启时，引擎也跟着重新启动
        Engine.get(this).start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null
}

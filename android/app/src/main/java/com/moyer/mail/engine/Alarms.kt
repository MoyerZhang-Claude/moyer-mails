package com.moyer.mail.engine

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 稍后提醒和定时发送的闹钟：在最近的一个到点时间叫醒应用（即使应用已经被系统关掉）。
 * 应用开着时引擎每 30 秒也会自己检查一次，闹钟是兜底。
 */
object Alarms {
    private fun intent(ctx: Context) =
        PendingIntent.getBroadcast(ctx, 0, Intent(ctx, AlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun reschedule(ctx: Context, db: Db) {
        runCatching {
            val nextSnooze = db.query("SELECT MIN(snooze_until) FROM messages WHERE snooze_until IS NOT NULL") { if (it.isNull(0)) null else it.getLong(0) }.firstOrNull()
            val nextSend = db.query("SELECT MIN(send_at) FROM outbox WHERE status = 'pending'") { if (it.isNull(0)) null else it.getLong(0) }.firstOrNull()
            val next = listOfNotNull(nextSnooze, nextSend).minOrNull()
            val am = ctx.getSystemService(AlarmManager::class.java)
            val pi = intent(ctx)
            if (next == null) {
                am.cancel(pi)
                return
            }
            val at = maxOf(next, System.currentTimeMillis() + 1_000)
            // 能用精确闹钟就用（安卓 12 以上需要用户在系统里允许）；否则用省电模式下也会响的普通闹钟，可能晚几分钟
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }.onFailure { Log.w("MoyerAlarms", "reschedule", it) }
    }
}

/** 闹钟响了：启动引擎，处理到点的提醒和定时邮件 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val engine = Engine.get(context)
        engine.start()
        // 广播最多只能占用几秒：等 8 秒就结束广播，没做完的发送不打断，由引擎在后台继续
        val job = engine.scope.launch { engine.tick() }
        engine.scope.launch {
            try {
                withTimeoutOrNull(8_000) { job.join() }
            } finally {
                pending.finish()
            }
        }
    }
}

/** 开机或应用更新后：恢复后台收信和闹钟 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val engine = Engine.get(context)
        runCatching { if (engine.settings().optBoolean("backgroundSync", true)) MailService.start(context) }
            .onFailure { Log.w("MoyerBoot", "start service", it) }
        Alarms.reschedule(context, engine.db)
    }
}

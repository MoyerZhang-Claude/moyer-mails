package com.moyer.mail.engine

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 界面 ↔ 手机端引擎的桥。界面调用 MailEngine.call({ method, args })，和电脑版的 window.moyer.call 一一对应；
 * 引擎的事件通过 "engine-event" 推给界面。另外几个方法（选文件、通知权限等）需要 Activity，单独放在这里。
 */
@CapacitorPlugin(
    name = "MailEngine",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])]
)
class MailEnginePlugin : Plugin() {
    private lateinit var engine: Engine
    /** 从通知点进来时要打开的邮件 */
    @Volatile private var launchMessage: Long? = null

    override fun load() {
        engine = Engine.get(context)
        engine.listener = { name, payload ->
            val ev = JSObject()
            ev.put("name", name)
            ev.put("payload", payload ?: JSONObject.NULL)
            notifyListeners("engine-event", ev)
        }
        Notifier.ensureChannels(context)
        engine.start()
        if (engine.settings().optBoolean("backgroundSync", true)) MailService.start(context)
        launchMessage = activity?.intent?.takeIf { it.hasExtra(Notifier.EXTRA_OPEN_MESSAGE) }?.getLongExtra(Notifier.EXTRA_OPEN_MESSAGE, 0L)
    }

    override fun handleOnResume() {
        super.handleOnResume()
        engine.appVisible = true
        Notifier.clearMail(context)
    }

    override fun handleOnPause() {
        super.handleOnPause()
        engine.appVisible = false
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        if (intent.hasExtra(Notifier.EXTRA_OPEN_MESSAGE)) {
            engine.emit("open-message", jobj("id" to intent.getLongExtra(Notifier.EXTRA_OPEN_MESSAGE, 0L)))
        }
    }

    @PluginMethod
    fun call(call: PluginCall) {
        val method = call.getString("method")
        if (method == null) {
            call.reject("缺少 method")
            return
        }
        val args = call.getArray("args") ?: JSArray()
        engine.scope.launch {
            try {
                val result = engine.dispatch(method, args)
                val out = JSObject()
                out.put("result", result ?: JSONObject.NULL)
                call.resolve(out)
            } catch (e: Throwable) {
                call.reject(friendlyError(e))
            }
        }
    }

    /** 冷启动时从通知点进来：界面加载完后来取一次 */
    @PluginMethod
    fun takeLaunchMessage(call: PluginCall) {
        val id = launchMessage
        launchMessage = null
        call.resolve(JSObject().put("id", id ?: JSONObject.NULL))
    }

    // ---------------- 通知权限（安卓 13+ 需要用户同意） ----------------
    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("notifications", call, "notificationsResult")
    }

    @PermissionCallback
    private fun notificationsResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }

    // ---------------- 后台运行（电池优化） ----------------
    @PluginMethod
    fun backgroundStatus(call: PluginCall) {
        val pm = context.getSystemService(PowerManager::class.java)
        call.resolve(JSObject().put("unrestricted", pm.isIgnoringBatteryOptimizations(context.packageName)))
    }

    /** 弹出系统自己的“允许后台运行”确认框，由用户决定 */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        runCatching { activity.startActivity(intent) }.onFailure {
            activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        }
        call.resolve()
    }

    // ---------------- 选附件 ----------------
    @PluginMethod
    fun pickFiles(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        startActivityForResult(call, intent, "pickFilesResult")
    }

    @ActivityCallback
    private fun pickFilesResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val out = JSArray()
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val data = result.data!!
            val uris = ArrayList<Uri>()
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
            // 复制到 App 自己的缓存目录，发信时直接读文件
            val dir = File(context.cacheDir, "outgoing/${UUID.randomUUID()}").apply { mkdirs() }
            for (uri in uris) {
                var name = "附件"
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
                }
                val file = File(dir, name.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
                context.contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { input.copyTo(it) } }
                out.put(JSObject().put("path", file.absolutePath).put("filename", name).put("size", file.length()))
            }
        }
        call.resolve(JSObject().put("result", out))
    }
}

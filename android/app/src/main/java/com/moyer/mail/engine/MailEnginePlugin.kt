package com.moyer.mail.engine

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 界面 ↔ 手机端引擎的桥。界面调用 MailEngine.call({ method, args })，和电脑版的 window.moyer.call 一一对应；
 * 引擎的事件通过 "engine-event" 推给界面。
 */
@CapacitorPlugin(name = "MailEngine")
class MailEnginePlugin : Plugin() {
    private lateinit var engine: Engine

    override fun load() {
        engine = Engine.get(context)
        engine.listener = { name, payload ->
            val ev = JSObject()
            ev.put("name", name)
            ev.put("payload", payload ?: JSONObject.NULL)
            notifyListeners("engine-event", ev)
        }
        engine.start()
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
}

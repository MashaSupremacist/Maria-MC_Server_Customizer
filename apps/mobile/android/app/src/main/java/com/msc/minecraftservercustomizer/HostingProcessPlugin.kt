package com.msc.minecraftservercustomizer

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "HostingProcess")
class HostingProcessPlugin : Plugin() {
    @PluginMethod
    fun startTestProcess(call: PluginCall) {
        ContextCompat.startForegroundService(
            context,
            Intent(context, HostingForegroundService::class.java).setAction(HostingForegroundService.ACTION_START_TEST),
        )
        call.resolve(JSObject().put("started", true))
    }

    @PluginMethod
    fun startServer(call: PluginCall) {
        val serverId = call.getString("serverId")
        if (serverId.isNullOrBlank()) { call.reject("A server ID is required"); return }
        ContextCompat.startForegroundService(context, Intent(context, HostingForegroundService::class.java).apply {
            action = HostingForegroundService.ACTION_START_SERVER
            putExtra(HostingForegroundService.EXTRA_SERVER_ID, serverId)
        })
        call.resolve(JSObject().put("started", true).put("serverId", serverId))
    }

    @PluginMethod
    fun sendInput(call: PluginCall) {
        val input = call.getString("input") ?: ""
        context.startService(Intent(context, HostingForegroundService::class.java).apply {
            action = HostingForegroundService.ACTION_INPUT
            putExtra(HostingForegroundService.EXTRA_INPUT, input)
        })
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val force = call.getBoolean("force") ?: false
        context.startService(Intent(context, HostingForegroundService::class.java).apply {
            action = if (force) HostingForegroundService.ACTION_FORCE_STOP else HostingForegroundService.ACTION_STOP
        })
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val snapshot = HostingStateStore.read(context)
        call.resolve(JSObject().apply {
            put("state", snapshot.state)
            put("pid", snapshot.pid)
            put("output", snapshot.output)
            put("serverStatus", snapshot.serverStatus)
            put("serverId", snapshot.serverId)
        })
    }
}

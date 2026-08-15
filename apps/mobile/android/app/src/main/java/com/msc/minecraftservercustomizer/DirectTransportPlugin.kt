package com.msc.minecraftservercustomizer

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "DirectTransport")
class DirectTransportPlugin : Plugin() {
    @PluginMethod
    fun startTest(call: PluginCall) {
        val config = runCatching {
            DirectTransportProtocol.validate(
                call.getString("host"),
                call.getInt("port"),
                call.getString("token"),
                call.getString("certificateFingerprint"),
                call.getInt("durationSeconds"),
                call.getInt("payloadBytes"),
            )
        }.getOrElse { error ->
            call.reject(error.message ?: "Invalid direct transport configuration")
            return
        }
        if (DirectTransportStateStore.read(context).active) {
            call.reject("A direct transport test is already running")
            return
        }

        DirectTransportStateStore.write(context, DirectTransportStateStore.Snapshot(
            status = "STARTING",
            host = config.host,
            port = config.port,
            message = "Starting Android foreground transport service",
            startedAt = System.currentTimeMillis(),
            certificateFingerprint = config.fingerprint,
        ))
        ContextCompat.startForegroundService(context, Intent(context, DirectTransportService::class.java).apply {
            action = DirectTransportService.ACTION_START
            putExtra(DirectTransportService.EXTRA_HOST, config.host)
            putExtra(DirectTransportService.EXTRA_PORT, config.port)
            putExtra(DirectTransportService.EXTRA_TOKEN, config.token)
            putExtra(DirectTransportService.EXTRA_FINGERPRINT, config.fingerprint)
            putExtra(DirectTransportService.EXTRA_DURATION_SECONDS, config.durationSeconds)
            putExtra(DirectTransportService.EXTRA_PAYLOAD_BYTES, config.payloadBytes)
        })
        call.resolve(snapshotToJs(DirectTransportStateStore.read(context)))
    }

    @PluginMethod
    fun stopTest(call: PluginCall) {
        context.startService(Intent(context, DirectTransportService::class.java).setAction(DirectTransportService.ACTION_STOP))
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(snapshotToJs(DirectTransportStateStore.read(context)))
    }

    private fun snapshotToJs(snapshot: DirectTransportStateStore.Snapshot): JSObject = JSObject().apply {
        put("status", snapshot.status)
        put("active", snapshot.active)
        put("transport", snapshot.transport)
        put("host", snapshot.host)
        put("port", snapshot.port)
        put("message", snapshot.message)
        put("startedAt", snapshot.startedAt)
        put("updatedAt", snapshot.updatedAt)
        put("completedAt", snapshot.completedAt)
        put("probes", snapshot.probes)
        put("reconnects", snapshot.reconnects)
        put("bytesSent", snapshot.bytesSent)
        put("bytesReceived", snapshot.bytesReceived)
        put("lastRttMs", snapshot.lastRttMs)
        put("tlsProtocol", snapshot.tlsProtocol)
        put("certificateFingerprint", snapshot.certificateFingerprint)
    }
}

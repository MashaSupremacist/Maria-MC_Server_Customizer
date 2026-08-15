package com.msc.minecraftservercustomizer

import android.content.Context
import android.system.Os
import java.io.File
import org.json.JSONObject

/** Cross-process status bridge for the isolated Phase 22A transport service. */
object DirectTransportStateStore {
    data class Snapshot(
        val status: String = "IDLE",
        val transport: String = DirectTransportProtocol.TRANSPORT,
        val host: String = "",
        val port: Int = DirectTransportProtocol.DEFAULT_PORT,
        val message: String = "Direct transport test has not started",
        val startedAt: Long = 0L,
        val updatedAt: Long = 0L,
        val completedAt: Long = 0L,
        val probes: Long = 0L,
        val reconnects: Int = 0,
        val bytesSent: Long = 0L,
        val bytesReceived: Long = 0L,
        val lastRttMs: Long = -1L,
        val tlsProtocol: String = "",
        val certificateFingerprint: String = "",
    ) {
        val active: Boolean get() = status in setOf("STARTING", "CONNECTING", "RUNNING", "RECONNECTING")
    }

    private fun stateFile(context: Context): File =
        File(context.filesDir, "MinecraftServerCustomizer/app-data/direct-transport-state.json")

    fun read(context: Context): Snapshot {
        val file = stateFile(context)
        if (!file.isFile) return Snapshot()
        return runCatching {
            val json = JSONObject(file.readText(Charsets.UTF_8))
            Snapshot(
                status = json.optString("status", "IDLE"),
                transport = json.optString("transport", DirectTransportProtocol.TRANSPORT),
                host = json.optString("host", ""),
                port = json.optInt("port", DirectTransportProtocol.DEFAULT_PORT),
                message = json.optString("message", ""),
                startedAt = json.optLong("startedAt", 0L),
                updatedAt = json.optLong("updatedAt", 0L),
                completedAt = json.optLong("completedAt", 0L),
                probes = json.optLong("probes", 0L),
                reconnects = json.optInt("reconnects", 0),
                bytesSent = json.optLong("bytesSent", 0L),
                bytesReceived = json.optLong("bytesReceived", 0L),
                lastRttMs = json.optLong("lastRttMs", -1L),
                tlsProtocol = json.optString("tlsProtocol", ""),
                certificateFingerprint = json.optString("certificateFingerprint", ""),
            )
        }.getOrDefault(Snapshot(status = "FAILED", message = "The saved transport status could not be read"))
    }

    fun write(context: Context, snapshot: Snapshot) {
        runCatching {
            val file = stateFile(context)
            file.parentFile?.mkdirs()
            val temporary = File(file.parentFile, "${file.name}.tmp")
            val now = System.currentTimeMillis()
            temporary.writeText(JSONObject().apply {
                put("status", snapshot.status)
                put("transport", snapshot.transport)
                put("host", snapshot.host)
                put("port", snapshot.port)
                put("message", snapshot.message.take(2048))
                put("startedAt", snapshot.startedAt)
                put("updatedAt", if (snapshot.updatedAt > 0L) snapshot.updatedAt else now)
                put("completedAt", snapshot.completedAt)
                put("probes", snapshot.probes)
                put("reconnects", snapshot.reconnects)
                put("bytesSent", snapshot.bytesSent)
                put("bytesReceived", snapshot.bytesReceived)
                put("lastRttMs", snapshot.lastRttMs)
                put("tlsProtocol", snapshot.tlsProtocol)
                put("certificateFingerprint", snapshot.certificateFingerprint)
            }.toString(), Charsets.UTF_8)
            Os.rename(temporary.absolutePath, file.absolutePath)
        }
    }
}

package com.msc.minecraftservercustomizer

import android.content.Context
import android.content.Intent
import android.system.Os
import java.io.File
import org.json.JSONObject

/** File-backed bridge between the Capacitor process and the isolated JVM host. */
object HostingStateStore {
    data class Snapshot(
        val state: Int = 4,
        val pid: Int = -1,
        val output: String = "",
        val serverStatus: String = "OFFLINE",
        val serverId: String = "",
    ) {
        fun isActiveFor(id: String): Boolean =
            id.isNotBlank() && serverId == id && serverStatus in setOf("STARTING", "ONLINE", "STOPPING")
    }

    private const val MAX_BRIDGED_OUTPUT_CHARS = 128 * 1024

    private fun stateFile(context: Context): File =
        File(context.filesDir, "MinecraftServerCustomizer/hosting-state.json")

    fun read(context: Context): Snapshot {
        val file = stateFile(context)
        if (!file.isFile) return Snapshot()
        return try {
            val json = JSONObject(file.readText(Charsets.UTF_8))
            Snapshot(
                state = json.optInt("state", 4),
                pid = json.optInt("pid", -1),
                output = json.optString("output", ""),
                serverStatus = json.optString("serverStatus", "OFFLINE"),
                serverId = json.optString("serverId", ""),
            )
        } catch (_: Exception) {
            Snapshot()
        }
    }

    fun write(context: Context, snapshot: Snapshot) {
        try {
            val file = stateFile(context)
            file.parentFile?.mkdirs()
            val temporary = File(file.parentFile, "${file.name}.tmp")
            val bridgedOutput = snapshot.output.takeLast(MAX_BRIDGED_OUTPUT_CHARS)
            temporary.writeText(JSONObject().apply {
                put("state", snapshot.state)
                put("pid", snapshot.pid)
                put("output", bridgedOutput)
                put("serverStatus", snapshot.serverStatus)
                put("serverId", snapshot.serverId)
                put("updatedAt", System.currentTimeMillis().toString())
            }.toString(), Charsets.UTF_8)
            Os.rename(temporary.absolutePath, file.absolutePath)
        } catch (_: Exception) {
            // Status mirroring must never interrupt the Minecraft process.
        }
    }

    fun sendCommand(context: Context, serverId: String, command: String): Boolean {
        if (!read(context).isActiveFor(serverId)) return false
        return try {
            context.startService(Intent(context, HostingForegroundService::class.java).apply {
                action = HostingForegroundService.ACTION_INPUT
                putExtra(HostingForegroundService.EXTRA_INPUT, "$command\n")
            })
            true
        } catch (_: Exception) {
            false
        }
    }
}

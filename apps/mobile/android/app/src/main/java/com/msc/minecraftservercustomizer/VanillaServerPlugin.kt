package com.msc.minecraftservercustomizer

import android.app.ActivityManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import org.json.JSONObject

@CapacitorPlugin(name = "VanillaServer")
class VanillaServerPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private val manifestUrl = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"

    @PluginMethod
    fun listVersions(call: PluginCall) {
        executor.execute {
            try {
                val manifest = JSONObject(downloadText(manifestUrl))
                val versions = JSArray()
                val entries = manifest.getJSONArray("versions")
                for (index in 0 until entries.length()) {
                    val entry = entries.getJSONObject(index)
                    if (entry.optString("type") != "release") continue
                    versions.put(JSObject().apply {
                        put("id", entry.getString("id"))
                        put("url", entry.getString("url"))
                        put("releaseTime", entry.optString("releaseTime"))
                    })
                    if (versions.length() >= 40) break
                }
                call.resolve(JSObject().apply {
                    put("latestRelease", manifest.getJSONObject("latest").getString("release"))
                    put("versions", versions)
                })
            } catch (error: Exception) {
                call.reject(error.message ?: "Could not discover Minecraft versions")
            }
        }
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val serverId = call.getString("serverId")
        val serverName = call.getString("serverName")?.trim()
        val version = call.getString("version")
        val ramMb = call.getInt("ramMb") ?: 1024
        val eulaAccepted = call.getBoolean("eulaAccepted") ?: false
        val ramOverrideAcknowledged = call.getBoolean("ramOverrideAcknowledged") ?: false
        if (!isSafeServerId(serverId)) { call.reject("Invalid server ID"); return }
        if (serverName.isNullOrBlank()) { call.reject("A server name is required"); return }
        if (version.isNullOrBlank()) { call.reject("A Minecraft version is required"); return }
        if (!eulaAccepted) { call.reject("EULA_REQUIRED"); return }
        if (ramMb < 512 || ramMb > 8192) { call.reject("RAM must be between 512 MB and 8192 MB"); return }
        if (ramMb > safeRamLimitMb() && !ramOverrideAcknowledged) {
            call.reject("RAM_OVERRIDE_REQUIRED")
            return
        }

        executor.execute {
            try {
                emitProgress(serverId!!, "resolving", null, "Finding Minecraft $version…")
                val manifest = JSONObject(downloadText(manifestUrl))
                val entries = manifest.getJSONArray("versions")
                val versionEntry = (0 until entries.length()).asSequence()
                    .map { entries.getJSONObject(it) }
                    .firstOrNull { it.optString("id") == version && it.optString("type") == "release" }
                    ?: throw IOException("Minecraft version $version was not found")
                val metadata = JSONObject(downloadText(versionEntry.getString("url")))
                val javaMajor = metadata.optJSONObject("javaVersion")?.optInt("majorVersion", 0)
                    ?.takeIf { it in setOf(8, 17, 21, 25) }
                    ?: requiredJava(version)
                val runtimeMetadata = File(
                    File(getContext().filesDir, "MinecraftServerCustomizer/runtimes"),
                    "java$javaMajor.json",
                )
                if (!runtimeMetadata.isFile) throw IOException("JAVA_RUNTIME_REQUIRED:$javaMajor")
                val serverDownload = metadata.getJSONObject("downloads").getJSONObject("server")
                val serverUrl = serverDownload.getString("url")
                val expectedSha1 = serverDownload.getString("sha1")
                val serverDirectory = File(getContext().filesDir, "MinecraftServerCustomizer/servers/$serverId")
                if (!serverDirectory.exists() && !serverDirectory.mkdirs()) throw IOException("Could not create server directory")
                val temporary = File(serverDirectory, "server.jar.part")
                val jar = File(serverDirectory, "server.jar")
                emitProgress(serverId, "downloading", 0, "Downloading Minecraft $version server…")
                downloadFile(serverUrl, temporary, serverId)
                emitProgress(serverId, "verifying", null, "Verifying server JAR…")
                val actualSha1 = digest(temporary, "SHA-1")
                if (!actualSha1.equals(expectedSha1, ignoreCase = true)) throw IOException("Server JAR checksum mismatch")
                if (jar.exists()) jar.delete()
                if (!temporary.renameTo(jar)) throw IOException("Could not finalize server JAR")
                File(serverDirectory, "eula.txt").writeText("# Minecraft EULA accepted by the server owner\neula=true\n")
                File(serverDirectory, "server.properties").writeText(
                    "motd=${serverName.replace("\n", " ")}\n" +
                        "server-port=25565\nserver-ip=\nonline-mode=true\n" +
                        "max-players=20\nlevel-name=world\nview-distance=10\nsimulation-distance=10\n",
                )
                val registration = JSONObject().apply {
                    put("serverId", serverId)
                    put("name", serverName)
                    put("type", "vanilla")
                    put("flavor", "vanilla")
                    put("version", version)
                    put("ramMb", ramMb)
                    put("serverJar", jar.absolutePath)
                    put("javaMajor", javaMajor)
                    put("sha1", actualSha1)
                    put("createdAt", System.currentTimeMillis().toString())
                    put("status", "ready")
                }
                File(serverDirectory, "server.json").writeText(registration.toString(2))
                emitProgress(serverId, "complete", 100, "Vanilla Minecraft $version is ready")
                call.resolve(JSObject().apply {
                    put("serverId", serverId)
                    put("name", serverName)
                    put("version", version)
                    put("serverDirectory", serverDirectory.absolutePath)
                    put("serverJar", jar.absolutePath)
                    put("status", "ready")
                })
            } catch (error: Exception) {
                emitProgress(serverId ?: "", "failed", null, error.message ?: "Vanilla installation failed")
                call.reject(error.message ?: "Vanilla installation failed")
            }
        }
    }

    private fun downloadText(url: String): String = URL(url).openConnection().run {
        (this as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            requestMethod = "GET"
        }.inputStream.bufferedReader().use { it.readText() }
    }

    private fun requiredJava(version: String): Int {
        val match = Regex("^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?").find(version)
        val major = match?.groupValues?.getOrNull(1)?.toIntOrNull() ?: return 17
        val minor = match.groupValues.getOrNull(2)?.toIntOrNull() ?: 0
        val patch = match.groupValues.getOrNull(3)?.toIntOrNull() ?: 0
        return when {
            major >= 26 -> 25
            major > 1 -> 25
            minor > 20 || (minor == 20 && patch >= 5) -> 21
            minor >= 17 -> 17
            else -> 8
        }
    }

    private fun downloadFile(url: String, destination: File, serverId: String) {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 20_000
        connection.readTimeout = 60_000
        connection.inputStream.use { input -> destination.outputStream().use { output ->
            val total = connection.contentLengthLong
            val buffer = ByteArray(64 * 1024)
            var copied = 0L
            var read: Int
            while (input.read(buffer).also { read = it } >= 0) {
                if (read == 0) continue
                output.write(buffer, 0, read)
                copied += read
                val percent = if (total > 0) ((copied * 100) / total).toInt() else null
                emitProgress(serverId, "downloading", percent, "Downloading server JAR…")
            }
        } }
        connection.disconnect()
    }

    private fun digest(file: File, algorithm: String): String {
        val digest = MessageDigest.getInstance(algorithm)
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            var read: Int
            while (input.read(buffer).also { read = it } >= 0) if (read > 0) digest.update(buffer, 0, read)
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun emitProgress(serverId: String, status: String, percent: Int?, message: String) {
        notifyListeners("serverProgress", JSObject().apply {
            put("serverId", serverId)
            put("status", status)
            put("percent", percent)
            put("message", message)
        })
    }

    private fun isSafeServerId(value: String?): Boolean =
        !value.isNullOrBlank() && value.matches(Regex("[A-Za-z0-9._-]{1,64}"))

    private fun safeRamLimitMb(): Int {
        val memory = ActivityManager.MemoryInfo()
        getContext().getSystemService(ActivityManager::class.java)?.getMemoryInfo(memory)
        val safeBytes = minOf(memory.totalMem / 2, memory.availMem * 3 / 4)
        return ((safeBytes / (1024L * 1024L) / 256L) * 256L).toInt()
    }
}

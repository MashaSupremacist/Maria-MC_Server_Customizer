package com.msc.minecraftservercustomizer

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.LinkedHashMap
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * Safe, app-private server configuration and administration operations.
 * File edits are limited to the managed server directory and are backed up
 * before changing user data.
 */
@CapacitorPlugin(name = "ServerManagement")
class ServerManagementPlugin : Plugin() {
    private val propertyDefaults = linkedMapOf(
        "motd" to "A Minecraft Server",
        "gamemode" to "survival",
        "difficulty" to "easy",
        "hardcore" to "false",
        "pvp" to "true",
        "online-mode" to "true",
        "max-players" to "20",
        "server-port" to "25565",
        "white-list" to "false",
        "enforce-whitelist" to "false",
        "spawn-protection" to "16",
        "view-distance" to "10",
        "simulation-distance" to "10",
        "allow-flight" to "false",
        "allow-nether" to "true",
        "generate-structures" to "true",
        "enable-command-block" to "false",
        "player-idle-timeout" to "0",
    )

    private val gameruleDefaults = linkedMapOf(
        "keepInventory" to "false",
        "mobGriefing" to "true",
        "doDaylightCycle" to "true",
        "doWeatherCycle" to "true",
        "doFireTick" to "true",
        "naturalRegeneration" to "true",
        "playersSleepingPercentage" to "100",
        "randomTickSpeed" to "3",
        "spawnRadius" to "10",
        "doImmediateRespawn" to "false",
        "commandBlockOutput" to "true",
    )

    @PluginMethod
    fun listServers(call: PluginCall) {
        try {
            val root = File(getContext().filesDir, "MinecraftServerCustomizer/servers")
            val servers = JSArray()
            root.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name }?.forEach { directory ->
                val metadataFile = File(directory, "server.json")
                val metadata = try {
                    if (metadataFile.isFile) org.json.JSONObject(metadataFile.readText(Charsets.UTF_8)) else org.json.JSONObject()
                } catch (_: Exception) { org.json.JSONObject() }
                val properties = parseProperties(File(directory, "server.properties"))
                val serverId = metadata.optString("serverId", directory.name).ifBlank { directory.name }
                val name = metadata.optString("name", properties["motd"] ?: serverId).ifBlank { serverId }
                val version = metadata.optString("version", "unknown").ifBlank { "unknown" }
                val flavor = metadata.optString("flavor", metadata.optString("type", "vanilla")).ifBlank { "vanilla" }
                if (metadataFile.isFile || File(directory, "server.jar").isFile || File(directory, "server.properties").isFile) {
                    servers.put(JSObject().apply {
                        put("serverId", serverId)
                        put("name", name)
                        put("version", version)
                        put("flavor", flavor)
                        put("ramMb", metadata.optInt("ramMb", 1024))
                        put("status", metadata.optString("status", "ready"))
                    })
                }
            }
            call.resolve(JSObject().apply { put("servers", servers) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not list installed servers")
        }
    }

    @PluginMethod
    fun deleteServer(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            if (isServerOnline(serverId)) throw IOException("SERVER_MUST_BE_STOPPED")
            val directory = serverDirectory(serverId)
            val existed = directory.isDirectory
            if (existed && !directory.deleteRecursively()) throw IOException("Could not delete server directory")
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("deleted", existed)
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not delete server")
        }
    }

    @PluginMethod
    fun getLogTail(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val maxChars = (call.getInt("maxChars") ?: 65_536).coerceIn(1_024, 262_144)
            val latestLog = serverFile(serverId, "logs/latest.log")
            val capturedLog = serverFile(serverId, "logs/mobile-console.log")
            val sourceLimit = (maxChars / 2).coerceAtLeast(512)
            val latestText = readLogTail(latestLog, sourceLimit)
            val capturedText = readLogTail(capturedLog, sourceLimit)
            val sections = StringBuilder()
            if (latestText.isNotBlank()) {
                sections.append("--- Minecraft latest.log (tail) ---\n")
                sections.append(latestText)
            }
            if (capturedText.isNotBlank()) {
                if (sections.isNotEmpty()) sections.append("\n\n")
                sections.append("--- Mobile captured console (tail) ---\n")
                sections.append(capturedText)
            }
            val paths = listOf(latestLog, capturedLog).filter { it.isFile }.joinToString("\n") { it.absolutePath }
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("exists", latestLog.isFile || capturedLog.isFile)
                put("path", paths)
                put("latestPath", latestLog.absolutePath)
                put("capturedPath", capturedLog.absolutePath)
                put("lastModified", maxOf(latestLog.lastModified(), capturedLog.lastModified()))
                put("text", sections.toString().takeLast(maxChars))
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not read server log")
        }
    }

    private fun readLogTail(file: File, maxChars: Int): String {
        return try {
            if (!file.isFile) "" else file.readText(Charsets.UTF_8).takeLast(maxChars)
        } catch (_: Exception) { "" }
    }

    @PluginMethod
    fun getServerProperties(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val file = serverFile(serverId, "server.properties")
            val values = parseProperties(file)
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("exists", file.isFile)
                put("properties", JSONObjectAdapter(values))
                put("settings", propertySettings(values))
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not read server properties")
        }
    }

    @PluginMethod
    fun updateServerProperties(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val values = call.getObject("values") ?: throw IOException("Property values are required")
            val file = serverFile(serverId, "server.properties")
            val current = parseProperties(file)
            val next = LinkedHashMap(current)
            propertyDefaults.keys.forEach { key ->
                if (values.has(key)) {
                    val value = values.optString(key, "")
                    validateProperty(key, value)
                    next[key] = value
                }
            }
            if (next == current) {
                call.resolve(JSObject().apply {
                    put("serverId", serverId)
                    put("changed", false)
                    put("restartRequired", false)
                    put("backupPath", "")
                })
                return
            }
            val backup = backupProperties(serverId, file)
            writeProperties(file, next)
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("changed", true)
                put("restartRequired", true)
                put("backupPath", backup.absolutePath)
                put("settings", propertySettings(next))
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not update server properties")
        }
    }

    @PluginMethod
    fun resetServerProperties(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val file = serverFile(serverId, "server.properties")
            val current = parseProperties(file)
            val next = LinkedHashMap(current)
            propertyDefaults.forEach { (key, value) -> next[key] = value }
            val backup = if (next != current) backupProperties(serverId, file) else null
            writeProperties(file, next)
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("changed", next != current)
                put("restartRequired", next != current)
                put("backupPath", backup?.absolutePath ?: "")
                put("settings", propertySettings(next))
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not reset server properties")
        }
    }

    @PluginMethod
    fun getGamerules(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val file = gameruleFile(serverId)
            val values = parseProperties(file)
            val rules = JSArray()
            gameruleDefaults.forEach { (name, defaultValue) ->
                val available = isGameruleAvailable(serverId, name)
                rules.put(JSObject().apply {
                    put("name", name)
                    put("value", values[name] ?: defaultValue)
                    put("defaultValue", defaultValue)
                    put("available", available)
                })
            }
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("rules", rules)
                put("versionAware", true)
                put("online", HostingStateStore.read(getContext()).let { it.serverId == serverId && it.serverStatus == "ONLINE" })
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not read gamerules")
        }
    }

    @PluginMethod
    fun setGamerule(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val name = call.getString("name") ?: throw IOException("Gamerule name is required")
            val value = call.getString("value") ?: throw IOException("Gamerule value is required")
            if (!gameruleDefaults.containsKey(name)) throw IOException("Unsupported gamerule: $name")
            if (!isGameruleAvailable(serverId, name)) throw IOException("Gamerule is not available for this Minecraft version")
            validateGamerule(name, value)
            val file = gameruleFile(serverId)
            val values = parseProperties(file)
            values[name] = value
            writeProperties(file, values)
            val online = HostingStateStore.read(getContext()).let { it.serverId == serverId && it.serverStatus == "ONLINE" }
            val commandSent = online && HostingStateStore.sendCommand(getContext(), serverId, "gamerule $name $value")
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("name", name)
                put("value", value)
                put("commandSent", commandSent)
                put("restartRequired", !commandSent)
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not update gamerule")
        }
    }

    @PluginMethod
    fun getPlayerAdministration(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val result = JSObject().apply {
                put("serverId", serverId)
                put("whitelist", jsonEntries(serverFile(serverId, "whitelist.json")))
                put("operators", jsonEntries(serverFile(serverId, "ops.json")))
                put("bannedPlayers", jsonEntries(serverFile(serverId, "banned-players.json")))
                put("bannedIps", jsonEntries(serverFile(serverId, "banned-ips.json")))
            }
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not read player administration data")
        }
    }

    @PluginMethod
    fun runPlayerCommand(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val command = call.getString("command")?.trim() ?: throw IOException("Command is required")
            if (!isAllowedPlayerCommand(command)) throw IOException("Unsupported player administration command")
            val online = HostingStateStore.read(getContext()).let { it.serverId == serverId && it.serverStatus == "ONLINE" }
            if (!online) throw IOException("SERVER_MUST_BE_ONLINE")
            val sent = HostingStateStore.sendCommand(getContext(), serverId, command)
            if (!sent) throw IOException("Could not send server command")
            call.resolve(JSObject().apply { put("serverId", serverId); put("command", command); put("sent", true) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not send player administration command")
        }
    }

    @PluginMethod
    fun listWorlds(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val worlds = JSArray()
            serverDirectory(serverId).listFiles()?.filter { it.isDirectory }?.sortedBy { it.name }?.forEach { directory ->
                worlds.put(worldInfo(directory))
            }
            call.resolve(JSObject().apply { put("serverId", serverId); put("worlds", worlds) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not list worlds")
        }
    }

    @PluginMethod
    fun createDefaultWorld(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            if (isServerOnline(serverId)) throw IOException("SERVER_MUST_BE_STOPPED")
            val worldName = sanitizeWorldName(call.getString("worldName") ?: "world")
            val world = serverFile(serverId, worldName)
            val existed = world.exists()
            if (!existed && !world.mkdirs()) throw IOException("Could not create world directory")
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("worldName", worldName)
                put("created", !existed)
                put("generatedByServer", true)
                put("message", "Start the server to generate the default world.")
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not create default world")
        }
    }

    @PluginMethod
    fun copyWorld(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            if (isServerOnline(serverId)) throw IOException("SERVER_MUST_BE_STOPPED")
            val sourceName = sanitizeWorldName(call.getString("sourceWorld") ?: throw IOException("Source world is required"))
            val destinationName = sanitizeWorldName(call.getString("destinationWorld") ?: throw IOException("Destination world is required"))
            val source = serverFile(serverId, sourceName)
            val destination = serverFile(serverId, destinationName)
            requireValidWorld(source)
            if (destination.exists()) throw IOException("Destination world already exists")
            copyDirectory(source, destination)
            call.resolve(JSObject().apply { put("serverId", serverId); put("worldName", destinationName); put("copied", true) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not copy world")
        }
    }

    @PluginMethod
    fun deleteWorld(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            if (isServerOnline(serverId)) throw IOException("SERVER_MUST_BE_STOPPED")
            val worldName = sanitizeWorldName(call.getString("worldName") ?: throw IOException("World name is required"))
            val world = serverFile(serverId, worldName)
            requireValidWorld(world)
            val backup = zipDirectory(world, backupDirectory(serverId), "pre-delete-$worldName-${System.currentTimeMillis()}.zip")
            if (!world.deleteRecursively()) throw IOException("Could not delete world")
            call.resolve(JSObject().apply { put("serverId", serverId); put("worldName", worldName); put("deleted", true); put("backupPath", backup.absolutePath) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not delete world")
        }
    }

    @PluginMethod
    fun importWorld(call: PluginCall) {
        val serverId = call.getString("serverId")
        if (serverId.isNullOrBlank() || !serverId.matches(Regex("[A-Za-z0-9._-]{1,64}"))) { call.reject("Invalid server ID"); return }
        if (isServerOnline(serverId)) { call.reject("SERVER_MUST_BE_STOPPED"); return }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
        }
        startActivityForResult(call, intent, "handleWorldImport")
    }

    @ActivityCallback
    fun handleWorldImport(call: PluginCall, result: ActivityResult) {
        val serverId = call.getString("serverId") ?: ""
        val requestedName = call.getString("worldName") ?: ""
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            call.resolve(JSObject().apply { put("canceled", true); put("serverId", serverId) })
            return
        }
        try {
            val worldName = sanitizeWorldName(if (requestedName.isBlank()) "imported-world" else requestedName)
            val staging = File(getContext().cacheDir, "world-import-${System.currentTimeMillis()}")
            staging.mkdirs()
            extractZip(result.data!!.data!!, staging)
            val source = findWorldRoot(staging) ?: throw IOException("The ZIP does not contain a valid Java world (level.dat missing)")
            val target = serverFile(serverId, worldName)
            if (target.exists()) throw IOException("Destination world already exists")
            copyDirectory(source, target)
            staging.deleteRecursively()
            call.resolve(JSObject().apply { put("canceled", false); put("serverId", serverId); put("worldName", worldName); put("imported", true) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not import world")
        }
    }

    @PluginMethod
    fun exportWorld(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val worldName = sanitizeWorldName(call.getString("worldName") ?: throw IOException("World name is required"))
            val world = serverFile(serverId, worldName)
            requireValidWorld(world)
            val archive = zipDirectory(world, File(getContext().cacheDir, "exports"), "$worldName.zip")
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/zip"
                putExtra(Intent.EXTRA_TITLE, archive.name)
            }
            call.data.put("temporaryArchive", archive.absolutePath)
            startActivityForResult(call, intent, "handleWorldExport")
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not prepare world export")
        }
    }

    @ActivityCallback
    fun handleWorldExport(call: PluginCall, result: ActivityResult) {
        val archive = File(call.data.optString("temporaryArchive", ""))
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            archive.delete()
            call.resolve(JSObject().apply { put("exported", false); put("canceled", true) })
            return
        }
        try {
            copyFileToUri(archive, result.data!!.data!!)
            archive.delete()
            call.resolve(JSObject().apply { put("exported", true); put("canceled", false) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not export world")
        }
    }

    @PluginMethod
    fun listBackups(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val backups = JSArray()
            backupDirectory(serverId).listFiles { file -> file.isFile && file.extension == "zip" }?.sortedByDescending { it.lastModified() }?.forEach { backup ->
                backups.put(JSObject().apply {
                    put("name", backup.name)
                    put("path", backup.absolutePath)
                    put("bytes", backup.length())
                    put("createdAt", backup.lastModified())
                })
            }
            call.resolve(JSObject().apply { put("serverId", serverId); put("backups", backups) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not list backups")
        }
    }

    @PluginMethod
    fun createBackup(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            if (isServerOnline(serverId)) throw IOException("SERVER_MUST_BE_STOPPED")
            val retention = (call.getInt("retentionLimit") ?: 10).coerceIn(1, 100)
            val archive = zipDirectory(serverDirectory(serverId), backupDirectory(serverId), "backup-${System.currentTimeMillis()}.zip")
            pruneBackups(serverId, retention)
            call.resolve(JSObject().apply { put("serverId", serverId); put("name", archive.name); put("path", archive.absolutePath); put("bytes", archive.length()) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not create backup")
        }
    }

    @PluginMethod
    fun deleteBackup(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val name = call.getString("name") ?: throw IOException("Backup name is required")
            val backup = backupFile(serverId, name)
            if (!backup.isFile || !backup.delete()) throw IOException("Could not delete backup")
            call.resolve(JSObject().apply { put("serverId", serverId); put("name", name); put("deleted", true) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not delete backup")
        }
    }

    @PluginMethod
    fun restoreBackup(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            if (isServerOnline(serverId)) throw IOException("SERVER_MUST_BE_STOPPED")
            val name = call.getString("name") ?: throw IOException("Backup name is required")
            val backup = backupFile(serverId, name)
            if (!backup.isFile || !isValidZip(backup)) throw IOException("Backup is missing or invalid")
            val current = zipDirectory(serverDirectory(serverId), backupDirectory(serverId), "pre-restore-${System.currentTimeMillis()}.zip")
            val staging = File(getContext().cacheDir, "restore-${System.currentTimeMillis()}")
            staging.mkdirs()
            extractZip(backup, staging)
            val extractedRoot = findRestoreRoot(staging)
            if (!File(extractedRoot, "server.properties").isFile && !File(extractedRoot, "server.json").isFile) throw IOException("Backup does not contain a server configuration")
            val serverRoot = serverDirectory(serverId)
            serverRoot.listFiles()?.forEach { it.deleteRecursively() }
            copyDirectory(extractedRoot, serverRoot)
            val metadata = File(serverRoot, "server.json")
            if (metadata.isFile) {
                val json = org.json.JSONObject(metadata.readText(Charsets.UTF_8))
                json.put("lastRestoredAt", System.currentTimeMillis().toString())
                json.put("restoredFrom", name)
                metadata.writeText(json.toString(2), Charsets.UTF_8)
            }
            staging.deleteRecursively()
            call.resolve(JSObject().apply { put("serverId", serverId); put("restored", true); put("safetyBackupPath", current.absolutePath) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not restore backup")
        }
    }

    @PluginMethod
    fun exportBackup(call: PluginCall) {
        try {
            val serverId = requireServerId(call)
            val name = call.getString("name") ?: throw IOException("Backup name is required")
            val backup = backupFile(serverId, name)
            if (!backup.isFile) throw IOException("Backup does not exist")
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/zip"
                putExtra(Intent.EXTRA_TITLE, backup.name)
            }
            call.data.put("backupPath", backup.absolutePath)
            startActivityForResult(call, intent, "handleBackupExport")
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not prepare backup export")
        }
    }

    @ActivityCallback
    fun handleBackupExport(call: PluginCall, result: ActivityResult) {
        val backup = File(call.data.optString("backupPath", ""))
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            call.resolve(JSObject().apply { put("exported", false); put("canceled", true) })
            return
        }
        try {
            copyFileToUri(backup, result.data!!.data!!)
            call.resolve(JSObject().apply { put("exported", true); put("canceled", false) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not export backup")
        }
    }

    private fun requireServerId(call: PluginCall): String {
        val serverId = call.getString("serverId")
        if (serverId.isNullOrBlank() || !serverId.matches(Regex("[A-Za-z0-9._-]{1,64}"))) throw IOException("Invalid server ID")
        return serverId
    }

    private fun worldInfo(directory: File): JSObject {
        var bytes = 0L
        directory.walkTopDown().filter { it.isFile }.forEach { bytes += it.length() }
        return JSObject().apply {
            put("name", directory.name)
            put("path", directory.absolutePath)
            put("valid", File(directory, "level.dat").isFile)
            put("sizeBytes", bytes)
            put("lastModified", directory.lastModified())
        }
    }

    private fun sanitizeWorldName(value: String): String {
        val name = value.trim()
        if (name.isBlank() || name.length > 64 || !name.matches(Regex("[A-Za-z0-9._-]+"))) throw IOException("Invalid world name")
        return name
    }

    private fun requireValidWorld(world: File) {
        if (!world.isDirectory || !File(world, "level.dat").isFile) throw IOException("World is not a valid Java world")
    }

    private fun copyDirectory(source: File, destination: File) {
        if (!source.isDirectory) throw IOException("Source directory is missing")
        destination.mkdirs()
        source.listFiles()?.forEach { child ->
            val target = File(destination, child.name)
            if (child.isDirectory) copyDirectory(child, target) else child.copyTo(target, overwrite = true)
        }
    }

    private fun isServerOnline(serverId: String): Boolean =
        HostingStateStore.read(getContext()).isActiveFor(serverId)

    private fun backupDirectory(serverId: String): File {
        val directory = File(getContext().filesDir, "MinecraftServerCustomizer/backups/$serverId").canonicalFile
        if (!directory.exists() && !directory.mkdirs()) throw IOException("Could not create backup directory")
        return directory
    }

    private fun backupFile(serverId: String, name: String): File {
        if (name.isBlank() || name.contains('/') || name.contains('\\') || name.contains("..")) throw IOException("Invalid backup name")
        return File(backupDirectory(serverId), name).canonicalFile.also { file ->
            if (!file.path.startsWith(backupDirectory(serverId).path + File.separator)) throw SecurityException("Invalid backup path")
        }
    }

    private fun zipDirectory(source: File, destinationDirectory: File, name: String): File {
        if (!source.isDirectory) throw IOException("Directory to back up is missing")
        destinationDirectory.mkdirs()
        val archive = File(destinationDirectory, name)
        ZipOutputStream(FileOutputStream(archive)).use { zip ->
            source.walkTopDown().filter { it.isFile && it.name != "server.jar.part" && !it.path.contains("${File.separator}logs${File.separator}") && !it.path.contains("${File.separator}tmp${File.separator}") }.forEach { file ->
                val relative = file.absolutePath.removePrefix(source.absolutePath + File.separator).replace(File.separatorChar, '/')
                zip.putNextEntry(ZipEntry(relative))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
        return archive
    }

    private fun extractZip(uri: Uri, destination: File) {
        getContext().contentResolver.openInputStream(uri).use { input ->
            if (input == null) throw IOException("Could not open ZIP")
            extractZipStream(input, destination)
        }
    }

    private fun extractZip(file: File, destination: File) {
        FileInputStream(file).use { extractZipStream(it, destination) }
    }

    private fun extractZipStream(input: java.io.InputStream, destination: File) {
        val root = destination.canonicalFile
        ZipInputStream(input).use { zip ->
            var entry = zip.nextEntry
            val buffer = ByteArray(64 * 1024)
            while (entry != null) {
                if (!entry.isDirectory) {
                    val output = File(root, entry.name).canonicalFile
                    if (output.path != root.path && !output.path.startsWith(root.path + File.separator)) throw SecurityException("ZIP entry escapes destination")
                    output.parentFile?.mkdirs()
                    FileOutputStream(output).use { out ->
                        var count = zip.read(buffer)
                        while (count >= 0) {
                            if (count > 0) out.write(buffer, 0, count)
                            count = zip.read(buffer)
                        }
                    }
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
    }

    private fun findWorldRoot(staging: File): File? {
        if (File(staging, "level.dat").isFile) return staging
        return staging.listFiles()?.firstOrNull { it.isDirectory && File(it, "level.dat").isFile }
    }

    private fun findRestoreRoot(staging: File): File {
        if (File(staging, "server.properties").isFile || File(staging, "server.json").isFile) return staging
        return staging.listFiles()?.firstOrNull { it.isDirectory && (File(it, "server.properties").isFile || File(it, "server.json").isFile) } ?: staging
    }

    private fun isValidZip(file: File): Boolean = try {
        ZipInputStream(FileInputStream(file)).use { zip -> zip.nextEntry != null }
    } catch (_: Exception) { false }

    private fun pruneBackups(serverId: String, retention: Int) {
        val files = backupDirectory(serverId).listFiles { file -> file.isFile && file.extension == "zip" }?.sortedBy { it.lastModified() } ?: return
        files.take((files.size - retention).coerceAtLeast(0)).forEach { it.delete() }
    }

    private fun copyFileToUri(source: File, destination: Uri) {
        getContext().contentResolver.openOutputStream(destination).use { output ->
            if (output == null) throw IOException("Could not open export destination")
            source.inputStream().use { input -> input.copyTo(output) }
        }
    }

    private fun serverDirectory(serverId: String): File = File(getContext().filesDir, "MinecraftServerCustomizer/servers/$serverId").canonicalFile

    private fun serverFile(serverId: String, name: String): File {
        val directory = serverDirectory(serverId)
        if (!directory.path.startsWith(File(getContext().filesDir, "MinecraftServerCustomizer/servers").canonicalPath)) throw SecurityException("Invalid server path")
        return File(directory, name).canonicalFile
    }

    private fun gameruleFile(serverId: String): File = serverFile(serverId, "gamerules.properties")

    private fun parseProperties(file: File): LinkedHashMap<String, String> {
        val result = LinkedHashMap<String, String>()
        if (!file.isFile) return result
        file.forEachLine(Charsets.UTF_8) { line ->
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#") || trimmed.startsWith("!")) return@forEachLine
            val separator = trimmed.indexOf('=')
            if (separator > 0) result[trimmed.substring(0, separator).trim()] = trimmed.substring(separator + 1).trim()
        }
        return result
    }

    private fun writeProperties(file: File, values: Map<String, String>) {
        file.parentFile?.mkdirs()
        file.writeText(values.entries.joinToString("\n") { "${it.key}=${it.value}" } + "\n", Charsets.UTF_8)
    }

    private fun propertySettings(values: Map<String, String>): JSArray = JSArray().apply {
        propertyDefaults.forEach { (key, defaultValue) ->
            put(JSObject().apply {
                put("key", key)
                put("value", values[key] ?: defaultValue)
                put("defaultValue", defaultValue)
                put("known", true)
            })
        }
    }

    private fun validateProperty(key: String, value: String) {
        if (value.contains('\n') || value.contains('\r')) throw IOException("Property values cannot contain newlines")
        when (key) {
            "gamemode" -> if (value !in setOf("survival", "creative", "adventure", "spectator", "0", "1", "2", "3")) throw IOException("Invalid gamemode")
            "difficulty" -> if (value !in setOf("peaceful", "easy", "normal", "hard", "0", "1", "2", "3")) throw IOException("Invalid difficulty")
            "hardcore", "pvp", "online-mode", "white-list", "enforce-whitelist", "allow-flight", "allow-nether", "generate-structures", "enable-command-block" -> if (value.lowercase() !in setOf("true", "false")) throw IOException("$key must be true or false")
            "max-players" -> validateInteger(key, value, 1, 1000)
            "server-port" -> validateInteger(key, value, 1, 65535)
            "spawn-protection" -> validateInteger(key, value, 0, 100000)
            "view-distance", "simulation-distance" -> validateInteger(key, value, 2, 32)
            "player-idle-timeout" -> validateInteger(key, value, 0, 100000)
            "motd" -> if (value.length > 256) throw IOException("MOTD is too long")
        }
    }

    private fun validateInteger(key: String, value: String, min: Int, max: Int) {
        val number = value.toIntOrNull() ?: throw IOException("$key must be a number")
        if (number !in min..max) throw IOException("$key must be between $min and $max")
    }

    private fun validateGamerule(name: String, value: String) {
        if (name in setOf("playersSleepingPercentage", "randomTickSpeed", "spawnRadius")) validateInteger(name, value, 0, 100000)
        else if (value.lowercase() !in setOf("true", "false")) throw IOException("$name must be true or false")
    }

    private fun isGameruleAvailable(serverId: String, name: String): Boolean {
        if (name != "playersSleepingPercentage" && name != "doImmediateRespawn") return true
        val version = try { org.json.JSONObject(serverFile(serverId, "server.json").readText()).optString("version") } catch (_: Exception) { "" }
        val match = Regex("^(\\d+)\\.(\\d+)").find(version) ?: return true
        val minor = match.groupValues[2].toIntOrNull() ?: return true
        return minor >= 15
    }

    private fun backupProperties(serverId: String, source: File): File {
        val backupDirectory = File(getContext().filesDir, "MinecraftServerCustomizer/backups/$serverId")
        if (!backupDirectory.exists() && !backupDirectory.mkdirs()) throw IOException("Could not create backup directory")
        val backup = File(backupDirectory, "properties-${System.currentTimeMillis()}.properties")
        if (source.isFile) source.copyTo(backup, overwrite = false) else backup.writeText("", Charsets.UTF_8)
        return backup
    }

    private fun jsonEntries(file: File): JSArray {
        val result = JSArray()
        if (!file.isFile) return result
        val text = file.readText(Charsets.UTF_8).trim()
        if (text.isEmpty()) return result
        try {
            val array = org.json.JSONArray(text)
            for (index in 0 until array.length()) result.put(array.get(index))
        } catch (_: Exception) { }
        return result
    }

    private fun isAllowedPlayerCommand(command: String): Boolean =
        command.matches(Regex("/(kick|op|deop|whitelist add|whitelist remove|ban|pardon|ban-ip|pardon-ip)\\s+[^\\s]+(?:\\s+.*)?", RegexOption.IGNORE_CASE))

    /** Avoid exposing a mutable JSONObject implementation to the bridge. */
    private fun JSONObjectAdapter(values: Map<String, String>): JSObject = JSObject().apply {
        values.forEach { (key, value) -> put(key, value) }
    }
}

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
import java.io.FileOutputStream
import java.io.IOException
import java.util.LinkedHashMap
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.json.JSONObject

/** Modded-flavor metadata, pack import, and safe Java-launch translation. */
@CapacitorPlugin(name = "ModdedServer")
class ModdedServerPlugin : Plugin() {
    private val launcherNames = setOf("start.bat", "run.bat", "start-server.bat", "startserver.bat", "launch.bat", "server.bat")

    @PluginMethod
    fun getFlavorCatalog(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("flavors", JSArray().apply {
                put(flavor("forge", "Forge", 8, 21, "mods"))
                put(flavor("fabric", "Fabric", 8, 21, "mods"))
                put(flavor("paper", "Paper", 17, 21, "plugins"))
            })
        })
    }

    @PluginMethod
    fun importServerPack(call: PluginCall) {
        val serverId = call.getString("serverId")
        val serverName = call.getString("serverName")?.trim()
        if (!isSafeId(serverId)) { call.reject("Invalid server ID"); return }
        if (serverName.isNullOrBlank()) { call.reject("A server name is required"); return }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
        }
        startActivityForResult(call, intent, "handleServerPackImport")
    }

    @ActivityCallback
    fun handleServerPackImport(call: PluginCall, result: ActivityResult) {
        val serverId = call.getString("serverId") ?: ""
        val serverName = call.getString("serverName") ?: "Imported server"
        val eulaAccepted = call.getBoolean("eulaAccepted") ?: false
        val ramMb = (call.getInt("ramMb") ?: 1024).coerceIn(512, 8192)
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            call.resolve(JSObject().apply { put("canceled", true); put("serverId", serverId) })
            return
        }
        var staging: File? = null
        try {
            if (!eulaAccepted) throw IOException("EULA_REQUIRED")
            val archive = File(getContext().cacheDir, "server-pack-${System.currentTimeMillis()}.zip")
            copyUriToFile(result.data!!.data!!, archive)
            staging = File(getContext().cacheDir, "server-pack-${System.currentTimeMillis()}").also { it.mkdirs() }
            extractZip(archive, staging)
            archive.delete()
            val source = findPackRoot(staging) ?: throw IOException("The pack has no usable server files")
            val destination = File(getContext().filesDir, "MinecraftServerCustomizer/servers/$serverId").canonicalFile
            if (destination.exists()) throw IOException("A server with this ID already exists")
            copyDirectory(source, destination)
            val launch = detectLaunchDescriptor(destination)
            val flavor = detectFlavor(destination, launch)
            val version = detectVersion(destination, launch)
            val requiredJava = requiredJava(version)
            val metadata = JSONObject().apply {
                put("serverId", serverId)
                put("name", serverName)
                put("type", flavor)
                put("flavor", flavor)
                put("version", version ?: "unknown")
                put("ramMb", ramMb)
                put("javaMajor", requiredJava)
                put("launch", launch)
                put("serverJar", launch.optString("jar", ""))
                put("source", "server-pack")
                put("createdAt", System.currentTimeMillis().toString())
                put("status", "ready")
            }
            writeDefaults(destination, serverName, eulaAccepted)
            File(destination, "server.json").writeText(metadata.toString(2), Charsets.UTF_8)
            call.resolve(JSObject().apply {
                put("canceled", false)
                put("serverId", serverId)
                put("name", serverName)
                put("flavor", flavor)
                put("version", version ?: "unknown")
                put("requiredJava", requiredJava)
                put("launch", launch)
                put("serverDirectory", destination.absolutePath)
                put("status", "ready")
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not import server pack")
        } finally {
            staging?.deleteRecursively()
        }
    }

    @PluginMethod
    fun translateLauncher(call: PluginCall) {
        try {
            val serverId = call.getString("serverId") ?: throw IOException("Server ID is required")
            if (!isSafeId(serverId)) throw IOException("Invalid server ID")
            val directory = File(getContext().filesDir, "MinecraftServerCustomizer/servers/$serverId")
            val launch = detectLaunchDescriptor(directory)
            call.resolve(JSObject().apply { put("serverId", serverId); put("launch", launch) })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not translate launcher")
        }
    }

    @PluginMethod
    fun listExtensions(call: PluginCall) {
        try {
            val serverId = call.getString("serverId") ?: throw IOException("Server ID is required")
            val kind = call.getString("kind") ?: "mods"
            if (kind !in setOf("mods", "plugins")) throw IOException("Unsupported extension directory")
            val directory = File(getContext().filesDir, "MinecraftServerCustomizer/servers/$serverId/$kind")
            val extensions = JSArray()
            directory.listFiles()?.filter { it.isFile && (it.name.endsWith(".jar") || it.name.endsWith(".jar.disabled")) }?.sortedBy { it.name }?.forEach { file ->
                extensions.put(JSObject().apply {
                    put("name", file.name.removeSuffix(".disabled"))
                    put("enabled", !file.name.endsWith(".disabled"))
                    put("bytes", file.length())
                })
            }
            call.resolve(JSObject().apply { put("serverId", serverId); put("kind", kind); put("extensions", extensions) })
        } catch (error: Exception) { call.reject(error.message ?: "Could not list extensions") }
    }

    @PluginMethod
    fun setExtensionEnabled(call: PluginCall) {
        try {
            val serverId = call.getString("serverId") ?: throw IOException("Server ID is required")
            val kind = call.getString("kind") ?: "mods"
            val name = call.getString("name") ?: throw IOException("Extension name is required")
            val enabled = call.getBoolean("enabled") ?: true
            if (kind !in setOf("mods", "plugins") || !name.matches(Regex("[A-Za-z0-9._-]+\\.jar"))) throw IOException("Invalid extension")
            if (HostingStateStore.read(getContext()).isActiveFor(serverId)) throw IOException("SERVER_MUST_BE_STOPPED")
            val directory = File(getContext().filesDir, "MinecraftServerCustomizer/servers/$serverId/$kind").canonicalFile
            directory.mkdirs()
            val source = File(directory, if (enabled) "$name.disabled" else name)
            val target = File(directory, if (enabled) name else "$name.disabled")
            if (!source.isFile || !source.renameTo(target)) throw IOException("Extension file was not found")
            call.resolve(JSObject().apply { put("serverId", serverId); put("kind", kind); put("name", name); put("enabled", enabled) })
        } catch (error: Exception) { call.reject(error.message ?: "Could not change extension state") }
    }

    private fun flavor(name: String, label: String, minJava: Int, maxJava: Int, extensionDirectory: String) = JSObject().apply {
        put("id", name); put("label", label); put("minimumJava", minJava); put("maximumJava", maxJava); put("extensionDirectory", extensionDirectory)
    }

    private fun detectLaunchDescriptor(directory: File): JSONObject {
        val launcher = directory.listFiles()?.firstOrNull { it.isFile && launcherNames.contains(it.name.lowercase()) }
        if (launcher != null) return translateBatch(launcher.readText(Charsets.UTF_8), directory, launcher.name)
        val candidate = directory.listFiles()?.firstOrNull { it.isFile && it.name.endsWith(".jar") && !it.name.contains("installer") }
            ?: throw IOException("No runnable JAR or supported start.bat/run.bat launcher found")
        return JSONObject().apply {
            put("kind", "jar")
            put("jar", candidate.relativeTo(directory).path.replace(File.separatorChar, '/'))
            put("jvmArgs", JSONArray())
            put("serverArgs", JSONArray().put("nogui"))
            put("classpath", JSONArray())
            put("source", "jar")
        }
    }

    private fun translateBatch(content: String, directory: File, scriptName: String): JSONObject {
        val blocked = Regex("(?i)\\b(powershell|cmd(?:\\.exe)?|pwsh|winget|curl|wget|invoke-webrequest|start-process)\\b")
        if (blocked.containsMatchIn(content)) throw IOException("Unsupported Windows command in $scriptName; manual launch configuration is required")
        val variables = LinkedHashMap<String, String>()
        val lines = content.replace("\r", "").lines()
        val javaLine = lines.firstOrNull { line ->
            val trimmed = line.trim()
            trimmed.isNotEmpty() && !trimmed.startsWith("rem", true) && !trimmed.startsWith("::") && Regex("(?i)(^|[\\s\\\"])(java)(?:\\.exe)?([\\s\"]|$)").containsMatchIn(trimmed)
        } ?: throw IOException("No supported Java launch command was found in $scriptName")
        lines.forEach { line ->
            val match = Regex("^\\s*set\\s+\\\"?([A-Za-z_][A-Za-z0-9_]*)=([^\\\"]*)\\\"?\\s*$", RegexOption.IGNORE_CASE).find(line)
            if (match != null) variables[match.groupValues[1].uppercase()] = match.groupValues[2]
        }
        val expanded = expandArgFiles(tokenize(expandVariables(javaLine, variables)), directory, 0)
        if (expanded.any { it.endsWith(".exe", true) && !it.equals("java.exe", true) && !it.endsWith("/java.exe", true) && !it.endsWith("\\java.exe", true) }) {
            throw IOException("Launcher references a native Windows executable; manual launch configuration is required")
        }
        val javaIndex = expanded.indexOfFirst { it.equals("java", true) || it.equals("java.exe", true) || it.endsWith("/java", true) || it.endsWith("\\java.exe", true) }
        if (javaIndex < 0) throw IOException("No supported Java executable was found in $scriptName")
        val tokens = expanded.drop(javaIndex + 1).filter { it != "%*" && it != "${'$'}*" }
        val jvmArgs = JSONArray()
        val serverArgs = JSONArray()
        val classpath = JSONArray()
        var jar: String? = null
        var mainClass: String? = null
        var index = 0
        var afterLaunchTarget = false
        while (index < tokens.size) {
            val token = tokens[index]
            when {
                token == "-jar" && index + 1 < tokens.size -> { jar = resolveRelative(directory, tokens[++index]); afterLaunchTarget = true }
                (token == "-cp" || token == "-classpath") && index + 1 < tokens.size -> {
                    tokens[++index].split(File.pathSeparator, ";").filter { it.isNotBlank() }.forEach { classpath.put(resolveRelative(directory, it)) }
                }
                !afterLaunchTarget && mainClass == null && token.startsWith("-") -> {
                    jvmArgs.put(token)
                    if (token in setOf("-p", "--module-path", "--class-path", "--add-modules", "--add-exports", "--add-opens", "--limit-modules", "--patch-module", "--upgrade-module-path", "--module-source-path") && index + 1 < tokens.size) {
                        val value = tokens[++index]
                        jvmArgs.put(if (token == "-p") "--module-path=$value" else "$token=$value")
                        if (token == "-p" || token == "--module-path" || token == "--class-path") {
                            value.split(File.pathSeparator, ";").filter { it.isNotBlank() }.forEach { classpath.put(resolveRelative(directory, it)) }
                        }
                    }
                }
                !afterLaunchTarget && mainClass == null -> mainClass = token
                else -> serverArgs.put(token)
            }
            index++
        }
        if (jar == null && mainClass == null) throw IOException("Launcher did not identify a JAR or main class")
        val result = JSONObject().apply {
            put("kind", "translated-batch")
            put("script", scriptName)
            put("jar", jar ?: classpath.optString(0, ""))
            put("mainClass", mainClass ?: "")
            put("jvmArgs", jvmArgs)
            put("serverArgs", if (serverArgs.length() == 0) JSONArray().put("nogui") else serverArgs)
            put("classpath", classpath)
            put("workingDirectory", ".")
            put("source", "batch-translation")
        }
        return result
    }

    private fun expandArgFiles(tokens: List<String>, directory: File, depth: Int): List<String> {
        if (depth > 4) throw IOException("Launcher argument-file nesting is too deep")
        val result = mutableListOf<String>()
        tokens.forEach { token ->
            if (token.startsWith("@") && token.length > 1) {
                val file = File(directory, token.substring(1).replace('\\', File.separatorChar)).canonicalFile
                if (!file.path.startsWith(directory.canonicalPath + File.separator) || !file.isFile) throw IOException("Launcher argument file is missing: ${token.substring(1)}")
                result += expandArgFiles(tokenize(file.readText(Charsets.UTF_8)), directory, depth + 1)
            } else result += token
        }
        return result
    }

    private fun tokenize(text: String): List<String> {
        val result = mutableListOf<String>()
        val current = StringBuilder()
        var quoted = false
        text.forEach { char ->
            when {
                char == '"' -> quoted = !quoted
                char.isWhitespace() && !quoted -> if (current.isNotEmpty()) { result += current.toString(); current.clear() }
                else -> current.append(char)
            }
        }
        if (current.isNotEmpty()) result += current.toString()
        return result
    }

    private fun expandVariables(text: String, variables: Map<String, String>): String {
        var expanded = text.replace("%~dp0", ".", ignoreCase = true)
        variables.forEach { (key, value) -> expanded = expanded.replace("%$key%", value, ignoreCase = true) }
        return expanded
    }

    private fun resolveRelative(root: File, raw: String): String {
        val normalized = raw.trim('"').replace('\\', File.separatorChar)
        val file = File(root, normalized).canonicalFile
        if (!file.path.startsWith(root.canonicalPath + File.separator)) throw IOException("Launcher path escapes server directory")
        return if (file.path.startsWith(root.canonicalPath + File.separator)) file.relativeTo(root).path.replace(File.separatorChar, '/') else normalized.replace(File.separatorChar, '/')
    }

    private fun detectFlavor(directory: File, launch: JSONObject): String {
        val names = directory.listFiles()?.map { it.name.lowercase() }?.toSet() ?: emptySet()
        if (names.any { it.startsWith("paper-") }) return "paper"
        if (names.any { it == "fabric-server-launch.jar" } || File(directory, "mods").exists() && directoryContains(directory, "fabric.mod.json")) return "fabric"
        if (names.any { it.startsWith("forge-") } || directoryContains(directory, "mods.toml") || launch.optString("mainClass").contains("forge", true)) return "forge"
        return "vanilla"
    }

    private fun detectVersion(directory: File, launch: JSONObject): String? {
        val names = directory.listFiles()?.map { it.name } ?: emptyList()
        val candidates = names + listOf(launch.optString("jar"), launch.optString("script"))
        candidates.forEach { candidate ->
            val match = Regex("1\\.\\d{1,2}(?:\\.\\d{1,2})?").find(candidate)
            if (match != null) return match.value
        }
        return null
    }

    private fun requiredJava(version: String?): Int {
        val minor = Regex("^1\\.(\\d+)").find(version ?: "")?.groupValues?.getOrNull(1)?.toIntOrNull() ?: 20
        return when {
            minor <= 16 -> 8
            minor <= 20 -> 17
            else -> 21
        }
    }

    private fun directoryContains(root: File, fileName: String): Boolean = root.walkTopDown().any { it.isFile && it.name.equals(fileName, true) }

    private fun findPackRoot(staging: File): File? {
        if (staging.listFiles()?.any { it.name.equals("server.jar", true) || launcherNames.contains(it.name.lowercase()) || it.name.endsWith(".jar") } == true) return staging
        return staging.listFiles()?.firstOrNull { it.isDirectory && it.listFiles()?.any { child -> child.name.equals("server.jar", true) || launcherNames.contains(child.name.lowercase()) || child.name.endsWith(".jar") } == true }
    }

    private fun writeDefaults(directory: File, name: String, eulaAccepted: Boolean) {
        val properties = File(directory, "server.properties")
        if (!properties.isFile) properties.writeText("motd=${name.replace("\n", " ")}\nserver-port=25565\nlevel-name=world\n", Charsets.UTF_8)
        if (eulaAccepted) File(directory, "eula.txt").writeText("eula=true\n", Charsets.UTF_8)
    }

    private fun extractZip(source: File, destination: File) {
        ZipInputStream(source.inputStream()).use { zip ->
            val root = destination.canonicalFile
            val buffer = ByteArray(64 * 1024)
            var entry: ZipEntry? = zip.nextEntry
            while (entry != null) {
                val raw = entry!!.name.replace('\\', '/')
                val relative = if (raw.startsWith("overrides/")) raw.removePrefix("overrides/") else raw
                if (relative.isNotBlank() && !relative.endsWith("/") && relative != "manifest.json" && relative != "modrinth.index.json") {
                    val output = File(root, relative).canonicalFile
                    if (!output.path.startsWith(root.path + File.separator)) throw SecurityException("Pack entry escapes managed storage")
                    output.parentFile?.mkdirs()
                    FileOutputStream(output).use { out ->
                        var count = zip.read(buffer)
                        while (count >= 0) { if (count > 0) out.write(buffer, 0, count); count = zip.read(buffer) }
                    }
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
    }

    private fun copyDirectory(source: File, destination: File) {
        destination.mkdirs()
        source.listFiles()?.forEach { child ->
            val target = File(destination, child.name)
            if (child.isDirectory) copyDirectory(child, target) else child.copyTo(target, overwrite = true)
        }
    }

    private fun copyUriToFile(uri: Uri, destination: File) {
        getContext().contentResolver.openInputStream(uri).use { input ->
            if (input == null) throw IOException("Could not open selected pack")
            destination.outputStream().use { output -> input.copyTo(output) }
        }
    }

    private fun isSafeId(value: String?): Boolean = !value.isNullOrBlank() && value.matches(Regex("[A-Za-z0-9._-]{1,64}"))
}

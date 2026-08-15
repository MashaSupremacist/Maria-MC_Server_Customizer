package com.msc.minecraftservercustomizer

import android.os.Build
import android.system.Os
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors
import java.util.zip.GZIPInputStream
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.json.JSONObject
import org.tukaani.xz.XZInputStream

@CapacitorPlugin(name = "JavaRuntime")
class JavaRuntimePlugin : Plugin() {
    private val supportedMajors = listOf(8, 17, 21, 25)
    private val executor = Executors.newSingleThreadExecutor()

    @PluginMethod
    fun getRuntimeInfo(call: PluginCall) {
        try {
            val root = runtimeRoot()
            root.mkdirs()
            val installed = JSONArray()
            supportedMajors.mapNotNull { readMetadata(it) }.forEach { installed.put(it) }
            call.resolve(JSObject().apply {
                put("architecture", androidArchitecture())
                put("root", root.absolutePath)
                put("supportedMajors", JSONArray(supportedMajors))
                put("installed", installed)
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not read Java runtimes")
        }
    }

    @PluginMethod
    fun downloadRuntime(call: PluginCall) {
        val majorVersion = call.getInt("majorVersion")
        if (majorVersion == null || majorVersion !in supportedMajors) {
            call.reject("Supported Java runtimes are 8, 17, 21, and 25")
            return
        }

        executor.execute {
            val partial = File(runtimeRoot(), "java$majorVersion.partial")
            val archive = File(runtimeRoot(), "java$majorVersion.tar.xz")
            var phase = "preparing"
            try {
                val existing = readMetadata(majorVersion)
                if (existing != null && File(existing.getString("javaPath")).canExecute()) {
                    call.resolve(JSObject().apply { put("runtime", existing) })
                    return@execute
                }

                runtimeRoot().mkdirs()
                partial.deleteRecursively()
                emitProgress(majorVersion, "resolving", null, "Finding a compatible Android runtime…")
                val pkg = resolvePackage(majorVersion)
                phase = "preparing the bundled archive"
                val bundled = copyBundledRuntime(pkg, archive, majorVersion)
                if (!bundled) {
                    phase = "downloading"
                    emitProgress(majorVersion, "downloading", 0, "Downloading Java $majorVersion…")
                    download(pkg.url, archive, pkg.size, majorVersion)
                }
                phase = "verifying the archive"
                emitProgress(majorVersion, "verifying", null, "Verifying downloaded archive…")
                val actualChecksum = sha256(archive)
                if (!actualChecksum.equals(pkg.checksum, ignoreCase = true)) {
                    throw IOException("Runtime checksum mismatch")
                }

                phase = "extracting the archive"
                emitProgress(majorVersion, "extracting", null, "Extracting Java $majorVersion…")
                extractArchive(archive, partial)
                val javaFile = findJavaExecutable(partial)
                    ?: throw IOException("Extracted runtime has no java executable")
                makeExecutable(javaFile)
                phase = "checking the extracted launcher"
                emitProgress(majorVersion, "checking", null, "Running java -version…")
                val versionOutput = readJavaVersion(javaFile, majorVersion)
                val version = parseJavaVersion(versionOutput)
                    ?: throw IOException("Extracted runtime did not return a Java version")

                phase = "finalizing the installation"
                val destination = File(runtimeRoot(), "java$majorVersion")
                destination.deleteRecursively()
                if (!partial.renameTo(destination)) {
                    throw IOException("Could not finalize Java $majorVersion installation")
                }
                val finalJava = findJavaExecutable(destination)
                    ?: throw IOException("Finalized runtime has no java executable")
                makeExecutable(finalJava)
                val metadata = JSObject().apply {
                    put("majorVersion", majorVersion)
                    put("architecture", androidArchitecture())
                    put("installPath", destination.absolutePath)
                    put("javaPath", finalJava.absolutePath)
                    put("version", version)
                    put("versionOutput", versionOutput)
                    put("checksum", actualChecksum)
                    put("installedAt", System.currentTimeMillis().toString())
                    put("sourceUrl", pkg.url)
                }
                writeMetadata(majorVersion, metadata)
                emitProgress(majorVersion, "complete", 100, "Java $majorVersion is ready")
                archive.delete()
                call.resolve(JSObject().apply { put("runtime", metadata) })
            } catch (error: Exception) {
                val detail = error.message?.takeIf { it.isNotBlank() } ?: error::class.java.simpleName
                val freeStorage = runtimeRoot().usableSpace
                val storageHint = if (freeStorage > 0L) " Free app storage: ${formatBytes(freeStorage)}." else ""
                val message = "Java $majorVersion installation failed while $phase: $detail.$storageHint"
                partial.deleteRecursively()
                if (phase != "downloading") archive.delete()
                emitProgress(majorVersion, "failed", null, message)
                call.reject(message)
            }
        }
    }

    @PluginMethod
    fun verifyRuntime(call: PluginCall) {
        val majorVersion = call.getInt("majorVersion")
        if (majorVersion == null || majorVersion !in supportedMajors) {
            call.reject("Unsupported Java runtime")
            return
        }
        executor.execute {
            try {
                val metadata = readMetadata(majorVersion)
                    ?: throw IOException("Java $majorVersion is not installed")
                val javaPath = File(metadata.getString("javaPath"))
                if (!javaPath.exists()) throw IOException("Installed Java executable is missing")
                val output = readJavaVersion(javaPath, majorVersion)
                val version = parseJavaVersion(output)
                    ?: throw IOException("java -version returned no usable version")
                call.resolve(JSObject().apply {
                    put("majorVersion", majorVersion)
                    put("installed", true)
                    put("javaPath", javaPath.absolutePath)
                    put("version", version)
                    put("output", output)
                })
            } catch (error: Exception) {
                call.reject(error.message ?: "Could not verify Java runtime")
            }
        }
    }

    private fun runtimeRoot(): File = File(
        File(getContext().filesDir, "MinecraftServerCustomizer"),
        "runtimes",
    ).canonicalFile

    private fun metadataFile(majorVersion: Int): File = File(runtimeRoot(), "java$majorVersion.json")

    private fun readMetadata(majorVersion: Int): JSONObject? {
        val file = metadataFile(majorVersion)
        if (!file.isFile) return null
        return try {
            JSONObject(file.readText())
        } catch (_: Exception) {
            null
        }
    }

    private fun writeMetadata(majorVersion: Int, metadata: JSONObject) {
        val file = metadataFile(majorVersion)
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeText(metadata.toString(2))
        if (!temporary.renameTo(file)) throw IOException("Could not save Java runtime metadata")
    }

    private fun androidArchitecture(): String = when (Build.SUPPORTED_ABIS.firstOrNull()) {
        "arm64-v8a" -> "aarch64"
        "armeabi-v7a" -> "arm"
        "x86_64" -> "x64"
        "x86" -> "x32"
        else -> throw IOException("Unsupported Android CPU architecture")
    }

    private data class RuntimePackage(
        val url: String,
        val checksum: String,
        val size: Long,
        val archiveName: String,
    )

    private fun resolvePackage(majorVersion: Int): RuntimePackage {
        val architecture = when (androidArchitecture()) {
            "aarch64" -> "arm64"
            "x64" -> "x86_64"
            else -> throw IOException("Android Java runtimes are currently available for ARM64 and x86_64 only")
        }
        val releaseTag = if (majorVersion == 17) "download" else "download_jre$majorVersion"
        val archiveName = "jre$majorVersion-android-$architecture.tar.xz"
        val checksums = mapOf(
            "jre8-android-arm64.tar.xz" to "9a59124d9791957d55c68be664ab76831f336cf2e1e1cd4414220c6fdbf0e06d",
            "jre8-android-x86_64.tar.xz" to "b1fbcef4965c17925894febe8216d089c6dd47b37950b5f945a89616443c1d0e",
            "jre17-android-arm64.tar.xz" to "e162c860fe05ee4a4e4af7606437419879f6c748386a7b09fa77d10db6a64091",
            "jre17-android-x86_64.tar.xz" to "893e27d2aed8b40407f29fe939e2a0f193e5d55f72892a303db634b0808a2b61",
            "jre21-android-arm64.tar.xz" to "8d41ec401ee59f7722df60ed991f81ad146e130452804bfdd8a05d3436f7bbfe",
            "jre21-android-x86_64.tar.xz" to "cb88723961f5f9ad63afa1f212eb199816c27cabfd7dc66567bde1d8fb69713b",
            "jre25-android-arm64.tar.xz" to "c4ee53fc699be07ff10930261f12e335cbf411dd53e13a29d4cf7d6be8c35065",
            "jre25-android-x86_64.tar.xz" to "97ce82b7b9ef3753d4040323cedd5e5e06bf70273e9cf3a47c9df6d7e74d5ce6",
        )
        val sizes = mapOf(
            "jre25-android-arm64.tar.xz" to 38_013_284L,
            "jre25-android-x86_64.tar.xz" to 39_028_920L,
        )
        val checksum = checksums[archiveName] ?: throw IOException("No checksum is pinned for $archiveName")
        val url = "https://github.com/AngelAuraMC/angelauramc-openjdk-build/releases/download/$releaseTag/$archiveName"
        return RuntimePackage(url, checksum, sizes[archiveName] ?: 0L, archiveName)
    }

    private fun copyBundledRuntime(pkg: RuntimePackage, destination: File, majorVersion: Int): Boolean {
        val assetPath = "runtimes/${pkg.archiveName}"
        val input = try {
            getContext().assets.open(assetPath)
        } catch (_: FileNotFoundException) {
            return false
        }

        emitProgress(majorVersion, "copying", 0, "Preparing bundled Java $majorVersion…")
        var copied = 0L
        input.use { source ->
            FileOutputStream(destination, false).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = source.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    copied += count
                    val percent = pkg.size.takeIf { it > 0 }?.let {
                        ((copied * 100) / it).toInt().coerceIn(0, 100)
                    }
                    emitProgress(majorVersion, "copying", percent, "Preparing bundled Java $majorVersion…")
                }
            }
        }
        if (pkg.size > 0L && copied != pkg.size) {
            destination.delete()
            throw IOException("Bundled runtime has $copied bytes; expected ${pkg.size}")
        }
        return true
    }

    private fun download(url: String, destination: File, totalBytes: Long, majorVersion: Int) {
        val maximumAttempts = 4
        var expectedTotal = totalBytes.takeIf { it > 0 }
        var lastFailure: IOException? = null

        for (attempt in 1..maximumAttempts) {
            val existingBytes = destination.length()
            if (expectedTotal != null && existingBytes == expectedTotal) return
            if (expectedTotal != null && existingBytes > expectedTotal) destination.delete()

            val resumeOffset = destination.length()
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.connectTimeout = 30_000
            connection.readTimeout = 60_000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("User-Agent", "MinecraftServerCustomizer/0.1")
            connection.setRequestProperty("Accept-Encoding", "identity")
            if (resumeOffset > 0L) connection.setRequestProperty("Range", "bytes=$resumeOffset-")

            try {
                val responseCode = connection.responseCode
                if (responseCode == 416 &&
                    expectedTotal != null && resumeOffset == expectedTotal
                ) return
                if (responseCode !in 200..299) throw IOException("Runtime download failed (HTTP $responseCode)")

                val appending = responseCode == HttpURLConnection.HTTP_PARTIAL && resumeOffset > 0L
                val receivedBeforeRequest = if (appending) resumeOffset else 0L
                if (!appending && resumeOffset > 0L) destination.delete()

                val contentRange = connection.getHeaderField("Content-Range")
                if (appending) {
                    val rangeMatch = Regex("bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)", RegexOption.IGNORE_CASE)
                        .matchEntire(contentRange.orEmpty())
                        ?: throw IOException("Server returned an invalid resume response")
                    val returnedStart = rangeMatch.groupValues[1].toLong()
                    if (returnedStart != resumeOffset) {
                        throw IOException("Server resumed at byte $returnedStart instead of $resumeOffset")
                    }
                    rangeMatch.groupValues[3].toLongOrNull()?.let { expectedTotal = it }
                }
                if (!appending && connection.contentLengthLong > 0L) {
                    expectedTotal = connection.contentLengthLong
                }

                var received = receivedBeforeRequest
                var requestBytes = 0L
                connection.inputStream.use { input ->
                    FileOutputStream(destination, appending).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            requestBytes += count
                            received += count
                            val percent = expectedTotal?.takeIf { it > 0 }?.let {
                                ((received * 100) / it).toInt().coerceIn(0, 100)
                            }
                            emitProgress(majorVersion, "downloading", percent, "Downloading Java $majorVersion…")
                        }
                    }
                }

                val responseBytes = connection.contentLengthLong
                if (responseBytes > 0L && requestBytes != responseBytes) {
                    throw IOException("Connection ended after $requestBytes of $responseBytes response bytes")
                }
                val finalSize = destination.length()
                if (expectedTotal != null && finalSize != expectedTotal) {
                    throw IOException("Connection ended at $finalSize of $expectedTotal archive bytes")
                }
                return
            } catch (error: IOException) {
                lastFailure = error
                if (attempt < maximumAttempts) {
                    val received = destination.length()
                    val progress = expectedTotal?.takeIf { it > 0 }?.let {
                        ((received * 100) / it).toInt().coerceIn(0, 100)
                    }
                    emitProgress(
                        majorVersion,
                        "downloading",
                        progress,
                        "Connection interrupted; resuming Java $majorVersion download (attempt ${attempt + 1}/$maximumAttempts)…",
                    )
                    Thread.sleep(750L * attempt)
                }
            } finally {
                connection.disconnect()
            }
        }

        val received = destination.length()
        val totalDescription = expectedTotal?.let { " of $it" }.orEmpty()
        throw IOException(
            "Runtime download failed after $maximumAttempts attempts (received $received$totalDescription bytes): " +
                (lastFailure?.message ?: "connection closed unexpectedly"),
            lastFailure,
        )
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(Locale.US, it) }
    }

    private fun extractArchive(archive: File, destination: File) {
        destination.mkdirs()
        when {
            archive.name.endsWith(".zip", ignoreCase = true) -> extractZip(archive, destination)
            archive.name.endsWith(".tar.xz", ignoreCase = true) -> extractTarXz(archive, destination)
            archive.name.endsWith(".tar.gz", ignoreCase = true) || archive.name.endsWith(".tgz", ignoreCase = true) ->
                extractTarGz(archive, destination)
            else -> throw IOException("Unsupported runtime archive format")
        }
    }

    private fun extractZip(archive: File, destination: File) {
        ZipInputStream(BufferedInputStream(FileInputStream(archive))).use { input ->
            while (true) {
                val entry = input.nextEntry ?: break
                val target = safeExtractTarget(destination, entry.name)
                if (entry.isDirectory) target.mkdirs() else {
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { output -> input.copyTo(output) }
                    target.setExecutable(target.path.contains("${File.separator}bin${File.separator}"))
                }
                input.closeEntry()
            }
        }
    }

    private fun extractTarGz(archive: File, destination: File) {
        GZIPInputStream(BufferedInputStream(FileInputStream(archive))).use { input -> extractTarStream(input, destination) }
    }

    private fun extractTarXz(archive: File, destination: File) {
        XZInputStream(BufferedInputStream(FileInputStream(archive))).use { input -> extractTarStream(input, destination) }
    }

    private fun extractTarStream(input: java.io.InputStream, destination: File) {
        val header = ByteArray(512)
        while (true) {
            readFully(input, header)
            if (header.all { it.toInt() == 0 }) break
            val name = readTarString(header, 0, 100)
            val size = readTarOctal(header, 124, 12)
            val type = header[156].toInt().toChar()
            val target = safeExtractTarget(destination, name)
            when (type) {
                '5' -> target.mkdirs()
                '0', '\u0000' -> {
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { output -> copyExactly(input, output, size) }
                    if (name.split('/').contains("bin")) makeExecutable(target)
                }
                else -> skipExactly(input, size)
            }
            val padding = (512 - (size % 512)) % 512
            skipExactly(input, padding)
        }
    }

    private fun safeExtractTarget(root: File, entryName: String): File {
        val target = File(root, entryName.removePrefix("./")).canonicalFile
        val rootPath = root.canonicalPath
        if (target.path != rootPath && !target.path.startsWith("$rootPath${File.separator}")) {
            throw IOException("Runtime archive contains an unsafe path")
        }
        return target
    }

    private fun makeExecutable(file: File) {
        if (file.setExecutable(true, false) && file.canExecute()) return
        Os.chmod(file.absolutePath, 493)
        if (!file.canExecute()) throw IOException("Could not make ${file.name} executable")
    }

    private fun readFully(input: java.io.InputStream, buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val count = input.read(buffer, offset, buffer.size - offset)
            if (count < 0) throw IOException("Unexpected end of runtime archive")
            offset += count
        }
    }

    private fun copyExactly(input: java.io.InputStream, output: FileOutputStream, size: Long) {
        var remaining = size
        val buffer = ByteArray(64 * 1024)
        while (remaining > 0) {
            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (count < 0) throw IOException("Unexpected end of runtime archive")
            output.write(buffer, 0, count)
            remaining -= count
        }
    }

    private fun skipExactly(input: java.io.InputStream, size: Long) {
        var remaining = size
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped <= 0L) {
                if (input.read() < 0) throw IOException("Unexpected end of runtime archive")
                remaining--
            } else remaining -= skipped
        }
    }

    private fun readTarString(header: ByteArray, offset: Int, length: Int): String =
        header.copyOfRange(offset, offset + length).takeWhile { it.toInt() != 0 }.toByteArray().toString(Charsets.UTF_8).trim()

    private fun readTarOctal(header: ByteArray, offset: Int, length: Int): Long =
        readTarString(header, offset, length).trim().ifBlank { "0" }.toLongOrNull(8) ?: 0L

    private fun findJavaExecutable(root: File): File? {
        val candidates = listOf("bin/java", "jre/bin/java", "java")
        candidates.forEach { relative ->
            val candidate = File(root, relative)
            if (candidate.isFile) return candidate
        }
        return root.walkTopDown().firstOrNull { it.isFile && it.name == "java" }
    }

    private fun readJavaVersion(javaFile: File, expectedMajor: Int): String {
        val runtimeRoot = javaFile.parentFile?.parentFile
            ?: throw IOException("Could not determine extracted runtime root")
        val libraryDirs = runtimeRoot.walkTopDown()
            .filter { it.isDirectory && it.listFiles()?.any { child -> child.isFile && child.name.endsWith(".so") } == true }
            .map { it.absolutePath }
            .distinct()
            .toList()
        if (libraryDirs.isEmpty()) throw IOException("Extracted runtime has no native library directories")

        Os.setenv("JAVA_HOME", runtimeRoot.absolutePath, true)
        val raw = try {
            NativeJvmLauncher.launchDirect(arrayOf("java", "-version"), libraryDirs.toTypedArray())
        } catch (error: UnsatisfiedLinkError) {
            throw IOException("The packaged Android Java launcher could not load: ${error.message}", error)
        }
        val marker = "__MSC_EXIT__:"
        val markerIndex = raw.indexOf(marker)
        if (markerIndex < 0) throw IOException("Native Java launcher returned an invalid result")
        val lineEnd = raw.indexOf('\n', markerIndex)
        val exitCode = raw.substring(markerIndex + marker.length, if (lineEnd >= 0) lineEnd else raw.length).trim().toIntOrNull()
            ?: throw IOException("Native Java launcher returned an invalid exit code")
        val output = if (lineEnd >= 0) raw.substring(lineEnd + 1).trim() else ""
        if (exitCode != 0) {
            return try {
                readJavaVersionViaJli(runtimeRoot, libraryDirs, expectedMajor)
            } catch (jliError: Exception) {
                val directDetail = output.ifBlank { "native JVM launcher exited with code $exitCode" }
                val jliDetail = jliError.message?.takeIf { it.isNotBlank() }
                    ?: jliError::class.java.simpleName
                throw IOException(
                    "Direct JVM verification failed: $directDetail; JLI verification failed: $jliDetail",
                    jliError,
                )
            }
        }
        return output
    }

    private fun readJavaVersionViaJli(runtimeRoot: File, libraryDirs: List<String>, expectedMajor: Int): String {
        val libjli = File(runtimeRoot, "lib/libjli.so")
        if (!libjli.isFile) throw IOException("Extracted runtime has no lib/libjli.so")
        val raw = NativeJvmLauncher.launch(
            libjli.absolutePath,
            arrayOf("java", "-version"),
            libraryDirs.toTypedArray(),
            expectedMajor.toString() + ".0.0-internal",
            expectedMajor.toString(),
        )
        val marker = "__MSC_EXIT__:"
        val markerIndex = raw.indexOf(marker)
        if (markerIndex < 0) throw IOException("Native JLI launcher returned an invalid result")
        val lineEnd = raw.indexOf('\n', markerIndex)
        val exitCode = raw.substring(markerIndex + marker.length, if (lineEnd >= 0) lineEnd else raw.length)
            .trim().toIntOrNull() ?: throw IOException("Native JLI launcher returned an invalid exit code")
        val output = if (lineEnd >= 0) raw.substring(lineEnd + 1).trim() else ""
        if (exitCode != 0) {
            throw IOException(output.ifBlank { "JLI launcher exited with code $exitCode" })
        }
        if (output.isBlank()) throw IOException("JLI launcher returned no version output")
        return output
    }

    private fun parseJavaVersion(output: String): String? =
        Regex("\\\"([0-9]+(?:[._-][0-9A-Za-z]+)*)\\\"").find(output)?.groupValues?.get(1)

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0L) return "unknown"
        val units = arrayOf("B", "KB", "MB", "GB")
        var value = bytes.toDouble()
        var index = 0
        while (value >= 1024.0 && index < units.lastIndex) {
            value /= 1024.0
            index++
        }
        return if (index == 0) "${value.toLong()} ${units[index]}"
        else String.format(Locale.US, "%.1f %s", value, units[index])
    }

    private fun emitProgress(majorVersion: Int, status: String, percent: Int?, message: String) {
        notifyListeners("runtimeProgress", JSObject().apply {
            put("majorVersion", majorVersion)
            put("status", status)
            if (percent == null) put("percent", JSONObject.NULL) else put("percent", percent)
            put("message", message)
        })
    }
}

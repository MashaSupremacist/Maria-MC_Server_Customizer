package com.msc.minecraftservercustomizer

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import org.json.JSONObject

/** Owns the Java hosting lifecycle while the app is backgrounded. */
class HostingForegroundService : Service() {
    companion object {
        const val ACTION_START_TEST = "com.msc.minecraftservercustomizer.action.START_TEST"
        const val ACTION_START_SERVER = "com.msc.minecraftservercustomizer.action.START_SERVER"
        const val ACTION_INPUT = "com.msc.minecraftservercustomizer.action.INPUT"
        const val ACTION_STOP = "com.msc.minecraftservercustomizer.action.STOP"
        const val ACTION_FORCE_STOP = "com.msc.minecraftservercustomizer.action.FORCE_STOP"
        const val EXTRA_INPUT = "input"
        const val EXTRA_SERVER_ID = "serverId"
        private const val CHANNEL_ID = "hosting"
        private const val NOTIFICATION_ID = 4101
        private const val MAX_CAPTURED_CONSOLE_BYTES = 512 * 1024L
        @Volatile var publishedState: Int = 4
        @Volatile var publishedPid: Int = -1
        @Volatile var publishedOutput: String = ""
        @Volatile var publishedServerStatus: String = "OFFLINE"
        @Volatile var publishedServerId: String = ""
    }

    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var nativeHandle: Long = 0L
    @Volatile private var lastOutput = ""
    @Volatile private var lastState = 4
    @Volatile private var lastPid = -1
    @Volatile private var consoleLogFile: File? = null
    private val consoleLogLock = Any()
    private var cpuWakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        publishedState = 4
        publishedPid = -1
        publishedOutput = ""
        publishedServerStatus = "OFFLINE"
        publishedServerId = ""
        persistPublishedState()
        createNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_TEST -> {
                promoteToForeground("Starting Java host…")
                // JNI_CreateJavaVM must run on the Android service thread;
                // the native bridge creates the managed worker after that.
                startTestProcessInternal()
            }
            ACTION_START_SERVER -> {
                promoteToForeground("Starting Minecraft…")
                startInstalledServerInternal(intent.getStringExtra(EXTRA_SERVER_ID).orEmpty())
            }
            ACTION_INPUT -> sendInputInternal(intent.getStringExtra(EXTRA_INPUT).orEmpty())
            ACTION_STOP -> stopInternal(false)
            ACTION_FORCE_STOP -> stopInternal(true)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopInternal(true)
        releaseHostingLocks()
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Closing the Capacitor activity must not stop the foreground host.
        // START_STICKY below also lets Android recreate this service if its
        // process is reclaimed later, while the ongoing notification remains
        // the user's explicit stop control.
        if (nativeHandle != 0L && publishedServerStatus in setOf("STARTING", "ONLINE")) {
            updateNotification("Minecraft is still running in the background")
        }
        super.onTaskRemoved(rootIntent)
    }

    private fun promoteToForeground(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification(text),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification(text))
        }
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireHostingLocks() {
        if (cpuWakeLock?.isHeld != true) {
            cpuWakeLock = getSystemService(PowerManager::class.java)?.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "$packageName:minecraft-server",
            )?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wifiLock?.isHeld != true) {
            try {
                val manager = applicationContext.getSystemService(WifiManager::class.java) ?: return
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                wifiLock = manager.createWifiLock(mode, "$packageName:minecraft-server").apply {
                    setReferenceCounted(false)
                    acquire()
                }
            } catch (_: Exception) {
                // The CPU lock still protects the JVM when Wi-Fi-lock support
                // is unavailable on a vendor Android build.
                wifiLock = null
            }
        }
    }

    private fun releaseHostingLocks() {
        runCatching { if (wifiLock?.isHeld == true) wifiLock?.release() }
        runCatching { if (cpuWakeLock?.isHeld == true) cpuWakeLock?.release() }
        wifiLock = null
        cpuWakeLock = null
    }

    private fun startTestProcessInternal() {
        if (nativeHandle != 0L && NativeJvmLauncher.processState(nativeHandle) in 0..1) return
        lastOutput = ""
        publishedOutput = ""
        consoleLogFile = null
        val runtimeRoot = findRuntimeRoot(17) ?: run {
            lastOutput = "Java 17 runtime is not installed"
            updateNotification(lastOutput)
            return
        }
        val libraryDirs = collectNativeDirectories(runtimeRoot)
        if (libraryDirs.isEmpty()) {
            lastOutput = "Java runtime has no native libraries"
            updateNotification(lastOutput)
            return
        }
        val version = NativeJvmLauncher.launchDirect(arrayOf("java", "-version"), libraryDirs.toTypedArray())
        if (!version.startsWith("__MSC_EXIT__:0")) {
            lastOutput = version
            updateNotification("Java runtime failed")
            return
        }
        val probe = copyProbeJar()
        nativeHandle = NativeJvmLauncher.startProcess(
            probe.absolutePath,
            "MscProcessProbe",
            filesDir.absolutePath,
            emptyArray(),
            libraryDirs.toTypedArray(),
        )
        if (nativeHandle == 0L) {
            lastOutput = "Could not start Java host process"
            updateNotification(lastOutput)
            return
        }
        lastPid = NativeJvmLauncher.processPid(nativeHandle)
        lastState = NativeJvmLauncher.processState(nativeHandle)
        publishedPid = lastPid
        publishedState = lastState
        updateNotification("Java host is running")
    }

    private fun startInstalledServerInternal(serverId: String) {
        if (serverId.isBlank()) return
        if (nativeHandle != 0L && NativeJvmLauncher.processState(nativeHandle) in 0..1) return
        lastOutput = ""
        publishedOutput = ""
        val serverDirectory = File(filesDir, "MinecraftServerCustomizer/servers/$serverId")
        val registration = File(serverDirectory, "server.json")
        if (!registration.isFile) {
            lastOutput = "Server $serverId is not installed"
            publishedServerStatus = "OFFLINE"
            updateNotification(lastOutput)
            return
        }
        consoleLogFile = prepareConsoleLogFile(serverDirectory, serverId)
        val registrationJson = try { JSONObject(registration.readText()) } catch (_: Exception) { JSONObject() }
        val requiredJava = registrationJavaMajor(registrationJson)
        publishedServerId = serverId
        val launch = registrationJson.optJSONObject("launch")
        val launchClasspath = jsonStringList(launch?.optJSONArray("classpath"))
        val configuredJar = resolveLaunchJar(serverDirectory, launch?.optString("jar", "server.jar") ?: "server.jar")
        val launchJar = if (configuredJar.isFile) configuredJar
            else launchClasspath.firstOrNull()?.let { resolveLaunchJar(serverDirectory, it) } ?: configuredJar
        if (!launchJar.isFile) {
            publishDiagnostic("Server $serverId has no runnable JAR or translated launch descriptor")
            publishedServerStatus = "OFFLINE"
            updateNotification(lastOutput)
            return
        }
        val runtimeRoot = findRuntimeRoot(requiredJava) ?: run {
            publishedServerStatus = "CRASHED"
            publishDiagnostic("Java $requiredJava runtime is required for Minecraft ${registrationJson.optString("version", "this server")} but is not installed")
            updateNotification(lastOutput)
            return
        }
        val libraryDirs = collectNativeDirectories(runtimeRoot)
        publishedServerStatus = "STARTING"
        persistPublishedState()
        acquireHostingLocks()
        val ramMb = registrationRamMb(registration)
        val jvmArgs = jsonStringList(launch?.optJSONArray("jvmArgs"))
        val serverArgs = if (launch != null && launch.has("serverArgs")) jsonStringList(launch.optJSONArray("serverArgs")) else listOf("nogui")
        val mainClass = launch?.optString("mainClass", "") ?: ""
        val classpath = launchClasspath.mapNotNull { path ->
            val raw = path.replace('/', File.separatorChar)
            if (raw.endsWith("${File.separator}*") || raw == "*") {
                val directory = File(serverDirectory, raw.removeSuffix("${File.separator}*").removeSuffix("*")).canonicalFile
                if (isWithinServerDirectory(serverDirectory, directory)) "${directory.path}${File.separator}*" else null
            } else {
                val entry = resolveLaunchJar(serverDirectory, path)
                if (isWithinServerDirectory(serverDirectory, entry)) entry.path else null
            }
        }
        val tempDirectory = File(serverDirectory, "tmp")
        tempDirectory.mkdirs()
        NativeJvmLauncher.setWorkingDirectory(serverDirectory.absolutePath)
        updateNotification("Starting ${registrationFlavor(registration)} ${registrationVersion(registration)} with ${ramMb} MB heap…")
        // The native launcher consumes these options when it creates the
        // embedded JVM. They are deliberately conservative: Xms is never the
        // full allocation, leaving Android room for the app and OS.
        val vmOptions = mutableListOf("java", "-Xms512m", "-Xmx${ramMb}m")
        vmOptions.addAll(jvmArgs)
        vmOptions.add("-version")
        val version = NativeJvmLauncher.launchDirect(vmOptions.toTypedArray(), libraryDirs.toTypedArray())
        if (!version.startsWith("__MSC_EXIT__:0")) {
            publishedServerStatus = "CRASHED"
            publishDiagnostic(version)
            releaseHostingLocks()
            updateNotification("Java runtime failed")
            return
        }
        val processArguments = mutableListOf(launchJar.absolutePath, "--msc-main=$mainClass", "--msc-classpath=${classpath.joinToString(File.pathSeparator)}")
        processArguments.addAll(serverArgs)
        nativeHandle = NativeJvmLauncher.startProcess(
            copyProbeJar().absolutePath,
            "MscServerLauncher",
            serverDirectory.absolutePath,
            processArguments.toTypedArray(),
            libraryDirs.toTypedArray(),
        )
        if (nativeHandle == 0L) {
            publishedServerStatus = "CRASHED"
            publishDiagnostic("Could not start Minecraft server")
            releaseHostingLocks()
            updateNotification(lastOutput)
            return
        }
        lastPid = NativeJvmLauncher.processPid(nativeHandle)
        publishedPid = lastPid
        monitorServer(nativeHandle, serverDirectory)
    }

    private fun registrationVersion(file: File): String = try {
        JSONObject(file.readText()).optString("version", "Vanilla")
    } catch (_: Exception) { "Vanilla" }

    private fun registrationFlavor(file: File): String = try {
        JSONObject(file.readText()).optString("flavor", JSONObject(file.readText()).optString("type", "vanilla"))
    } catch (_: Exception) { "vanilla" }

    private fun registrationRamMb(file: File): Int = try {
        JSONObject(file.readText()).optInt("ramMb", 1024).coerceIn(512, 8192)
    } catch (_: Exception) { 1024 }

    private fun jsonStringList(array: org.json.JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index -> array.optString(index, null) }
    }

    private fun resolveLaunchJar(serverDirectory: File, relativeOrAbsolute: String): File {
        val raw = relativeOrAbsolute.replace('/', File.separatorChar)
        if (raw.endsWith("${File.separator}*") || raw == "*") {
            val directory = File(serverDirectory, raw.removeSuffix("${File.separator}*")).canonicalFile
            if (!isWithinServerDirectory(serverDirectory, directory)) return File(serverDirectory, "missing.jar")
            return directory.listFiles()?.firstOrNull { it.isFile && it.name.endsWith(".jar") } ?: File(directory, "missing.jar")
        }
        val result = File(serverDirectory, raw).canonicalFile
        return if (isWithinServerDirectory(serverDirectory, result)) result else File(serverDirectory, "missing.jar")
    }

    private fun isWithinServerDirectory(serverDirectory: File, candidate: File): Boolean {
        val root = serverDirectory.canonicalFile.path
        val path = candidate.canonicalFile.path
        return path == root || path.startsWith(root + File.separator)
    }

    private fun monitorServer(handle: Long, serverDirectory: File) {
        executor.execute {
            while (nativeHandle == handle && NativeJvmLauncher.processState(handle) in 0..1) {
                val output = drainOutput()
                val logOutput = serverLogDoneOutput(serverDirectory)
                if (output.contains("Done (") || logOutput != null) {
                    if (logOutput != null && !lastOutput.contains("Done (")) lastOutput += "\n$logOutput"
                    publishedServerStatus = "ONLINE"
                    applyPersistedGamerules(serverDirectory)
                    updateNotification("Minecraft is online")
                }
                Thread.sleep(250L)
            }
            // A failed or very fast process can write its diagnostic just before
            // changing state; collect that final pipe data before publishing CRASHED.
            val finalOutput = drainOutput()
            val finalLogOutput = serverLogDoneOutput(serverDirectory)
            if (finalOutput.contains("Done (") || finalLogOutput != null) {
                if (finalLogOutput != null && !lastOutput.contains("Done (")) lastOutput += "\n$finalLogOutput"
                publishedServerStatus = "ONLINE"
                applyPersistedGamerules(serverDirectory)
                updateNotification("Minecraft is online")
            }
            if (nativeHandle == handle && publishedServerStatus != "STOPPING") {
                val logTail = serverLogTail(serverDirectory)
                if (!logTail.isNullOrBlank()) {
                    lastOutput += "\n--- Minecraft latest.log (tail after process exit) ---\n$logTail"
                    publishedOutput = lastOutput
                }
                publishedServerStatus = "CRASHED"
                updateNotification("Minecraft process exited")
                releaseExitedProcess(handle)
            }
        }
    }

    private fun releaseExitedProcess(handle: Long) {
        synchronized(this) {
            if (nativeHandle != handle || NativeJvmLauncher.processState(handle) in 0..1) return
            // stopProcess joins an already-exited native worker and restores the
            // app's stdout/stderr. Without this, the next WebView diagnostic can
            // be redirected into the closed Minecraft pipe.
            NativeJvmLauncher.stopProcess(handle, true)
            lastState = NativeJvmLauncher.processState(handle)
            publishedState = lastState
            nativeHandle = 0L
            releaseHostingLocks()
        }
    }

    private fun sendInputInternal(input: String): Boolean {
        val handle = nativeHandle
        if (handle == 0L) return false
        return NativeJvmLauncher.writeProcessInput(handle, input) == 0
    }

    private fun stopInternal(force: Boolean) {
        synchronized(this) {
            val handle = nativeHandle
            if (handle == 0L) return
            publishedServerStatus = if (force) "OFFLINE" else "STOPPING"
            NativeJvmLauncher.stopProcess(handle, force)
            if (!force) {
                val deadline = System.currentTimeMillis() + 5_000L
                while (NativeJvmLauncher.processState(handle) in 0..1 && System.currentTimeMillis() < deadline) {
                    drainOutput()
                    Thread.sleep(50L)
                }
                if (NativeJvmLauncher.processState(handle) in 0..1) {
                    NativeJvmLauncher.stopProcess(handle, true)
                }
            }
            lastOutput += drainOutput()
            lastState = NativeJvmLauncher.processState(handle)
            publishedState = lastState
            publishedOutput = lastOutput
            publishedServerStatus = "OFFLINE"
            nativeHandle = 0L
            releaseHostingLocks()
            updateNotification(if (force) "Java host force-stopped" else "Java host stopped")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun drainOutput(): String {
        val handle = nativeHandle
        if (handle == 0L) return ""
        val output = NativeJvmLauncher.readProcessOutput(handle)
        val filtered = sanitizeProcessOutput(output)
        if (filtered.isNotEmpty()) {
            appendCapturedConsole(filtered)
            lastOutput += filtered
            // Publish incrementally so the Capacitor console can poll while
            // the service is still running, rather than waiting for stop().
            publishedOutput = lastOutput
            persistPublishedState()
        }
        return filtered
    }

    private fun prepareConsoleLogFile(serverDirectory: File, serverId: String): File? {
        return try {
            val logsDirectory = File(serverDirectory, "logs")
            if (!logsDirectory.exists() && !logsDirectory.mkdirs()) return null
            if (!logsDirectory.isDirectory) return null
            val file = File(logsDirectory, "mobile-console.log")
            file.writeText(
                "=== Mobile captured console: $serverId (${System.currentTimeMillis()}) ===\n",
                Charsets.UTF_8,
            )
            file
        } catch (_: Exception) {
            null
        }
    }

    private fun appendCapturedConsole(output: String) {
        if (output.isEmpty()) return
        val file = consoleLogFile ?: return
        synchronized(consoleLogLock) {
            try {
                file.parentFile?.mkdirs()
                file.appendText(output, Charsets.UTF_8)
                if (file.length() > MAX_CAPTURED_CONSOLE_BYTES) {
                    val tail = file.readText(Charsets.UTF_8).takeLast(MAX_CAPTURED_CONSOLE_BYTES.toInt())
                    file.writeText("=== Earlier captured console omitted; showing most recent output ===\n$tail", Charsets.UTF_8)
                }
            } catch (_: Exception) {
                // Console persistence must never interrupt the hosting process.
            }
        }
    }

    private fun publishDiagnostic(message: String) {
        val filtered = sanitizeProcessOutput(message)
        lastOutput = filtered
        publishedOutput = filtered
        appendCapturedConsole(if (filtered.endsWith("\n")) filtered else "$filtered\n")
        persistPublishedState()
    }

    private fun serverLogDoneOutput(serverDirectory: File): String? {
        return serverLogTail(serverDirectory)?.takeIf { it.contains("Done (") }
    }

    private fun serverLogTail(serverDirectory: File): String? {
        val log = File(serverDirectory, "logs/latest.log")
        return try {
            if (!log.isFile) return null
            val contents = log.readText()
            if (contents.isBlank()) null else contents.takeLast(16_384)
        } catch (_: Exception) { null }
    }

    private fun sanitizeProcessOutput(output: String?): String {
        if (output.isNullOrEmpty()) return ""
        if (!output.contains("third_party/crashpad") && !output.contains("Unknown scheduling policy")) return output
        val hadTrailingNewline = output.endsWith("\n")
        val filtered = output.lineSequence()
            .filterNot { line ->
                line.contains("third_party/crashpad/crashpad/snapshot/linux/thread_snapshot_linux.cc") ||
                    line.contains("Unknown scheduling policy 1073741824")
            }
            .joinToString("\n")
        return if (hadTrailingNewline && filtered.isNotEmpty()) "$filtered\n" else filtered
    }

    private fun applyPersistedGamerules(serverDirectory: File) {
        val rules = File(serverDirectory, "gamerules.properties")
        if (!rules.isFile) return
        rules.forEachLine(Charsets.UTF_8) { line ->
            val separator = line.indexOf('=')
            if (separator > 0) sendInputInternal("gamerule ${line.substring(0, separator).trim()} ${line.substring(separator + 1).trim()}\n")
        }
    }

    private fun findRuntimeRoot(javaMajor: Int): File? {
        val root = File(filesDir, "MinecraftServerCustomizer/runtimes")
        return listOf(File(root, "java$javaMajor"), File(root, "java$javaMajor.partial"))
            .firstOrNull { File(it, "lib/server/libjvm.so").isFile }
    }

    private fun registrationJavaMajor(registration: JSONObject): Int {
        val declared = registration.optInt("javaMajor", 17).takeIf { it in setOf(8, 17, 21, 25) } ?: 17
        val version = registration.optString("version", "")
        val numeric = Regex("^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?").find(version)
        val major = numeric?.groupValues?.getOrNull(1)?.toIntOrNull()
        val minor = numeric?.groupValues?.getOrNull(2)?.toIntOrNull() ?: 0
        val patch = numeric?.groupValues?.getOrNull(3)?.toIntOrNull() ?: 0
        val inferred = when {
            major == null -> declared
            major >= 26 -> 25
            major > 1 -> 25
            minor > 20 || (minor == 20 && patch >= 5) -> 21
            minor >= 17 -> 17
            else -> 8
        }
        return maxOf(declared, inferred)
    }

    private fun collectNativeDirectories(root: File): List<String> {
        val result = mutableListOf<String>()
        root.walkTopDown().filter { it.isDirectory && it.listFiles()?.any { child -> child.isFile && child.name.endsWith(".so") } == true }
            .forEach { result += it.absolutePath }
        return result.distinct()
    }

    private fun copyProbeJar(): File {
        val destination = File(filesDir, "minimal-process.jar")
        assets.open("minimal-process.jar").use { input ->
            FileOutputStream(destination).use { output -> input.copyTo(output) }
        }
        return destination
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Minecraft hosting", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private fun notification(text: String): Notification {
        val stopIntent = PendingIntent.getService(
            this, 2, Intent(this, HostingForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Minecraft Server Customizer")
            .setContentText(text)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopIntent)
            .build()
    }

    private fun updateNotification(text: String) {
        persistPublishedState()
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification(text))
    }

    private fun persistPublishedState() {
        val handle = nativeHandle
        if (handle != 0L) {
            lastState = NativeJvmLauncher.processState(handle)
            lastPid = NativeJvmLauncher.processPid(handle)
            publishedState = lastState
            publishedPid = lastPid
        }
        HostingStateStore.write(
            this,
            HostingStateStore.Snapshot(
                state = publishedState,
                pid = publishedPid,
                output = publishedOutput,
                serverStatus = publishedServerStatus,
                serverId = publishedServerId,
            ),
        )
    }
}

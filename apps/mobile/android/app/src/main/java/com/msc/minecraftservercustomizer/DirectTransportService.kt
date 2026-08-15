package com.msc.minecraftservercustomizer

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.math.min

/**
 * Isolated foreground-service client for the Phase 22A service-free topology.
 * It intentionally does not touch the Minecraft process or expose a generic proxy.
 */
class DirectTransportService : Service() {
    companion object {
        const val ACTION_START = "com.msc.minecraftservercustomizer.action.START_DIRECT_TRANSPORT_TEST"
        const val ACTION_STOP = "com.msc.minecraftservercustomizer.action.STOP_DIRECT_TRANSPORT_TEST"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_FINGERPRINT = "fingerprint"
        const val EXTRA_DURATION_SECONDS = "durationSeconds"
        const val EXTRA_PAYLOAD_BYTES = "payloadBytes"
        private const val CHANNEL_ID = "direct-transport-test"
        private const val NOTIFICATION_ID = 4201
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val stopRequested = AtomicBoolean(false)
    @Volatile private var activeSocket: SSLSocket? = null
    @Volatile private var activeTask: Future<*>? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startTest(intent)
            ACTION_STOP -> stopTest("Stopped by user")
        }
        return START_NOT_STICKY
    }

    private fun startTest(intent: Intent) {
        if (activeTask?.isDone == false) return
        val config = runCatching {
            DirectTransportProtocol.validate(
                intent.getStringExtra(EXTRA_HOST),
                intent.getIntExtra(EXTRA_PORT, DirectTransportProtocol.DEFAULT_PORT),
                intent.getStringExtra(EXTRA_TOKEN),
                intent.getStringExtra(EXTRA_FINGERPRINT),
                intent.getIntExtra(EXTRA_DURATION_SECONDS, DirectTransportProtocol.DEFAULT_DURATION_SECONDS),
                intent.getIntExtra(EXTRA_PAYLOAD_BYTES, DirectTransportProtocol.DEFAULT_PAYLOAD_BYTES),
            )
        }.getOrElse { error ->
            DirectTransportStateStore.write(this, DirectTransportStateStore.Snapshot(
                status = "FAILED",
                message = error.message ?: "Invalid direct transport configuration",
                completedAt = System.currentTimeMillis(),
            ))
            stopSelf()
            return
        }

        stopRequested.set(false)
        promoteToForeground("Preparing direct TLS transport…")
        acquireWakeLock(config.durationSeconds)
        val startedAt = System.currentTimeMillis()
        publish(DirectTransportStateStore.Snapshot(
            status = "STARTING",
            host = config.host,
            port = config.port,
            message = "Starting certificate-pinned TLS 1.3 test",
            startedAt = startedAt,
            certificateFingerprint = config.fingerprint,
        ))
        activeTask = executor.submit { runTest(config, startedAt) }
    }

    private fun runTest(config: DirectTransportProtocol.Config, startedAt: Long) {
        val deadline = startedAt + config.durationSeconds * 1000L
        var snapshot = DirectTransportStateStore.Snapshot(
            status = "CONNECTING",
            host = config.host,
            port = config.port,
            message = "Connecting to ${config.host}:${config.port}",
            startedAt = startedAt,
            certificateFingerprint = config.fingerprint,
        )
        publish(snapshot)
        var backoffMs = 1_000L
        var hadConnection = false

        try {
            while (!stopRequested.get() && System.currentTimeMillis() < deadline) {
                try {
                    val socket = connect(config)
                    activeSocket = socket
                    hadConnection = true
                    backoffMs = 1_000L
                    socket.use { connected ->
                        val input = DataInputStream(connected.inputStream.buffered())
                        val output = DataOutputStream(connected.outputStream.buffered())
                        DirectTransportProtocol.writeAuthentication(output, config.token)
                        DirectTransportProtocol.requireAuthenticationAccepted(input)
                        snapshot = snapshot.copy(
                            status = "RUNNING",
                            message = "Direct TLS 1.3 path is active",
                            tlsProtocol = connected.session.protocol,
                        )
                        publish(snapshot)
                        updateNotification("Direct transport connected")

                        while (!stopRequested.get() && System.currentTimeMillis() < deadline) {
                            val payload = DirectTransportProtocol.testPayload(config.payloadBytes, snapshot.probes)
                            val startedProbe = System.nanoTime()
                            DirectTransportProtocol.writeFrame(output, payload)
                            val echoed = DirectTransportProtocol.readFrame(input)
                            require(echoed.contentEquals(payload)) { "The PC listener returned different test bytes" }
                            val rttMs = (System.nanoTime() - startedProbe) / 1_000_000L
                            snapshot = snapshot.copy(
                                status = "RUNNING",
                                message = "Probe ${snapshot.probes + 1} passed",
                                probes = snapshot.probes + 1,
                                bytesSent = snapshot.bytesSent + payload.size,
                                bytesReceived = snapshot.bytesReceived + echoed.size,
                                lastRttMs = rttMs,
                                tlsProtocol = connected.session.protocol,
                            )
                            publish(snapshot)
                            sleepUntilNextProbe(deadline, 2_000L)
                        }
                    }
                    activeSocket = null
                } catch (error: Exception) {
                    activeSocket = null
                    if (stopRequested.get() || System.currentTimeMillis() >= deadline) break
                    if (isPermanentFailure(error)) {
                        snapshot = snapshot.copy(
                            status = "FAILED",
                            message = conciseError(error),
                            completedAt = System.currentTimeMillis(),
                        )
                        publish(snapshot)
                        break
                    }
                    snapshot = snapshot.copy(
                        status = if (hadConnection) "RECONNECTING" else "CONNECTING",
                        message = conciseError(error),
                        reconnects = snapshot.reconnects + if (hadConnection) 1 else 0,
                    )
                    publish(snapshot)
                    updateNotification(if (hadConnection) "Direct transport reconnecting…" else "Direct transport connecting…")
                    sleepUntilNextProbe(deadline, backoffMs)
                    backoffMs = min(backoffMs * 2L, 15_000L)
                }
            }

            if (!stopRequested.get()) {
                val completed = snapshot.probes > 0
                snapshot = snapshot.copy(
                    status = if (completed) "COMPLETE" else "FAILED",
                    message = if (completed) {
                        "Completed ${snapshot.probes} authenticated echo probes"
                    } else {
                        "The test ended without completing an authenticated echo probe"
                    },
                    completedAt = System.currentTimeMillis(),
                )
                publish(snapshot)
            }
        } finally {
            activeSocket = null
            releaseWakeLock()
            stopForegroundCompat()
            stopSelf()
        }
    }

    private fun connect(config: DirectTransportProtocol.Config): SSLSocket {
        val trustManager = FingerprintTrustManager(config.fingerprint)
        val sslContext = SSLContext.getInstance("TLSv1.3").apply {
            init(null, arrayOf(trustManager), SecureRandom())
        }
        val rawSocket = Socket()
        rawSocket.tcpNoDelay = true
        rawSocket.connect(InetSocketAddress(config.host, config.port), 10_000)
        val socket = sslContext.socketFactory.createSocket(rawSocket, config.host, config.port, true) as SSLSocket
        socket.enabledProtocols = arrayOf("TLSv1.3")
        socket.soTimeout = 15_000
        socket.startHandshake()
        require(socket.session.protocol == "TLSv1.3") { "The listener did not negotiate TLS 1.3" }
        val certificate = socket.session.peerCertificates.firstOrNull() as? X509Certificate
            ?: throw CertificateException("The listener did not provide an X.509 certificate")
        require(DirectTransportProtocol.certificateFingerprint(certificate) == config.fingerprint) {
            "The listener certificate changed after verification"
        }
        return socket
    }

    private fun sleepUntilNextProbe(deadline: Long, requestedMs: Long) {
        var remaining = min(requestedMs, (deadline - System.currentTimeMillis()).coerceAtLeast(0L))
        while (!stopRequested.get() && remaining > 0L) {
            val slice = min(remaining, 250L)
            Thread.sleep(slice)
            remaining -= slice
        }
    }

    private fun conciseError(error: Exception): String {
        val detail = generateSequence(error as Throwable?) { it.cause }.lastOrNull()?.message
            ?: error.message
            ?: error.javaClass.simpleName
        return "Connection failed: ${detail.take(240)}"
    }

    private fun isPermanentFailure(error: Exception): Boolean {
        val causes = generateSequence(error as Throwable?) { it.cause }.toList()
        if (causes.any { it is CertificateException }) return true
        val combined = causes.mapNotNull { cause -> cause.message }.joinToString(" ").lowercase()
        return "rejected the test token" in combined ||
            "returned different test bytes" in combined ||
            "did not negotiate tls 1.3" in combined ||
            "invalid inbound frame" in combined
    }

    private fun publish(snapshot: DirectTransportStateStore.Snapshot) {
        DirectTransportStateStore.write(this, snapshot.copy(updatedAt = System.currentTimeMillis()))
    }

    private fun stopTest(message: String) {
        stopRequested.set(true)
        runCatching { activeSocket?.close() }
        val previous = DirectTransportStateStore.read(this)
        if (previous.active) {
            publish(previous.copy(status = "STOPPED", message = message, completedAt = System.currentTimeMillis()))
        }
        releaseWakeLock()
        stopForegroundCompat()
        stopSelf()
    }

    override fun onDestroy() {
        stopRequested.set(true)
        runCatching { activeSocket?.close() }
        activeTask?.cancel(true)
        releaseWakeLock()
        executor.shutdownNow()
        super.onDestroy()
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock(durationSeconds: Int) {
        val manager = getSystemService(PowerManager::class.java) ?: return
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:phase22a-direct-transport").apply {
            setReferenceCounted(false)
            acquire((durationSeconds + 120L) * 1000L)
        }
    }

    private fun releaseWakeLock() {
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        wakeLock = null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(NotificationChannel(
            CHANNEL_ID,
            "Direct transport test",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "Phase 22A background connectivity feasibility" })
    }

    private fun promoteToForeground(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification(text))
        }
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification(text))
    }

    private fun notification(text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val openPending = PendingIntent.getActivity(
            this,
            10,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopPending = PendingIntent.getService(
            this,
            11,
            Intent(this, DirectTransportService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("MSC direct transport test")
            .setContentText(text)
            .setContentIntent(openPending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "Stop", stopPending)
            .build()
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else @Suppress("DEPRECATION") stopForeground(true)
    }

    private class FingerprintTrustManager(expectedFingerprint: String) : X509TrustManager {
        private val expected = expectedFingerprint

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("Client certificate validation is not used by the Phase 22A client")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val certificate = chain?.firstOrNull() ?: throw CertificateException("The listener did not provide a certificate")
            val actual = DirectTransportProtocol.certificateFingerprint(certificate)
            if (actual != expected) throw CertificateException("Certificate fingerprint mismatch: received $actual")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}

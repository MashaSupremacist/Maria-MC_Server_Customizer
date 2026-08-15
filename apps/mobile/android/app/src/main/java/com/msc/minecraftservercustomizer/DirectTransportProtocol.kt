package com.msc.minecraftservercustomizer

import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.security.cert.X509Certificate

/** Small, versioned protocol used only by the Phase 22A direct-path harness. */
object DirectTransportProtocol {
    const val TRANSPORT = "tls-tcp"
    const val DEFAULT_PORT = 44333
    const val DEFAULT_DURATION_SECONDS = 60
    const val DEFAULT_PAYLOAD_BYTES = 64 * 1024
    const val MAX_FRAME_BYTES = 1024 * 1024
    val MAGIC: ByteArray = "MSC22A01".toByteArray(Charsets.US_ASCII)

    data class Config(
        val host: String,
        val port: Int,
        val token: String,
        val fingerprint: String,
        val durationSeconds: Int,
        val payloadBytes: Int,
    )

    fun validate(
        rawHost: String?,
        port: Int?,
        rawToken: String?,
        rawFingerprint: String?,
        durationSeconds: Int?,
        payloadBytes: Int?,
    ): Config {
        val host = rawHost.orEmpty().trim().removeSurrounding("[", "]")
        require(host.isNotBlank()) { "A PC host or IP address is required" }
        require(host.length <= 253 && host.none(Char::isWhitespace) && '/' !in host && "://" !in host) {
            "Enter only the PC hostname or IP address, without a URL scheme or path"
        }
        val validatedPort = port ?: DEFAULT_PORT
        require(validatedPort in 1..65535) { "The listener port must be between 1 and 65535" }
        val token = rawToken.orEmpty()
        val tokenBytes = token.toByteArray(Charsets.UTF_8)
        require(tokenBytes.size in 16..4096) { "The listener token must be between 16 and 4096 UTF-8 bytes" }
        val fingerprint = normalizeFingerprint(rawFingerprint.orEmpty())
        val validatedDuration = durationSeconds ?: DEFAULT_DURATION_SECONDS
        require(validatedDuration in 10..1800) { "Test duration must be between 10 and 1800 seconds" }
        val validatedPayload = payloadBytes ?: DEFAULT_PAYLOAD_BYTES
        require(validatedPayload in 1..MAX_FRAME_BYTES) { "Payload must be between 1 and $MAX_FRAME_BYTES bytes" }
        return Config(host, validatedPort, token, fingerprint, validatedDuration, validatedPayload)
    }

    fun normalizeFingerprint(value: String): String {
        val normalized = value.filterNot { it == ':' || it.isWhitespace() }.uppercase()
        require(normalized.length == 64 && normalized.all { it in '0'..'9' || it in 'A'..'F' }) {
            "The certificate SHA-256 fingerprint must contain exactly 64 hexadecimal characters"
        }
        return normalized
    }

    fun writeAuthentication(output: DataOutputStream, token: String) {
        val tokenBytes = token.toByteArray(Charsets.UTF_8)
        require(tokenBytes.size in 16..4096) { "Invalid authentication token length" }
        output.write(MAGIC)
        output.writeShort(tokenBytes.size)
        output.write(tokenBytes)
        output.flush()
    }

    fun requireAuthenticationAccepted(input: DataInputStream) {
        require(input.readUnsignedByte() == 1) { "The PC listener rejected the test token" }
    }

    fun writeFrame(output: DataOutputStream, payload: ByteArray) {
        require(payload.size in 1..MAX_FRAME_BYTES) { "Invalid outbound frame length ${payload.size}" }
        output.writeInt(payload.size)
        output.write(payload)
        output.flush()
    }

    fun readFrame(input: DataInputStream): ByteArray {
        val length = input.readInt()
        require(length in 1..MAX_FRAME_BYTES) { "Invalid inbound frame length $length" }
        return ByteArray(length).also(input::readFully)
    }

    fun testPayload(size: Int, probe: Long): ByteArray {
        require(size in 1..MAX_FRAME_BYTES)
        return ByteArray(size) { index -> ((index.toLong() + probe) % 251L).toByte() }
    }

    fun certificateFingerprint(certificate: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString(separator = "") { byte -> "%02X".format(byte.toInt() and 0xff) }
}

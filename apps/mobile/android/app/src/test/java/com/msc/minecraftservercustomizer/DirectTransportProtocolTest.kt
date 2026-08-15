package com.msc.minecraftservercustomizer

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DirectTransportProtocolTest {
    private val fingerprint = "A1:".repeat(31) + "A1"

    @Test
    fun validatesAndNormalizesConfiguration() {
        val config = DirectTransportProtocol.validate(
            "[2001:db8::1]",
            44333,
            "1234567890abcdef",
            fingerprint,
            60,
            65_537,
        )
        assertEquals("2001:db8::1", config.host)
        assertEquals("A1".repeat(32), config.fingerprint)
        assertEquals(65_537, config.payloadBytes)
    }

    @Test
    fun rejectsUrlsAndShortTokens() {
        assertThrows(IllegalArgumentException::class.java) {
            DirectTransportProtocol.validate("https://example.com", 44333, "1234567890abcdef", fingerprint, 60, 1024)
        }
        assertThrows(IllegalArgumentException::class.java) {
            DirectTransportProtocol.validate("example.com", 44333, "short", fingerprint, 60, 1024)
        }
    }

    @Test
    fun writesVersionedAuthenticationAndBoundedFrames() {
        val outputBytes = ByteArrayOutputStream()
        val output = DataOutputStream(outputBytes)
        DirectTransportProtocol.writeAuthentication(output, "1234567890abcdef")
        val input = DataInputStream(ByteArrayInputStream(outputBytes.toByteArray()))
        assertArrayEquals(DirectTransportProtocol.MAGIC, ByteArray(8).also(input::readFully))
        val tokenBytes = ByteArray(input.readUnsignedShort()).also(input::readFully)
        assertEquals("1234567890abcdef", tokenBytes.toString(Charsets.UTF_8))

        val payload = DirectTransportProtocol.testPayload(65_537, 7)
        outputBytes.reset()
        DirectTransportProtocol.writeFrame(output, payload)
        val frameInput = DataInputStream(ByteArrayInputStream(outputBytes.toByteArray()))
        assertArrayEquals(payload, DirectTransportProtocol.readFrame(frameInput))
    }
}

package com.msc.minecraftservercustomizer

import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Read-only Phase 21 diagnostics. Tunnel authentication and lifecycle belong
 * to the Phase 22 integration after ARM64 verification.
 */
@CapacitorPlugin(name = "PlayitResearch")
class PlayitResearchPlugin : Plugin() {
    companion object {
        private const val RELEASE = "v1.0.10"
        private const val RELEASE_BASE =
            "https://github.com/playit-cloud/playit-agent/releases/download/$RELEASE"
    }

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        val abi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty()
        val asset = assetForAbi(abi)
        val agentFile = File(context.filesDir, "MinecraftServerCustomizer/playit/playit")
        val result = JSObject()
        result.put("status", "research-only")
        result.put("release", RELEASE)
        result.put("abi", abi)
        result.put("asset", asset)
        result.put("downloadUrl", asset?.let { "$RELEASE_BASE/$it" })
        result.put("architectureSupported", asset != null)
        result.put("executionMode", "app-private-process")
        result.put("defaultPathsCompatible", false)
        result.put("secretRequired", true)
        result.put("agentPrepared", agentFile.isFile && agentFile.canExecute())
        result.put("integrationReady", false)
        result.put(
            "message",
            if (asset == null) "No official Playit Linux asset matches this ABI."
            else "Official $asset is the candidate for this device; Phase 22 still requires authenticated tunnel testing.",
        )
        call.resolve(result)
    }

    private fun assetForAbi(abi: String): String? = when (abi) {
        "arm64-v8a" -> "playit-linux-aarch64"
        "armeabi-v7a" -> "playit-linux-armv7"
        "x86_64" -> "playit-linux-amd64"
        "x86" -> "playit-linux-i686"
        else -> null
    }
}

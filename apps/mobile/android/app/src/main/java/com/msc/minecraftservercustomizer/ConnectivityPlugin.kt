package com.msc.minecraftservercustomizer

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.ServerSocket

/** Reports the address a Minecraft client on the local network can use. */
@CapacitorPlugin(name = "Connectivity")
class ConnectivityPlugin : Plugin() {
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val serverId = call.getString("serverId").orEmpty()
        val properties = if (serverId.isBlank()) emptyMap() else readProperties(serverId)
        val configuredPort = properties["server-port"]?.toIntOrNull() ?: 25565
        val requestedPort = call.getInt("port") ?: configuredPort
        val port = requestedPort.coerceIn(1, 65535)
        val network = networkSnapshot()
        val hostingThisServer = HostingStateStore.read(context).isActiveFor(serverId)
        val portAvailable = hostingThisServer || canBindPort(port)
        val portConflict = network.connected && !hostingThisServer && !portAvailable
        val localIp = network.localIp

        val result = JSObject()
        result.put("localIp", localIp)
        result.put("serverPort", port)
        result.put("lanAddress", if (localIp.isNullOrBlank()) null else "$localIp:$port")
        result.put("networkConnected", network.connected)
        result.put("wifiConnected", network.wifi)
        result.put("networkType", network.type)
        result.put("portAvailable", portAvailable)
        result.put("portConflict", portConflict)
        result.put("serverId", serverId)
        call.resolve(result)
    }

    private fun readProperties(serverId: String): Map<String, String> {
        val root = File(context.filesDir, "MinecraftServerCustomizer/servers/$serverId")
        val file = File(root, "server.properties")
        if (!file.isFile) return emptyMap()
        return runCatching {
            file.readLines(Charsets.UTF_8).mapNotNull { line ->
                val clean = line.trim()
                if (clean.isBlank() || clean.startsWith("#")) return@mapNotNull null
                val separator = clean.indexOf('=')
                if (separator <= 0) return@mapNotNull null
                clean.substring(0, separator).trim() to clean.substring(separator + 1).trim()
            }.toMap()
        }.getOrDefault(emptyMap())
    }

    private data class NetworkSnapshot(
        val connected: Boolean,
        val wifi: Boolean,
        val type: String,
        val localIp: String?,
    )

    private fun networkSnapshot(): NetworkSnapshot {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return NetworkSnapshot(false, false, "offline", null)
        val active = manager.activeNetwork
        val capabilities = active?.let(manager::getNetworkCapabilities)
        val connected = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val wifi = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val type = when {
            !connected -> "offline"
            wifi -> "wifi"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "ethernet"
            else -> "other"
        }
        val address = active?.let(manager::getLinkProperties)?.linkAddresses
            ?.map { it.address }
            ?.filterIsInstance<Inet4Address>()
            ?.firstOrNull { !it.isLoopbackAddress }
            ?.hostAddress
        return NetworkSnapshot(connected, wifi, type, address)
    }

    private fun canBindPort(port: Int): Boolean = runCatching {
        ServerSocket().use { socket ->
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(port))
        }
        true
    }.getOrDefault(false)
}

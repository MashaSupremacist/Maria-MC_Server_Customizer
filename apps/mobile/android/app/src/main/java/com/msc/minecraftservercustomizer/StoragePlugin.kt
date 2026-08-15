package com.msc.minecraftservercustomizer

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

@CapacitorPlugin(name = "Storage")
class StoragePlugin : Plugin() {
    private val storageFolderName = "MinecraftServerCustomizer"

    @PluginMethod
    fun getStorageLayout(call: PluginCall) {
        try {
            val directories = managedDirectories()
            directories.values.forEach { directory ->
                if (!directory.exists() && !directory.mkdirs()) {
                    throw IOException("Could not create ${directory.absolutePath}")
                }
            }
            val result = JSObject()
            directories.forEach { (name, directory) -> result.put(name, directory.absolutePath) }
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not initialize managed storage")
        }
    }

    @PluginMethod
    fun createServerDirectory(call: PluginCall) {
        val serverId = call.getString("serverId")
        if (!isSafeServerId(serverId)) {
            call.reject("Server ID must contain only letters, numbers, dots, underscores, or hyphens")
            return
        }

        try {
            val target = resolveManagedPath("servers/$serverId")
            val existed = target.exists()
            if (!existed && !target.mkdirs()) throw IOException("Could not create server directory")
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("path", target.absolutePath)
                put("existed", existed)
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not create server directory")
        }
    }

    @PluginMethod
    fun deleteServerDirectory(call: PluginCall) {
        val serverId = call.getString("serverId")
        if (!isSafeServerId(serverId)) {
            call.reject("Invalid server ID")
            return
        }

        try {
            val target = resolveManagedPath("servers/$serverId")
            val existed = target.exists()
            if (existed && !target.deleteRecursively()) throw IOException("Could not delete server directory")
            call.resolve(JSObject().apply {
                put("serverId", serverId)
                put("deleted", existed)
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not delete server directory")
        }
    }

    @PluginMethod
    fun writeTestFile(call: PluginCall) {
        val relativePath = call.getString("relativePath")
        val content = call.getString("content") ?: ""
        if (relativePath.isNullOrBlank()) {
            call.reject("A relative path is required")
            return
        }

        try {
            val target = resolveManagedPath(relativePath)
            if (target == managedRoot()) throw IOException("A file path is required")
            target.parentFile?.mkdirs()
            target.writeText(content, Charsets.UTF_8)
            call.resolve(fileResult(relativePath, target))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not write managed test file")
        }
    }

    @PluginMethod
    fun validateManagedPath(call: PluginCall) {
        val relativePath = call.getString("relativePath")
        if (relativePath.isNullOrBlank()) {
            call.resolve(JSObject().apply { put("valid", false); put("error", "A relative path is required") })
            return
        }

        try {
            val target = resolveManagedPath(relativePath)
            call.resolve(JSObject().apply {
                put("valid", true)
                put("path", target.absolutePath)
            })
        } catch (error: Exception) {
            call.resolve(JSObject().apply {
                put("valid", false)
                put("error", error.message ?: "Path is outside managed storage")
            })
        }
    }

    @PluginMethod
    fun importFile(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        startActivityForResult(call, intent, "handleImportResult")
    }

    @ActivityCallback
    fun handleImportResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            call.resolve(JSObject().apply {
                put("canceled", true)
                put("relativePath", "")
            })
            return
        }

        val relativePath = call.getString("destinationRelativePath")
            ?: "downloads/imported-${System.currentTimeMillis()}"
        try {
            val target = resolveManagedPath(relativePath)
            target.parentFile?.mkdirs()
            copyUriToFile(result.data!!.data!!, target)
            call.resolve(fileResult(relativePath, target))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not import file into managed storage")
        }
    }

    @PluginMethod
    fun exportFile(call: PluginCall) {
        val relativePath = call.getString("relativePath")
        if (relativePath.isNullOrBlank()) {
            call.reject("A relative path is required")
            return
        }

        try {
            val source = resolveManagedPath(relativePath)
            if (!source.isFile) throw IOException("Managed file does not exist")
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/octet-stream"
                putExtra(Intent.EXTRA_TITLE, source.name)
            }
            startActivityForResult(call, intent, "handleExportResult")
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not prepare managed file export")
        }
    }

    @ActivityCallback
    fun handleExportResult(call: PluginCall, result: ActivityResult) {
        val relativePath = call.getString("relativePath") ?: ""
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            call.resolve(JSObject().apply {
                put("exported", false)
                put("canceled", true)
                put("relativePath", relativePath)
            })
            return
        }

        try {
            val source = resolveManagedPath(relativePath)
            val destination = result.data!!.data!!
            getContext().contentResolver.openOutputStream(destination).use { output ->
                if (output == null) throw IOException("Could not open export destination")
                source.inputStream().use { input -> input.copyTo(output) }
            }
            call.resolve(JSObject().apply {
                put("exported", true)
                put("relativePath", relativePath)
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not export managed file")
        }
    }

    private fun managedRoot(): File = File(getContext().filesDir, storageFolderName).canonicalFile

    private fun managedDirectories(): LinkedHashMap<String, File> {
        val root = managedRoot()
        return linkedMapOf(
            "root" to root,
            "servers" to File(root, "servers"),
            "backups" to File(root, "backups"),
            "runtimes" to File(root, "runtimes"),
            "downloads" to File(root, "downloads"),
            "logs" to File(root, "logs"),
            "appData" to File(root, "app-data"),
        )
    }

    private fun resolveManagedPath(relativePath: String): File {
        val root = managedRoot()
        val target = File(root, relativePath).canonicalFile
        val rootPath = root.absolutePath
        if (target.absolutePath != rootPath && !target.absolutePath.startsWith("$rootPath${File.separator}")) {
            throw SecurityException("Path escapes managed storage")
        }
        return target
    }

    private fun isSafeServerId(serverId: String?): Boolean =
        !serverId.isNullOrBlank() && serverId.matches(Regex("[A-Za-z0-9._-]{1,64}"))

    private fun fileResult(relativePath: String, file: File): JSObject = JSObject().apply {
        put("relativePath", relativePath)
        put("path", file.absolutePath)
        put("bytes", file.length())
    }

    private fun copyUriToFile(uri: Uri, destination: File) {
        getContext().contentResolver.openInputStream(uri).use { input ->
            if (input == null) throw IOException("Could not open selected file")
            FileOutputStream(destination).use { output -> input.copyTo(output) }
        }
    }
}

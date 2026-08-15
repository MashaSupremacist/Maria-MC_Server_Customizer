package com.msc.minecraftservercustomizer

import android.app.ActivityManager
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

@CapacitorPlugin(name = "DeviceInfo")
class DeviceInfoPlugin : Plugin() {
    @PluginMethod
    fun getDeviceInfo(call: PluginCall) {
        val result = JSObject()
        result.put("androidVersion", Build.VERSION.RELEASE ?: "unknown")
        result.put("sdkInt", Build.VERSION.SDK_INT)
        result.put("architecture", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
        result.put("manufacturer", Build.MANUFACTURER ?: "unknown")
        result.put("model", Build.MODEL ?: "unknown")
        call.resolve(result)
    }

    @PluginMethod
    fun getMemoryInfo(call: PluginCall) {
        val memory = ActivityManager.MemoryInfo()
        val manager = getContext().getSystemService(ActivityManager::class.java)
        manager?.getMemoryInfo(memory)

        val result = JSObject()
        result.put("totalBytes", memory.totalMem)
        result.put("availableBytes", memory.availMem)
        result.put("lowMemory", memory.lowMemory)
        call.resolve(result)
    }

    @PluginMethod
    fun getStorageInfo(call: PluginCall) {
        val stat = StatFs(getContext().filesDir.absolutePath)
        val blockSize = stat.blockSizeLong

        val result = JSObject()
        result.put("totalBytes", stat.blockCountLong * blockSize)
        result.put("availableBytes", stat.availableBlocksLong * blockSize)
        call.resolve(result)
    }

    @PluginMethod
    fun getSafetyInfo(call: PluginCall) {
        val context = getContext()
        val memory = ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java)?.getMemoryInfo(memory)
        val stat = StatFs(context.filesDir.absolutePath)
        val blockSize = stat.blockSizeLong
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val batteryPercent = if (level >= 0 && scale > 0) (level * 100 / scale).coerceIn(0, 100) else -1
        val batteryStatus = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = batteryStatus == BatteryManager.BATTERY_STATUS_CHARGING ||
            batteryStatus == BatteryManager.BATTERY_STATUS_FULL
        val thermalCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            context.getSystemService(PowerManager::class.java)?.currentThermalStatus
                ?: PowerManager.THERMAL_STATUS_NONE
        } else PowerManager.THERMAL_STATUS_NONE

        val result = JSObject()
        result.put("batteryPercent", batteryPercent)
        result.put("charging", charging)
        result.put("thermalStatusCode", thermalCode)
        result.put("thermalStatus", thermalLabel(thermalCode))
        result.put("totalMemoryBytes", memory.totalMem)
        result.put("availableMemoryBytes", memory.availMem)
        result.put("lowMemory", memory.lowMemory)
        result.put("totalStorageBytes", stat.blockCountLong * blockSize)
        result.put("availableStorageBytes", stat.availableBlocksLong * blockSize)
        call.resolve(result)
    }

    @PluginMethod
    fun getAppDataDirectory(call: PluginCall) {
        val appData = getContext().filesDir.absoluteFile
        val result = JSObject()
        result.put("path", appData.absolutePath)
        result.put("serverDirectory", File(appData, "servers").absolutePath)
        call.resolve(result)
    }

    private fun thermalLabel(status: Int): String = when (status) {
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
        PowerManager.THERMAL_STATUS_NONE -> "none"
        else -> "unknown"
    }
}

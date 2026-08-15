package com.msc.minecraftservercustomizer;

import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Assume;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertTrue;

public class VanillaServerProcessTest {
    @Test
    public void startsVanillaServerAndStopsItAcrossProcessBoundary() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File serverJar = new File(context.getFilesDir(),
                "MinecraftServerCustomizer/servers/my-survival-server/server.jar");
        Assume.assumeTrue("Phase 7 Vanilla server is not installed", serverJar.isFile());
        File properties = new File(serverJar.getParentFile(), "server.properties");
        String propertyText = properties.isFile()
                ? new String(Files.readAllBytes(properties.toPath()), StandardCharsets.UTF_8) : "";
        propertyText = setProperty(propertyText, "view-distance", "2");
        propertyText = setProperty(propertyText, "simulation-distance", "2");
        propertyText = setProperty(propertyText, "online-mode", "false");
        propertyText = setProperty(propertyText, "level-type", "flat");
        propertyText = setProperty(propertyText, "generate-structures", "false");
        propertyText = setProperty(propertyText, "level-name", "phase8-test");
        Files.write(properties.toPath(), propertyText.getBytes(StandardCharsets.UTF_8));
        for (int cycle = 1; cycle <= 2; cycle++) {
            ContextCompat.startForegroundService(context, new Intent(context, HostingForegroundService.class)
                    .setAction(HostingForegroundService.ACTION_START_SERVER)
                    .putExtra(HostingForegroundService.EXTRA_SERVER_ID, "my-survival-server"));
            String output = awaitOutput(context, "Done (", 300_000);
            HostingStateStore.Snapshot snapshot = HostingStateStore.INSTANCE.read(context);
            assertTrue("Vanilla server did not reach Done (cycle " + cycle + ", status="
                            + snapshot.getServerStatus() + ", state=" + snapshot.getState() + ", pid="
                            + snapshot.getPid() + "): " + output,
                    output.contains("Done ("));
            assertTrue("Vanilla service did not report ONLINE (cycle " + cycle + ")",
                    awaitServerStatus(context, "ONLINE", 5_000));
            context.startService(new Intent(context, HostingForegroundService.class)
                    .setAction(HostingForegroundService.ACTION_STOP));
            assertTrue("Vanilla server did not stop (cycle " + cycle + ")",
                    awaitServerStatus(context, "OFFLINE", 10_000));
            Thread.sleep(500);
        }
    }

    private static String awaitOutput(Context context, String marker, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        String output = "";
        while (System.currentTimeMillis() < deadline) {
            output = HostingStateStore.INSTANCE.read(context).getOutput();
            if (output.contains(marker)) return output;
            Thread.sleep(150);
        }
        return output;
    }

    private static boolean awaitServerStatus(Context context, String expected, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (expected.equals(HostingStateStore.INSTANCE.read(context).getServerStatus())) return true;
            Thread.sleep(100);
        }
        return expected.equals(HostingStateStore.INSTANCE.read(context).getServerStatus());
    }

    private static String setProperty(String text, String key, String value) {
        StringBuilder result = new StringBuilder();
        for (String line : text.split("\\r?\\n")) {
            if (!line.startsWith(key + "=")) result.append(line).append('\n');
        }
        return result.append(key).append('=').append(value).append('\n').toString();
    }
}

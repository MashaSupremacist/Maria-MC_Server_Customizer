package com.msc.minecraftservercustomizer;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

public class HostingForegroundServiceTest {
    @Test
    public void foregroundServiceOwnsProbeLifecycleAcrossProcessBoundary() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ContextCompat.startForegroundService(context, new Intent(context, HostingForegroundService.class)
                .setAction(HostingForegroundService.ACTION_START_TEST));

        String output = awaitOutput(context, "READY", 15_000);
        HostingStateStore.Snapshot snapshot = HostingStateStore.INSTANCE.read(context);
        assertTrue("Foreground-owned probe did not start (state=" + snapshot.getState()
                + ", pid=" + snapshot.getPid() + "): " + output, output.contains("READY"));
        assertTrue("Foreground-owned probe did not expose a PID", snapshot.getPid() > 0);
        assertTrue("Hosting notification was not published", ((NotificationManager) context
                .getSystemService(Context.NOTIFICATION_SERVICE)).getActiveNotifications().length > 0);

        context.startService(new Intent(context, HostingForegroundService.class)
                .setAction(HostingForegroundService.ACTION_INPUT)
                .putExtra(HostingForegroundService.EXTRA_INPUT, "ping\n"));
        output = awaitOutput(context, "ECHO:ping", 5_000);
        assertTrue("Foreground-owned probe did not echo stdin: " + output, output.contains("ECHO:ping"));

        context.startService(new Intent(context, HostingForegroundService.class)
                .setAction(HostingForegroundService.ACTION_STOP));
        output = awaitOutput(context, "STOPPED", 5_000);
        assertTrue("Foreground-owned probe did not stop: " + output, output.contains("STOPPED"));
    }

    private static String awaitOutput(Context context, String marker, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        String output = "";
        while (System.currentTimeMillis() < deadline) {
            output = HostingStateStore.INSTANCE.read(context).getOutput();
            if (output.contains(marker)) return output;
            Thread.sleep(100);
        }
        return output;
    }
}

package com.msc.minecraftservercustomizer;

import android.system.Os;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

@RunWith(AndroidJUnit4.class)
public class NativeJvmLauncherTest {
    @Test
    public void startsCommunicatesAndStopsMinimalJavaProcess() throws Exception {
        File runtimeRoot = new File(InstrumentationRegistry.getInstrumentation()
                .getTargetContext().getFilesDir(),
                "MinecraftServerCustomizer/runtimes/java17.partial");
        File libjvm = new File(runtimeRoot, "lib/server/libjvm.so");
        Assume.assumeTrue("Java 17 process-test runtime is not installed", libjvm.isFile());

        File probeJar = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),
                "minimal-process.jar");
        try (java.io.InputStream input = InstrumentationRegistry.getInstrumentation().getTargetContext()
                .getAssets().open("minimal-process.jar");
             FileOutputStream output = new FileOutputStream(probeJar)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
        }

        List<String> libraryDirs = new ArrayList<>();
        collectNativeDirectories(runtimeRoot, libraryDirs);
        Assume.assumeTrue("Java runtime has no native libraries", !libraryDirs.isEmpty());
        long handle = NativeJvmLauncher.startProcess(
                probeJar.getAbsolutePath(), "MscProcessProbe", probeJar.getParentFile().getAbsolutePath(), new String[0],
                libraryDirs.toArray(new String[0]));
        assertTrue("Native process did not start", handle != 0);
        long pidDeadline = System.currentTimeMillis() + 5000;
        while (NativeJvmLauncher.processPid(handle) <= 0 && System.currentTimeMillis() < pidDeadline) {
            Thread.sleep(50);
        }
        assertTrue("Native process did not expose a thread id", NativeJvmLauncher.processPid(handle) > 0);
        String output = awaitOutput(handle, "READY", 15000);
        assertTrue("Probe did not become ready (state=" + NativeJvmLauncher.processState(handle) + "): " + output,
                output.contains("READY"));

        assertEquals(0, NativeJvmLauncher.writeProcessInput(handle, "ping\n"));
        output += awaitOutput(handle, "ECHO:ping", 5000);
        assertTrue("Probe did not receive stdin: " + output, output.contains("ECHO:ping"));

        NativeJvmLauncher.stopProcess(handle, false);
        output += awaitOutput(handle, "STOPPED", 5000);
        NativeJvmLauncher.stopProcess(handle, false);
        assertTrue("Probe did not stop cleanly: " + output, output.contains("STOPPED"));

        long forcedHandle = NativeJvmLauncher.startProcess(
                probeJar.getAbsolutePath(), "MscProcessProbe", probeJar.getParentFile().getAbsolutePath(), new String[0],
                libraryDirs.toArray(new String[0]));
        assertTrue("Second native process did not start", forcedHandle != 0);
        awaitOutput(forcedHandle, "READY", 15000);
        NativeJvmLauncher.stopProcess(forcedHandle, true);
        assertEquals(3, NativeJvmLauncher.processState(forcedHandle));
    }

    private static String awaitOutput(long handle, String marker, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        StringBuilder output = new StringBuilder();
        while (System.currentTimeMillis() < deadline) {
            String chunk = NativeJvmLauncher.readProcessOutput(handle);
            if (chunk != null && !chunk.isEmpty()) output.append(chunk);
            if (output.indexOf(marker) >= 0) return output.toString();
            Thread.sleep(100);
        }
        return output.toString();
    }

    @Test
    public void launchesExtractedJavaRuntimeInProcess() throws Exception {
        File appRuntimeRoot = new File(InstrumentationRegistry.getInstrumentation()
                .getTargetContext().getFilesDir(),
                "MinecraftServerCustomizer/runtimes/java17.partial");
        File externalRuntimeRoot = new File(
                InstrumentationRegistry.getInstrumentation().getTargetContext()
                        .getExternalFilesDir(null), "jre17-host");
        File runtimeRoot = appRuntimeRoot.isDirectory()
                ? appRuntimeRoot
                : externalRuntimeRoot;
        File libjvm = new File(runtimeRoot, "lib/server/libjvm.so");
        Assume.assumeTrue("Java 17 smoke-test runtime is not installed", libjvm.isFile());

        List<String> libraryDirs = new ArrayList<>();
        collectNativeDirectories(runtimeRoot, libraryDirs);
        Assume.assumeTrue("Java runtime has no native libraries", !libraryDirs.isEmpty());

        Os.setenv("JAVA_HOME", runtimeRoot.getAbsolutePath(), true);
        String result = NativeJvmLauncher.launchDirect(
                new String[] {"java", "-version"},
                libraryDirs.toArray(new String[0]));
        Log.e("MSC-NativeTest", "native launcher result=" + result);
        int markerEnd = result.indexOf('\n');
        assertTrue("Native launcher did not return an exit marker: " + result,
                result.startsWith("__MSC_EXIT__:") && markerEnd > 0);
        assertEquals("__MSC_EXIT__:0", result.substring(0, markerEnd));
        assertTrue("java -version output was missing: " + result,
                result.contains("version"));
    }

    private static void collectNativeDirectories(File root, List<String> output) {
        File[] children = root.listFiles();
        if (children == null) return;
        boolean hasNativeLibrary = false;
        for (File child : children) {
            if (child.isFile() && child.getName().endsWith(".so")) {
                hasNativeLibrary = true;
                break;
            }
        }
        if (hasNativeLibrary) output.add(root.getAbsolutePath());
        for (File child : children) if (child.isDirectory()) collectNativeDirectories(child, output);
    }
}

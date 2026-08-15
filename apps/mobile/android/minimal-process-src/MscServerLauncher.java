import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.util.Enumeration;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.ArrayList;
import java.util.List;

/**
 * Keeps Mojang's bundled launcher attached to the native process lifecycle.
 * The bundled Main starts the real server on a child thread and returns, so
 * this wrapper joins that thread instead of reporting a false process exit.
 */
public final class MscServerLauncher {
    private MscServerLauncher() {}

    public static void main(String[] args) throws Exception {
        if (args.length == 0) throw new IllegalArgumentException("server JAR path is required");
        File serverJar = new File(args[0]);
        String mainClass = null;
        String customClasspath = null;
        int serverArgStart = 1;
        while (serverArgStart < args.length && args[serverArgStart].startsWith("--msc-")) {
            String marker = args[serverArgStart++];
            if (marker.startsWith("--msc-main=")) mainClass = marker.substring("--msc-main=".length());
            else if (marker.startsWith("--msc-classpath=")) customClasspath = marker.substring("--msc-classpath=".length());
        }
        String[] serverArgs = new String[Math.max(0, args.length - serverArgStart)];
        System.arraycopy(args, serverArgStart, serverArgs, 0, serverArgs.length);

        File root = serverJar.getParentFile();
        extractBundledJars(serverJar, root);
        List<URL> classpath = new ArrayList<>();
        classpath.add(serverJar.toURI().toURL());
        collectJars(new File(root, "libraries"), classpath);
        collectJars(new File(root, "versions"), classpath);
        if (customClasspath != null && !customClasspath.isEmpty()) {
            for (String entry : customClasspath.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
                if (entry.isEmpty()) continue;
                File resolved = new File(entry).isAbsolute() ? new File(entry) : new File(root, entry);
                if (entry.endsWith("/*")) {
                    collectJars(resolved.getParentFile(), classpath);
                } else {
                    classpath.add(resolved.toURI().toURL());
                }
            }
        }
        URLClassLoader serverLoader = new URLClassLoader(
                classpath.toArray(new URL[0]), ClassLoader.getSystemClassLoader());
        if (mainClass == null || mainClass.isEmpty()) mainClass = manifestMainClass(serverJar);
        if (mainClass == null || mainClass.isEmpty()) mainClass = "net.minecraft.server.Main";
        Class<?> serverMain = serverLoader.loadClass(mainClass);
        serverMain.getMethod("main", String[].class).invoke(null, (Object) serverArgs);
        // Minecraft starts its long-lived server loop on a named thread and
        // returns from Main; keep stdout/stdin attached until that thread ends.
        // Keep the native pipe alive even if Android's thread enumeration does
        // not expose the server thread; the service owns eventual shutdown.
        long deadline = System.currentTimeMillis() + 600_000L;
        while (System.currentTimeMillis() < deadline) {
            Thread serverThread = findThread("Server thread");
            if (serverThread != null) {
                serverThread.join();
                return;
            }
            Thread.sleep(100L);
        }
    }

    private static void extractBundledJars(File serverJar, File root) throws Exception {
        try (JarFile jar = new JarFile(serverJar)) {
            Enumeration<JarEntry> entries = jar.entries();
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                String name = entry.getName();
                String relative;
                String outputRoot;
                if (name.startsWith("META-INF/versions/") && name.endsWith(".jar")) {
                    outputRoot = "versions";
                    relative = name.substring("META-INF/versions/".length());
                } else if (name.startsWith("META-INF/libraries/") && name.endsWith(".jar")) {
                    outputRoot = "libraries";
                    relative = name.substring("META-INF/libraries/".length());
                } else {
                    continue;
                }
                File destination = new File(new File(root, outputRoot), relative);
                Files.createDirectories(destination.getParentFile().toPath());
                try (var input = jar.getInputStream(entry);
                     var output = new FileOutputStream(destination)) {
                    input.transferTo(output);
                }
            }
        }
    }

    private static String manifestMainClass(File jar) throws Exception {
        try (JarFile file = new JarFile(jar)) {
            return file.getManifest() == null || file.getManifest().getMainAttributes() == null
                    ? null : file.getManifest().getMainAttributes().getValue("Main-Class");
        }
    }

    private static void collectJars(File directory, List<URL> result) throws Exception {
        if (!directory.isDirectory()) return;
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isDirectory()) collectJars(child, result);
            else if (child.getName().endsWith(".jar")) result.add(child.toURI().toURL());
        }
    }

    private static Thread findThread(String name) {
        for (Thread candidate : Thread.getAllStackTraces().keySet()) {
            if (name.equals(candidate.getName()) && candidate.isAlive()) return candidate;
        }
        return null;
    }
}

package com.msc.minecraftservercustomizer;

/** Minimal in-process Java launcher adapted from the Android launcher approach used by Pojav/Amethyst. */
public final class NativeJvmLauncher {
    private NativeJvmLauncher() {}

    static {
        System.loadLibrary("mscjvm");
    }

    public static native String launch(String libjliPath, String[] arguments, String[] libraryPaths,
                                       String fullVersion, String dotVersion);

    /** Starts the downloaded VM through JNI_CreateJavaVM without executing bin/java. */
    public static native String launchDirect(String[] arguments, String[] libraryPaths);

    /** Changes the native cwd before creating the embedded VM. */
    public static native boolean setWorkingDirectory(String directory);

    public static native long startProcess(String classPath, String mainClass, String workingDirectory, String[] arguments, String[] libraryPaths);

    public static native String readProcessOutput(long handle);

    public static native int writeProcessInput(long handle, String input);

    public static native int processState(long handle);

    public static native int processPid(long handle);

    public static native void stopProcess(long handle, boolean force);
}

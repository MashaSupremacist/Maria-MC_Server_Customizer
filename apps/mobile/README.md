# Mobile application boundary

This directory contains the Android application described in
`MINECRAFT_SERVER_CUSTOMIZER_ANDROID_PLAN.md`.

Phase 4 now provides the React/Vite shell, Capacitor configuration, native
device/storage bridges, and the first Java runtime manager implementation.
The runtime manager is limited to private runtime discovery, download,
verification, extraction, and `java -version` checks. Minecraft server
hosting and native process management remain deferred to later phases.

The planned application layout is:

```text
apps/mobile/
├── android/   # Generated Capacitor Android project (Phase 1, when available)
├── native/    # Kotlin plugins/services (Phase 2+)
├── src/       # React + TypeScript UI (Phase 1)
└── README.md
```

Desktop Electron and Node.js process-management code remains under
`apps/desktop/`. Mobile code should depend on platform-neutral contracts, not
on Electron APIs or the desktop backend implementation.

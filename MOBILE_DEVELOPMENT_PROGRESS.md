# Android Mobile Development Progress

This file records progress for the Android implementation described in
`MINECRAFT_SERVER_CUSTOMIZER_ANDROID_PLAN.md`.

## Current status

- **Branch:** `mobile-dev`
- **Current phase:** Phase 22A — Service-free direct-path feasibility (TLS/TCP harness built; QUIC and physical network validation pending)
- **Status:** Forge/Fabric/Paper flavor metadata, ZIP import, managed extension toggles, native JAR launch descriptors, safe `start.bat`/`run.bat` translation, version-routed Java hosting, LAN address reporting, and the Phase 22A certificate-pinned TLS/TCP test harness are implemented; Minecraft 26.2 with Java 25 is physically verified on ARM64
- **Remaining phases:** Phase 22 — service-free TCP translator; Phase 23 — battery and thermal handling; Phase 24 — mobile crash recovery; Phase 25 — Android release pipeline
- **Follow-up validation:** Phase 22A LAN and mobile-data-to-mapped-PC test, QUIC shared-core path, standalone PC translator, Android Minecraft connector, repeated server restart and zombie-process soak, background-client stability, second-device LAN and port-conflict checks, and real Forge/Fabric/Paper pack launches

### 2026-08-13 — Phase 22A direct TLS/TCP feasibility harness built

- Added the temporary `tools/phase22a/msc-direct-listener.mjs` PC listener. It
  creates/reuses a local self-signed identity with JDK `keytool`, enforces TLS
  1.3, prints a random test token and certificate SHA-256 fingerprint, rejects
  incorrect tokens with constant-time comparison, and echoes only bounded
  versioned Phase 22A frames.
- Added an isolated `:connectivity` Android foreground service and Capacitor
  bridge. The phone validates the listener by pinned certificate fingerprint,
  authenticates the one-time token, sends deterministic 65,537-byte probes,
  verifies the exact echo, records RTT/bytes/reconnects in an atomic file-backed
  cross-process state, and holds a time-bounded partial wake lock during the
  user-started test. Certificate, authentication, protocol, and data-integrity
  failures stop immediately rather than entering the transient reconnect loop.
- Extended More > Connectivity with a Direct transport lab for the listener
  endpoint, token, fingerprint, duration, start/stop actions, live status, RTT,
  transfer, and reconnect metrics. Credentials remain in native call arguments;
  the token is not written to status storage or logs.
- Added three Android protocol unit tests and a Node end-to-end listener test.
  The Node test negotiated TLS 1.3, verified the listener certificate
  fingerprint, authenticated a valid token, rejected an invalid token, and
  echoed a 65,537-byte binary frame.
- Validation passed: mobile TypeScript/Vite build, Capacitor sync, Android
  `testDebugUnitTest` (four total tests, including three new protocol tests),
  `assembleDebug`, `assembleDebugAndroidTest`, root typechecks, and all 247
  desktop backend tests. Updated debug APK SHA-256:
  `43010D50DB38C7B8E864D8D5AFB4532F78CF6AA797957A774377FB4181E704F0`.
- No Android device is attached, so Phase 22A is not complete: run the LAN test,
  then the Tecno-on-mobile-data to mapped-PC test with background/screen-off
  checks. The real QUIC path also remains to be implemented through the planned
  shared Rust core; an ordinary UDP probe was intentionally not mislabeled as
  QUIC.

### 2026-08-13 — Phase 22 revised to a service-free PC/mobile translator

- Changed Phase 22 from a relay-first design to a direct-first, cross-platform
  translator. A lightweight PC companion will accept Minecraft on loopback,
  while the CGNAT Android host initiates encrypted QUIC, with direct TLS/TCP
  fallback, outward to the player's reachable PC.
- Removed hosted signaling, public STUN, and first-party relay infrastructure
  from the core completion gate. Pairing candidates and one-time credentials
  will be exchanged manually by text, QR, or file; the player obtains
  reachability through global IPv6, PCP/NAT-PMP/UPnP, or manual UDP forwarding.
- Recorded the hard boundary that two endpoints behind hard/symmetric CGNAT
  cannot form a guaranteed direct path without a third reachable machine. The
  app must diagnose that topology rather than promise a universal bypass.
- Kept the stable desktop product isolated: Phase 22 first creates a standalone
  PC companion and shared native connectivity core, then integrates the proven
  core into the PC version on a separate feature branch.
- Rewrote `docs/MSC_TCP_CONNECTIVITY_PLAN.md` with the revised topology,
  offline pairing flow, component boundary, security requirements, real-network
  test matrix, and completion gates. No application code was changed.

### 2026-08-13 — Phase 22 provider-independent TCP plan completed

- Replaced the provider-specific Phase 22 implementation target with a clean-room,
  provider-independent public TCP connectivity engine while preserving Playit as
  an optional adapter that requires written service-integration permission.
- Added `docs/MSC_TCP_CONNECTIVITY_PLAN.md` covering the unavoidable CGNAT
  constraint, stock-client reverse-relay mode, an optional player-side
  TCP-to-QUIC translator for peer-to-peer attempts, bring-your-own relay support,
  Android foreground-service integration, security/abuse controls, addressing,
  cost containment, validation, and completion gates.
- No application or relay code was changed, and no public endpoint was opened.
  Phase 22A protocol/threat-model implementation is the next planned step.

### 2026-08-13 — Minecraft 26.2 / Java 25 physical validation passed

- Installed the runtime-isolation APK on the Tecno Pova 7 and started the existing Minecraft 26.2 Vanilla server with the managed Java 25 runtime.
- The server now works correctly; the previous `UnixNativeDispatcher.init()` unresolved-native-method crash is resolved by the isolated hosting process and version-aware runtime routing.
- Java 25 did not need to be downloaded again and the existing server registration remained usable, confirming the compatibility inference for previously created 26.x servers.
- Java 25/Minecraft 26.2 ARM64 startup is no longer pending. Four planned phases remain: Playit integration, battery/thermal handling, crash recovery, and the Android release pipeline; authenticated tunnel/reconnect and long-running lifecycle testing remain validation gates.

### 2026-08-13 — Java 25 / Minecraft 26.2 runtime isolation fix built

- The Tecno log proves Java 25 installed and its VM started, but Minecraft then reached `UnixNativeDispatcher.init()` with Java 17 native library paths. The host had been hardcoded to `java17`; because runtime verification had already created a Java 25 VM in the app process, the embedded launcher combined a Java 25 VM with Java 17 support libraries and failed while loading the server JAR.
- Moved `HostingForegroundService` into a dedicated `:hosting` Android process so runtime installation/verification can no longer contaminate the long-lived server VM. Hosting now selects the runtime from `server.json` and independently infers Java 25 for existing 26.x registrations, so the already-created 26.2 server does not need to be deleted and recreated.
- Added an atomic file-backed hosting-state/console bridge and routed commands, connectivity checks, gamerules, player actions, extension safety checks, and UI status polling through it. Removed the old same-process Binder path and updated lifecycle instrumentation tests to exercise the real cross-process intents and state bridge.
- Vanilla installation now reads Mojang's per-version `javaVersion.majorVersion`, stores it in the registration, requires that exact managed runtime, and tells the UI which Java version must be installed. The legacy version fallback maps 1.20.5+ to Java 21 and 26.x to Java 25.
- Validation passed: mobile TypeScript/Vite build, Capacitor sync, Android `assembleDebug`, and `assembleDebugAndroidTest`. The merged manifest contains the isolated hosting process. No ADB device is currently connected, so actual Java 25/Minecraft 26.2 startup remains a physical-phone retest.
- Updated APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`, 47,729,111 bytes, SHA-256 `C0228AD26CE12B5A635580B384B9B35BB3E852E89CE247DD15BC1BDDFF15B82D`. Install it over the current app and retry the existing 26.2 server; Java 25 does not need to be downloaded again.

### 2026-08-13 — Offline ARM64 Java 25 installation built

- The resumable downloader still received zero of 38,013,284 bytes across four attempts on the Tecno, showing that the phone/network could reach GitHub's release endpoint but could not begin receiving the redirected release-asset body; range retries cannot recover a transfer that never starts.
- Added the verified `jre25-android-arm64.tar.xz` release archive to the Android APK and documented its upstream source/build scripts and pinned SHA-256. The installer now prefers a matching bundled runtime, copies it into app-private storage with progress reporting, then performs the same mandatory checksum, extraction, and native verification pipeline. Network download remains the fallback for runtime/ABI combinations that are not bundled.
- Confirmed the bundled asset is exactly 38,013,284 bytes with SHA-256 `C4EE53FC699BE07FF10930261F12E335CBF411DD53E13A29D4CF7D6BE8C35065`; APK inspection confirms that exact asset path and the four required `libc++_shared.so` ABI packages.
- Validation passed: Capacitor sync, Android `assembleDebug`, and `assembleDebugAndroidTest`. The APK is now 47,729,111 bytes with SHA-256 `EF9AC9462C7ED4FFACA99065E15F086297C8AC3A667E906559453A7B13F29E86`.
- No ADB device was connected for physical verification. Install this APK over the current app and retry Java 25; it should display `Preparing bundled Java 25` instead of `Downloading Java 25` and should not require network access for the runtime archive.

### 2026-08-13 — Resumable Java runtime downloads built

- The Tecno Java 25 retry failed before extraction with Android OkHttp's `unexpected end of stream`, identifying a transient/truncated GitHub release download rather than a Java archive, storage, or native-loader failure.
- Reworked runtime downloads to retry up to four times, resume partial archives with HTTP byte ranges, validate `Content-Range`, response length, and final archive length, and request identity encoding so byte offsets remain stable.
- Pinned the known Java 25 ARM64/x86_64 archive sizes, reports retry/resume progress in the UI, and retains partial archives after exhausted connection retries so the next Download press can continue. Completed, corrupt, or post-download-failure archives are still removed appropriately and SHA-256 verification remains mandatory before extraction.
- Validation passed: Android `assembleDebug` and `assembleDebugAndroidTest`. APK inspection still confirms the Java 25 `libc++_shared.so` dependency for all four ABIs. Updated APK SHA-256: `7EE7C6EA59564381530AAC72770B1E5E5D87DA5023E04C2252A6DF123CCE3F90`.
- Physical retry remains required. Install the updated APK over the existing app and press Java 25 Download/Retry; if the connection breaks, the app should automatically resume and show the attempt number.

### 2026-08-12 — Java 25 native dependency repair built

- Re-inspected the extracted Java 17 and Java 25 ELF dependencies. Java 25's `libjvm.so` and `libjli.so` require `libc++_shared.so`, but neither the downloaded Java 25 archive nor the previous APK supplied it; the prior launcher then obscured that `dlopen` failure with a later `JNI_CreateJavaVM` lookup error.
- Configured the Android native build to use and package the NDK 27 shared C++ runtime. Added a minimal C++ launcher translation unit and linked `libmscjvm.so` to `c++_shared`, ensuring the dependency is loaded in the app's linker namespace before the downloaded Java 25 libraries.
- Removed the downloaded `bin/java` `ProcessBuilder` verification fallback because Android 10+ forbids executing downloaded binaries from writable app storage for this target SDK. Runtime verification now remains fully in-process through the direct JNI launcher with JLI fallback.
- Hardened native diagnostics so a failed `dlopen(libjvm.so)` returns its original dynamic-linker message immediately. Direct-JNI and JLI errors are both retained in the installation error instead of discarding the fallback result, and the experimental global `dlsym` hook was removed.
- Validation passed: mobile TypeScript/Vite build, Capacitor sync, Android `assembleDebug`, and `assembleDebugAndroidTest`. APK inspection confirms `libc++_shared.so` is present for `arm64-v8a`, `armeabi-v7a`, `x86`, and `x86_64`; the ARM64 launcher declares it as a required dependency. Updated APK SHA-256: `6DACCEC70E72E8D9501442E6D903D66ACD97CED416114B0EB98127453DCD7799`.
- Physical Java 25 installation remains pending because no ADB device was connected. Install the updated APK over the existing app and use Java 25 Download/Retry. A dedicated hosting service process remains the longer-term design for switching Java major versions safely within one app lifecycle.

### 2026-08-12 — Java 25 installation diagnostics started

- The Java 25 ARM64 archive URL and pinned SHA-256 were independently checked; the archive is valid and contains the expected regular `bin/java` launcher, so the generic “Could not install Java 25” message was not sufficient to identify the phone-side failure.
- Updated the mobile runtime UI to show the native Capacitor error instead of discarding it, and updated the native installer to report the exact stage (download, verification, extraction, launcher check, or finalization) plus available app storage when installation fails.
- Validation of the new diagnostic APK is the next step; retrying Java 25 on the Tecno phone will distinguish low storage from extraction/native-launcher incompatibility.

### 2026-08-12 — Java 25 installation diagnostics built

- The mobile web build/typecheck, Capacitor sync, and Android `assembleDebug` all pass after the diagnostic changes.
- Updated APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
- Physical validation is pending. The next retry should show the precise failing stage and available app storage instead of only “Could not install Java 25.”

### 2026-08-12 — Java 25 versioned JNI export fix started

- The phone diagnostic identified the exact failure: Java 25 extraction succeeds, but its `lib/server/libjvm.so` exports `JNI_CreateJavaVM` under the ELF version `SUNWprivate_1.1`; the launcher only used plain `dlsym`, so Android reported an undefined symbol.
- Updating the native launcher to resolve the normal unversioned export and versioned OpenJDK exports through `dlvsym` (available from the app's API-24 minimum) before retrying the Java 25 install.

### 2026-08-12 — Java 25 bionic symbol-resolution fallback built

- The phone still could not resolve the versioned export through `dlvsym`; the Java 25 file is valid, but this device/runtime combination does not expose that versioned symbol through the public lookup API.
- Added a checked ELF dynamic-symbol fallback that inspects the already-loaded `libjvm.so` image and resolves `JNI_CreateJavaVM` by its exported symbol name, after normal and versioned lookup attempts. This keeps Java 17 compatibility and covers the Java 25 build's version table.
- Android `assembleDebug` passes for all configured ABIs. Updated APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
- Physical validation is required next; install over the existing app and retry Java 25. “Refresh runtimes” only rereads metadata, so use the Java 25 Download/Retry action after the app update.

### 2026-08-12 — Java 25 libjli verification fallback started

- The ELF lookup fallback still did not resolve the versioned `JNI_CreateJavaVM` export on the physical phone, so direct embedded-VM verification remains incompatible with this Java 25 package/device combination.
- Adding a version-aware `libjli.so` launch path for `java -version`; Java 25's JLI entry point is unversioned and avoids the failing JNI symbol lookup. Java 17 will continue using the existing direct JNI path.

### 2026-08-12 — Java 25 libjli verification fallback built

- Extended the native JLI bridge to accept the runtime's full/dotted version and added Java runtime verification fallback through `lib/libjli.so` when direct JNI startup fails.
- Android `assembleDebug` passes for all configured ABIs. Physical validation is pending; the updated APK must be installed before retrying Java 25.

### 2026-08-12 — Java 25 JLI JNI lookup bridge added

- Java's `libjli.so` can itself ask `dlsym` for `JNI_CreateJavaVM`, so the native bridge now hooks that lookup during JLI startup and supplies the checked address from the loaded Java 25 ELF image when Android rejects the versioned lookup.
- The hook is scoped to the active runtime and preserves normal `dlsym` behavior for all other libraries. Android `assembleDebug` passes; physical JLI verification remains pending.

### 2026-08-12 — Independent Java launcher verification added

- Confirmed the key difference with Anvil-MC's documented architecture: it runs the selected Java runtime as an independent process, while this app was trying to embed Java through `JNI_CreateJavaVM`.
- Added a `ProcessBuilder` fallback for runtime `java -version`, setting `JAVA_HOME`, `LD_LIBRARY_PATH`, `TMPDIR`, and the extracted runtime as the working directory. This matches the independent-process approach and bypasses the failing versioned JNI lookup; the JLI/native fallbacks remain available afterward.
- Android `assembleDebug` passes. Physical Java 25 retry is pending with the updated APK.

### 2026-08-12 — Java 25 ELF fallback rebuilt after retry

- Hardened the loaded-library lookup to prefer an exact runtime path before a basename fallback, avoiding accidental selection of a previously loaded Java runtime with the same `libjvm.so` name.
- Android `assembleDebug` passes again for all configured ABIs. Physical Java 25 retry remains the required validation step.

### 2026-08-12 — Java 25 versioned JNI export fix built

- Added version-aware `JNI_CreateJavaVM` lookup for `SUNWprivate_1.1`/`LIBJVM_1.0` while preserving the existing Java 17 unversioned lookup.
- Android `assembleDebug` passed for all configured ABIs. Physical Java 25 installation verification is pending on the Tecno phone.
- Updated APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

### 2026-08-10 — Java17 Vanilla emulator verification

- Installed the current debug APK on `emulator-5554` (Android 15, x86_64) and downloaded/verified the private Java 17 runtime (`17.0.19-internal`).
- Created and downloaded Vanilla Minecraft 1.20.4 with EULA accepted and a conservative 768 MB heap for the emulator's 2.4 GB RAM.
- First runtime-backed launch reached the native hosting service but crashed while initializing Java NIO (`UnixNativeDispatcher.init()` unresolved). This is a runtime-loader compatibility issue, not a Vanilla download/EULA failure.
- Adjusted native runtime preloading to let `libnio.so` register after VM creation; rebuild and rerun the launch test next.
- Vanilla 1.20.4 then reached `Done (115.236s)` and reported `ONLINE`; the console `list` command returned successfully. A clean-stop attempt revealed that the native `STOP` probe sentinel was being sent to Minecraft, so the launcher now translates server shutdown to the Minecraft `stop` command while retaining `STOP` for the probe.
- Updated the Android Vanilla process test to wait for the service's asynchronous `ONLINE`/`OFFLINE` monitor states instead of asserting immediately after the `Done (` output marker.
- Extended the lifecycle instrumentation test to bind, start, reach `ONLINE`, stop, and unbind twice in one run, covering the service restart boundary without leaving a stale native handle.

### 2026-08-10 — Java17 Vanilla lifecycle verification completed

- Rebuilt `:app:assembleDebugAndroidTest` successfully after the native loader, server-stop, and asynchronous-status fixes.
- Ran the targeted `VanillaServerProcessTest` on `emulator-5554` (Android 15, x86_64) with the downloaded Java 17 runtime and Vanilla 1.20.4 server: `OK (1 test)` in 61.076 seconds.
- Verified the complete lifecycle: Java 17 launch, Vanilla startup/readiness, `ONLINE` publication, console command handling, graceful Minecraft `stop`, and `OFFLINE` publication.
- Repeated the same instrumentation test after a clean app force-stop; the second run also passed (`OK (1 test)` in 54.243 seconds), confirming the server can be started and stopped again without a stale process.
- Rebuilt and reran the expanded two-cycle test; both start/stop cycles passed in one instrumentation run (`OK (1 test)` in 93.792 seconds), including rebinding after service shutdown.
- Runtime-backed Vanilla testing is now complete for this emulator configuration; Phase 20 LAN connectivity remains the next planned phase.

### 2026-08-10 — Phase 20 LAN connectivity implementation started

- Began the LAN checkpoint after Java 17 Vanilla lifecycle verification passed.
- The implementation will expose the active Wi-Fi IPv4 address, configured server port, LAN address, connection state, and port-conflict status through a native Capacitor bridge, with copy/share controls in the mobile UI.
- The first emulator smoke check exposed the expected Android permission guard around `ConnectivityManager`; added `ACCESS_NETWORK_STATE` to the manifest before rerunning the packaged screen.

### 2026-08-10 — Phase 20 LAN connectivity implementation completed

- Added the native `Connectivity` Capacitor plugin and registered it with the Android bridge. It reports local IPv4, active network type, configured server port, LAN address, and port availability/conflicts; it treats the app's own hosting port as available while the server is running.
- Added the TypeScript bridge and a mobile Connectivity panel under More, with automatic refresh plus Copy address and Share address actions.
- Added the Android `ACCESS_NETWORK_STATE` permission after the first emulator smoke check correctly surfaced the permission requirement.
- `npm run build -w @msc/mobile`, `npm run cap:sync -w @msc/mobile`, and `:app:assembleDebug` all pass.
- Installed the rebuilt APK on `emulator-5554` and verified the panel reports `10.0.2.16:25565`, network `wifi`, and port `Available` without a crash.
- Phase 20 implementation is complete; validating a second physical LAN client and a deliberate port conflict remains device-level follow-up.

### 2026-08-10 — Phase 21 Playit research prototype started

- Reviewed the official Playit agent release assets and documented the Android execution, architecture, IPC, authentication, and foreground-service constraints before integrating anything into the hosting path.
- On the x86_64 Android emulator, the official `playit-linux-amd64` v1.0.10 binary executed from app-private storage, accepted custom app-private socket/secret paths, and reached `Waiting for frontend secret provisioning over IPC`.
- The research prototype will expose capability and asset-selection diagnostics only; user authentication, tunnel creation, and production foreground-service integration remain Phase 22 work.

### 2026-08-10 — Phase 21 Playit research prototype completed

- Added `PlayitResearchPlugin` and a mobile Playit research screen. The bridge reports the device ABI, official Playit release asset, app-private execution mode, secret requirement, and whether an agent is prepared.
- Added `docs/PLAYIT_ANDROID_RESEARCH.md` with the release review, Android execution probe, IPC/path findings, and Phase 22 boundary.
- Installed the rebuilt APK on `emulator-5554`; the screen reports Android ABI `x86_64`, candidate asset `playit-linux-amd64`, `app-private-process`, and `Phase 22 required` without a crash.
- `npm run build -w @msc/mobile`, `npm run cap:sync -w @msc/mobile`, and `:app:assembleDebug` pass.
- Phase 21 is complete for the x86_64 research device. ARM64 binary execution and authenticated tunnel/reconnect testing are explicitly deferred to Phase 22.

### 2026-08-10 — Real-device APK testing handoff

- The current debug APK is available at:

  ```text
  C:\GitHub Repos\Maria-MC_Server_Customizer-Mobile\apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk
  ```

- A real Android phone can install this APK for Java 17 Vanilla lifecycle, LAN Connectivity, and Playit capability-screen testing. Authenticated Playit tunneling remains Phase 22.

### 2026-08-12 — Tecno Pova 7 Vanilla runtime test

- Installed Java 17 successfully on a real Tecno Pova 7 and created a Vanilla 1.20.4 server with a 1 GB heap.
- The server began launching successfully but crashed during spawn/world preparation at approximately 70–90%.
- The Java/runtime installation path is therefore validated on the physical device; the remaining failure is likely a world-generation memory spike or Android process kill, pending the final console/Android crash lines.
- Next diagnostic: capture the last server output, then retry with a conservative higher heap if the device safety limit permits, reduced view/simulation distance, and a fresh or flat test world to separate world-generation pressure from native process failure.

### 2026-08-12 — Server persistence recovery started

- Confirmed the dashboard kept the selected server only in React memory, so an app crash/reopen reset the UI to “No active server” even when the app-private server files remained.
- Adding a native installed-server catalog and dashboard startup restore before continuing crash/memory diagnosis.

### 2026-08-12 — Server persistence recovery built

- Added `ServerManagement.listServers()` to scan the app-private server catalog and return saved metadata after an app restart.
- The dashboard now restores the first installed server on startup, preserving the server card and management controls after a WebView/app crash.
- Web typecheck/production build, Capacitor sync, and Android `assembleDebug` pass. Emulator verification was unavailable because `emulator-5554` was offline; the rebuilt APK needs to be installed on the Tecno phone for final confirmation.

### 2026-08-12 — Managed server deletion implementation started

- Confirmed the real server card had no delete action; only the Phase 3 test directory exposed deletion.
- Adding a dedicated server deletion method and Dashboard control with confirmation and a running-server safety guard.

### 2026-08-12 — Managed server deletion implementation completed

- Added `ServerManagement.deleteServer()` with managed-path validation and a `SERVER_MUST_BE_STOPPED` guard.
- Added a confirmed Dashboard “Delete server” action; it is disabled while the server is starting, online, or stopping and clears the selected server only after native deletion succeeds.
- Web typecheck/production build, Capacitor sync, and Android `assembleDebug` pass. Physical-device verification is pending because the test emulator is offline.

### 2026-08-12 — Crashpad console-noise diagnosis started

- A Tecno screenshot showed repeated Chromium Crashpad `Unknown scheduling policy 1073741824` warnings in the Minecraft console while the service remained `STARTING`.
- Identified the cause: the embedded JVM bridge temporarily redirects process-wide stdout/stderr, so Android WebView diagnostics can enter the server pipe.
- Filtering that known noise and appending the server `logs/latest.log` tail on unexpected exit so the next physical run exposes the real Minecraft/JVM failure.

### 2026-08-12 — Crashpad console-noise diagnosis built

- Native Android build passes after filtering the repeated Crashpad scheduling-policy warnings from the live console.
- Unexpected server exits now append the last 16 KB of the server's `logs/latest.log` and publish `CRASHED`, making Java OOM, launcher, and Minecraft exceptions visible even when the embedded process pipe contains unrelated Android diagnostics.
- Rebuilt APK path remains `C:\GitHub Repos\Maria-MC_Server_Customizer-Mobile\apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk`; physical-device rerun is required to capture the underlying crash.

### 2026-08-12 — Persistent server-console logging started

- The Logs screen currently reads only `logs/latest.log`; early JVM/native failures can be emitted on the captured process pipe before Minecraft creates or flushes that file.
- The hosting service will persist its filtered stdout/stderr to a separate app-managed `logs/mobile-console.log` file for each server run, and the Logs bridge will expose both sources.

### 2026-08-12 — Persistent server-console logging built

- `HostingForegroundService` now creates/truncates `logs/mobile-console.log` for each managed server start, filters known Crashpad noise, appends captured Java/Minecraft stdout/stderr as it arrives, and bounds the file to 512 KB.
- Exited native workers are now joined and their process-wide stdout/stderr descriptors are restored before the service reports the crash, preventing later WebView diagnostics from being routed into a closed server pipe.
- `ServerManagement.getLogTail()` now combines bounded tails from Minecraft `latest.log` and the persisted mobile console file. The Logs page labels both sources and exports the combined diagnostic text.
- `npm run build -w @msc/mobile`, Capacitor sync, and `:app:assembleDebug` pass. No ADB device is currently connected, so the Tecno rerun is still required to capture the real world-generation failure.

### 2026-08-12 — ARM tagged-pointer crash workaround started

- The physical-device captured console reaches `Starting net.minecraft.server.Main` and then ends with Android's fatal `Pointer tag ... was truncated` diagnostic.
- This indicates the downloaded Java runtime/native libraries are incompatible with Android heap pointer tagging on the Tecno ARM64 process; add the Android compatibility flag and revalidate on the phone.

### 2026-08-12 — ARM tagged-pointer crash workaround built

- Added `android:allowNativeHeapPointerTagging="false"` to the application manifest so the Android process does not apply heap tags that the bundled Java 17 native libraries are stripping.
- Mobile TypeScript/Vite build, Capacitor sync, and `:app:assembleDebug` pass. The new APK needs a physical-device rerun; no ADB device is connected here.

### 2026-08-12 — Background hosting reliability started

- The server JVM already lives in a foreground service, but the service did not hold a CPU or Wi-Fi lock while hosting. On aggressive Android battery/network policies this can reset a connected player's socket when the UI leaves the foreground even though the JVM remains `ONLINE`.
- Add scoped hosting locks, keep the service sticky when the task is removed, and use Android's long-running `specialUse` foreground-service classification instead of the Android 15-limited `dataSync` type.

### 2026-08-12 — Background hosting reliability built

- `HostingForegroundService` now acquires a partial CPU wake lock and a Wi-Fi lock only while a managed Minecraft server is starting or online, then releases both on stop, crash, or service destruction.
- The service remains sticky after the activity/task is removed and updates its ongoing notification to state that Minecraft is still running in the background.
- Changed the service classification to `specialUse` with a documented Minecraft-hosting subtype and added the required Android foreground-service, wake-lock, and Wi-Fi permissions. This avoids Android 15's six-hour `dataSync` timeout for long-running hosts.
- Mobile build, Capacitor sync, and `:app:assembleDebug` pass. Physical-device background/network validation remains required; the only build warning is the expected deprecation of the pre-API-29 Wi-Fi lock mode.

### 2026-08-12 — Minecraft version test matrix reviewed

- Current physical-device coverage is Java 17: Vanilla 1.20.4 is working, and Forge 1.19.2 remains the next practical modded fixture.
- Mojang changed 1.20.5+ to Java 21 and 26.1+ to Java 25. The runtime manager has Java 21/25 packages, but the current installer/host path still selects Java 17 for Vanilla, so latest-version testing must wait for Java-major routing.
- Recommended sequence: 1.20.4/Forge 1.19.2 stability, then Java 21 with 1.20.6 or 1.21.x, then Java 25 with 26.1/26.2 after routing and low-heap validation.

### 2026-08-12 — Logs navigation implementation started

- Confirmed More → Logs was still a disabled placeholder, preventing physical-device crash diagnosis.
- Adding a native latest-log tail API and a read-only Logs screen with refresh/export controls.

### 2026-08-12 — Logs navigation implementation completed

- Added `ServerManagement.getLogTail()` for the managed server's `logs/latest.log` with a bounded 64 KB tail.
- Enabled More → Logs and added refresh/export controls so crash logs remain available after the live process exits or the app is reopened.
- Web typecheck/production build, Capacitor sync, and Android `assembleDebug` pass. The rebuilt APK requires installation on the Tecno phone for physical verification.

### 2026-08-10 — Direct JNI workaround started

- Added a separate `JNI_CreateJavaVM` launcher path that loads `libjvm.so` directly and reports `java.version` without invoking the downloaded `bin/java` executable.
- Switched the managed Java-runtime verification and native instrumentation smoke test to exercise this direct path.
- The existing JLI/ByteHook path remains available for comparison; build and emulator verification are still pending.
- The first native compile exposed that Android's bundled JNI headers define support through `JNI_VERSION_1_6`; the direct invocation path now uses that compatible initialization constant.
- `:app:assembleDebug` now succeeds for all configured ABIs after the direct JNI addition.
- The x86_64 API 35 instrumentation test now passes with a seeded Java 17 runtime and logs `__MSC_EXIT__:0` plus `openjdk version "17.0.19-internal"`.
- The managed Settings flow was rerun end-to-end: Java 17 downloaded to 100%, checksum verification and extraction completed, and the new direct JNI path reported Java 17 successfully. The UI now shows `Installed · 17.0.19-internal` and `Java 17 installed and verified.`
- This resolves the Android `bin/java` execute denial for the tested runtime. The Pojav/Amethyst and target-SDK alternatives remain contingency paths; Termux is not required for this verified route.

### 2026-08-10 — Phase 5 minimal Java process implementation started

- Added a generated `minimal-process.jar` probe with a `READY` handshake, stdin echo, graceful `STOP`, and stdout flushing.
- Added native process lifecycle bindings around the direct JNI VM path: start, output polling, stdin writes, state/PID reporting, graceful stop, and force stop.
- Added an instrumentation test covering startup, communication, clean stop, and force-stop behavior. Build and device execution are pending.
- Android's bionic pthread headers do not provide `pthread_cancel`; the force-stop implementation now uses the supported cooperative EOF/close path and preserves the force-stopped state.
- The generated probe task and `:app:assembleDebug` now succeed for all configured ABIs.
- The first device run exposed a startup race in the instrumentation assertion (the native thread ID is assigned asynchronously); the test now waits briefly for the PID/state handoff before evaluating the process.
- The next device run reached the native process thread but did not produce the probe handshake; diagnostic output and state reporting were added to identify whether VM creation or class loading is failing.
- The diagnostic identified `JNI_CreateJavaVM` returning `JNI_ERR` when the VM was created from the worker thread. The launcher now keeps one invocation VM alive, attaches worker threads to it, and falls back to `URLClassLoader` for the generated probe JAR.
- The first class-loader retry showed the Android path needed a `file:` URL prefix; the native loader now supplies a valid file URL for the probe archive.
- The next run successfully reached `READY` and echoed stdin; the test now waits for the asynchronous graceful-stop output before cleaning up the handle.

### 2026-08-10 — Phase 5 verification completed

- Rebuilt the native bridge and generated probe JAR successfully.
- Ran the instrumentation suite manually against a seeded Java 17 runtime: `OK (2 tests)`.
- Verified the probe lifecycle: startup/PID, `READY` output, stdin `ping` → `ECHO:ping`, graceful `STOP` → `STOPPED`, and force-stop state.
- The direct JNI VM is kept alive and worker threads attach to it, avoiding the Android `JNI_CreateJavaVM` worker-thread failure.
- Scope note: this checkpoint proves the required Java execution and I/O lifecycle, but the implementation uses an in-process JVM thread rather than a separately isolated Android OS process. Phase 6 must own that lifecycle from a foreground service.

### 2026-08-10 — Phase 6 foreground service implementation started

- Added `HostingForegroundService` with a persistent hosting notification, Start/Stop action, service-owned Java probe handle, stdin/output/status binder, and Android 14 foreground-service declarations.
- Added the `HostingProcess` Capacitor bridge and TypeScript contract for starting the service, sending input, stopping, and reading published status.
- Added an instrumentation smoke test for service bind, probe startup, stdin/stdout communication, PID ownership, and graceful stop. Build and device verification are pending.
- The first service run confirmed binding and I/O but exposed that graceful stop published status before the probe had exited; the service now waits for the stopped state and drains final output before releasing its handle.
- The service binder now enters foreground mode before starting the probe, and the instrumentation test also checks that a hosting notification is active.

### 2026-08-10 — Phase 6 verification completed

- `:app:assembleDebug` and `:app:assembleDebugAndroidTest` succeed with the foreground-service implementation.
- The emulator service test passes (`OK (1 test)`): binds to the service, starts the Java probe under service ownership, confirms the hosting notification is active, verifies PID and stdin/stdout, then stops cleanly.
- Added Android 14-compatible `FOREGROUND_SERVICE_DATA_SYNC` declaration and notification permission declaration.
- Added Capacitor `HostingProcess` methods for starting, input, stopping, and status reads; the next phase can replace the probe JAR with the Vanilla server JAR.
- The mobile web workspace typecheck and production build also pass after adding the hosting-process bridge contract.

### 2026-08-10 — Phase 7 Vanilla installation implementation started

- Added `VanillaServerPlugin` for Mojang release-version discovery, server metadata resolution, SHA-1-verified server JAR download, managed server registration, EULA writing, and initial `server.properties` generation.
- Added the TypeScript Vanilla bridge and a mobile create-server flow with version selection, server name, RAM, EULA acceptance, progress, and Java-runtime guidance.
- Phase 7 build and emulator installation verification are pending; Minecraft process startup and LAN connectivity remain Phase 8/20 work.
- The mobile TypeScript/Vite build and Android debug plus instrumentation APK builds pass with the Phase 7 bridge and create-server UI.
- Capacitor sync completed, copying the Phase 7 create-server UI into the Android app assets.
- Rebuilt the Android debug APK after sync; the packaged app now contains the Phase 7 UI and native plugin registration.
- Phase 8's first compile caught the new working-directory parameter at the existing probe call site; the service probe invocation now passes its app-files directory explicitly.
- Added a Vanilla server-process instrumentation test covering `net.minecraft.server.Main`, working-directory launch, `Done (` readiness, ONLINE state, and clean stop.
- Phase 8's first emulator run timed out without server output; the instrumentation assertion now reports service status, native state, and PID to isolate startup failures.
- The diagnostic run reported native state `4` (CRASHED) before the monitor drained the final error bytes; the monitor now performs a final output drain after fast exits.
- Final diagnostics showed the 1.20.1 JAR exposes `net.minecraft.bundler.Main` rather than `net.minecraft.server.Main`; the process manager now launches Mojang's bundled bootstrap class.
- The bundled bootstrap then exposed the embedded VM's stale `/` `user.dir`; the native launcher now sets Java's working-directory property to the registered server directory before class loading.
- Mojang's bootstrap uses its dedicated `bundlerRepoDir` property for extraction, so the native launcher now sets both `user.dir` and `bundlerRepoDir` to the server directory.
- The bundled launcher was returning after spawning Mojang's `ServerMain` thread; added `MscServerLauncher` to invoke the bundler and join that thread, keeping native state alive for stop/restart and readiness monitoring.
- The service now refreshes the generated helper JAR on each start so an upgraded wrapper is not shadowed by an older copied asset.
- Corrected the wrapper source location to the Android probe build directory after the first Gradle invocation caught the path mismatch.
- Minecraft initialization then exposed Android's read-only `/tmp` and `/logs`; the service now creates a server-local temp directory, sets native cwd before VM creation, and the launcher redirects `java.io.tmpdir` alongside the bundler path.
- The first world-generation run produced normal server logs but exceeded the 45-second test window; the wrapper now joins Minecraft's `Server thread`, and the lifecycle test allows 120 seconds for initial world preparation.
- To avoid the bundled launcher’s asynchronous handoff entirely, `MscServerLauncher` now extracts nested version/library JARs directly and invokes `net.minecraft.server.Main` with a complete local classpath.
- Direct `Main` invocation still hands the loop to Minecraft's named `Server thread`; the helper now joins that thread so console output remains piped and native state stays RUNNING through `Done` and shutdown.
- Extended the helper's fallback wait to ten minutes so a missing Android thread-enumeration result cannot make the native handle exit at the same time as the readiness timeout.
- The running server writes Log4j output to `logs/latest.log` instead of the native pipe on Android; the service now detects and publishes `Done (` from that file, and graceful stop escalates to force-stop after five seconds.
- The emulator's first complete world-generation cycle exceeded two minutes; expanded the instrumentation readiness window to five minutes for low-powered/API-35 emulator runs.
- The lifecycle test now lowers view and simulation distance to 2 on its seeded server, keeping repeated emulator verification bounded without changing the installed server defaults.
- Android's test compiler lacks Java 11 `Files.readString`/`writeString`; switched the test to byte-based `Files` APIs for compatibility.
- Disabled online-mode in the instrumentation-only server properties to keep readiness verification independent of external authentication services.
- Also configured a flat, structure-free test world so the API-35 emulator can reach `Done` without spending the full run on terrain generation.
- The test uses a dedicated `phase8-test` level name to avoid reusing an interrupted world from earlier diagnostic runs.
- Updated the test property helper to replace existing defaults (not only append missing keys), ensuring the dedicated flat test world is actually selected on repeated runs.
- Added Dashboard process controls for Start, Stop, Restart, and Force stop, with one-second status polling through the foreground-service bridge.
- Mobile typecheck and production build pass with the Phase 8 controls (`npm run build -w @msc/mobile`).
- Repeated API-35 instrumentation runs keep the native handle in state `1` and produce normal Minecraft startup logs, but the five-minute test window still ends before `Done` on this emulator; Phase 8 is therefore not marked complete yet.
- Capacitor sync and Android debug APK assembly pass after packaging the Phase 8 Dashboard controls.

### 2026-08-10 — Phase 9 live output bridge started

- Foreground-service output is now published incrementally while a process is running, allowing the Console page to stream logs through the existing `getStatus` bridge.
- Added the Phase 9 Console page with live polling, pause/resume auto-scroll, search, severity filters, clear, export, command input, command history, and warning/error highlighting.
- The post-Phase 9 service smoke run exposed a probe-start regression diagnostic gap; the test assertion now reports native state and PID when READY is missing.
- Fixed the regression: `readOutput()` now drains the native pipe before returning accumulated output, preserving both live server monitoring and the probe's direct binder reads.

### 2026-08-10 — Phase 9 verification completed

- `npm run build -w @msc/mobile` passes TypeScript checking and Vite production output.
- Capacitor sync and `:app:assembleDebug :app:assembleDebugAndroidTest` pass with the Console packaged into Android assets.
- `HostingForegroundServiceTest` passes (`OK (1 test)`) after the streaming fix, confirming the service-owned output/input lifecycle remains functional.
- Manual sustained-output UI stress testing remains appropriate for device validation; the next planned implementation phase is Phase 10.

### 2026-08-10 — Phase 8 real Vanilla verification deferred

- Deferred the slow full Vanilla emulator assertion so it does not block Phase 9 work.
- Retained the Phase 8 instrumentation test and documented follow-up options: a lightweight fake server JAR for lifecycle testing, a pre-generated flat world, or a physical Android device.
- Phase 8 is not marked complete until repeated real start/stop/restart testing confirms no zombie server threads.
- Gradle initially treated the generated helper task as up-to-date despite source edits; declared both helper sources as task inputs so wrapper changes are packaged reliably.
- Moved the Gradle input declaration outside `doLast` after Gradle rejected mutating task inputs during execution.

### 2026-08-10 — Phase 7 verification completed

- The Android UI discovered Mojang release versions, including 1.20.1, and enforced EULA acceptance before creation.
- With Java 17 installed, the UI downloaded and SHA-1-verified the 47,791,053-byte Minecraft 1.20.1 server JAR.
- Verified managed files on the emulator: `server.jar`, `eula.txt` with `eula=true`, initial `server.properties`, and `server.json` registration with status `ready` and matching SHA-1 `84194a2f286ef7c14ed7ce0090dba59902951553`.
- Phase 7 prepares a ready Vanilla server; starting it and reaching `Done` is intentionally deferred to Phase 8, and LAN client validation remains Phase 20.

## Change log

### 2026-08-10 — Phase 0 preparation completed

- Confirmed the dedicated `mobile-dev` branch and separate worktree.
- Added the `apps/mobile/` boundary marker and documented the planned mobile
  layout.
- Added the Phase 0 repository audit covering shared-code candidates,
  desktop-only implementations, and Android portability hazards.
- Kept Android hosting, Capacitor, Kotlin, Java runtime, and process-management
  logic out of this phase.
- Verified the desktop application remains healthy:
  - Typecheck passed.
  - Production build passed.
  - 247 backend tests passed.

### 2026-08-10 — Phase 1 Android shell implemented

- Added the `@msc/mobile` React + TypeScript + Vite workspace package.
- Added the compact green/black mobile UI with Dashboard, Console, Players,
  Settings, and More navigation plus placeholder states.
- Added Capacitor configuration and generated `apps/mobile/android/` with the
  Android platform project.
- Added Capacitor 8 dependencies and synchronized the web bundle into the
  Android project.
- Validation passed:
  - `npm run build -w @msc/mobile`
  - `npm run cap:sync -w @msc/mobile`
  - Root desktop/shared/backend typecheck
  - Root backend test suite (247 tests)
- APK build was initially blocked by Java 25; the generated Gradle build
  reported unsupported class file major version 69. The build now succeeds
  when run with the installed Java 24 runtime and Android SDK configured.

### 2026-08-10 — Android toolchain clarification

- Confirmed the generated project uses Android Gradle Plugin 8.13.0 and
  Gradle 8.14.3.
- Confirmed JDK 17 is the AGP 8.13 minimum/default documented by Android;
  Java 24 also works with this Gradle 8.14.3 build.

### 2026-08-10 — Java 24 and Android SDK verification

- Found Java 24 at
  `C:\Program Files\Eclipse Adoptium\jdk-24.0.2.12-hotspot`.
- Found the Android SDK at
  `C:\Users\TO GOD BE THE GLORY\AppData\Local\Android\Sdk`.
- Rebuilt with Java 24 and the SDK configured; `assembleDebug` passed and
  produced the debug APK.
- Checked connected devices and configured AVDs; none are currently available,
  so APK installation and manual navigation testing remain pending.

### 2026-08-10 — Phase 1 completion gate review

- React/Vite shell, Capacitor project generation, web build, and debug APK
  compilation are complete.
- Phase 1 is **not yet fully complete** under the roadmap criteria because an
  Android device or emulator is unavailable for APK installation, app launch,
  and manual navigation verification.
- Phase 2 is intentionally paused until that device validation is performed.

### 2026-08-10 — Phase 1 manual validation completed

- Installed Google's Android command-line tools so a local emulator could be
  created from the existing SDK system image.
- Created and booted the `MSC_API35` Android 15 x86_64 emulator.
- Installed `app-debug.apk` successfully with ADB.
- Launched `com.msc.minecraftservercustomizer/.MainActivity` successfully.
- Verified Dashboard, Console, Players, Settings, and More navigation through
  Android UI inspection.
- Verified the More menu renders its placeholder tool entries.
- Phase 1 completion criteria are now satisfied; Phase 2 may begin.

### 2026-08-10 — Phase 2 native Android bridge completed

- Added the Kotlin `DeviceInfo` Capacitor plugin with calls for:
  - `getDeviceInfo()` — Android version, API level, architecture, manufacturer,
    and model.
  - `getMemoryInfo()` — total/available RAM and low-memory state.
  - `getStorageInfo()` — total/available app-storage space.
  - `getAppDataDirectory()` — app data path and planned server directory path.
- Registered the plugin from the Android `MainActivity`.
- Added the TypeScript plugin contract and displayed native results in the
  Settings screen with refresh/error states.
- Added Kotlin Gradle configuration and aligned Java/Kotlin compilation to JVM
  21 for the generated Android project.
- Validation passed:
  - Mobile TypeScript/Vite production build.
  - Capacitor sync.
  - Android `assembleDebug` using Java 24 and the configured SDK.
  - Android emulator install and app launch.
  - React-to-Kotlin bridge data rendered in Settings (API 35, x86_64, RAM,
    storage, device, and app paths).
  - Root backend test suite (247 tests).
- No server process, Java runtime manager, or hosting logic was added.
- Phase 3 is the next permitted phase: safe Android-managed storage paths and
  import/export groundwork.

### 2026-08-10 — Phase 3 Android storage model completed

- Added the Kotlin `Storage` Capacitor plugin and registered it from
  `MainActivity`.
- Added a private app-managed storage root with `servers`, `backups`,
  `runtimes`, `downloads`, `logs`, and `app-data` directories.
- Added server-directory creation/deletion, managed test-file writing, and
  canonical path validation that blocks traversal outside the managed root.
- Added Android `ACTION_OPEN_DOCUMENT` import and `ACTION_CREATE_DOCUMENT`
  export flows without broad filesystem permissions.
- Added TypeScript contracts and Settings-screen controls for exercising the
  storage model and reporting success/error states.
- Emulator validation passed on the Android 15 (API 35) `MSC_API35` AVD:
  - Created and deleted a test server directory.
  - Wrote and read back a managed test file.
  - Confirmed `../outside-managed-storage.txt` was blocked.
  - Imported a selected file into managed downloads.
  - Exported the managed file through DocumentsUI and confirmed the saved
    file in Downloads.
- Repository validation passed:
  - `npm run build -w @msc/mobile`
  - `npm run cap:sync -w @msc/mobile`
  - Root `npm run typecheck`
  - Root `npm test` (247 tests)
  - Android `assembleDebug` with Java 24 and the configured Android SDK.
- No Java runtime installation, server process, or hosting logic was added.
- Phase 4 is now the next permitted phase: Java runtime discovery and
  selection.

### 2026-08-10 — Phase 4 Java runtime manager implementation started

- Added the TypeScript `JavaRuntime` Capacitor contract and Settings UI for
  Java 8, 17, 21, and 25 runtime entries.
- Added the Kotlin `JavaRuntime` plugin and registered it from `MainActivity`.
- Implemented the app-private runtime directory, architecture mapping
  (`arm64-v8a` → `aarch64`, plus emulator x64 support), Android JRE package
  resolution for Java 8/17/21/25, streamed download progress, pinned SHA-256
  verification, safe XZ archive extraction, metadata persistence, and
  `java -version` verification.
- Added a pure-Java XZ decoder dependency and an explicit Android `chmod 0755`
  fallback for extracted Java launchers after emulator validation reported
  an execution-permission failure.
- Confirmed the remaining gate is an Android platform restriction, not a bad
  archive: Android 15 rejects `execve` for downloaded binaries when the app
  targets API 29+, even after extraction and `chmod`. The plugin now reports
  this as an actionable launcher-strategy limitation.
- Corrected the restriction check to read the Capacitor context's target SDK
  metadata; the Android source remains ready for the final build once this
  gate is addressed.
- Began the launcher adaptation: added a minimal packaged JNI library that
  follows the Pojav/Amethyst pattern by loading `libjli.so` and calling
  `JLI_Launch` in-process instead of executing `bin/java`.
- Installed Android NDK 27.1 locally and wired the mobile Gradle project to
  build the native launcher for the device ABI.
- Added ByteHook-based `exit()` interception so OpenJDK's `JLI_Launch` can
  return control to the Capacitor plugin instead of terminating the Android
  process, matching the relevant Pojav/Amethyst launcher behavior.
- Pinned ByteHook to 1.0.10 because the newer artifact requires compile SDK
  37, while this project is intentionally on the current AGP-supported SDK.
- Switched the native launcher to resolve ByteHook from its packaged shared
  library at runtime because the 1.0.10 AAR does not expose a usable CMake
  package in this Gradle configuration. The launcher now also sets
  `JAVA_HOME` to the extracted runtime before calling `JLI_Launch`.
- Added the required confirmation notice before a runtime download and a
  verification-output view in Settings.
- Kept runtime metadata timestamping compatible with the generated Android
  minimum SDK (API 24).
- Validation passed:
  - Mobile TypeScript/Vite production build.
  - Root typecheck.
  - Root backend test suite (247 tests).
  - Capacitor sync.
  - Android `assembleDebug` with Java 24 and the configured SDK.
  - Android emulator install, launch, runtime catalog rendering, and download
    confirmation notice.
- Rebuilt the native launcher after the runtime ByteHook resolution change;
  Android `assembleDebug` passed for arm64-v8a, armeabi-v7a, x86, and x86_64.
- Added an Android instrumentation smoke test that calls the packaged native
  launcher directly against the extracted Java 17 runtime, avoiding reliance
  on emulator WebView tap coordinates for this low-level gate.
- The first instrumentation compile caught a checked `ErrnoException` from
  the Java-side `JAVA_HOME` setup; the test now declares that expected setup
  exception and is ready to rerun.
- The first instrumentation run reached the native bridge but returned exit
  code `1`; added test logging to capture OpenJDK's launcher output for the
  next diagnosis. The unrelated generated Capacitor example test also still
  expects its old package name.
- Prepared the instrumented smoke test to use a pushed emulator runtime
  fallback when the test runner clears app-private files between installs;
  this keeps the native launcher test independent of the WebView download UI.
- Adjusted that fallback to the app-specific external-files directory, which
  is readable by the target app under scoped storage; the test runner can now
  be installed, seeded, and invoked directly without clearing the seed first.
- Updated the generated Capacitor instrumentation assertion to the actual
  mobile application ID so the Android test suite does not fail on its stale
  template package name.
- Added an Android native-launcher instrumentation harness and a scoped-
  storage runtime seed path. The first reported `OK (1 test)` was later
  identified as an assumption skip because the seeded runtime was not present
  in the target app directory; it is not counted as a successful launch gate.
- Android emulator testing downloaded the pinned Java 17 x86_64 archive,
  verified its SHA-256 checksum, and extracted the runtime successfully.
- The clean UI-managed verification reproduced the remaining failure after
  extraction: OpenJDK attempted to execute `bin/java` and Android denied it.
  The native bridge now preloads `libjvm.so` and the runtime support libraries
  before entering `JLI_Launch`, matching the required Pojav launcher setup.
- Rebuilt and reran the UI-managed verification with the preload change. The
  archive reached 100%, checksum verification and extraction completed, and
  `libjvm.so` was preloaded, but the runtime still returned Android's
  `Permission denied` / `trying to exec .../bin/java` error. Phase 4 remains
  blocked on a launcher implementation compatible with this OpenJDK build;
  no Minecraft process was started.
- Phase 4 is **not complete yet**: Android 15 blocked the extracted
  `java -version` process with `error=13` because the app targets API 36.
  A packaged/native launcher strategy is required before this completion
  criterion can pass. No Minecraft process was started.

### 2026-08-10 — Phase 10 RAM/device safety telemetry started

- Added native Android safety telemetry for battery level/charging state,
  thermal status, available/total memory, low-memory state, and storage.
- Added the TypeScript bridge contract and server-install acknowledgement field
  for unsafe RAM allocations.
- Added a native install guard that requires explicit acknowledgement when the
  requested allocation exceeds a conservative device-derived limit.
- Validation is pending after the RAM guidance UI and hosting integration are
  added.

### 2026-08-10 — Phase 10 RAM guidance and acknowledgement UI added

- Added phone-aware conservative RAM recommendations (4/6/8/12 GB tiers),
  available-memory limits, and warnings for low memory, thermal stress, low
  battery, low storage, and aggressive allocations.
- Added an explicit acknowledgement checkbox and disabled server creation
  until risky allocations are reviewed and acknowledged.
- Persisted the selected allocation and acknowledgement through the Vanilla
  server install bridge; native installation rejects unsafe allocations unless
  the acknowledgement is present.
- Android/web build verification is still pending.

### 2026-08-10 — Phase 10 hosting heap configuration wired

- Persisted server RAM is now read by the foreground hosting service and
  applied as conservative `-Xms512m` plus selected `-Xmx` options when the
  embedded JVM is created.
- Extended the native JNI launcher to preserve only the recognized heap flags,
  keeping Minecraft's own command-line arguments unchanged.
- The embedded JVM remains process-scoped; a heap change takes effect when a
  fresh VM is created, while the install-time safety guard still protects the
  saved configuration.
- Full TypeScript, native, and Android validation is pending.

### 2026-08-10 — Phase 10 Android test dependency alignment

- Aligned transitive Kotlin stdlib/JDK artifacts in the Android build so the
  Capacitor Cordova instrumentation variant does not package conflicting
  Kotlin 1.6/1.8 and 2.2 classes.
- This was required after the first Phase 10 instrumentation build exposed a
  duplicate-class failure; production `assembleDebug` already passed.
- Instrumentation rebuild is in progress.

### 2026-08-10 — Phase 10 build verification completed

- `npm run build -w @msc/mobile` passed (TypeScript typecheck and Vite
  production bundle).
- `npm run cap:sync -w @msc/mobile` passed.
- Android `assembleDebug` and `assembleDebugAndroidTest` passed with Java 24.
- The first instrumentation build exposed a generated Cordova/Kotlin
  duplicate-class conflict; the build-level Kotlin alignment fixed it.
- The connected suite was intentionally not counted as a Phase 10 pass: it
  includes the deferred Vanilla integration test and exceeded the command
  timeout. The isolated hosting smoke test also requires the previously
  downloaded Java 17 runtime, which is not currently present on the emulator.
- Phase 10 implementation is complete for the buildable safety/configuration
  path; manual device UI review and a runtime-backed server launch remain
  follow-up validation before final release sign-off.

### 2026-08-10 — Phase 10 desktop regression checks passed

- Root `npm run typecheck` passed for desktop, shared types, and backend.
- Root `npm test` passed all 247 backend tests.

### 2026-08-10 — Phase 10 final asset rebuild passed

- Rebuilt the mobile web bundle after the final RAM guidance copy update,
  synchronized Capacitor assets, and rebuilt `assembleDebug` successfully.

### 2026-08-10 — Phases 11–15 batch started

- Began the requested two-batch implementation: Phases 11–13 (configuration,
  gamerules, player administration) followed by Phases 14–15 (worlds and
  backups/restore).
- The implementation will share one validated Android server-management bridge
  while keeping each phase's UI and validation milestones separate.

### 2026-08-10 — Phases 11–13 native management bridge added

- Added the `ServerManagement` Capacitor bridge and Android implementation for
  validated `server.properties` reads, updates, reset-to-default, and backup
  before destructive edits.
- Added version-aware gamerule catalog/state with online command forwarding and
  persisted offline values.
- Added whitelist/operator/ban file reads and safe online player-administration
  command forwarding.
- UI wiring and build validation are next for this batch.

### 2026-08-10 — Phases 11–13 UI and build validation passed

- Added server.properties editing to Settings with friendly labels, raw keys,
  defaults, typed controls, validation errors, restart notices, reset-to-default,
  and backup-before-change behavior.
- Added searchable gamerule controls with version-aware availability metadata,
  persisted offline values, and live command forwarding when the server is
  online.
- Added player administration views for whitelist/operators/bans and guarded
  live commands for kick, op/de-op, whitelist, ban, and pardon operations.
- `npm run build -w @msc/mobile`, Capacitor sync, Android `assembleDebug`, and
  `assembleDebugAndroidTest` passed.
- Persisted gamerules are also replayed after a server reaches `ONLINE`, so
  offline edits survive the next server start.

### 2026-08-10 — Phases 14–15 world and backup operations added

- Added managed world listing, default-world directory creation, ZIP import with
  traversal protection, export through DocumentsUI, copy, valid-world detection,
  and delete with a pre-delete safety archive.
- Added manual ZIP backups, retention pruning, listing, export, deletion, and a
  validated restore sequence that requires the server to be stopped, backs up
  current state, restores through staging, and validates server metadata.
- Phase 14–15 UI and final regression validation remain.

### 2026-08-10 — Phases 14–15 UI and Android packaging validation passed

- Added Worlds, Gamerules, Backups, and Player Administration navigation from
  the mobile shell, with stop-before-destructive-action notices and DocumentsUI
  import/export flows.
- Added version-aware gamerule disabling and replay of saved gamerules after a
  server reaches `ONLINE`.
- Added restore metadata timestamps and source tracking after a successful
  staged restore.
- `npm run build -w @msc/mobile`, Capacitor sync, Android `assembleDebug`, and
  `assembleDebugAndroidTest` passed after the final changes.
- Full emulator validation of world/backup flows remains limited because the
  emulator does not currently contain a downloaded Java runtime and real
  Minecraft world.

### 2026-08-10 — Phases 11–15 desktop regression checks passed

- Root `npm run typecheck` passed for desktop, shared types, and backend.
- Root `npm test` passed all 247 backend tests.
- Phases 11–15 are implemented and package-validated; runtime-backed Android
  world/backup testing is the remaining external-data follow-up.

### 2026-08-10 — Phases 14–15 compatibility rebuild passed

- Replaced the world archive path calculation with an API-24-safe string-based
  relative path implementation and rebuilt `assembleDebug` successfully.

### 2026-08-10 — Forge priority reordered

- Reordered execution so Phase 18 — Forge Support is the next implementation
  target, ahead of Phase 16 Fabric Support and Phase 17 Paper Support.
- Updated the plan to preserve the original phase numbering while documenting
  the requested execution priority and Forge's version-specific constraints.

### 2026-08-10 — Cross-platform server-pack launcher constraint recorded

- Confirmed from the existing desktop pack-installer/process-manager code and
  tests that valid packs may contain only `start.bat`/`run.bat`, with no root
  `server.jar`.
- Android will not execute Windows batch files. The combined Forge/Fabric/Paper/
  server-pack implementation must detect and safely parse recognized scripts,
  recover referenced JAR/JVM arguments, and create managed launch metadata.
- Unsupported or opaque scripts will require manual configuration instead of
  being executed blindly.

### 2026-08-10 — Batch execution feasibility clarified

- Standard Minecraft `start.bat` packs can run on Android by translating their
  supported Java-launch subset into a native launch descriptor (`java`, JAR,
  JVM flags, argument files, working directory, and server arguments).
- Direct `.bat` execution is not portable because Android has no Windows
  `cmd.exe`; Termux alone also does not execute Windows batch syntax.
- Full Windows emulation (Wine/Winlator-style) is not the default hosting path
  because of ABI, performance, storage, and compatibility constraints.
  Arbitrary scripts will require manual configuration.

### 2026-08-10 — Forge/Fabric/Paper and launcher translation implementation started

- Began the combined flavor-support batch with a native launch-descriptor
  path, so imported Forge/Fabric/Paper packs can retain their JAR, main class,
  classpath, JVM arguments, and server arguments without depending on a root
  `server.jar`.
- The next changes extend the embedded launcher and add safe pack detection and
  `start.bat`/`run.bat` translation.

### 2026-08-10 — Flavor launch safety and Forge module arguments hardened

- Added `flavor: vanilla` to vanilla registrations so all managed servers use
  the same flavor-aware metadata shape.
- Restricted translated JAR/classpath resolution to the managed server
  directory and preserved common Forge module JVM options that consume a
  following value (`-p`, `--module-path`, `--add-modules`, and related flags).
- Next step is full desktop/mobile regression validation; runtime-backed
  Minecraft launch still depends on installing a compatible Android Java
  runtime and providing a representative pack.

### 2026-08-10 — Modern Forge module-path translation completed

- Translated separate-value Forge module options into JNI-compatible
  `--module-path=...`, `--add-modules=...`, and related forms, while adding
  module/class paths to the managed classpath descriptor.
- Extended the native JVM option filter for module, patch, limit, and upgrade
  options so recognized Forge launchers retain their required VM configuration.

### 2026-08-10 — ZIP/mrpack picker compatibility added

- Broadened the Android pack picker MIME filters to include common ZIP and
  `.mrpack` provider types; extraction remains path-traversal guarded and strips
  pack index metadata before managed installation.

### 2026-08-10 — Final flavor batch rebuild passed

- Revalidated after the pack-picker change: mobile TypeScript/Vite build,
  Android `assembleDebug`, and `assembleDebugAndroidTest` all passed.

### 2026-08-10 — Forge test fixture heap reduced

- Updated `C:\Servers\MinecraftServers\CARP\user_jvm_args.txt` from
  `-Xmx4G -Xms4G` to `-Xmx2G -Xms2G` for safer Android test-server memory use.
- The server pack remains suitable for the next import/launch test; a ZIP copy
  will still be needed to transfer it into Android managed storage.

### 2026-08-10 — Flavor/server-pack batch validated

- Completed the Forge-first combined batch: the Android bridge now exposes a
  Forge/Fabric/Paper catalog, imports managed ZIP packs, detects flavor/version/
  Java requirements, manages `mods` and `plugins`, and stores a native launch
  descriptor for JAR or translated batch launchers.
- `start.bat`/`run.bat` translation supports the safe Java subset (`java`,
  `-jar`, class/module paths, argument files, JVM flags, script-relative paths,
  and server arguments). Arbitrary Windows commands, PowerShell, installers,
  and native executables are rejected with a manual-configuration message.
- Validation passed: mobile typecheck/Vite build, Capacitor sync,
  `assembleDebug`, `assembleDebugAndroidTest`, root typechecks, and all 247
  desktop backend tests (21 test files). No real Minecraft pack was launched
  on an Android device in this pass because runtime-backed validation remains
  environment-dependent.
- Next planned step is Phase 20 LAN connectivity.

## Development rule

Every future implementation change for the Android project must add a dated
entry to this file describing:

1. The phase or task worked on.
2. The files or behavior changed.
3. Validation performed and its result.
4. The next planned step or any blocker.

Changes must remain limited to the active phase, and desktop behavior must
continue to be checked before moving to the next major phase.

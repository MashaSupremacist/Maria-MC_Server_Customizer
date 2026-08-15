# Playit Android Research — Phase 21

Date: 2026-08-10

## Scope

This checkpoint evaluates whether the official Playit agent can execute on
Android and what must be solved before adding tunnel controls to the mobile
application. It is intentionally separate from the stable LAN connectivity
path and does not create or store a user account secret.

## Upstream release inspected

- Repository: <https://github.com/playit-cloud/playit-agent>
- Release inspected: `v1.0.10`
- Official assets include `playit-linux-aarch64`, `playit-linux-armv7`,
  `playit-linux-amd64`, and `playit-linux-i686`.
- The `.apk` assets are Alpine Linux packages, not Android application APKs;
  they must not be installed as Android packages.

## Android execution probe

The official `playit-linux-amd64` asset was copied to the Android 15 x86_64
emulator and executed from the app-private files directory.

Results:

1. `--help` completed successfully.
2. The daemon's default `/.config/playit_gg` location failed because an Android
   app cannot create that root-level path.
3. Supplying app-private `--socket-path`, `--secret-path`, and `--log-path`
   allowed the daemon to start.
4. The daemon reached:

   ```text
   Waiting for frontend secret provisioning over IPC
   ```

This proves the official x86_64 Linux binary can execute in the tested Android
app-private context. The aarch64 asset is available from the same release but
still requires a physical ARM64 device verification.

## Constraints and design decisions

- The agent must be launched and stopped by the Android foreground service;
  an Activity-owned process is not sufficient for background hosting.
- Every runtime path must be under the app-private directory. The agent's
  default Linux configuration/socket locations are not valid on Android.
- Secret provisioning and claim-link handling must be explicit user actions;
  no secret is bundled, logged, or silently uploaded by the research layer.
- Playit is a relay/tunnel path for networks where direct inbound connections
  fail (such as common mobile CGNAT). It does not replace LAN address display.
- The agent must be treated as an optional experimental process until an ARM64
  device test, authenticated tunnel test, reconnect test, and foreground-service
  stop test pass.

## Phase 21 prototype boundary

The app-side prototype exposes architecture, official asset selection, Android
execution mode, and the remaining authentication requirement. It does not yet
download, authenticate, create tunnels, or expose a public management screen.
Those operations belong to Phase 22 after the ARM64 and authenticated-agent
checks are complete.

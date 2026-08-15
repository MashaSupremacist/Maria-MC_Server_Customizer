# Mobile Phase 0 Repository Audit

Status: preparation only. No Android hosting or runtime logic is implemented.

## Repository isolation

- The `mobile-dev` branch and its separate worktree already exist at
  `C:\GitHub Repos\Maria-MC_Server_Customizer-Mobile`.
- The stable desktop checkout remains in the sibling worktree
  `C:\GitHub Repos\Minecraft Server Customizer` on `main`.
- The mobile worktree currently starts from the same commit as `main`; this
  phase adds only documentation and the `apps/mobile/` boundary marker.

## Reuse candidates

These areas are good candidates for future platform-neutral packages. They
should be extracted only when mobile code needs them; Phase 0 does not move or
rewrite them.

| Candidate | Current location | Planned use |
| --- | --- | --- |
| Server and install contracts | `packages/shared-types/src/index.ts` | Shared request/response types, server states, logs, progress, and Minecraft metadata. Split desktop-only IPC types from the neutral contracts when the mobile shell needs them. |
| Server properties schema and validation | `apps/desktop/backend/src/server-properties-schema.ts` | Shared field definitions, defaults, validation, and value conversion. Move pure logic into `packages/minecraft-config/` later. |
| Properties parser/serializer | `apps/desktop/backend/src/properties.ts` | Shared `server.properties` text parsing and serialization. Keep filesystem access outside the shared package. |
| Gamerule catalog and version comparison | `apps/desktop/backend/src/gamerule-catalog.ts` | Shared version-aware gamerule definitions and comparison helpers. Move pure data/functions into `packages/minecraft-config/` later. |
| Server flavor metadata | `apps/desktop/backend/src/server-types.ts` | Shared Vanilla/Fabric/Forge/Paper labels and capability metadata. Remove Node `path` and filesystem helpers before sharing. |
| Visual language | `apps/desktop/renderer/src/styles/theme.css` and selected presentational components | Reuse colors, status semantics, and compact control conventions. Do not reuse Electron window/IPC assumptions. |

## Keep platform-specific

The following code must remain behind separate desktop and Android adapters:

- `apps/desktop/electron/` (Electron windows, preload, IPC, and desktop paths).
- `apps/desktop/backend/src/process-manager.ts` (Node child processes,
  `cmd.exe`, batch launchers, `taskkill`, and Windows process-tree handling).
- `apps/desktop/backend/src/java-service.ts` (desktop Java executable lookup,
  Windows-specific runtime downloads, and PowerShell extraction).
- `apps/desktop/backend/src/playit-service.ts` (desktop executable launching
  and Windows process cleanup).
- Desktop database, filesystem, dialog, shell, and backend service wiring.
- Bedrock installation code, which currently targets the official Windows
  Bedrock binary and is not part of the initial Android scope.

Android equivalents should implement a common host interface such as
`startServer`, `stopServer`, `restartServer`, and `sendCommand`, but use Kotlin,
Capacitor, Android storage APIs, and a foreground service.

## Known portability hazards

- Absolute desktop folder paths and unrestricted folder pickers cannot be
  carried directly to Android; use app-managed storage and Android's document
  picker.
- `.bat`/`.cmd` launchers and shell-script execution are desktop import cases;
  Android server-pack support must parse recognized launch configuration rather
  than execute imported scripts blindly.
- Hard-coded Windows x64 Java/Bedrock download targets need architecture-aware
  Android runtime and server handling later.
- Node/Electron IPC channels in `IpcChannels` describe the desktop transport;
  they are not an Android bridge API.

## Phase 0 guardrails

- Do not change desktop runtime behavior or force a broad repository refactor.
- Do not add Capacitor, Kotlin, Android, Java-runtime, or Minecraft process
  logic in this phase.
- Before Phase 1, run the existing desktop type checks/build/tests and record
  any baseline failures separately from mobile work.

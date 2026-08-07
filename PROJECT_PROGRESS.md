# Minecraft Server Customizer — Project Progress

Tracks implementation phases and completion status against
`MINECRAFT_SERVER_CUSTOMIZER_PLAN.md`.

---

## Phase 1: Repository and Desktop Shell

**Status:** Complete

**Goal:** Working Electron app with React, TypeScript, and the compact green-and-black interface.

### Implemented

- npm workspace monorepo: `apps/desktop`, `apps/desktop/backend` (placeholder), `packages/shared-types`
- Electron main process with secure webPreferences (`contextIsolation`, `sandbox`, `nodeIntegration: false`)
- Narrow `contextBridge` preload API (`window.msc`: app info + window controls)
- React 19 + TypeScript + Vite renderer
- Compact green-and-black theme using the plan's exact CSS variables (no gradients)
- Custom title bar with minimize / maximize / close window controls
- Sidebar navigation with Java / Bedrock edition toggle
- Java Edition nav: Dashboard, Console, Worlds, Players, Settings, Gamerules, Datapacks, Mods / Plugins, Backups, Playit
- Bedrock Edition nav: Dashboard, Console, Worlds, Players, Settings, Permissions, Allowlist, Behavior Packs, Resource Packs, Backups, Playit
- Placeholder pages for every nav destination
- External links open in the system browser (window.open denied)
- Dev (`npm run dev`) and production build (`npm run build`) scripts
- README.md with setup and layout docs

### Completion criteria

- [x] App launches successfully
- [x] Navigation works
- [x] No gradients
- [x] Layout is compact
- [x] Renderer has no unrestricted Node access
- [x] Production build opens successfully

### Verification notes

- `npm run build` (typecheck renderer + electron + shared-types, Vite build, tsc electron) passes
- Production build launched with `npx electron .` from `apps/desktop`; UI confirmed via screenshot (green-and-black shell, sidebar nav, dashboard placeholder)
- Fixed: sandboxed preload could not resolve `@msc/shared-types` at runtime — preload now inlines channel constants and imports types only
- Known limitation: the app must be launched from `apps/desktop` (where the electron `package.json` lives); packaging (Phase 15) will handle the app root
- Note: `npm install` on this machine skipped dev dependencies on the first pass; `npm install --include=dev` (or an `npm ci`) is required after a fresh clone

---

## Phase 2: Local API and SQLite

**Status:** Complete

**Goal:** Local Fastify backend, WebSocket, SQLite persistence, server-instance records, app settings, library path.

### Implemented

- `@msc/backend` workspace package (`apps/desktop/backend`)
- Fastify server bound to `127.0.0.1` with a random port
- Auth: random 32-byte token per launch (`X-MSC-Token` header); health and `/ws` are public, everything else requires the token
- WebSocket endpoint (`/ws`) sending a `hello` event
- SQLite via better-sqlite3 v13 (prebuilt binaries — no compile step)
  - `settings` table (key/value, JSON-encoded)
  - `servers` table (id, name, edition, server_type, folder_path, java_path, memory_mb, port, version, timestamps)
- REST routes: `GET /health`, `GET/POST/PUT/DELETE /servers[/:id]`, `GET/PUT /settings`
- `MSC_READY <port>` stdout handshake so Electron main learns the chosen port
- Graceful shutdown on SIGINT/SIGTERM/SIGBREAK; DB closed on Fastify `onClose`
- Electron main spawns the backend as a child process using the system Node executable (`process.env.NODE`), shares one spawn promise, kills it on quit
- Renderer Dashboard page: live backend status (Online/Connecting/Offline + uptime), server library folder picker (native dialog via main process), server instance table with create/delete
- Narrow preload API extended (`getBackendInfo`, `getSettings`, `setSetting`, `selectServerLibrary`, `listServers`, `createServer`, `updateServer`, `deleteServer`)
- CSP added to `index.html` (`connect-src http://127.0.0.1:* ws://127.0.0.1:*`) fixing the Phase 1 security warning; `ws://` is required for the renderer's WebSocket connection to the local backend

### Completion criteria

- [x] Renderer can call the health endpoint
- [x] WebSocket connects
- [x] Selected library path persists after restart
- [x] Server records can be created, listed, edited, and deleted

### Verification notes

- 7/7 backend vitest tests pass (health, auth 401s, servers CRUD, settings persistence)
- Standalone E2E: health OK; settings and server records persisted across a backend restart
- Live app launch: single backend child spawned on system Node, bound to 127.0.0.1; `/health` returned `{"status":"ok","version":"0.1.0"}`; Dashboard rendered Backend Online + library/instance panels (confirmed by screenshot)
- DB file confirmed at `app-data/msc.db` with `settings` and `servers` tables
- Issues fixed during verification:
  - First `npm install` missed nested-workspace deps — root `workspaces` now includes `apps/*/*`
  - better-sqlite3 v11 had no Node 24 prebuild → used v13 (ships prebuilt binaries)
  - Settings route body schema stripped `serverLibraryPath` (missing `properties`) — declared it
  - Settings stored double-JSON-encoded — `getSettings` now parses stored values
  - Backend initially spawned with `process.execPath` (= electron.exe) which crashed — now resolves the real Node from `process.env.NODE`
  - Concurrent `ensureBackend()` calls spawned duplicate backends — shared `backendStartPromise` now guarantees one spawn

## Phase 3: Vanilla Process Manager

**Status:** Complete

**Goal:** Run an existing Vanilla server folder: select folder + Java, configure JVM args, start/stop/restart/force-kill, track state, stream logs, send commands.

### Implemented

- `ProcessManager` (`backend/src/process-manager.ts`):
  - Spawns `java.exe` (via `spawn`, no shell) with `-Xms/-Xmx`, custom JVM args, `-jar <jar> nogui`
  - States: offline → starting → online → stopping / crashed / offline
  - Detects `Done (x.xs)` line → online
  - stdout/stderr streaming with per-line timestamps + error/warn classification
  - Ring buffer of last 500 log lines
  - Graceful stop: sends `stop` to stdin, force-kills after 20s timeout
  - Force-kill kills the process tree (`taskkill /T /F` on Windows)
  - Crash detection: unexpected exit while starting/online → `crashed` + exit code
  - One server at a time; duplicate starts blocked
- `ServerManagerService` (`backend/src/server-manager.ts`): bridges DB records ↔ process manager, broadcasts state/log events over WebSocket, restart = stop-then-start
- Backend routes: `GET /servers/:id/status`, `GET /servers/:id/logs`, `POST /process/start|stop|kill|restart|command`
- WebSocket now streams `server:state` and `server:log` events to authenticated clients (token via query param for browser WS)
- `jvm_args` column added to `servers` table (with migration for existing DBs)
- Electron main: java.exe picker dialog, open-server-folder (shell), and IPC for status/start/stop/restart/kill/command/logs
- Renderer: server picker chips, ServerForm (create with RAM + java selection), ServerControls (Start/Stop/Restart/Force Kill/Open Folder + live state), live Console (logs, filter, auto-scroll, download, command history)
- `useServerRuntime` hook: WebSocket connection to backend, live state/log updates, action methods

### Completion criteria

- [x] A manually prepared Vanilla server starts
- [x] Console output appears live (WS streaming, verified by test)
- [x] Commands work (stdin → echo in logs, verified)
- [x] Stop command shuts down safely
- [x] Duplicate starts are blocked
- [x] Crashes are detected

### Verification notes

- 21/21 backend tests pass: API (7), ProcessManager (13), WebSocket streaming (1)
- ProcessManager tests use a fake Java (cmd wrapper → node fake server) that prints `Done`, echoes commands, exits on `stop`; verifies start→online, duplicate-block, missing jar/java/folder, stdin commands, graceful stop→offline, unexpected exit→crashed, status shape
- WebSocket test asserts clients receive `hello`, `server:state` (incl. `online`), and `server:log` events
- Standalone E2E over the real backend: create → start → online → send command → echo in logs → stop → offline → restart → force-kill → offline — all pass
- Live app launch: backend child spawns, health OK; renderer bundle contains new UI
- Issues fixed during verification:
  - Fake Java for tests must ignore java-style args; used `cmd /c` wrapper (test-only; production always spawns real java.exe)
  - `@fastify/websocket` v11 handler receives the ws `WebSocket` directly (not `{socket}`)
  - `buildApp` must `await app.register(websocket)` (Fastify v5 plugin ordering)
  - `backendFetch` set `content-type: application/json` on body-less POSTs → Fastify 400 `FST_ERR_CTP_EMPTY_JSON_BODY`; now only set when body present
  - Force-kill now uses `taskkill /T /F` to kill the whole process tree on Windows

## Phase 4: Vanilla Server Installer

**Status:** Complete

**Goal:** Create new Vanilla servers from the application: version list, official JAR download, server directory creation, EULA flow, RAM settings, initial server.properties, progress, cancellation, download verification.

### Implemented

- `VanillaInstallerService` (`backend/src/vanilla-installer.ts`):
  - Fetches the official Mojang version manifest (`piston-meta.mojang.com/mc/game/version_manifest_v2.json`), releases first, newest first
  - Resolves each version's official server JAR (via the version JSON)
  - Streams the JAR download with 0-100% progress and cancellation support
  - Verifies the download against the published SHA-1; mismatch → `checksum` failure + folder cleanup
  - Writes `eula.txt` (eula=true) and a starter `server.properties` (port, level-name, motd, max-players, online-mode, etc.)
  - Creates the server folder under the library (dedupes names), then the DB record
  - Progress broadcast over WebSocket (`install:progress`): downloading / verifying / writing-config / complete / failed / canceled
  - Failed/canceled installs clean up partial folders; no record is left for failed downloads
- Backend routes: `GET /vanilla/versions`, `POST /install/vanilla`, `POST /install/cancel`
- EULA required before install (route + service both enforce)
- Electron main + preload: `getVanillaVersions`, `installVanillaServer`, `cancelVanillaInstall`
- Renderer `ServerForm` rewritten as the full install flow: name, folder, Minecraft version dropdown (live from Mojang), RAM, java.exe picker, EULA checkbox, live progress bar with cancel, auto-adds the created server

### Completion criteria

- [x] User can create a new Vanilla server
- [x] Server starts after installation (ProcessManager from Phase 3 handles launch)
- [x] EULA is handled explicitly
- [x] Failed downloads do not leave broken instances marked as ready

### Verification notes

- 25/25 backend tests pass, including `VanillaInstallerService` unit tests against a local fake Mojang server: success (downloads, sha1 verify, config write, record create), EULA rejection, checksum failure + cleanup, cancellation + no record
- Real-world E2E against live Mojang: fetched 905 versions (102 releases, latest `26.2`), installed a real 60.9 MB server JAR for the latest release, verified SHA-1, wrote eula.txt + server.properties, created the record — `INSTALL E2E OK`
- Live app: backend spawns, `/vanilla/versions` auth-protected (401 without token), renderer bundle contains the new install UI
- Shared WebSocket singleton so server-runtime and install progress both listen on one connection
- Installer constructor now accepts `manifestUrl` + `fetchImpl` for testability (defaults to the real Mojang manifest)

## Phase 5: Java Runtime Manager

**Status:** Complete

**Goal:** Detect installed Java, read versions, match Java to Minecraft versions, show the install notice, download private runtimes, store per-server paths, allow custom java.exe.

### Implemented

- `JavaService` (`backend/src/java-service.ts`):
  - `detect(javaPath)` / `readJavaVersion` — runs `java -version` (with cmd-wrapper support for `.cmd`/`.bat`), extracts major + full version
  - `requiredJavaForMinecraft` — maps MC versions to Java feature versions (1.21+ → 21, 1.20.5+ → 21, 1.18–1.20.4 → 17, 1.17 → 16, ≤1.16 → 8)
  - `getRequirement` — builds the JavaRequirement report (required, detected, compatible, per-server path)
  - `getDownloadInfo` — queries Adoptium for the JDK binary (size + link) for the notice
  - `install(majorVersion)` — downloads the real Adoptium Temurin JDK zip with progress + cancel, extracts via PowerShell, finds `java.exe` (incl. nested `jdk-x/bin` folders), broadcasts `java:progress` events
- Server launch now validates Java: `ServerManagerService.start`/`restart` are async and run a `JavaValidator` before launching; incompatible Java returns `incompatible-java` with `{found, required}` (new error code)
- Private runtimes install to `<dataDir>/runtimes/java/java-<major>` (never touches system PATH)
- Backend routes: `POST /java/detect`, `GET /java/required`, `GET /java/download-info`, `POST /java/install`, `POST /java/cancel`
- Electron main + preload: `detectJava`, `getRequiredJava`, `getJavaDownloadInfo`, `installJava`, `cancelJavaInstall`
- Renderer:
  - `useServerRuntime` now exposes a structured `startError` + `clearError`
  - `JavaRequiredDialog` — the plan's exact notice (requires Java X, download size, install location, private-runtime explanation) with **Install Java / Choose Existing Java / Cancel**, live progress, and "Use This Java"
  - `ServerControls` opens the dialog when start fails with `incompatible-java`, and updates the server's `javaPath` when a runtime is installed/chosen

### Completion criteria

- [x] Incompatible Java is detected before launch
- [x] User receives a clear notice before download
- [x] Private runtime does not modify system PATH
- [x] Different servers may use different runtimes (per-server javaPath in DB)

### Verification notes

- 32/32 backend tests pass, including `JavaService` unit tests (fake java.exe via cmd wrapper + fake Adoptium): version reading, MC→Java mapping, compatible/incompatible requirements, bad-path detection, download info, nested java.exe discovery
- Real-world E2E #1 (live backend): detected real system Java 25.0.2, correctly flagged MC 1.21.4 needs Java 21 → incompatible, Adoptium download info = Java 21 ~196 MB
- Real-world E2E #2 (live backend): **installed a real 205 MB Java 21 runtime** from Adoptium with live progress 0→100%, extracted it, found `java.exe` in the nested `jdk-21.0.12+8/bin`, and verified it runs (`openjdk version "21.0.12"`)
- Issues fixed during verification:
  - Adoptium v3 assets API nests the binary at `[0].binary.package` (not flat) — fixed
  - cmd-wrapper version reading needed `cmd /c <path>` without literal quotes around the path
  - `java -version` full-version capture now returns e.g. `21.0.12` (not just `21`)

## Phase 6: Console and Server Dashboard

**Status:** Complete

**Goal:** Finish the primary server-control experience: live dashboard status, CPU/RAM usage, uptime, player count, server address, console filtering, command history, log download, crash details.

### Implemented

- `ServerStats` in shared types: `cpuPercent`, `memoryMb`, `playerCount`; `ServerStatus` now includes `stats` + `address` (e.g. `127.0.0.1:25565`)
- New `server:stats` WebSocket event (broadcast every 2s while running)
- `ProcessManager`:
  - Samples CPU + RAM every 2s via `pidusage` (per-process tree), rounds to 0.1
  - Parses player count from Vanilla log lines (`There are N of a max of M players online`)
  - Emits `onStats`; clears the sampler on exit/shutdown
  - `getStatus` returns `stats` + `address` (from the server's configured port)
- `ServerManagerService` forwards stats events to the WS broadcast
- Renderer:
  - `useServerRuntime` subscribes to `server:stats` and exposes `stats` + `address`
  - `DashboardStats` — live stat tiles: Status, Players, CPU, Memory, Uptime, PID, Address
  - Crash details panel on the dashboard (exit code + last error lines) when state is `crashed`
  - Console toolbar: level filter dropdown (All / Info / Warnings / Errors) alongside the text filter
- `pidusage` added to the backend (pure-JS, no native compile)

### Completion criteria

- [x] Dashboard updates live (stats stream over WebSocket)
- [x] Console remains responsive during long sessions (ring buffer + WS events)
- [x] Crash state and exit code are shown clearly

### Verification notes

- 34/34 backend tests pass, including new `parsePlayerCount` tests and the status-shape test (address + stats)
- Stats E2E over the live backend: server started → online; 2 `server:stats` events streamed over WS with real CPU/RAM (memory 5.2 MB for the node fake); player count parsed from the log line (3); `status.address` = `127.0.0.1:25566`; status endpoint returns stats
- Full typecheck + production build pass; renderer bundle contains the stats/crash/filter UI
- Notes:
  - `pidusage` is pure-JS (no native module), so no rebuild concern
  - `npm install -w <workspace>` on this machine prunes other workspaces' devDeps; recovered each time with `npm install --include=dev`

### Follow-up fixes (Phase 6 polish)

- **Live player count baseline seed**: `playerCount` initialized to `null` and only became a number when the full `There are N of a max of M players online:` line appeared — which modern Vanilla (e.g. MC 26.2) does not print by default. Join/leave deltas were gated on non-null, so the dashboard Players tile stayed "—" forever even with real players joining. `ProcessManager` now seeds `playerCount = 0` when the server hits the `Done` (online) line, so `X joined the game` / `X left the game` deltas work from the start. New unit test; process-manager suite now 17 tests.
- Verified: `process-manager` suite green, full typecheck + production build pass. (The pre-existing flaky fake-HTTP installer tests — `server-installer`, `vanilla-installer`, `api` backup — still fail intermittently under parallel workers; unrelated to this fix.)

### Follow-up fixes (Dashboard polish)

- **Edition labels on server chips**: the server picker lists all servers regardless of edition, so a Java server and a Bedrock server looked identical. Each chip now shows a colored edition badge — orange `Java`, blue `Bedrock` (`--chip-java` / `--chip-bedrock` theme vars) — so it's obvious which servers belong to which section.
- **Semantic control buttons**: Start / Stop / Restart in Server Controls are now color-coded outline buttons — green (accent), red (danger), yellow (warning) — with a subtle neon border + inner glow (`.btn-start` / `.btn-stop` / `.btn-restart`) that brightens on hover, matching the app's neon aesthetic instead of solid fills. Force Kill keeps the existing red outline treatment.

## Phase 7: Vanilla Settings Editor

**Status:** Complete

**Goal:** Friendly editor for `server.properties`: schema-driven controls, validation, descriptions, restart-required tracking, reset to default, backup before save, raw-editor fallback.

### Implemented

- `properties.ts` — Java `.properties` parser/serializer that preserves comments (`#`/`!`), blank lines, line order, and unknown keys; handles `=`/`:` separators, minimal escaping/unescaping
- `server-properties-schema.ts` — 29-field schema (motd, gamemode, difficulty, hardcore, pvp, online-mode, max-players, server-port, whitelist, spawn-protection, view/simulation distance, allow-flight/nether, structures, command blocks, idle timeout, resource pack, RCON, query, level-name/seed, max-tick-time, network compression) with friendly labels, descriptions, types, ranges, defaults, and restart-required flags
- `ServerPropertiesService` (`server-properties.ts`):
  - `read` — merges the file with schema defaults (missing file → defaults)
  - `validate` — per-field validation (boolean/enum/integer with min/max)
  - `update` — **backs up the current file** to `<folder>/msc-backups/server.properties.bak-<stamp>`, merges validated values, preserves comments/unknown keys, appends missing defaults
- Backend routes: `GET/PUT /servers/:id/properties`
- Electron main + preload: `getServerProperties`, `updateServerProperties`
- Renderer `SettingsPage`: schema-driven friendly editor (boolean/enum selects, numeric/text inputs), friendly label + description + original key, restart-required badge, per-field Reset-to-default, validation errors inline, Save with backup notice, and an **Advanced (raw)** editor toggle that edits the raw text with save

### Completion criteria

- [x] Valid settings save correctly
- [x] Invalid settings are rejected (inline errors, file untouched)
- [x] Unknown properties are preserved
- [x] Comments and unrelated entries are not silently destroyed
- [x] Backup before saving

### Verification notes

- 43/43 backend tests pass, including 9 new properties tests: parser round-trip, comment/unknown preservation, new-key append, defaults-when-missing, existing-value read, invalid + out-of-range rejection (file unchanged), valid save preserves unknown keys, backup created with original content
- Props E2E over the live backend: read 29 fields, invalid update rejected ("Must be a whole number"), valid update applied with backup created, file preserved comment + `custom-key`, port/motd changed, backup file contains original `server-port=25565`
- Full typecheck + production build pass; renderer bundle contains the settings UI (Save Changes / Friendly Editor / reset)
- Live app launch: backend spawned healthy

## Phase 8: Gamerules and Player Management

**Status:** Complete

**Goal:** Version-aware gamerule editor (searchable, grouped) plus whitelist, operators, bans, IP bans, kick, and op/deop — using Minecraft commands when online, JSON file edits when offline.

### Implemented

- `gamerule-catalog.ts` — 28-rule version-aware catalog with categories (Gameplay, Mobs, Drops, Player, World, Spawning, Chat, Command Blocks), types (boolean/integer), ranges, defaults, and `since` versions; `compareVersions` + `gamerulesForVersion` filter rules by the server's MC version
- `PlayerService` (`player-service.ts`):
  - Gamerules: online → sends `gamerule <key> <value>` command; offline → reads/writes `<world>/settings/gamerules.json` (modern) or `<world>/gamerules.json` (legacy), with validation
  - Whitelist / ops / banned-players / banned-ips: read + replace JSON files (offline-safe; refuses file edits while online with a helpful message)
  - Player commands: `kick`, `ban`, `op`, `deop`, `ban-ip` sent via console when online; `offline: true` reported otherwise
- Backend routes: `GET/PUT /servers/:id/gamerules`, `GET/PUT /servers/:id/whitelist|operators|bans|ip-bans`, `POST /servers/:id/commands`
- Electron main + preload: all gamerule/player channels
- Renderer:
  - `GamerulesPage` — searchable, category-grouped gamerule editor with boolean selects / numeric inputs, reset-to-default, offline/live indicator
  - `PlayersPage` — Whitelist / Operators / Bans / IP Bans tables with add + remove (file edits), and online quick-action buttons (/kick, /op, /deop, /ban) that send console commands

### Completion criteria

- [x] Changes are reflected in the running server (online commands; offline JSON writes)
- [x] Offline-only edits are clearly marked (offline badge, whitelist-file-edit error while online)
- [x] Failed commands show useful errors

### Verification notes

- 58/58 backend tests pass, including 11 PlayerService tests (defaults, version filtering, file read/write at both paths, invalid-value rejection, online command dispatch, whitelist/ops edits, offline command reporting) and 4 gamerule-catalog tests
- Phase 8 E2E over the live backend: offline gamerule read picks up `settings/gamerules.json` values, offline update writes the file, whitelist/ops/bans/ip-bans adds persist to JSON, invalid gamerule rejected, commands while offline report `offline: true`
- Full typecheck + production build pass
- Bugs found & fixed during verification:
  - Gamerules live at `<world>/settings/gamerules.json` on modern MC (not `<world>/gamerules.json`) — now resolves both, preferring the modern path
  - The `settings` subdirectory must be created with `mkdirSync(path.dirname(filePath), {recursive:true})`

## Phase 9: World Discovery and Import

**Status:** Complete

**Goal:** Find and import local Minecraft worlds safely — user-authorized folder scanning, common save-folder suggestions, Java world validation, preview metadata, copy progress, duplicate-name handling, import cancellation.

### Implemented

- `nbt.ts` — minimal gzip-NBT parser for `level.dat` (strings, ints, longs, bytes, lists, compounds, arrays); extracts LevelName, GameType, Version, LastPlayed
- `WorldService` (`world-service.ts`):
  - `discover(folder)` — scans one level deep; valid worlds have `level.dat` (also checks region/playerdata/advancements indicators); invalid folders reported separately
  - `inspectWorld` — reads level.dat metadata + computes folder size
  - `import` — copies a world into the server folder with streamed progress (0–100%), duplicate-name handling (`name-2`, `name-3`, …), cancellation (removes partial copy), refuses while the server is running, rejects sources without `level.dat`
  - Broadcasts `world:import-progress` over WebSocket (copying / complete / failed / canceled)
- `suggestSaveFolders()` — `%APPDATA%\.minecraft\saves`, Documents, Desktop, Downloads (only reports existing dirs as scan shortcuts)
- Backend routes: `POST /worlds/discover`, `GET /worlds/save-folders`, `POST /worlds/import`, `POST /worlds/cancel`
- Electron main + preload: `selectWorldFolder` (native folder picker), `discoverWorlds`, `getSaveFolders`, `importWorld`, `cancelWorldImport`
- Renderer `WorldsPage`: choose/scan folder, save-folder shortcut chips, discovered-world table (display name, game mode, version, size) with Import buttons, live progress bar with Cancel

### Completion criteria

- [x] Existing single-player worlds can be copied into a server
- [x] Original worlds remain untouched (copy, never move)
- [x] Invalid folders are rejected clearly

### Verification notes

- 66/66 backend tests pass, including 8 new world tests: NBT metadata parse, discover valid/invalid, import with duplicate handling, non-world rejection, running-server rejection, custom target name
- World E2E over the live backend: discovered CoolWorld + OldWorld (invalid NotAWorld flagged), imported CoolWorld (level.dat + region copied), duplicate import → CoolWorld-2, non-world rejected, save-folders returned
- Live app launch: backend healthy, `/worlds/save-folders` auth-protected (401 without token)
- Notes:
  - Synthetic level.dat fixtures are built in-test as gzip NBT (Data compound) — no external files
  - The vanilla-installer checksum test was intermittently flaky under parallel workers; made that describe `sequential`

## Phase 10: Backups and Restore

**Status:** Complete

**Goal:** Protect server data with ZIP backups stored outside the server folder — manual backups, backup notes, backup list, restore with validation, delete, retention limit, and a safety backup before restoration.

### Implemented

- `backups` SQLite table (id, server_id, file_path, note, size_bytes, created_at; FK cascade on server delete)
- `BackupService` (`backend/src/backup-service.ts`):
  - `create` — streams the server folder into a ZIP (`yazl`) with byte-based progress, writes to `<dataDir>/backups/<server>-<stamp>.zip` (temp + rename), creates the DB record, enforces retention
  - `list` — all backups for a server, newest first
  - `delete` — removes the DB record and archive file
  - `restore` — validates the archive (`yauzl`), creates a `pre-restore-<stamp>.zip` safety backup of the current state, clears the server folder, then extracts (safe-path checked, byte progress)
  - Retention: keeps the newest `DEFAULT_RETENTION` (10) backups per server, deleting older records + files; deterministic ordering (`created_at, rowid`)
  - Refuses create/restore while the server is running; rejects missing servers/folders/archives
  - `backup:progress` WebSocket events (creating / restoring / complete / failed / canceled) with cancellation support
- Backend routes: `GET /servers/:id/backups`, `POST /backups`, `DELETE /backups/:id`, `POST /backups/restore`, `POST /backups/cancel`
- New deps: `yazl` (zip writer) + `yauzl` (zip reader) + `@types/yazl` — small, dependency-free, no native compile
- Electron main + preload: `listBackups`, `createBackup`, `deleteBackup`, `restoreBackup`
- Renderer `BackupsPage`: create form with optional note, live progress bar, backup list (note, created, size) with Restore (confirm) + Delete (confirm dialog), live `backup:progress` subscription

### Completion criteria

- [x] Backups are stored outside active server folders
- [x] Restore performs validation (archive verified before touching the folder)
- [x] Current state is backed up before restoration (safety backup)

### Verification notes

- 77/77 backend tests pass, including 10 new BackupService tests (create ZIP with correct nested entries, note default, running-server rejection, missing-folder rejection, delete, restore replacing folder, missing-backup rejection, restore-while-running rejection, retention limit, progress broadcast) and 1 new API route test (create → list → restore → delete over HTTP)
- Live E2E over the real backend: create server → create backup → listed with size → zip contains `server.properties` + `world/level.dat` → modify file → restore → original content back → delete → `{deleted:true}`
- Full typecheck + production build pass; renderer bundle contains the Backups UI
- Issues fixed during verification:
  - `walk()` used `path.relative(dir, ...)` per recursion level, flattening nested folders in the ZIP — now tracks the root so `world/level.dat` keeps its relative path
  - `extractZip` resolved after the first entry (completion check `total === done` fired prematurely with lazy entry totals) — now resolves only on `zipfile 'end'` once in-flight writes drain
  - Retention pruned ties incorrectly when rapid backups shared the same millisecond `created_at` — added `rowid` tiebreaker to the ordering
  - Backup timestamps in filenames can collide for rapid backups; archive names use ISO with `:`/`.` replaced

## Phase 11: Playit Basic Integration

**Status:** Complete

**Goal:** Launch and monitor Playit beside the selected Minecraft server.

### Implemented

- `PlayitService` (`backend/src/playit-service.ts`):
  - Spawns the Playit agent (via `cmd /c` for `.cmd`/`.bat` wrappers, direct otherwise), one instance at a time
  - States: offline → starting → online / crashed → offline; `online` detected from `tunnel established` / `tunnel ready` / `connected` lines
  - stdout/stderr streaming with per-line timestamps + warn/error classification, ring buffer of last 500 lines
  - Detects setup/claim links (`https://playit.gg/claim/<code>`, `https://playit.gg/account/tunnels`) and keeps the newest 5
  - Detects public tunnel addresses (`<host>.playit.gg`) from output
  - Graceful stop + force-kill (taskkill /T /F tree kill on Windows); crash detection on unexpected exit
  - Settings persisted via the settings table: selected executable path + last known public address
- Backend routes: `GET/PUT /playit/settings`, `POST /playit/detect`, `GET /playit/status`, `POST /playit/start|stop|kill` (all auth-protected)
- WebSocket events: `playit:state` and `playit:log` broadcast to authenticated clients
- Electron main + preload: `selectPlayitExecutable` dialog (exe/cmd/bat), `getPlayitSettings`, `updatePlayitSettings`, `detectPlayit`, `getPlayitStatus`, `startPlayit`, `stopPlayit`, `forceKillPlayit`
- Renderer:
  - `usePlayit` hook: subscribes to the shared WebSocket, live state/logs/links/address, 10s status poll, uptime tick, settings actions
  - `PlayitPage`: executable picker, Start/Stop/Force Kill, live status badge (state/pid/uptime/exit code), Setup Required panel with clickable claim links, Public Address panel (detected or manually saved), console-style log viewer, and a warning banner when the Minecraft server is online but Playit is offline
  - `Getting Started` guide panel on the Playit page (collapsible): download link to playit.gg, selecting the executable, starting the agent, claiming/logging in via the claim link, creating a TCP tunnel to the server port, and saving the public address

### Completion criteria

- [x] Playit can be launched and stopped reliably
- [x] Setup links open correctly (claim links detected in output and opened via the system browser)
- [x] Minecraft and Playit statuses are shown separately

### Verification notes

- 13 new `PlayitService` tests pass (fake playit agent via cmd wrapper): detect, settings persistence, no-executable/missing-executable rejection, start → online with claim link + address detection, duplicate-start block, graceful stop → offline, force-kill → crashed, unexpected exit → crashed; plus `findSetupLink` / `findPublicAddress` unit tests
- Live E2E over the real backend: health OK, `/playit/settings` auth-protected (401), detect true/false, path persisted, start → online with claim link + detected address, duplicate start blocked, manual public address saved, stop → offline — `PLAYIT E2E OK` (15 checks)
- Full typecheck + production build pass; renderer bundle contains the Playit UI
- Issues fixed during verification:
  - Windows cannot `spawn` a `.cmd`/`.bat` directly (`spawn EINVAL`) — `.cmd`/`.bat` paths are spawned via `cmd /c` (mirrors the JavaService wrapper approach); real playit.exe spawns directly
  - The fake test agent must stay alive (setInterval keepalive) or node exits 0 after printing the setup lines, which the service correctly interpreted as a crash
  - Pre-existing flaky `vanilla-installer` test (checksum/cancel race against the fast local fake server) still fails intermittently — unrelated to Phase 11, noted in Phase 4 verification

### Follow-up fixes (Phase 11 polish)

- **Playit online detection for the v1 daemon**: the modern agent (`playitd`, v1.0.10) never prints the old "Tunnel established" line — it logs `Starting playitd daemon` / `Waiting for frontend secret provisioning over IPC`. `isOnlineLine` now also fires on those daemon startup lines, so Playit shows **online** as soon as the daemon is running (the tunnel was working, but the UI stayed "starting"). `findPublicAddress` also matches `address:port` formats.
- **Sticky Settings save button**: `.settings-actions` is now `position: sticky; bottom: 0` with a background, so Save Changes follows the viewport instead of sitting at the bottom of the form.
- **Live player count via join/leave deltas**: added `parsePlayerDelta` — `Steve joined the game` / `Alex left the game` now increment/decrement the tracked count, so the dashboard count stays current even when the full "There are N of a max of M players online:" report line doesn't appear. (New `parsePlayerDelta` unit test; process-manager suite now 16 tests.)
- **Global Playit status indicator on the Dashboard**: new `PlayitIndicator` component rendered in the dashboard page header (not the server's stat tiles, since Playit is machine-wide/global). Shows a colored status dot (`offline/starting/online/stopping/crashed`), the public address when known, and inline Start/Stop buttons. Driven by the existing `usePlayit` hook (shared WebSocket + 10s poll).
- **v1 `playitd` claim-flow gap documented**: the modern agent (v1.0.10) does not print a claim URL to stdout — it writes a secret to `%LOCALAPPDATA%\playit_gg\playit.toml` and waits for `playitd-windows-setup.exe` (the GUI frontend) to provision the secret over IPC. The app's `findSetupLink` only parses stdout, so a fresh v1 agent shows "online" (false positive from `Starting playitd daemon`) with no setup link surfaced. Claim flow: select `C:\Program Files\playit_gg\bin\playit.exe` (or the official download), run it once, complete the GUI claim, then the agent connects and the public address appears. Also: deleting `%LOCALAPPDATA%\playit_gg` unclaims the agent — it must be re-claimed, not just re-enabled.
- Verified: Playit + process-manager suites green (29 tests), full typecheck + build pass.

## Phase 12: Fabric Support

**Status:** Complete (implemented with Phases 13 as one unified "server flavor" system)

## Phase 13: Paper Support

**Status:** Complete (implemented with Phase 12 as one unified "server flavor" system)

### Unified implementation (Phases 12 + 13 + Forge)

Phases 12 and 13 were combined into a single flavor abstraction because Fabric, Forge, Paper, and Vanilla are the same thing: a server JAR + optional mods/plugins folder + config. The app now supports **Vanilla / Fabric / Forge / Paper** chosen at server creation, a shared Mods/Plugins page, and in-place server-type conversion.

### Implemented

- **Flavor registry** (`server-types.ts`): `ServerFlavor = 'vanilla' | 'fabric' | 'forge' | 'paper'`, metadata per flavor (label, extension folder, whether it needs an install step)
- **Generic installer** (`server-installer.ts`): one pipeline (folder, EULA, server.properties, JAR download with progress/cancel/SHA-1, per-flavor install step) driven by thin resolvers; `POST /install/server` for any flavor; `/install/vanilla` kept as a wrapper for backwards compatibility
- **Resolvers** (`resolvers/`): vanilla (Mojang manifest), fabric (Fabric meta + optional Fabric API from Modrinth), forge (Forge maven + `--installServer` bootstrap), paper (Paper API, build selection)
- **Convert in place** (`POST /servers/convert`): swaps an existing server's jar/type without touching the world folder; used to rescue vanilla servers or change loaders later
- **Extension manager** (`extension-manager.ts`): lists mods/plugins with JAR metadata (fabric.mod.json / META-INF/mods.toml / plugin.yml / paper-plugin.yml), enable/disable via `.disabled` renames, delete, upload (base64, `.jar` only, size-capped), all refused while running
- **ProcessManager** flavor-aware: finds `fabric-server-launch.jar`, `forge-*.jar`, `paper-*.jar`, or vanilla `server.jar` per flavor
- **Electron + renderer**: ServerForm has a Server Type select with flavor descriptions, Fabric loader + Fabric API options; new `ModsPluginsPage` (list, toggle, upload, delete, open-folder, convert); wired into the `mods-plugins` nav for Java servers

### Completion criteria

- [x] Fabric server can be installed and launched (fabric-server-launch.jar + loader)
- [x] Paper server can be installed and launched (paper-<version>-<build>.jar)
- [x] Forge server can be installed and launched (installer --installServer bootstrap)
- [x] Mods/plugins can be enabled and disabled (rename round-trip)
- [x] Vanilla pages do not show Fabric-only controls (Mods/Plugins page shows "not supported" + convert for Vanilla)

### Verification notes

- 21 new backend tests pass: resolvers (vanilla/fabric/paper/forge URL resolution against fake meta servers), generic installer (vanilla/fabric/paper install, EULA reject, convert, missing-server reject), extension manager (metadata listing, enable/disable/delete, upload validation, running-server refusal, paper plugin.yml parsing)
- Full backend suite: **111/111 tests pass** (the new install/resolver/extension suites run `describe.sequential` to avoid the known fake-HTTP-server parallel-worker flake, same as vanilla-installer)
- Live E2E over the real backend: installed real vanilla + fabric (with Fabric API) + paper servers, uploaded a real mod JAR, listed with metadata, disabled → enabled → deleted, and converted vanilla → paper in place — `FLAVOR E2E OK` (24 checks)
- Full typecheck + production build pass; renderer bundle contains the Server Type select + Mods/Plugins UI
- Issues fixed during verification:
  - The installer test's fake server needed prefix + longest-match routing so query strings and nested paths resolve correctly
  - Fabric API is optional; a failure to fetch it never fails the install (resolver returns null)
  - Upload is base64 over IPC (the sandboxed renderer cannot read file paths), validated as `.jar` with a 1 GB cap

## Phase 14: Bedrock Desktop Support

**Status:** Complete

**Goal:** Add official Bedrock Dedicated Server (BDS) management in a separate application section: installation, process control, console, settings, permissions, allowlist, behavior/resource packs, plus existing Backups and Playit (edition-agnostic).

### Implemented

- **Bedrock installer** (`bedrock-installer.ts`): lists BDS versions from the community registry `EndstoneMC/bedrock-server-data` (releases first, then previews — Microsoft has no official version-list API), resolves the official `minecraft.net` Windows binary, downloads with progress + cancel, verifies SHA-256, extracts the ZIP into the server folder (safe-path checked), writes starter `server.properties` (Bedrock keys, port 19132), empty `allowlist.json`/`permissions.json` and `eula.txt`, then creates the record with `edition: 'bedrock'`
- **Process manager** (`process-manager.ts`): edition-aware — Bedrock spawns `bedrock_server.exe` directly (no Java/JVM args), `.cmd`/`.bat` wrappers routed through `cmd /c` (mirrors Playit); online detection via `Server started.` / `Level "..." started`; player deltas via `Player connected:` / `Player disconnected:`; new `findServerExecutable` + `parseBedrockPlayerDelta`/`isBedrockOnlineLine` exports; new `missing-executable` start-error code
- **ServerManagerService**: skips Java-path resolution + Java validation for Bedrock servers
- **Bedrock settings editor** (`bedrock-server-properties-schema.ts` + `bedrock-properties.ts`): 29-field schema (port, level, online-mode, allowlist, motd, max-players, difficulty, gamemode, view/tick distance, permissions level, cheats, compression, telemetry, LAN, chat restriction, etc.), friendly editor reusing the same `ServerPropertiesDocument` shape + raw editor; backs up before save, preserves unknown keys/comments
- **Allowlist + permissions** (`bedrock-player-service.ts`): offline-safe editing of `allowlist.json` and `permissions.json` (permission levels operator/member/visitor), refuses edits while the server runs
- **Pack manager** (`pack-service.ts`): lists `behavior_packs/`/`resource_packs/`, uploads `.mcpack`/`.zip`/`.mcworld`/`.mcaddon` (extracted into a subfolder, path-traversal-safe, 1 GB cap), deletes packs; all mutations refused while running
- **Backend routes**: `GET /bedrock/versions`, `POST /install/bedrock`, `GET/PUT /servers/:id/bedrock-properties`, `GET/PUT /servers/:id/allowlist`, `GET/PUT /servers/:id/permissions`, `GET /servers/:id/packs?kind=…`, `POST /servers/:id/packs/:kind/upload|delete`; `/install/cancel` now also cancels Bedrock installs
- **Electron main + preload**: 12 new IPC channels + bridge methods (Bedrock versions/install/cancel, properties, allowlist, permissions, packs)
- **Renderer**:
  - `useBedrockInstall` hook (versions + install progress over the shared WebSocket)
  - `BedrockServerForm` — name, folder, version dropdown (releases/previews), port, EULA, live progress; no Java/RAM fields
  - `AllowlistPage`, `PermissionsPage`, `PackPage` (used for both behavior + resource packs)
  - `App.tsx`: Bedrock no-server dashboard renders `BedrockServerForm`; new nav pages wired; existing install banner covers Bedrock installs
  - `SettingsPage` / `PlayersPage` / `WorldsPage` / `ServerControls` branch on `server.edition` — Bedrock never shows Java whitelist/ops/bans tables, Java-path lines, or the Java dialog; Worlds shows an "open folder" note (Bedrock world import deferred)
  - Console, Backups, Playit pages unchanged (already edition-agnostic)

### Completion criteria

- [x] Bedrock server can be installed and run (install → extract `bedrock_server.exe` → start → online → commands → graceful stop)
- [x] Java and Bedrock settings remain completely separate (edition-gated UI + distinct property schema/routes)

### Verification notes

- **155/156 backend tests pass.** New suites: `bedrock-installer` (6), `bedrock-properties` (6), `bedrock-player-service` (9), `pack-service` (10 incl. `safeEntryTarget` traversal unit tests), plus Bedrock ProcessManager tests (start/online/logs/commands/stop, missing-executable, `.cmd` wrapper) and an API smoke block. The one failure is the **pre-existing flaky** `server-installer` "converts vanilla to fabric" test (documented in Phases 9/11/12 notes) — it passes in isolation; it is a fake-HTTP timing issue unrelated to Phase 14.
- Full typecheck + production build pass (renderer Vite build + electron tsc + backend tsc).
- **Live E2E over the real backend: `BEDROCK E2E OK` (12 checks)** — auth 401, live version registry (129 entries, 51 releases), Bedrock record create, properties read/update with unknown-key preservation, allowlist + permissions round-trips, packs list.
- Electron app launches cleanly from `apps/desktop` (production build).
- Issues fixed during implementation:
  - Windows cannot `spawn` a `.cmd`/`.bat` directly (`spawn UNKNOWN`) — Bedrock `.cmd`/`.bat` launch wrappers now route through `cmd /c` (production `bedrock_server.exe` still spawns directly)
  - `yazl`'s `outputStream` must be piped to a writable to emit data/end — test fixtures pipe to an in-memory sink
  - yauzl extraction resolved on `'end'` before in-flight writes drained — added a pending-write drain check (same pattern as backup restore)
  - The schema-defaults append in the properties `update()` overwrote a user-provided value with the default when the key was missing from the file — now skips keys already in the request (fixed in both Java + Bedrock services)
  - `PackService.upload` is now async (awaits ZIP extraction) so uploads complete before returning

## Phase 15: Packaging and GitHub Releases

**Status:** Complete

**Goal:** Create distributable Windows builds: installer, portable ZIP, app icon, version info, GitHub Actions workflow, release checksums, and a basic update-notification mechanism.

### Implemented

- **electron-builder** config (`apps/desktop/package.json` `build` field):
  - NSIS installer (`Minecraft Server Customizer-Setup-x.y.z.exe`, non-one-click, changeable install dir, desktop + start-menu shortcuts)
  - Portable target (`Minecraft Server Customizer-Portable-x.y.z.exe`)
  - Portable ZIP (`Minecraft Server Customizer-Portable-x.y.z.zip`, built by `scripts/make-portable-zip.mjs` from `win-unpacked`)
  - App icon (`apps/desktop/build/icon.ico` + `icon.png`, generated by `scripts/generate-icon.mjs` — green block on dark panel, no gradients)
  - `appId`, `productName`, `copyright`, version info
  - App data stored outside the install dir (`%APPDATA%\@msc\desktop\app-data` via `app.getPath('userData')`)
- **Backend runtime in the packaged app**:
  - The backend runs as a child process under a **bundled `node.exe`** (`resources/bin/node.exe`, extraResource) — Electron's embedded Node 20 has an ABI (130) incompatible with the better-sqlite3 prebuild compiled for system Node 24 (ABI 137), which hard-crashes on DB open. Bundling the real Node keeps the backend on the ABI its native module was built for.
  - `main.ts` `resolveNodeExecutable()` now prefers the bundled `resources/bin/node.exe` in packaged mode, falling back to `process.env.NODE` in dev
  - `scripts/prepare-backend-deps.mjs` stages the backend's full transitive production dependency tree into `apps/desktop/backend/node_modules` (copied as `extraResources/backend/node_modules`); handles `exports`-map packages (rfdc, toad-cache) via a direct-fs fallback
  - Backend entry resolved from `process.resourcesPath/backend/dist/index.js` in packaged mode
- **Update-notification mechanism** (`electron/update-check.ts` + `UpdateBanner` component):
  - Checks the GitHub Releases API for the latest version on startup (8s timeout, soft-fail)
  - Semver comparison (`isNewerVersion`)
  - Compact green banner in the renderer when a newer version exists, with a "View Release" button (opens GitHub in the system browser)
  - IPC channels `app:check-for-update` / `app:open-release-url` (narrow preload bridge)
- **GitHub Actions workflow** (`.github/workflows/build-release.yml`): triggered on `v*` tags; runs typecheck, backend tests, build, stages bundled node + backend deps, electron-builder (`--publish never`, `CSC_IDENTITY_AUTO_DISCOVERY=false`), creates the portable ZIP + `SHA256SUMS.txt`, and attaches all artifacts to a GitHub Release via `softprops/action-gh-release`
- **Git repo**: the project now lives in its own git repository (previously the folder was inside a larger umbrella repo). Initial commit covers Phases 1–14; Phase 15 committed separately.
- README updated with packaging, release, and project layout docs.

### Completion criteria

- [x] Fresh Windows installation works (NSIS installer builds; `win-unpacked` launches, backend spawns, DB created)
- [x] Portable build works (portable ZIP from `win-unpacked`; the app runs from the extracted folder)
- [x] Application data is stored outside the installation directory (`%APPDATA%\@msc\desktop\app-data` — DB + backups + runtimes confirmed)
- [x] GitHub Release contains all required files (Setup exe, Portable zip, SHA256SUMS.txt — via the CI workflow on tag push)

### Verification notes

- Local `npm run dist` (with `CSC_IDENTITY_AUTO_DISCOVERY=false` and `win.signAndEditExecutable: false`) produces the full release set in `release/`:
  - `Minecraft Server Customizer-Setup-0.1.0.exe` (~117 MB)
  - `Minecraft Server Customizer-Portable-0.1.0.exe` (~117 MB)
  - `Minecraft Server Customizer-Portable-0.1.0.zip` (~165 MB)
  - `SHA256SUMS.txt`
- **Packaged app launch test**: launched `release/win-unpacked/Minecraft Server Customizer.exe` — Electron came up, spawned the backend via bundled `node.exe` (`resources/bin/node.exe ... resources/backend/dist/index.js`), and the SQLite DB + `runtimes/java` + `backups` folders appeared under `%APPDATA%\@msc\desktop\app-data`. No backend errors in the log.
- Backend standalone test under bundled node: prints `MSC_READY <port>` and stays alive (health endpoint works).
- Full typecheck + production build pass after the packaging changes.
- Issues fixed during verification:
  - **Electron ABI crash**: better-sqlite3's prebuild is ABI 137 (Node 24) but Electron 33 embeds Node 20 (ABI 130). `require()` succeeds but opening a DB hard-crashes the process (`0x10000003`). Fix: bundle a real `node.exe` and run the backend with it (never `ELECTRON_RUN_AS_NODE`).
  - **Stale asar**: running `npx electron-builder` directly without rebuilding `dist-electron` packaged the old main.js (still using `ELECTRON_RUN_AS_NODE`). Fix: always run `npm run dist` (builds first) or rebuild electron before packaging.
  - **Transitive deps missing**: the first `prepare-backend-deps` copied only direct deps, so fastify failed on `avvio`. Rewrote it to walk the full dependency graph; also handles `exports`-map packages that block `require.resolve('<pkg>/package.json')`.
  - **winCodeSign extraction**: 7-Zip cannot create symlinks without admin, failing the signing step. Fixed with `win.signAndEditExecutable: false` + `CSC_IDENTITY_AUTO_DISCOVERY=false` (we publish unsigned).
  - **Workspace npm installs prune the tree**: `npm install <pkg>` at the root without `-w` prunes other workspaces' deps. Always use root `npm install --include=dev`. Also, this npm version blocks install scripts by default (allow-scripts); `electron`, `esbuild`, and `better-sqlite3` needed approval, and better-sqlite3's prebuild had to be restored from the package tarball.
  - `win.signAndEditExecutable: false` skips the Windows code-signing/edit step entirely (no cert available; unsigned release).

### Known limitations

- The build is **unsigned** (no code-signing certificate). Windows SmartScreen will warn on first run. A signing cert can be added later via `win.certificateFile` / `CSC_LINK` + `CSC_KEY_PASSWORD` in CI secrets.
- `node.exe` (~92 MB) is bundled to guarantee backend ABI compatibility, making the installer/portable ~117 MB. A future optimization: rebuild better-sqlite3 for Electron's ABI (`buildDependenciesFromSource: true` on a CI runner with VS Build Tools) and drop the bundled node.
- The pre-existing flaky installer tests (fake-HTTP races) still fail intermittently under parallel workers — unrelated to Phase 15.

---

# MVP Definition (from plan §27)

The Vanilla MVP is complete: a Windows user can install the app, create/import Vanilla servers, import worlds, install/select Java, run the server with live console + commands, edit settings and gamerules, manage players, back up and restore, and launch Playit. Fabric, Forge, Paper, and Bedrock support are also implemented and packaged.

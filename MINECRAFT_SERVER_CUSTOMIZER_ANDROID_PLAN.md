# Minecraft Server Customizer — Android Mobile Roadmap

## Project Goal

Build an **Android version of Minecraft Server Customizer** that can host and manage **Minecraft Java Edition servers directly on an Android phone**.

The mobile version should reuse as much of the existing desktop project's design language, shared types, configuration knowledge, and user experience as practical, while keeping Android-specific hosting logic separate.

The desktop application is already considered stable. Mobile development must **not destabilize the desktop release**.

---

# 1. Repository Strategy

## Use the Same Repository

Keep the Android version inside the existing repository instead of creating an unrelated second repository.

Recommended structure:

```text
Maria-MC_Server_Customizer/
├── apps/
│   ├── desktop/
│   │   ├── electron/
│   │   ├── renderer/
│   │   └── backend/
│   │
│   └── mobile/
│       ├── android/
│       ├── renderer/
│       └── native/
│
├── packages/
│   ├── shared-types/
│   ├── shared-ui/
│   ├── minecraft-config/
│   └── minecraft-versions/
│
├── docs/
├── scripts/
└── .github/
```

Do **not** rewrite or move the stable desktop app just to make the structure look cleaner.

Refactor shared code only when it becomes genuinely useful to both applications.

---

# 2. Development Folder Strategy

## Recommended: Separate Worktree Folder

Do not develop the Android version directly inside the same working folder used for the stable desktop branch.

Use the same Git repository but create a separate Git worktree.

Example:

```powershell
cd "C:\GitHub Repos\Maria-MC_Server_Customizer"

git switch main
git pull

git branch mobile-dev

git worktree add "..\Maria-MC_Server_Customizer-Mobile" mobile-dev
```

Result:

```text
C:\GitHub Repos\
├── Maria-MC_Server_Customizer\
│   └── stable desktop/main checkout
│
└── Maria-MC_Server_Customizer-Mobile\
    └── mobile-dev checkout
```

This gives the project:

- One GitHub repository
- Shared commit history
- Separate working folders
- Separate branches
- No accidental mobile changes inside the stable desktop checkout
- Easy cherry-picking of shared fixes between branches

### Branch Recommendation

```text
main
├── stable desktop releases
│
└── mobile-dev
    ├── feature/mobile-shell
    ├── feature/android-runtime
    ├── feature/mobile-server-process
    ├── feature/mobile-console
    └── ...
```

Do not merge `mobile-dev` into `main` until mobile development is structurally clean enough that the repository can safely contain both applications.

---

# 3. Mobile Platform Scope

## Initial Platform

Support:

```text
Android
```

Do not target iOS during the first mobile implementation.

Reasons:

- Android provides significantly more flexibility for local files and long-running foreground services.
- Java server hosting is much more realistic on Android.
- iOS process restrictions would make the project unnecessarily difficult.
- The immediate goal is proving that Minecraft Java hosting works reliably on phones.

---

# 4. Edition Priority

## Mobile Release Priority

### Priority 1

```text
Minecraft Java Edition — Vanilla
```

### Priority 2

```text
Fabric
```

### Priority 3

```text
Paper
```

### Priority 4

```text
Forge
```

### Not Initial Scope

```text
Official Bedrock Dedicated Server hosting on Android
```

The official Bedrock Dedicated Server does not have a normal Android build.

If Bedrock hosting is ever added, it must be clearly labeled according to the implementation used rather than being falsely presented as the official Vanilla Bedrock server.

---

# 5. Core Architecture

Recommended mobile architecture:

```text
React + TypeScript
        │
        ▼
Capacitor
        │
        ▼
Native Android Plugin / Kotlin Layer
        │
        ▼
Android Foreground Service
        │
        ▼
Android-compatible Java Runtime
        │
        ▼
Minecraft server.jar
```

## Responsibility Split

### React / TypeScript

Responsible for:

- User interface
- Navigation
- Forms
- Server creation wizard
- Settings screens
- Gamerule editor
- Console presentation
- Backup interface
- Player management interface
- Server status UI
- Shared validation where practical

### Capacitor

Responsible for:

- Packaging the React application as Android
- Bridging React with native Kotlin functionality
- Android permissions
- File picker integration
- Native plugin communication

### Kotlin Native Layer

Responsible for:

- Starting Java processes
- Stopping Java processes
- Monitoring process state
- Streaming stdout and stderr
- Writing commands to stdin
- Foreground service management
- Wake locks
- Runtime downloads
- File operations requiring native Android support
- Storage access
- Process cleanup
- Android notifications
- Device RAM information
- Battery/thermal awareness

Do **not** attempt to implement the Minecraft hosting engine entirely in browser JavaScript.

---

# 6. Shared Code Strategy

Reuse concepts and code from desktop where reasonable.

Good candidates for shared packages:

```text
packages/
├── shared-types/
├── minecraft-config/
├── minecraft-versions/
└── shared-ui/
```

Potential shared items:

- Server flavor enums
- Minecraft version metadata
- Java-version requirement mapping
- Server configuration schemas
- `server.properties` parser
- Gamerule definitions
- Validation functions
- Backup metadata types
- Server state enums
- Minecraft loader metadata
- Common UI components
- Status badges
- Form controls

Do **not** force desktop Electron APIs into the mobile version.

Desktop process management and Android process management should remain different implementations behind similar interfaces.

Example:

```ts
interface ServerHost {
  startServer(...): Promise<void>
  stopServer(...): Promise<void>
  restartServer(...): Promise<void>
  sendCommand(...): Promise<void>
}
```

Implementations:

```text
DesktopServerHost
AndroidServerHost
```

---

# 7. Mobile UI Direction

Keep the existing identity:

- Green and black palette
- No gradients
- Compact spacing
- Functional layout
- Small controls
- Minimal wasted space
- Clear status indicators
- No giant mobile cards
- No oversized padding

## Suggested Bottom Navigation

```text
Dashboard
Console
Players
Settings
More
```

### More Menu

```text
Worlds
Gamerules
Backups
Mods
Plugins
Logs
Connectivity
App Settings
```

Hide irrelevant sections depending on server software.

Examples:

```text
Vanilla
├── Datapacks
└── No Mods / Plugins tabs

Fabric
├── Mods
└── Datapacks

Paper
├── Plugins
└── Datapacks
```

---

# 8. PHASED IMPLEMENTATION RULE

## Critical Rule

**DO NOT IMPLEMENT THE ENTIRE MOBILE APPLICATION IN ONE PROMPT OR ONE CODING SESSION.**

Each phase must:

1. Have one focused goal.
2. Build on the previous completed phase.
3. Compile successfully.
4. Pass relevant tests.
5. Be manually tested.
6. Be committed before beginning the next major phase.

If a phase reveals architectural problems, fix them before continuing.

Do not allow the coding agent to jump ahead unless the current phase works.

---

# 9. Phase 0 — Mobile Repository Preparation

## Goal

Prepare the repository for mobile development without changing desktop behavior.

Tasks:

- Create `mobile-dev` branch.
- Create separate Git worktree.
- Add `apps/mobile/`.
- Do not modify desktop runtime behavior.
- Audit reusable types.
- Identify Windows-only code.
- Document candidate shared modules.

Possible structure:

```text
apps/mobile/
├── src/
├── android/
├── public/
├── capacitor.config.ts
├── package.json
└── tsconfig.json
```

### Completion Criteria

- Desktop still builds.
- Desktop tests still pass.
- Mobile folder exists.
- Mobile has no server-hosting logic yet.
- No unnecessary desktop refactors.

---

# 10. Phase 1 — Android Application Shell

## Goal

Create a basic Android application using the existing visual language.

Tasks:

- React
- TypeScript
- Vite
- Capacitor
- Android project generation
- Green/black theme
- Compact mobile layout
- Bottom navigation
- Placeholder screens

Screens:

```text
Dashboard
Console
Players
Settings
More
```

No Minecraft server hosting yet.

### Completion Criteria

- APK builds.
- APK installs.
- App opens.
- Navigation works.
- No desktop code broken.

---

# 11. Phase 2 — Native Android Bridge

## Goal

Prove communication between React and Kotlin.

Create a small Capacitor plugin.

Test calls:

```text
getDeviceInfo()
getMemoryInfo()
getStorageInfo()
getAppDataDirectory()
```

Return:

- total RAM
- available RAM
- Android version
- architecture
- available storage
- app server directory

### Completion Criteria

React can call Kotlin and display native device information.

Do not continue until this bridge is reliable.

---

# 12. Phase 3 — Android Storage Model

## Goal

Create a safe server storage system.

Recommended app-managed structure:

```text
MinecraftServerCustomizer/
├── servers/
│   └── <server-id>/
├── backups/
├── runtimes/
├── downloads/
├── logs/
└── app-data/
```

Use Android's supported storage APIs.

Allow:

- Import existing server
- Import world ZIP
- Export server
- Export backup
- Choose files using Android document picker

Avoid demanding broad filesystem permissions unless absolutely required.

### Completion Criteria

- Create server directory.
- Import/export test file.
- Delete test server.
- Paths cannot escape approved directories.

---

# 13. Phase 4 — Java Runtime Manager

## Goal

Allow Minecraft Java servers to run without requiring users to install Java manually.

Requirements:

- Detect CPU architecture.
- Support Android ARM64 first.
- Download compatible Java runtimes on demand.
- Verify downloaded archives.
- Extract into app runtime directory.
- Maintain runtime metadata.
- Allow multiple Java major versions.

Initial target runtimes:

```text
Java 8
Java 17
Java 21
Java 25
```

Only download a runtime when needed.

Example:

```text
runtimes/
├── java8/
├── java17/
├── java21/
└── java25/
```

## User Notice

Before downloading:

```text
Java Runtime Required

Minecraft <version> requires Java <major>.

Minecraft Server Customizer can download a private runtime for this server.

The runtime is stored only inside the app's data directory.

[Download Runtime]
[Cancel]
```

### Completion Criteria

- Runtime downloads.
- Runtime verifies.
- Runtime extracts.
- `java -version` executes successfully.
- Output is returned to the UI.

Do not start Minecraft yet.

---

# 14. Phase 5 — Minimal Java Process Test

## Goal

Prove that Android can execute and manage a Java process.

Use a tiny test JAR before Minecraft.

Requirements:

- Spawn Java
- Read stdout
- Read stderr
- Send stdin
- Detect exit
- Kill process
- Return PID/state

### Completion Criteria

A test Java process can be:

```text
started
communicated with
stopped
force-killed
```

This is one of the most important architecture checkpoints.

---

# 15. Phase 6 — Android Foreground Service

## Goal

Keep a server process alive while the app is backgrounded or the screen is off.

Implement:

- Android foreground service
- Persistent hosting notification
- Process ownership
- Wake lock where necessary
- Notification controls

Example notification:

```text
Minecraft Server Customizer

Survival is running
Vanilla • 2 / 10 players • 1h 42m

[Open]
[Stop]
```

The foreground service must remain the authoritative owner of the Minecraft process.

The React UI should connect to the service instead of owning the process itself.

### Completion Criteria

- Start test Java process.
- Lock phone.
- Leave app.
- Process remains running.
- Return to app.
- UI reconnects to running process.
- Stop from notification works.

---

# 16. Phase 7 — Vanilla Minecraft Installation

## Goal

Create a Vanilla Minecraft server.

Server creation flow:

```text
Create Server
    ↓
Java Edition
    ↓
Vanilla
    ↓
Minecraft Version
    ↓
Server Name
    ↓
RAM
    ↓
World Options
    ↓
EULA Notice
    ↓
Create
```

Requirements:

- Minecraft version discovery
- Server JAR download
- Version metadata
- Required Java detection
- Runtime download prompt
- EULA flow
- Initial `server.properties`
- Server registration

### Completion Criteria

A newly created Vanilla server reaches:

```text
Done
```

in console output.

A second Minecraft client on the same LAN can connect.

---

# 17. Phase 8 — Server Process Manager

## Goal

Build real lifecycle management.

States:

```text
OFFLINE
STARTING
ONLINE
STOPPING
CRASHED
```

Controls:

```text
Start
Stop
Restart
Force Stop
```

Requirements:

- Prevent duplicate starts.
- Save process state.
- Capture exit code.
- Detect crashes.
- Graceful `stop` command.
- Force kill fallback.
- Clean up stale process records.

### Completion Criteria

Repeated start/stop/restart testing works without zombie processes.

### Implementation tracking note

Core lifecycle controls and foreground-service integration may proceed before the
slow full Vanilla emulator assertion is complete. The Java 17 emulator checkpoint
now has two successful Vanilla start/stop cycles in one instrumentation run,
including a service rebind after clean `OFFLINE` publication. A long-running
zombie-process soak remains a follow-up hardening item for full Phase 8 closure.

---

# 18. Phase 9 — Live Console

## Goal

Provide the familiar desktop console experience.

Features:

- stdout/stderr stream
- Auto-scroll
- Pause scroll
- Search
- Filter
- Command input
- Command history
- Clear display
- Export logs
- Crash highlighting

Optimize rendering so long logs do not make the phone UI lag.

### Completion Criteria

Console remains usable during sustained server output.

---

# 19. Phase 10 — RAM Allocation and Device Safety

## Goal

Make memory configuration phone-aware.

Display:

```text
Total Device RAM
Available RAM
Server Allocation
Recommended Allocation
```

Avoid allocating nearly all system memory.

Initial recommendation logic can be conservative.

Example guidance:

```text
4 GB device
Recommended server allocation: ~1 GB

6 GB device
Recommended: ~2 GB

8 GB device
Recommended: ~3 GB

12 GB device
Recommended: ~4–5 GB
```

Allow advanced manual override with warnings.

Example JVM arguments:

```text
-Xms512M
-Xmx3G
```

Do not default `Xms` to the full `Xmx` amount.

Warnings should include:

- low available memory
- high thermal state
- low battery
- low storage
- overly aggressive RAM allocation

### Completion Criteria

Unsafe memory selections require explicit user acknowledgement.

---

# 20. Phase 11 — Vanilla Settings Editor

## Goal

Port the friendly configuration experience.

Support important `server.properties` values:

```text
MOTD
Gamemode
Difficulty
Hardcore
PvP
Online Mode
Max Players
Server Port
Whitelist
Enforce Whitelist
Spawn Protection
View Distance
Simulation Distance
Allow Flight
Allow Nether
Generate Structures
Command Blocks
Player Idle Timeout
```

Requirements:

- Validation
- Friendly descriptions
- Raw property name
- Restart requirement notice
- Reset to default
- Backup before destructive change

### Completion Criteria

Settings survive server restart and match written configuration.

---

# 21. Phase 12 — Gamerules

## Goal

Provide a searchable gamerule editor.

Examples:

```text
keepInventory
mobGriefing
doDaylightCycle
doWeatherCycle
doFireTick
naturalRegeneration
playersSleepingPercentage
randomTickSpeed
spawnRadius
doImmediateRespawn
commandBlockOutput
```

Make gamerule availability version-aware.

### Completion Criteria

Changes can be applied reliably and reflected by the running server.

---

# 22. Phase 13 — Player Administration

## Goal

Support basic server administration.

Features:

```text
Whitelist
Operators
Banned Players
Banned IPs
Kick
Op
De-op
Whitelist Add
Whitelist Remove
Ban
Pardon
```

Use server commands where appropriate instead of directly rewriting files while the server is running.

### Completion Criteria

Player-management operations work while the server is online.

---

# 23. Phase 14 — Worlds

## Goal

Support mobile-friendly world management.

Features:

- Create default world
- Import Java world
- Export world
- Copy world
- Delete world
- Detect valid Java world structure
- View world metadata where practical

Never host a world directly from an unsafe temporary import location.

Copy imported worlds into the app's managed server library.

---

# 24. Phase 15 — Backups and Restore

## Goal

Protect user worlds before adding more complexity.

Features:

```text
Manual Backup
Pre-configuration Backup
Pre-update Backup
Restore
Delete Backup
Export Backup
Retention Limit
```

Safe restore sequence:

1. Stop server.
2. Verify backup.
3. Back up current state.
4. Restore into temporary directory.
5. Replace server data.
6. Validate files.
7. Update metadata.

### Completion Criteria

Backup and restore tested with a real Minecraft world.

---

# 25. Phase 16 — Fabric Support

## Goal

Add Fabric after Vanilla is stable.

Features:

- Fabric loader installation
- Fabric-compatible runtime checks
- Mods folder
- `.jar` import
- Enable/disable mod
- Fabric metadata inspection
- Duplicate detection
- Basic dependency warnings
- Fabric API notice

Do not build an online mod browser yet.

### Completion Criteria

A simple Fabric server with known mods starts successfully.

---

# 26. Phase 17 — Paper Support

## Goal

Add Paper hosting and plugin management.

Features:

- Paper version installation
- Plugin upload
- Plugin enable/disable
- Paper configuration
- Bukkit configuration
- Spigot configuration
- World configuration
- Mob-cap controls
- Advanced optimization settings

### Completion Criteria

A Paper server with plugins runs reliably.

---

# 27. Phase 18 — Forge Support

## Goal

Support older and modern Forge servers where feasible.

Forge is more complicated because installation behavior differs considerably between Minecraft generations.

Execution priority: implement Forge immediately after Phase 15, before Fabric
and Paper, at the user's request. Keep the version-specific installer and Java
compatibility checks isolated so this priority change does not assume all Forge
versions launch the same way.

Combined implementation note: Forge, Fabric, Paper, and server-pack import may
be delivered as one loader/pack-management batch, sharing runtime checks,
managed `mods`/`config` directories, and launch metadata.

Requirements:

- Version-specific installer logic
- Java compatibility rules
- Mods directory
- Legacy server support
- Installer-generated arguments
- Existing server-pack import

Do not assume all Forge versions launch the same way.

---

# 28. Phase 19 — Server Pack Import

## Goal

Bring desktop server-pack convenience to Android.

Possible formats:

```text
.zip
.mrpack
```

Detection:

- Minecraft version
- Loader
- Required Java
- Launch JAR/script structure
- Mods
- Configs

Never blindly execute imported shell scripts.

Convert recognized packs into safe app-managed launch configurations.

Important cross-platform constraint: some packs contain only `start.bat` (or
`run.bat`) and no root `server.jar`. Android must not execute a Windows batch
file directly because it has no Windows `cmd.exe`. For standard Minecraft
launchers, detect and translate the supported subset (`java`, `-jar`, `@argfile`,
`-X*`, `-D*`, `cd`, `set`, and script-relative paths) into a native Java launch
descriptor, then run the server through the Android Java bridge. This allows
common Forge/Fabric/Paper packs to retain their generated arguments. Scripts
that depend on arbitrary Windows commands, PowerShell, installers, or native
`.exe` programs must stop with an actionable manual-configuration message; a
general Windows emulation layer is not a reliable mobile hosting requirement.

---

# 29. Phase 20 — LAN Connectivity

## Goal

Make LAN hosting easy.

Show:

```text
Local IP
Server Port
LAN Address
```

Example:

```text
192.168.1.42:25565
```

Provide:

```text
Copy Address
Share Address
```

Detect:

- Wi-Fi disconnected
- IP changed
- Port unavailable

### Implementation tracking note

The native Android bridge and mobile Connectivity panel are implemented. The
emulator smoke check reports its local IPv4 address, port `25565`, network type,
and port availability, with copy/share actions available. A physical-device
client connection and deliberate port-conflict check remain follow-up
verification before the next networking prototype.

---

# 30. Phase 21 — Playit Research Prototype

## Goal

Investigate public Internet hosting under CGNAT.

Do not integrate Playit into the main mobile release until Vanilla LAN hosting is stable.

Research:

- Playit agent source
- Android ARM64 compilation
- `aarch64-linux-android`
- Android execution restrictions
- Tunnel configuration
- Agent authentication
- Foreground-service integration

Possible architecture:

```text
Android Foreground Service
├── Minecraft Java process
└── Playit Android-native agent
```

Treat this as experimental until proven reliable.

### Implementation tracking note

Phase 21 research is complete for the x86_64 Android emulator. The official
Playit v1.0.10 Linux binary executes from app-private storage when its socket,
secret, and log paths are redirected into app-private storage, then waits for
frontend secret provisioning over IPC. The app now exposes read-only capability
diagnostics and does not authenticate, create tunnels, or own the agent process.
ARM64 execution and authenticated Playit tunnel/reconnect behavior remain
optional provider research. They are no longer Phase 22 completion gates after
the project switched Phase 22 to the service-free translator design.

---

# 31. Phase 22 — Service-Free TCP Translator

## Goal

Build a clean-room, cross-platform translator that carries Minecraft TCP over
an encrypted direct QUIC connection, with direct TLS/TCP fallback, without
requiring a project-hosted relay or a third-party tunnel service.

The player runs a lightweight PC companion bound to loopback. The Android host,
which may be behind CGNAT, reverses the usual direction and initiates the
connection outward to a player PC that has global IPv6, an automatically mapped
UDP port, or a manually forwarded UDP port. Pairing candidates and one-time
credentials are exchanged by QR/text/file rather than a hosted signaling API.

Subphases:

```text
22A  PC-to-Android direct-path feasibility spike
22B  Versioned translator protocol and threat model
22C  Standalone PC player translator
22D  Android foreground-service host connector
22E  Product integration and PC host support
22F  Optional user-configured reachability extensions
```

Minecraft itself connects only to `localhost` on the player PC. The companion
translates the unchanged TCP byte stream into QUIC or direct TLS/TCP, and the
Android connector delivers it to the local Minecraft server. The core
completion gate must not use Playit, Cloudflare, Tailscale, public STUN, hosted
signaling, or a relay.

This cannot guarantee connectivity when both sides are behind hard/symmetric
CGNAT with no reachable IPv6 or mapped port. Such a topology requires a third
reachable machine; the app must detect and explain it rather than claim an
impossible universal bypass.

Implement the PC translator first as a standalone companion so the stable
desktop product is not modified during the feasibility work. Integrate the
shared core into the PC version only after real-network mobile tests pass.

Do not expose the management UI through the translator. Do not copy or
impersonate a proprietary provider protocol.

The full architecture, security requirements, cost controls, validation matrix,
and completion gates are recorded in:

```text
docs/MSC_TCP_CONNECTIVITY_PLAN.md
```

### Implementation tracking note

The Phase 22A direct TLS 1.3/TCP fallback harness is implemented for Android and
a temporary PC listener. It includes certificate pinning, a one-time test token,
bounded echo frames, foreground/background ownership, reconnect/RTT/byte
counters, and the Connectivity test UI. Automated builds and protocol tests
pass. Physical LAN/mobile-data validation and the real QUIC shared core remain
required before Phase 22A is complete.

---

# 32. Phase 23 — Battery and Thermal Handling

## Goal

Improve real-world hosting reliability.

Monitor where Android APIs allow:

- Battery state
- Charging state
- Thermal status
- Available RAM
- Storage
- Network state

Warnings:

```text
Phone is overheating
Server memory pressure is high
Battery is below 15%
Device is not charging
Storage is nearly full
Wi-Fi disconnected
```

Do not automatically shut down a running server solely because of a warning unless the situation is genuinely unsafe.

---

# 33. Phase 24 — Mobile Crash Recovery

## Goal

Handle app/process interruptions gracefully.

Requirements:

- Persist server state.
- Detect orphaned state.
- Reconnect UI after activity restart.
- Record previous server exit.
- Recover logs.
- Avoid duplicate Java processes.
- Detect Android service termination.
- Explain unexpected server shutdown clearly.

---

# 34. Phase 25 — Android Release Pipeline

Create a separate GitHub Actions workflow.

Example:

```text
.github/workflows/
├── build-release.yml
└── build-android.yml
```

Android output:

```text
Minecraft-Server-Customizer-Android-0.1.0.apk
```

Eventually consider:

```text
APK
AAB
SHA256SUMS.txt
```

GitHub Releases can distribute APKs directly.

No Vercel or web deployment is required.

---

# 35. Mobile Versioning

Keep mobile versions separate from desktop versions initially.

Desktop:

```text
v0.5.2
v0.5.3
v0.6.0
```

Mobile:

```text
android-v0.1.0-alpha.1
android-v0.1.0-alpha.2
android-v0.1.0-beta.1
android-v0.1.0
```

This prevents confusion between desktop maturity and experimental Android releases.

---

# 36. Suggested Mobile Release Milestones

## Android 0.1.0 Alpha

Target:

```text
Android app shell
Native bridge
Runtime installation
Vanilla server creation
Start / stop
Console
LAN connections
Foreground hosting
```

## Android 0.2.0

Target:

```text
Settings
Gamerules
Players
World import
Backups
```

## Android 0.3.0

Target:

```text
Fabric
Mods
```

## Android 0.4.0

Target:

```text
Paper
Plugins
Advanced config
```

## Android 0.5.0

Target:

```text
Forge
Server pack import
Legacy support
```

## Android 0.6.0+

Potential:

```text
Playit
Connectivity diagnostics
Battery/thermal improvements
Performance tuning
```

---

# 37. Features Explicitly Deferred

Do not include these in the first Android implementation:

```text
iOS
Official Bedrock Dedicated Server hosting
Public remote control dashboard
Online mod marketplace
Automatic mod dependency resolution
Cloud server hosting
Multiple simultaneous servers
Automatic router configuration
Playit before LAN hosting works
```

They can be revisited later.

---

# 38. One-Server-at-a-Time Rule

Like the original desktop MVP, Android should initially allow:

```text
Multiple saved servers
One active server at a time
```

Reasons:

- Phone RAM
- CPU limitations
- Battery usage
- Thermal constraints
- Simpler lifecycle handling
- Simpler port management

Do not support simultaneous servers until there is a strong reason.

---

# 39. Security Requirements

The Android implementation must:

- Validate all paths.
- Prevent path traversal.
- Restrict file operations to authorized locations.
- Verify downloads when possible.
- Avoid shell command concatenation.
- Treat imported JARs as untrusted files.
- Never silently execute imported scripts.
- Keep authentication/secrets out of logs.
- Prevent duplicate server processes.
- Use safe ZIP extraction.
- Back up important configuration before modification.
- Require user confirmation before deleting worlds or servers.

---

# 40. Performance Rules

Mobile hardware is more limited than desktop hardware.

Avoid:

- Constant high-frequency polling
- Rendering thousands of console lines at once
- Loading entire large logs into memory
- Repeated full-directory scans
- Blocking filesystem work on the UI thread
- Keeping unnecessary WebViews/components alive
- Excessive React rerenders

Use:

- Buffered log streaming
- Virtualized console rendering
- Background native work
- Cached metadata
- Incremental filesystem operations

---

# 41. Testing Strategy

Each major feature should be tested against at least:

```text
Low-memory Android device / emulator
Mid-range Android phone
Modern ARM64 Android phone
```

Minecraft test versions should include:

```text
Legacy Java 8-era server
Java 17-era server
Java 21-era server
Newest supported server
```

Do not claim general version support based on one modern Vanilla server.

---

# 42. Development Rules for Coding Agents

When providing this plan to Command Code, Codex, DeepSeek, or another coding agent:

## Always Tell the Agent

```text
Work only on the current phase.

Do not implement future phases.

Do not refactor unrelated desktop code.

Inspect the existing repository before changing architecture.

Reuse existing shared types where appropriate.

Keep desktop builds working.

Run type checks/tests before declaring the phase complete.

Summarize all files changed.

Stop after the phase completion criteria are satisfied.
```

## Never Prompt

```text
"Build the Android version."
```

That invites the agent to vomit an entire half-connected architecture into the repository.

Prompt it phase by phase.

---

# 43. First Recommended Task

Start with:

```text
PHASE 0 — Mobile Repository Preparation
```

Then:

```text
PHASE 1 — Android Application Shell
```

Do **not** begin with Minecraft hosting.

The important technical sequence is:

```text
React UI
    ↓
Kotlin bridge
    ↓
storage
    ↓
Java runtime
    ↓
test Java process
    ↓
foreground service
    ↓
Vanilla Minecraft
```

If Java process execution or the foreground service proves unreliable, discovering that before building twenty management screens saves a spectacular amount of wasted work.

---

# 44. Final Architecture Target

```text
Minecraft Server Customizer Repository
│
├── Desktop Application
│   ├── Electron
│   ├── React
│   ├── Fastify
│   └── Node.js process manager
│
├── Android Application
│   ├── React
│   ├── Capacitor
│   ├── Kotlin native layer
│   ├── Android foreground service
│   └── Android Java process manager
│
└── Shared Packages
    ├── Types
    ├── Minecraft metadata
    ├── Configuration schemas
    ├── Validation
    └── Selected UI components
```

The desktop and Android applications should share **knowledge and interfaces**, not blindly share platform-specific implementation.

---

# 45. Recommended Immediate Workflow

```powershell
# Stable desktop checkout
cd "C:\GitHub Repos\Maria-MC_Server_Customizer"

git switch main
git pull

# Create mobile branch
git branch mobile-dev

# Create separate mobile working folder
git worktree add "..\Maria-MC_Server_Customizer-Mobile" mobile-dev

# Enter mobile checkout
cd "..\Maria-MC_Server_Customizer-Mobile"
```

Then give the coding agent **Phase 0 only**.

Once Phase 0 is complete and committed, move to Phase 1.

The goal is not to build the mobile version quickly in one massive pass.

The goal is to reach a point where an Android phone can reliably run a Vanilla Minecraft Java server, keep it alive in the background, and manage it through the same compact Minecraft Server Customizer experience without turning the stable desktop project into collateral damage.

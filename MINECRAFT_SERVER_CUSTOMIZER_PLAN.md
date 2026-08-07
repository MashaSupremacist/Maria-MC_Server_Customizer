# Minecraft Server Customizer

## Project Plan

A Windows-first desktop application for creating, importing, configuring, running, and managing local Minecraft servers through a compact green-and-black interface.

This project must be built in small, testable phases. Do **not** ask the coding agent to implement the entire application in one command.

---

## 1. Product Direction

### Primary platform

- Windows 10 and Windows 11
- Desktop application or launcher
- Distributed through GitHub Releases
- No Vercel, Netlify, or cloud deployment required
- No cloud-hosted Minecraft servers
- All servers, worlds, backups, runtimes, and configuration files remain on the user's computer

### Edition priority

1. Java Edition Vanilla
2. Java Edition Fabric
3. Java Edition Paper
4. Bedrock Dedicated Server

Java and Bedrock must be kept in separate sections of the application. Their settings, files, terminology, and installation processes must not be mixed.

### Initial hosting limitation

- Multiple saved server instances are supported
- Only one server may run at a time in the first release
- The application manages local server processes only
- Playit is used to expose the server through CGNAT
- The administration interface must never be publicly exposed through Playit

---

## 2. Recommended Technology Stack

### Desktop application

- Electron
- React
- TypeScript
- Vite

### Local backend

- Node.js
- Fastify
- WebSockets
- SQLite

### Supporting libraries

- Zod for validation
- Drizzle ORM or better-sqlite3 for SQLite
- YAML parser
- TOML parser
- JSON5 parser
- ZIP library for backups

### Process management

Use `child_process.spawn()` without a shell.

Never build command strings from untrusted values and pass them to `exec()`.

The application must manage:

- Java runtime processes
- Minecraft server processes
- Playit processes
- Bedrock server processes
- Standard output and standard error streams
- Process IDs
- Graceful shutdown
- Forced termination when necessary

---

## 3. Design Requirements

### Visual direction

- Green and black color palette
- No gradients
- Compact layout
- Minimal empty space
- No oversized cards
- No giant landing page
- No decorative marketing sections
- No excessive animation
- Clear status indicators
- Desktop-first layout
- Must remain usable on smaller laptop displays

### Suggested colors

```css
:root {
  --background: #050805;
  --panel: #0b110b;
  --panel-raised: #101810;
  --border: #203524;
  --accent: #39e66d;
  --accent-hover: #62ff8b;
  --text: #e8f5eb;
  --muted: #8da095;
  --danger: #ff5c5c;
  --warning: #e5c34f;
}
```

### Spacing rules

- General spacing: 8px to 12px
- Input height: 32px to 38px
- Maximum border radius: 8px
- Thin borders
- Compact tables
- Monospace console
- No gradients anywhere

---

## 4. Main Application Structure

```text
Minecraft Server Customizer/
├── apps/
│   ├── desktop/
│   │   ├── electron/
│   │   ├── backend/
│   │   └── renderer/
│   └── dashboard/
├── packages/
│   ├── shared-types/
│   ├── config-schemas/
│   ├── minecraft-versions/
│   └── shared-utils/
├── data/
│   ├── instances/
│   │   ├── java/
│   │   └── bedrock/
│   ├── backups/
│   ├── runtimes/
│   │   └── java/
│   ├── playit/
│   └── app-data/
└── docs/
```

The exact structure may change during implementation, but server data must remain separate from application source code.

---

## 5. Main Navigation

### Java Edition

- Dashboard
- Console
- Worlds
- Players
- Settings
- Gamerules
- Datapacks
- Mods or Plugins
- Backups
- Playit

### Bedrock Edition

- Dashboard
- Console
- Worlds
- Players
- Settings
- Permissions
- Allowlist
- Behavior Packs
- Resource Packs
- Backups
- Playit

Only show features that apply to the selected server type.

Examples:

- Vanilla: Datapacks
- Fabric: Mods and Datapacks
- Paper: Plugins and Datapacks

---

## 6. Core User Flow

### First launch

1. Show a short local-hosting explanation
2. Ask the user to select a server library folder
3. Detect installed Java runtimes
4. Detect Playit if installed
5. Offer to create or import a server

### Creating a Java server

1. Enter server name
2. Select Minecraft version
3. Select server software
4. Configure RAM
5. Configure port
6. Select server location
7. Show Java requirement notice
8. Accept the Minecraft EULA
9. Download required files
10. Create the server instance

### Importing a server

1. Select an existing folder
2. Validate the server structure
3. Detect edition and server software
4. Copy or register the folder
5. Read existing configuration
6. Create an application record

### Importing a single-player world

1. Let the user choose a Minecraft saves folder
2. Detect valid worlds using `level.dat`
3. Display discovered worlds
4. Copy the selected world into a server instance
5. Never run the server directly from `.minecraft/saves`

---

## 7. Java Runtime Handling

The application must check whether a compatible Java runtime exists for the selected Minecraft version.

### Required notice

Before downloading Java, show:

```text
Java Runtime Required

This Minecraft version requires Java [version].

The application can download a private Java runtime inside the
Minecraft Server Customizer data folder. This will not replace your
system Java or modify the Windows PATH environment variable.

Download size: [size]
Installation location: [path]

[Install Java] [Choose Existing Java] [Cancel]
```

### Runtime rules

- Prefer private application-managed Java runtimes
- Do not modify the system PATH
- Allow the user to select an existing `java.exe`
- Store the selected runtime per server
- Validate runtime compatibility before starting the server

---

## 8. Vanilla Java Priority

Vanilla must be the default and most polished server path.

### Vanilla creation card

```text
Vanilla
The official Minecraft Java server.
Recommended for the normal Minecraft experience.
```

### Vanilla features

- Official server JAR installation
- EULA handling
- Start, stop, restart, and force-kill
- Live console
- Console command input
- `server.properties` editor
- Gamerule editor
- Whitelist management
- Operator management
- Ban management
- Datapack management
- World import
- Backups
- Playit integration

### Configuration warning

Not every setting is stored in `server.properties`.

The application must be version-aware and should support:

- `server.properties`
- Gamerules
- Whitelist files
- Operator files
- Ban files
- Datapacks

Vanilla does not provide a normal numerical mob-cap configuration system. Do not show fake mob-cap controls for Vanilla.

---

## 9. Fabric Support

Fabric is an optional server type used for mods.

### Fabric features

- Fabric server installation
- Fabric Loader version selection
- Optional Fabric API installation
- Mod upload
- Mod enable and disable
- Mod deletion
- Mod metadata reading
- Basic dependency warnings
- Configuration file editor

### Supported configuration formats

- JSON
- JSON5
- TOML
- YAML
- Properties

Known configuration files may use generated forms. Unknown files should open in an advanced text editor with syntax validation and automatic backups.

---

## 10. Paper Support

Paper is an optional server type used for plugins, performance controls, and advanced server settings.

### Paper features

- Paper server installation
- Plugin upload
- Plugin enable and disable
- Plugin deletion
- Plugin metadata reading
- Paper configuration editor
- Bukkit configuration editor
- Spigot configuration editor
- Mob-cap controls where officially supported

### Relevant files

- `server.properties`
- `bukkit.yml`
- `spigot.yml`
- `config/paper-global.yml`
- `config/paper-world-defaults.yml`
- Per-world Paper configuration files

Paper-specific controls must never appear on Vanilla or Fabric servers.

---

## 11. Bedrock Support

Bedrock must be a separate desktop section.

### Bedrock MVP features

- Install the official Bedrock Dedicated Server
- Import existing Bedrock servers
- Start, stop, restart, and force-kill
- Live console
- Edit Bedrock `server.properties`
- Manage permissions
- Manage allowlist
- Manage behavior packs
- Manage resource packs
- Create and restore backups
- Launch Playit

Do not mix Bedrock and Java settings in the same forms.

---

## 12. Server Process Manager

The process manager is one of the most important systems.

### Required states

- Offline
- Starting
- Online
- Stopping
- Crashed
- Updating

### Required controls

- Start
- Stop gracefully
- Restart
- Force-kill
- Open server folder
- Copy local address
- Copy Playit address

### Required behavior

- Prevent duplicate starts
- Store the current PID
- Stream stdout and stderr
- Detect crashes
- Record exit codes
- Track uptime
- Send console commands through stdin
- Attempt graceful shutdown before force-killing
- Mark unexpected exits as crashes
- Clean up child processes when the app closes

---

## 13. Live Console

### Console features

- Real-time logs
- Search
- Pause auto-scroll
- Clear visible output
- Download logs
- Command input
- Command history
- Crash highlighting
- Error highlighting
- Timestamps

The console must use WebSockets or an equivalent event-based local connection.

Do not poll log files every second unless there is no better option.

---

## 14. Settings Editor

### General Java settings

Friendly controls should cover:

- MOTD
- Game mode
- Difficulty
- Hardcore
- PvP
- Online mode
- Maximum players
- Server port
- Whitelist
- Enforce whitelist
- Spawn protection
- View distance
- Simulation distance
- Allow flight
- Allow Nether
- Generate structures
- Command blocks
- Player idle timeout
- Resource pack URL
- Resource pack requirement
- RCON
- Query settings

### Field requirements

Each field should include:

- Friendly label
- Short explanation
- Original property key
- Valid range
- Default value
- Restart-required marker
- Reset button

### Dangerous settings

Display warnings for settings such as:

- `online-mode=false`
- Enabling RCON without a strong password
- Excessive view distance
- Excessive RAM allocation
- Force-killing a running server

---

## 15. Gamerule Editor

The gamerule editor must be searchable and grouped by category.

Example gamerules:

- Keep inventory
- Mob griefing
- Daylight cycle
- Weather cycle
- Fire spread
- Immediate respawn
- Player sleeping percentage
- Random tick speed
- Spawn radius
- Command block output
- Natural regeneration

The app must query or maintain a version-aware gamerule list. It must not assume every Minecraft version exposes the same gamerules.

---

## 16. Player Management

### Required features

- View online players
- View known players
- Add or remove operators
- Add or remove whitelist entries
- Ban and unban players
- Ban and unban IP addresses
- Kick players
- Copy UUID when available

Use Minecraft commands where appropriate and edit JSON files only when the server is offline or when necessary.

---

## 17. Mods, Plugins, and Datapacks

### File controls

- Drag-and-drop upload
- Multiple file upload
- Enable
- Disable
- Delete with confirmation
- Open containing folder
- Show file size
- Show modified date
- Show restart-required marker

### JAR inspection

Inspect archives for metadata:

- Fabric: `fabric.mod.json`
- Bukkit or Paper: `plugin.yml`
- Paper plugin: `paper-plugin.yml`

### Safety

- Accept only expected file types
- Set upload-size limits
- Prevent path traversal
- Do not extract unknown archives directly into server folders
- Back up affected folders before major changes

A Modrinth browser is not part of the first release.

---

## 18. Backups

### Required backup features

- Manual backup
- Backup before configuration changes
- Backup before updates
- Backup before installing or removing mods
- Restore backup
- Delete backup
- Retention limit
- Backup notes

### Restore process

1. Stop the server
2. Verify the backup archive
3. Back up the current server state
4. Restore into a temporary directory
5. Validate the restored files
6. Replace the active server directory
7. Preserve application metadata

Backups must be stored outside the active server directory.

---

## 19. Playit MVP Integration

### Initial features

- Detect Playit installation
- Allow selecting the Playit executable
- Launch Playit
- Stop Playit
- Show Playit process status
- Stream Playit output
- Detect setup or claim links
- Open setup links in the default browser
- Save the user-entered public address
- Warn when Minecraft is online but Playit is offline

### Initial limitations

Do not attempt deep tunnel automation during the first release.

The first version only needs reliable process launching and clear setup guidance.

The application administration interface must not be exposed through Playit.

---

## 20. Local World Discovery

The application may search only locations the user has authorized.

### Suggested locations

- `%APPDATA%\.minecraft\saves`
- Documents
- Desktop
- Downloads
- User-selected folders

### Java world indicators

- `level.dat`
- `region/`
- `playerdata/`
- `advancements/`

### Java server indicators

- `server.properties`
- `eula.txt`
- `logs/`
- World folders

### Bedrock world indicators

- `levelname.txt`
- `db/`
- `level.dat`
- `level.dat_old`

Never scan the entire computer silently.

Always show which folder is being searched and allow the user to cancel.

---

## 21. Security Requirements

These protections are mandatory from the beginning:

- Bind local APIs to `127.0.0.1` by default
- Never execute user-controlled shell commands
- Use `spawn()` without a shell
- Validate all filesystem paths
- Prevent `../` path traversal
- Restrict file operations to registered directories
- Validate uploaded file extensions
- Set upload-size limits
- Create configuration backups
- Redact secrets from logs
- Never upload server files externally
- Track managed process IDs
- Prevent duplicate processes
- Shut down child processes safely
- Use Electron context isolation
- Disable direct Node access in the renderer
- Use a narrow preload API
- Validate all IPC messages

---

## 22. GitHub Distribution

### Repository should provide

- Source code
- Setup instructions
- Development instructions
- Issue tracker
- Release notes
- Windows installer
- Portable ZIP
- Checksums

### Release files

```text
MinecraftServerCustomizer-Setup-x.y.z.exe
MinecraftServerCustomizer-Portable-x.y.z.zip
SHA256SUMS.txt
```

Do not publish the application through Vercel or another website host.

---

# 23. Staged Implementation Plan

Each phase must be completed and tested before moving to the next phase.

Do not combine phases unless the current phase is fully functional.

---

## Phase 1: Repository and Desktop Shell

### Goal

Create a working Electron application with React, TypeScript, and the compact green-and-black interface.

### Implement only

- Project structure
- Electron main process
- Secure preload bridge
- React renderer
- Basic navigation
- Theme variables
- Placeholder pages
- Application window controls
- Development and production scripts

### Do not implement yet

- Minecraft downloads
- Java installation
- Server processes
- Playit
- Backups
- Mods
- Bedrock

### Completion criteria

- App launches successfully
- Navigation works
- No gradients
- Layout is compact
- Renderer has no unrestricted Node access
- Production build opens successfully

---

## Phase 2: Local API and SQLite

### Goal

Create the local backend and persistent application database.

### Implement only

- Fastify server
- Localhost binding
- Health endpoint
- WebSocket connection
- SQLite database
- Server-instance records
- Application settings
- Server library path selection

### Completion criteria

- Renderer can call the health endpoint
- WebSocket connects
- Selected library path persists after restart
- Server records can be created, listed, edited, and deleted

---

## Phase 3: Vanilla Process Manager

### Goal

Run an already-existing Vanilla server folder.

### Implement only

- Select existing server folder
- Select Java executable
- Configure JVM arguments
- Start server
- Stop server gracefully
- Restart server
- Force-kill server
- Track process state
- Stream logs
- Send console commands

### Do not implement yet

- Automatic server download
- Automatic Java download
- Fabric
- Paper
- Bedrock
- Playit

### Completion criteria

- A manually prepared Vanilla server starts
- Console output appears live
- Commands work
- Stop command shuts down safely
- Duplicate starts are blocked
- Crashes are detected

---

## Phase 4: Vanilla Server Installer

### Goal

Create new Vanilla servers from the application.

### Implement only

- Minecraft version list
- Official server JAR download
- Server directory creation
- EULA acceptance flow
- Basic RAM settings
- Initial `server.properties`
- Installation progress
- Download cancellation
- Download verification

### Completion criteria

- User can create a new Vanilla server
- Server starts after installation
- EULA is handled explicitly
- Failed downloads do not leave broken instances marked as ready

---

## Phase 5: Java Runtime Manager

### Goal

Detect and install compatible private Java runtimes.

### Implement only

- Detect installed Java
- Read Java version
- Match Java to Minecraft version
- Display installation notice
- Download private Java runtime
- Store runtime path
- Allow custom `java.exe`

### Completion criteria

- Incompatible Java is detected before launch
- User receives a clear notice before download
- Private runtime does not modify system PATH
- Different servers may use different runtimes

---

## Phase 6: Console and Server Dashboard

### Goal

Finish the primary server-control experience.

### Implement only

- Dashboard status
- CPU usage
- RAM usage
- Uptime
- Player count when available
- Server address
- Console filtering
- Command history
- Log download
- Crash details

### Completion criteria

- Dashboard updates live
- Console remains responsive during long sessions
- Crash state and exit code are shown clearly

---

## Phase 7: Vanilla Settings Editor

### Goal

Provide a user-friendly editor for `server.properties`.

### Implement only

- Properties parser
- Schema-driven controls
- Validation
- Friendly descriptions
- Restart-required tracking
- Reset to default
- Automatic backup before saving
- Raw editor fallback

### Completion criteria

- Valid settings save correctly
- Invalid settings are rejected
- Unknown properties are preserved
- Comments and unrelated entries are not silently destroyed when possible

---

## Phase 8: Gamerules and Player Management

### Goal

Manage gamerules and common player administration tasks.

### Implement only

- Gamerule list
- Searchable gamerule editor
- Boolean and numeric controls
- Whitelist
- Operators
- Player bans
- IP bans
- Kick command

### Completion criteria

- Changes are reflected in the running server
- Offline-only edits are clearly marked
- Failed commands show useful errors

---

## Phase 9: World Discovery and Import

### Goal

Find and import local Minecraft worlds safely.

### Implement only

- User-authorized folder scanning
- Common save-folder suggestions
- Java world validation
- World preview metadata
- Copy progress
- Duplicate-name handling
- Import cancellation

### Completion criteria

- Existing single-player worlds can be copied into a server
- Original worlds remain untouched
- Invalid folders are rejected clearly

---

## Phase 10: Backups and Restore

### Goal

Protect server data before adding more complex features.

### Implement only

- Manual backups
- Automatic pre-change backups
- Backup list
- Restore
- Delete
- Retention settings
- Backup notes

### Completion criteria

- Backups are stored outside active server folders
- Restore performs validation
- Current state is backed up before restoration

---

## Phase 11: Playit Basic Integration

### Goal

Launch and monitor Playit beside the selected Minecraft server.

### Implement only

- Detect executable
- Select executable manually
- Start and stop Playit
- Display logs
- Detect claim links
- Save public address manually
- Show tunnel status warning

### Completion criteria

- Playit can be launched and stopped reliably
- Setup links open correctly
- Minecraft and Playit statuses are shown separately

---

## Phase 12: Fabric Support

### Goal

Add modded Java server support without changing the Vanilla workflow.

### Implement only

- Fabric installation
- Loader selection
- Fabric API option
- Mod manager
- JAR metadata inspection
- Fabric config editor

### Completion criteria

- Fabric server can be installed and launched
- Mods can be enabled and disabled
- Vanilla pages do not show Fabric-only controls

---

## Phase 13: Paper Support

### Goal

Add plugin and advanced configuration support.

### Implement only

- Paper installation
- Plugin manager
- Plugin metadata inspection
- Bukkit settings
- Spigot settings
- Paper global settings
- Paper world defaults
- Supported mob-cap controls

### Completion criteria

- Paper server can be installed and launched
- Plugins can be managed
- Paper-only controls remain hidden elsewhere

---

## Phase 14: Bedrock Desktop Support

### Goal

Add official Bedrock Dedicated Server management in a separate application section.

### Implement only

- Bedrock installation
- Bedrock process manager
- Bedrock console
- Bedrock settings
- Permissions
- Allowlist
- Pack folders
- Bedrock backups
- Playit association

### Completion criteria

- Bedrock server can be installed and run
- Java and Bedrock settings remain completely separate

---

## Phase 15: Packaging and GitHub Releases

### Goal

Create distributable Windows builds.

### Implement only

- Windows installer
- Portable ZIP
- Application icon
- Version information
- GitHub Actions build workflow
- Release checksums
- Basic update-notification mechanism

### Completion criteria

- Fresh Windows installation works
- Portable build works
- Application data is stored outside the installation directory
- GitHub Release contains all required files

---

# 24. Coding-Agent Rules

Use these rules in every Command Code instruction.

1. Work on only one phase at a time.
2. Inspect the existing repository before changing files.
3. Do not rewrite unrelated working code.
4. Do not add features from future phases.
5. Explain the files changed after implementation.
6. Run available type checks, tests, and builds.
7. Fix errors caused by the current phase.
8. Do not claim success without verifying the build.
9. Preserve the compact green-and-black design.
10. Do not add gradients.
11. Do not create unnecessary abstraction layers.
12. Prefer reliable, readable code over clever code.
13. Keep security boundaries intact.
14. Never expose unrestricted Node APIs to the renderer.
15. Never execute shell commands built from user input.

---

# 25. Command Code Workflow

For each phase, use this sequence instead of asking the coding agent to do everything at once.

## Step A: Inspect

```text
Inspect the repository and summarize the current architecture, relevant files,
and anything that may block Phase [number]. Do not modify files yet.
```

## Step B: Plan

```text
Create a focused implementation plan for Phase [number] only. List the files
that should be created or changed. Do not implement future phases.
```

## Step C: Implement

```text
Implement Phase [number] according to the approved project plan. Keep the scope
strictly limited to this phase. Preserve existing working behavior and the
compact green-and-black design. Do not add gradients.
```

## Step D: Verify

```text
Run the relevant type checks, tests, linting, and production build. Fix errors
caused by this phase. Then summarize what works, what was tested, and any known
limitations. Do not begin the next phase.
```

## Step E: Review

Manually test the completion criteria before starting the next phase.

---

# 26. First Command to Use

Start with Phase 1 only:

```text
We are building a Windows-first Minecraft Server Customizer desktop app.

Read MINECRAFT_SERVER_CUSTOMIZER_PLAN.md before making changes.

Implement Phase 1 only: Repository and Desktop Shell.

Requirements:
- Electron desktop application
- React, TypeScript, and Vite renderer
- Secure Electron preload bridge
- Context isolation enabled
- No unrestricted Node access in the renderer
- Compact green-and-black interface
- No gradients
- Sidebar navigation with placeholder pages
- Java Edition and Bedrock Edition selectors
- Desktop window controls
- Working development scripts
- Working production build

Do not implement Minecraft downloads, Java installation, process management,
Playit, backups, Fabric, Paper, or Bedrock server execution yet.

Before changing files, inspect the repository and briefly state the files you
will create or modify. After implementation, run type checks and a production
build. Fix errors caused by this phase and stop after Phase 1 is complete.
```

---

# 27. MVP Completion Definition

The initial MVP is complete when a Windows user can:

1. Install or open the application
2. Create a Vanilla Java server
3. Import an existing Vanilla server
4. Import a local single-player world
5. Install or select a compatible Java runtime
6. Start, stop, restart, and force-kill the server
7. View live console output
8. Send console commands
9. Edit common Vanilla settings
10. Edit gamerules
11. Manage players, whitelist, operators, and bans
12. Create and restore backups
13. Launch Playit and complete its basic setup
14. Manage multiple saved servers with only one running at a time

Fabric, Paper, and Bedrock support may be added after the Vanilla MVP is stable.

---

# 28. Explicitly Deferred Features

Do not include these in the initial MVP:

- Android hosting
- iOS hosting
- Cloud hosting
- Public web dashboard
- Multiple simultaneous server processes
- Modrinth browsing
- Automatic mod dependency resolution
- Automatic modpack installation
- Deep Playit tunnel API management
- User accounts
- Remote internet administration
- Hosting-company billing features
- Docker deployment
- Kubernetes

These may be considered only after the desktop Vanilla workflow is stable.

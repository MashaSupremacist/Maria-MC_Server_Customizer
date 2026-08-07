# Minecraft Server Customizer

A Windows-first desktop application for creating, importing, configuring,
running, and managing local Minecraft servers through a compact green-and-black
interface.

**Status:** Phases 1–14 complete (Vanilla, Fabric, Forge, Paper, Bedrock;
process manager, console, settings, gamerules, players, worlds, backups,
Playit). Phase 15 (packaging) in progress. See
[PROJECT_PROGRESS.md](./PROJECT_PROGRESS.md) and
[MINECRAFT_SERVER_CUSTOMIZER_PLAN.md](./MINECRAFT_SERVER_CUSTOMIZER_PLAN.md).

## Features

- Create and run **Vanilla, Fabric, Forge, Paper**, and **Bedrock** servers
- Live console with command input, filtering, and crash highlighting
- Friendly settings editors (`server.properties` for Java and Bedrock)
- Gamerule editor, player/whitelist/operator/ban management
- World discovery and import from local save folders
- ZIP backups with restore and retention
- Playit tunnel integration
- Private Java runtime installation (no system PATH changes)
- Green-and-black compact UI (no gradients)

## Requirements

- Windows 10/11
- Node.js 20+ (tested on v24) for development
- npm 10+

## Getting started

```sh
npm install
npm run dev
```

`npm run dev` starts the Vite renderer dev server and launches Electron
pointing at it.

## Production build

```sh
npm run build
npm start
```

The production renderer is written to `apps/desktop/dist/renderer`, and the
Electron main process compiles to `apps/desktop/dist-electron`.

## Packaging

Build the Windows installer and portable ZIP with electron-builder:

```sh
npm run dist
```

Output lands in `release/`:

```text
release/
  MinecraftServerCustomizer-Setup-x.y.z.exe
  MinecraftServerCustomizer-Portable-x.y.z.zip
```

The `dist` script:
1. Builds the renderer, Electron main, and backend
2. Stages the backend's production dependencies into
   `apps/desktop/backend/node_modules` (self-contained, so the packaged app
   does not depend on the workspace)
3. Runs electron-builder for the `nsis` installer and `portable` targets

Checksums are generated for each release:

```sh
cd release
sha256sum MinecraftServerCustomizer-Setup-*.exe MinecraftServerCustomizer-Portable-*.zip > SHA256SUMS.txt
```

## GitHub Releases

Pushing a tag triggers the CI workflow (`.github/workflows/build-release.yml`),
which builds the installer + portable ZIP on `windows-latest` and attaches them
to a GitHub Release:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The app checks the GitHub Releases API on startup and shows a compact banner
when a newer version is available.

## Scripts

| Script        | Description                                |
| ------------- | ------------------------------------------ |
| `npm run dev` | Vite dev server + Electron in watch mode   |
| `npm run build` | Type check, build renderer, build Electron |
| `npm run typecheck` | Type check desktop and shared packages     |
| `npm test`    | Run the backend test suite (vitest)        |
| `npm run dist` | Build + package installer and portable ZIP |

## Project layout

```text
apps/
  desktop/
    electron/    Electron main process and preload bridge
    renderer/    React + Vite renderer (green-and-black UI)
    backend/     Local Fastify + SQLite backend
    build/       App icon (icon.ico / icon.png)
packages/
  shared-types/  IPC contract types shared between main and renderer
scripts/
  generate-icon.mjs        Generates the app icon
  prepare-backend-deps.mjs Stages backend prod deps for packaging
.github/workflows/
  build-release.yml        CI: build + attach release assets
```

Server data (`data/`) stays out of source control. In development it lives in
the repo's `data/` folder; in the packaged app it lives under the user's
`AppData/Roaming/Minecraft Server Customizer/`.

## Security model

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- Narrow `contextBridge` preload API only (`window.msc`)
- External links open in the system browser
- Backend bound to `127.0.0.1` with a per-launch random auth token
- Server processes spawned via `child_process.spawn()` (no shell)

# Minecraft Server Customizer

A Windows-first desktop application for creating, importing, configuring,
running, and managing local Minecraft servers through a compact green-and-black
interface.

**Status:** Phase 1 (Repository and Desktop Shell) in progress. See
[PROJECT_PROGRESS.md](./PROJECT_PROGRESS.md) and
[MINECRAFT_SERVER_CUSTOMIZER_PLAN.md](./MINECRAFT_SERVER_CUSTOMIZER_PLAN.md).

## Requirements

- Node.js 20+ (tested on v24)
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

## Scripts

| Script        | Description                                |
| ------------- | ------------------------------------------ |
| `npm run dev` | Vite dev server + Electron in watch mode   |
| `npm run build` | Type check, build renderer, build Electron |
| `npm run typecheck` | Type check desktop and shared packages     |

## Project layout

```text
apps/
  desktop/
    electron/    Electron main process and preload bridge
    renderer/    React + Vite renderer (green-and-black UI)
    backend/     Reserved for the Phase 2 local Fastify backend
packages/
  shared-types/  IPC contract types shared between main and renderer
```

Server data (`data/`) stays out of source control and will live outside the
source tree as the app matures.

## Security model (Phase 1)

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- Narrow `contextBridge` preload API only (`window.msc`)
- External links open in the system browser

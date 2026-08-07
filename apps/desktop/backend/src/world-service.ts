import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type {
  ImportWorldRequest,
  SaveFolderSuggestion,
  WorldDiscoveryResult,
  WorldImportProgress,
  WorldInfo,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { readWorldMetadata } from './nbt';

export type WsBroadcast = (event: WsServerEvent) => void;

/** Common single-player save locations, in order. */
export function suggestSaveFolders(): SaveFolderSuggestion[] {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'saves'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Downloads'),
  ];
  return candidates.map((p) => ({ path: p, exists: fs.existsSync(p) }));
}

/**
 * Discovers and imports Minecraft worlds. Worlds are only ever copied into a
 * server instance (never run in place). Progress is broadcast over WebSocket.
 */
export class WorldService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private imports = new Map<string, { cancelRequested: boolean }>();

  constructor(db: DatabaseResult, broadcast: WsBroadcast) {
    this.db = db;
    this.broadcast = broadcast;
  }

  /** Scan a folder for worlds (one level deep). */
  discover(folder: string): WorldDiscoveryResult {
    const result: WorldDiscoveryResult = { folder, worlds: [], invalid: [], canceled: false };
    if (!fs.existsSync(folder)) return result;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const worldPath = path.join(folder, entry.name);
      if (fs.existsSync(path.join(worldPath, 'level.dat'))) {
        const info = this.inspectWorld(worldPath);
        result.worlds.push(info);
      } else {
        result.invalid.push(entry.name);
      }
    }
    return result;
  }

  /** Build a WorldInfo for a folder (assumes level.dat exists). */
  private inspectWorld(worldPath: string): WorldInfo {
    const meta = readWorldMetadata(path.join(worldPath, 'level.dat'));
    return {
      path: worldPath,
      name: path.basename(worldPath),
      displayName: meta?.displayName || path.basename(worldPath),
      gameMode: meta?.gameMode,
      lastPlayedVersion: meta?.lastPlayedVersion || undefined,
      sizeBytes: folderSize(worldPath),
      valid: true,
    };
  }

  /** Import a world into a server. Returns the import id. */
  import(request: ImportWorldRequest): { importId: string; error?: string } {
    const record = this.db.getServer(request.serverId);
    if (!record) return { importId: '', error: 'Server not found' };
    if (this.isServerRunning(request.serverId)) {
      return { importId: '', error: 'Stop the server before importing a world' };
    }
    const source = request.sourcePath;
    if (!fs.existsSync(path.join(source, 'level.dat'))) {
      return { importId: '', error: 'Not a valid Java world (missing level.dat)' };
    }

    const importId = crypto.randomUUID();
    this.imports.set(importId, { cancelRequested: false });
    void this.runImport(importId, request, record.folderPath).catch((err: unknown) => {
      this.finish(importId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        errorCode: 'io',
      });
    });
    return { importId };
  }

  cancel(importId: string): boolean {
    const entry = this.imports.get(importId);
    if (!entry) return false;
    entry.cancelRequested = true;
    return true;
  }

  private isServerRunning(serverId: string): boolean {
    // WorldService is constructed with the manager's runningServerId via a
    // getter injected in app.ts.
    return this.runningServerId?.() === serverId;
  }

  private runningServerId: (() => string | null) | null = null;
  setRunningServerId(fn: () => string | null): void {
    this.runningServerId = fn;
  }

  private emit(importId: string, progress: WorldImportProgress): void {
    this.broadcast({
      type: 'world:import-progress',
      importId,
      progress,
    } satisfies WsServerEvent);
  }

  private finish(importId: string, progress: WorldImportProgress): void {
    this.imports.delete(importId);
    this.emit(importId, progress);
  }

  private async runImport(
    importId: string,
    request: ImportWorldRequest,
    serverFolder: string,
  ): Promise<void> {
    const entry = this.imports.get(importId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;

    if (isCanceled()) {
      this.finish(importId, { status: 'canceled', percent: null, message: 'Import canceled' });
      return;
    }

    const source = request.sourcePath;
    const targetName = sanitizeName(request.targetName || path.basename(source));
    // Duplicate-name handling: append -2, -3, etc.
    let targetPath = path.join(serverFolder, targetName);
    let i = 2;
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(serverFolder, `${targetName}-${i}`);
      i += 1;
    }

    this.emit(importId, {
      status: 'copying',
      percent: 0,
      message: `Copying world "${path.basename(source)}"…`,
    });

    const totalBytes = folderSize(source);
    await copyDirectory(source, targetPath, (copied) => {
      const percent = totalBytes > 0 ? Math.min(100, Math.round((copied / totalBytes) * 100)) : null;
      this.emit(importId, { status: 'copying', percent, message: 'Copying world…' });
    }, isCanceled);

    if (isCanceled()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      this.finish(importId, { status: 'canceled', percent: null, message: 'Import canceled' });
      return;
    }

    this.imports.delete(importId);
    this.emit(importId, {
      status: 'complete',
      percent: 100,
      message: 'World imported',
      targetPath,
    });
  }
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'world';
}

/** Compute the total size of a folder tree in bytes. */
function folderSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += folderSize(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return total;
}

/** Recursively copy a directory with a progress callback + cancellation. */
async function copyDirectory(
  src: string,
  dest: string,
  onProgress: (copiedBytes: number) => void,
  isCanceled: () => boolean,
): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (isCanceled()) return;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, onProgress, isCanceled);
    } else if (entry.isFile()) {
      if (isCanceled()) return;
      const stat = fs.statSync(srcPath);
      await copyFileWithProgress(srcPath, destPath, stat.size, (n) => {
        copied += n;
        onProgress(copied);
      });
    }
  }
}

function copyFileWithProgress(
  src: string,
  dest: string,
  size: number,
  onChunk: (bytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(src);
    const write = fs.createWriteStream(dest);
    read.on('data', (chunk: string | Buffer) => onChunk(Buffer.byteLength(chunk)));
    read.on('error', reject);
    write.on('error', reject);
    write.on('close', resolve);
    read.pipe(write);
  });
}

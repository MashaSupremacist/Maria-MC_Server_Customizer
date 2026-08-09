import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type {
  ImportWorldRequest,
  SaveFolderSuggestion,
  ServerRecord,
  WorldDiscoveryResult,
  WorldImportProgress,
  WorldInfo,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { readWorldMetadata } from './nbt';
import { replaceDirectoryAtomically } from './fs-transaction';
import { requireServerEdition } from './server-edition';
import {
  ServerOperationConflictError,
  type ServerOperationCoordinator,
} from './server-operation-coordinator';

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
  private readonly coordinator: ServerOperationCoordinator | null;
  private imports = new Map<string, { cancelRequested: boolean; serverId: string }>();

  constructor(
    db: DatabaseResult,
    broadcast: WsBroadcast,
    coordinator: ServerOperationCoordinator | null = null,
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.coordinator = coordinator;
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
    let record: ServerRecord;
    try {
      record = requireServerEdition(this.db, request.serverId, 'java');
    } catch (error) {
      return { importId: '', error: error instanceof Error ? error.message : String(error) };
    }
    if (this.isServerRunning(request.serverId)) {
      return { importId: '', error: 'Stop the server before importing a world' };
    }
    const source = request.sourcePath;
    if (!fs.existsSync(path.join(source, 'level.dat'))) {
      return { importId: '', error: 'Not a valid Java world (missing level.dat)' };
    }
    try {
      const canonicalSource = fs.realpathSync.native(source);
      const canonicalServer = fs.realpathSync.native(record.folderPath);
      if (samePath(canonicalSource, canonicalServer) || isPathInside(canonicalSource, canonicalServer)) {
        return { importId: '', error: 'World source cannot contain the destination server folder' };
      }
    } catch (error) {
      return { importId: '', error: error instanceof Error ? error.message : String(error) };
    }

    const importId = crypto.randomUUID();
    try {
      this.coordinator?.acquire(request.serverId, 'world-import', importId);
    } catch (error) {
      if (error instanceof ServerOperationConflictError) {
        return { importId: '', error: error.message };
      }
      throw error;
    }
    this.imports.set(importId, { cancelRequested: false, serverId: request.serverId });
    void this.runImport(importId, request, record.folderPath).catch((err: unknown) => {
      this.finish(importId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        errorCode: 'io',
      });
    }).finally(() => {
      this.coordinator?.release(request.serverId, importId);
    });
    return { importId };
  }

  cancel(importId: string): boolean {
    const entry = this.imports.get(importId);
    if (!entry) return false;
    if (
      this.coordinator &&
      !this.coordinator.requestCancel(entry.serverId, importId)
    ) {
      return false;
    }
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

    const canonicalSource = fs.realpathSync.native(source);
    const resolvedTarget = path.resolve(targetPath);
    if (samePath(canonicalSource, resolvedTarget) || isPathInside(canonicalSource, resolvedTarget)) {
      throw new Error('World destination cannot be inside its source folder');
    }

    const totalBytes = folderSize(source);
    let copiedBytes = 0;
    try {
      await replaceDirectoryAtomically(
        targetPath,
        async (stagingPath) => {
          await copyDirectory(
            source,
            stagingPath,
            (chunkBytes) => {
              copiedBytes += chunkBytes;
              const percent = totalBytes > 0
                ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100))
                : null;
              this.emit(importId, { status: 'copying', percent, message: 'Copying world…' });
            },
            isCanceled,
          );
        },
        async (stagingPath) => {
          if (isCanceled()) throw new WorldImportCanceledError();
          if (!fs.existsSync(path.join(stagingPath, 'level.dat'))) {
            throw new Error('Imported world is incomplete (missing level.dat)');
          }
        },
      );
    } catch (error) {
      if (isCanceled() || error instanceof WorldImportCanceledError) {
        this.finish(importId, { status: 'canceled', percent: null, message: 'Import canceled' });
        return;
      }
      throw error;
    }

    if (isCanceled()) {
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
  if (isCanceled()) throw new WorldImportCanceledError();
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (isCanceled()) throw new WorldImportCanceledError();
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`World source contains a symbolic link or junction: ${srcPath}`);
    }
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, onProgress, isCanceled);
    } else if (entry.isFile()) {
      if (isCanceled()) throw new WorldImportCanceledError();
      const stat = fs.statSync(srcPath);
      await copyFileWithProgress(srcPath, destPath, stat.size, (n) => {
        onProgress(n);
      }, isCanceled);
    }
  }
}

function copyFileWithProgress(
  src: string,
  dest: string,
  size: number,
  onChunk: (bytes: number) => void,
  isCanceled: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(src);
    const write = fs.createWriteStream(dest);
    read.on('data', (chunk: string | Buffer) => {
      if (isCanceled()) {
        read.destroy(new WorldImportCanceledError());
        write.destroy(new WorldImportCanceledError());
        return;
      }
      onChunk(Buffer.byteLength(chunk));
    });
    read.on('error', reject);
    write.on('error', reject);
    write.on('close', resolve);
    read.pipe(write);
  });
}

class WorldImportCanceledError extends Error {
  constructor() {
    super('World import canceled');
    this.name = 'WorldImportCanceledError';
  }
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

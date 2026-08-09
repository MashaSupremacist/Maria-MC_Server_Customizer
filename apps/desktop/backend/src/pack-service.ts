import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PackEntry, PackKind, PackListResponse } from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { requireServerEdition } from './server-edition';
import { walkZip, writeEntryStream } from './zip-utils';
import {
  ServerOperationConflictError,
  type ServerOperationCoordinator,
} from './server-operation-coordinator';

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB safety cap

export interface OnlineStatus {
  (serverId: string): boolean;
}

/**
 * Manages a Bedrock server's behavior_packs/ and resource_packs/ folders.
 * Lists pack entries (folders or .mcpack/.zip files), uploads (extracts
 * archives into a subfolder so BDS loads them), and deletes. All mutations are
 * refused while the server is running.
 */
export class PackService {
  private readonly db: DatabaseResult;
  private readonly coordinator: ServerOperationCoordinator | null;
  private isOnline: OnlineStatus;

  constructor(
    db: DatabaseResult,
    isOnline: OnlineStatus,
    coordinator: ServerOperationCoordinator | null = null,
  ) {
    this.db = db;
    this.isOnline = isOnline;
    this.coordinator = coordinator;
  }

  private packDir(serverId: string, kind: PackKind): string {
    const record = requireServerEdition(this.db, serverId, 'bedrock');
    return path.join(record.folderPath, kind === 'behavior' ? 'behavior_packs' : 'resource_packs');
  }

  /** List pack entries in the server's pack folder. */
  list(serverId: string, kind: PackKind): PackListResponse {
    const dir = this.packDir(serverId, kind);
    const entries: PackEntry[] = [];
    if (!fs.existsSync(dir)) {
      return { serverId, kind, entries };
    }
    for (const name of fs.readdirSync(dir)) {
      if (name === '.' || name === '..') continue;
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const fileCount = countFiles(full);
        entries.push({
          name,
          kind,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isFolder: true,
          fileCount,
        });
      } else if (stat.isFile() && /\.(mcpack|zip|mcworld|mcaddon)$/i.test(name)) {
        entries.push({
          name,
          kind,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isFolder: false,
          fileCount: 1,
        });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { serverId, kind, entries };
  }

  /**
   * Upload a pack archive. Accepts .mcpack/.zip (and .mcworld/.mcaddon for
   * convenience) only, size-capped, and extracts the archive into a subfolder
   * named after the file so BDS loads it from behavior_packs/ or
   * resource_packs/.
   */
  async upload(
    serverId: string,
    kind: PackKind,
    filePaths: string[],
  ): Promise<{ ok: boolean; error?: string; added: string[] }> {
    let operationId: string | null = null;
    try {
      const operation = this.coordinator?.acquire(serverId, 'pack-mutation');
      operationId = operation?.operationId ?? null;
    } catch (error) {
      if (error instanceof ServerOperationConflictError) {
        return { ok: false, error: error.message, added: [] };
      }
      throw error;
    }
    try {
      return await this.uploadUnlocked(serverId, kind, filePaths);
    } finally {
      if (operationId) this.coordinator?.release(serverId, operationId);
    }
  }

  private async uploadUnlocked(
    serverId: string,
    kind: PackKind,
    filePaths: string[],
  ): Promise<{ ok: boolean; error?: string; added: string[] }> {
    requireServerEdition(this.db, serverId, 'bedrock');
    if (this.isOnline(serverId)) {
      return { ok: false, error: 'Stop the server before changing packs', added: [] };
    }
    const dir = this.packDir(serverId, kind);
    fs.mkdirSync(dir, { recursive: true });
    const staging = path.join(dir, `.msc-pack-import-${crypto.randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true });
    const added: string[] = [];
    const committed: string[] = [];
    try {
      for (const sourcePath of filePaths) {
        const before = fs.lstatSync(sourcePath);
        const base = path.basename(sourcePath);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Not a regular file: ${base}`);
        if (!/\.(mcpack|zip|mcworld|mcaddon)$/i.test(base)) {
          throw new Error(`Only .mcpack/.zip/.mcworld/.mcaddon files are allowed (${base})`);
        }
        if (before.size <= 0 || before.size > MAX_UPLOAD_BYTES) {
          throw new Error(before.size <= 0 ? `File is empty: ${base}` : `${base} exceeds the 1 GB upload limit`);
        }
        const folderName = base.replace(/\.(mcpack|zip|mcworld|mcaddon)$/i, '');
        if (fs.existsSync(path.join(dir, folderName))) throw new Error(`A pack named "${folderName}" already exists`);
        const stagedArchive = path.join(staging, base);
        const stagedFolder = path.join(staging, folderName);
        await fs.promises.copyFile(sourcePath, stagedArchive, fs.constants.COPYFILE_EXCL);
        const after = fs.lstatSync(sourcePath);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error(`File changed while it was being imported: ${base}`);
        }
        await extractZipTo(stagedArchive, stagedFolder);
        fs.rmSync(stagedArchive, { force: true });
        if (!containsFile(stagedFolder, 'manifest.json')) {
          throw new Error(`Pack archive has no manifest.json: ${base}`);
        }
        added.push(folderName);
      }
      for (const folderName of added) {
        const destination = path.join(dir, folderName);
        await fs.promises.rename(path.join(staging, folderName), destination);
        committed.push(destination);
      }
      return { ok: true, added };
    } catch (error) {
      for (const destination of committed) fs.rmSync(destination, { recursive: true, force: true });
      return { ok: false, error: error instanceof Error ? error.message : String(error), added: [] };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Delete a pack entry (folder or file). */
  delete(serverId: string, kind: PackKind, name: string): { ok: boolean; error?: string } {
    let operationId: string | null = null;
    try {
      const operation = this.coordinator?.acquire(serverId, 'pack-mutation');
      operationId = operation?.operationId ?? null;
    } catch (error) {
      if (error instanceof ServerOperationConflictError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
    try {
      return this.deleteUnlocked(serverId, kind, name);
    } finally {
      if (operationId) this.coordinator?.release(serverId, operationId);
    }
  }

  private deleteUnlocked(serverId: string, kind: PackKind, name: string): { ok: boolean; error?: string } {
    if (path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
      return { ok: false, error: 'Invalid pack name' };
    }
    if (this.isOnline(serverId)) {
      return { ok: false, error: 'Stop the server before changing packs' };
    }
    const dir = this.packDir(serverId, kind);
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) {
      return { ok: false, error: `Pack not found: ${name}` };
    }
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  }
}

function countFiles(dir: string): number {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += countFiles(full);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  } catch {
    // unreadable dir → 0
  }
  return count;
}

function containsFile(root: string, wantedName: string): boolean {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === wantedName.toLowerCase()) return true;
    if (entry.isDirectory() && containsFile(full, wantedName)) return true;
  }
  return false;
}

/** Extract a ZIP into destFolder, rejecting paths that escape it. */
async function extractZipTo(zipPath: string, destFolder: string): Promise<void> {
  await walkZip(zipPath, async (entry, stream) => {
    const target = safeEntryTarget(destFolder, entry.fileName);
    if (!target) throw new Error(`Unsafe path in archive: ${entry.fileName}`);
    await writeEntryStream(stream, target);
  });
}

/**
 * Resolve an archive entry name under destFolder, rejecting any path that
 * escapes it. Returns the safe absolute target or null.
 */
export function safeEntryTarget(destFolder: string, entryName: string): string | null {
  if (path.isAbsolute(entryName)) return null;
  const target = path.join(destFolder, entryName);
  const relative = path.relative(destFolder, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

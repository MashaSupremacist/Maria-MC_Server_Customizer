import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import type { PackEntry, PackKind, PackListResponse } from '@msc/shared-types';
import type { DatabaseResult } from './db';

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
  private isOnline: OnlineStatus;

  constructor(db: DatabaseResult, isOnline: OnlineStatus) {
    this.db = db;
    this.isOnline = isOnline;
  }

  private packDir(serverId: string, kind: PackKind): string {
    const record = this.db.getServer(serverId);
    if (!record) throw new Error(`No server record with id ${serverId}`);
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
    files: Array<{ name: string; contentBase64: string; sizeBytes: number }>,
  ): Promise<{ ok: boolean; error?: string; added: string[] }> {
    const record = this.db.getServer(serverId);
    if (!record) return { ok: false, error: 'Server not found', added: [] };
    if (this.isOnline(serverId)) {
      return { ok: false, error: 'Stop the server before changing packs', added: [] };
    }
    const dir = this.packDir(serverId, kind);
    fs.mkdirSync(dir, { recursive: true });
    const added: string[] = [];
    for (const file of files) {
      const base = path.basename(file.name);
      if (!/\.(mcpack|zip|mcworld|mcaddon)$/i.test(base)) {
        return {
          ok: false,
          error: `Only .mcpack/.zip/.mcworld/.mcaddon files are allowed (${base})`,
          added: [],
        };
      }
      if (file.sizeBytes > MAX_UPLOAD_BYTES) {
        return { ok: false, error: `${base} exceeds the 1 GB upload limit`, added: [] };
      }
      if (!file.contentBase64) {
        return { ok: false, error: `File is empty: ${base}`, added: [] };
      }
      // Extract into a subfolder named after the archive (sans extension).
      const folderName = base.replace(/\.(mcpack|zip|mcworld|mcaddon)$/i, '');
      const destFolder = path.join(dir, folderName);
      if (fs.existsSync(destFolder)) {
        return { ok: false, error: `A pack named "${folderName}" already exists`, added: [] };
      }
      const tmpZip = path.join(dir, `.upload-${Date.now()}-${base}`);
      fs.writeFileSync(tmpZip, Buffer.from(file.contentBase64, 'base64'));
      try {
        await extractZipTo(tmpZip, destFolder);
      } catch (err) {
        fs.rmSync(tmpZip, { force: true });
        fs.rmSync(destFolder, { recursive: true, force: true });
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to extract pack archive',
          added: [],
        };
      }
      fs.rmSync(tmpZip, { force: true });
      added.push(folderName);
    }
    return { ok: true, added };
  }

  /** Delete a pack entry (folder or file). */
  delete(serverId: string, kind: PackKind, name: string): { ok: boolean; error?: string } {
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

/** Extract a ZIP into destFolder, rejecting paths that escape it. */
function extractZipTo(zipPath: string, destFolder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('Failed to open pack archive'));
        return;
      }
      let pending = 0;
      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const safety = safeEntryTarget(destFolder, entry.fileName);
        if (!safety) {
          zipfile.close();
          reject(new Error(`Unsafe path in archive: ${entry.fileName}`));
          return;
        }
        const target = safety;
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(target, { recursive: true });
          zipfile.readEntry();
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        pending += 1;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.close();
            reject(streamErr ?? new Error('Failed to open pack archive entry'));
            return;
          }
          const out = fs.createWriteStream(target);
          stream.on('error', (e) => {
            out.destroy();
            zipfile.close();
            reject(e);
          });
          out.on('error', (e) => {
            zipfile.close();
            reject(e);
          });
          out.on('close', () => {
            pending -= 1;
            zipfile.readEntry();
          });
          stream.pipe(out);
        });
      });
      zipfile.on('end', () => {
        const check = (): void => {
          if (pending === 0) {
            zipfile.close();
            resolve();
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });
      zipfile.on('error', (e) => reject(e));
    });
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

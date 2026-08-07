import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yazl from 'yazl';
import yauzl from 'yauzl';
import type {
  BackupEntry,
  BackupProgress,
  CreateBackupRequest,
  RestoreBackupRequest,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import type { WsBroadcast } from './world-service';

/** Result of starting a backup operation. */
export interface BackupOperationStart {
  /** Operation id for the broadcast + cancel lookup. */
  operationId: string;
  error?: string;
}

/** Default number of backups to keep per server. */
export const DEFAULT_RETENTION = 10;

/**
 * Creates ZIP backups of a server folder, lists/restores/deletes them, and
 * enforces a per-server retention limit. Backups live outside the active
 * server folder. Progress is broadcast over WebSocket.
 */
export class BackupService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly backupsDir: string;
  private operations = new Map<string, { cancelRequested: boolean }>();

  constructor(db: DatabaseResult, broadcast: WsBroadcast, backupsDir: string) {
    this.db = db;
    this.broadcast = broadcast;
    this.backupsDir = backupsDir;
    fs.mkdirSync(this.backupsDir, { recursive: true });
  }

  /** All backups for a server, newest first. */
  list(serverId: string): BackupEntry[] {
    return this.db
      .getServerBackups(serverId)
      .map((row) => ({
        id: row.id,
        serverId: row.serverId,
        filePath: row.filePath,
        note: row.note,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Create a backup of a server folder. */
  create(request: CreateBackupRequest): BackupOperationStart {
    const record = this.db.getServer(request.serverId);
    if (!record) return { operationId: '', error: 'Server not found' };
    if (!fs.existsSync(record.folderPath)) {
      return { operationId: '', error: `Server folder not found: ${record.folderPath}` };
    }
    if (this.isServerRunning(request.serverId)) {
      return {
        operationId: '',
        error: 'Stop the server before creating a backup',
      };
    }

    const operationId = crypto.randomUUID();
    this.operations.set(operationId, { cancelRequested: false });
    void this.runCreate(operationId, request, record.folderPath).catch(
      (err: unknown) => {
        this.finish(operationId, {
          status: 'failed',
          percent: null,
          message: err instanceof Error ? err.message : String(err),
          errorCode: 'io',
        });
      },
    );
    return { operationId };
  }

  /** Delete a backup by record id. Returns false when not found. */
  delete(backupId: string): boolean {
    const row = this.db.getBackup(backupId);
    if (!row) return false;
    this.db.deleteBackup(backupId);
    fs.rmSync(row.filePath, { force: true });
    return true;
  }

  /** Restore a backup into the server folder (replaces the current state). */
  restore(request: RestoreBackupRequest): BackupOperationStart {
    const row = this.db.getBackup(request.backupId);
    if (!row) return { operationId: '', error: 'Backup not found' };
    const record = this.db.getServer(row.serverId);
    if (!record) return { operationId: '', error: 'Server not found' };
    if (this.isServerRunning(row.serverId)) {
      return {
        operationId: '',
        error: 'Stop the server before restoring a backup',
      };
    }
    if (!fs.existsSync(row.filePath)) {
      return { operationId: '', error: `Backup file missing: ${row.filePath}` };
    }

    const operationId = crypto.randomUUID();
    this.operations.set(operationId, { cancelRequested: false });
    void this.runRestore(operationId, row, record.folderPath).catch(
      (err: unknown) => {
        this.finish(operationId, {
          status: 'failed',
          percent: null,
          message: err instanceof Error ? err.message : String(err),
          errorCode: 'io',
        });
      },
    );
    return { operationId };
  }

  /** Request cancellation of a running backup create/restore. */
  cancel(operationId: string): boolean {
    const entry = this.operations.get(operationId);
    if (!entry) return false;
    entry.cancelRequested = true;
    return true;
  }

  private isServerRunning(serverId: string): boolean {
    return this.runningServerId?.() === serverId;
  }

  private runningServerId: (() => string | null) | null = null;
  setRunningServerId(fn: () => string | null): void {
    this.runningServerId = fn;
  }

  private emit(operationId: string, progress: BackupProgress): void {
    this.broadcast({
      type: 'backup:progress',
      backupId: operationId,
      progress,
    } satisfies WsServerEvent);
  }

  private finish(operationId: string, progress: BackupProgress): void {
    this.operations.delete(operationId);
    this.emit(operationId, progress);
  }

  private async runCreate(
    operationId: string,
    request: CreateBackupRequest,
    serverFolder: string,
  ): Promise<void> {
    const entry = this.operations.get(operationId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;

    if (isCanceled()) {
      this.finish(operationId, {
        status: 'canceled',
        percent: null,
        message: 'Backup canceled',
        errorCode: 'cancelled',
      });
      return;
    }

    const note = (request.note ?? '').trim() || defaultBackupNote();
    const serverName = this.db.getServer(request.serverId)?.name ?? 'server';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(this.backupsDir, `${sanitizeName(serverName)}-${stamp}.zip`);
    const tempPath = `${filePath}.tmp`;

    this.emit(operationId, {
      status: 'creating',
      percent: 0,
      message: 'Preparing backup…',
    });

    await createZip(serverFolder, tempPath, (done, total) => {
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
      this.emit(operationId, { status: 'creating', percent, message: 'Creating backup…' });
    }, isCanceled);

    if (isCanceled()) {
      fs.rmSync(tempPath, { force: true });
      this.finish(operationId, {
        status: 'canceled',
        percent: null,
        message: 'Backup canceled',
        errorCode: 'cancelled',
      });
      return;
    }

    fs.renameSync(tempPath, filePath);
    const sizeBytes = fs.statSync(filePath).size;
    const backup = this.db.createBackup({
      serverId: request.serverId,
      filePath,
      note,
      sizeBytes,
    });

    this.enforceRetention(request.serverId);

    this.finish(operationId, {
      status: 'complete',
      percent: 100,
      message: 'Backup created',
      backup,
    });
  }

  private async runRestore(
    operationId: string,
    row: BackupRow,
    serverFolder: string,
  ): Promise<void> {
    const entry = this.operations.get(operationId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;

    if (isCanceled()) {
      this.finish(operationId, {
        status: 'canceled',
        percent: null,
        message: 'Restore canceled',
        errorCode: 'cancelled',
      });
      return;
    }

    this.emit(operationId, {
      status: 'restoring',
      percent: 0,
      message: 'Verifying backup archive…',
    });

    await validateZip(row.filePath);

    if (isCanceled()) {
      this.finish(operationId, {
        status: 'canceled',
        percent: null,
        message: 'Restore canceled',
        errorCode: 'cancelled',
      });
      return;
    }

    // Safety net: back up the current state before replacing it.
    const safetyName = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const safetyPath = path.join(this.backupsDir, safetyName);
    await createZip(serverFolder, safetyPath, () => undefined, () => false);

    if (!fs.existsSync(serverFolder) || fs.readdirSync(serverFolder).length === 0) {
      // Nothing to preserve; drop the safety backup.
      fs.rmSync(safetyPath, { force: true });
    }

    this.emit(operationId, {
      status: 'restoring',
      percent: 30,
      message: 'Restoring backup…',
    });

    // Remove current contents so the archive replaces the folder state.
    for (const entryName of fs.readdirSync(serverFolder)) {
      fs.rmSync(path.join(serverFolder, entryName), { recursive: true, force: true });
    }

    await extractZip(row.filePath, serverFolder, (done, total) => {
      const percent = 30 + Math.min(70, Math.round((done / total) * 70));
      this.emit(operationId, { status: 'restoring', percent, message: 'Restoring backup…' });
    }, isCanceled);

    if (isCanceled()) {
      this.finish(operationId, {
        status: 'canceled',
        percent: null,
        message: 'Restore canceled',
        errorCode: 'cancelled',
      });
      return;
    }

    this.finish(operationId, {
      status: 'complete',
      percent: 100,
      message: 'Backup restored',
    });
  }

  /** Keep at most DEFAULT_RETENTION backups per server (oldest removed). */
  private enforceRetention(serverId: string): void {
    const rows = this.db.getServerBackups(serverId);
    if (rows.length <= DEFAULT_RETENTION) return;
    for (const row of rows.slice(DEFAULT_RETENTION)) {
      this.db.deleteBackup(row.id);
      fs.rmSync(row.filePath, { force: true });
    }
  }
}

interface BackupRow {
  id: string;
  serverId: string;
  filePath: string;
  note: string;
  sizeBytes: number;
  createdAt: string;
}

function defaultBackupNote(): string {
  return new Date().toLocaleString();
}

function sanitizeName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  );
}

/** Total size of a folder tree in bytes. */
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

/** Walk a folder and invoke onFile for each file with its relative path. */
function walk(
  rootDir: string,
  onFile: (absolute: string, relative: string) => void,
  dir = rootDir,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(rootDir, onFile, absolute);
    } else if (entry.isFile()) {
      onFile(absolute, path.relative(rootDir, absolute).replace(/\\/g, '/'));
    }
  }
}

/**
 * Create a ZIP of `sourceDir` into `destFile`, reporting byte progress.
 * yazl does not expose per-entry progress, so we approximate by measuring
 * the bytes that have actually been written to the output stream.
 */
function createZip(
  sourceDir: string,
  destFile: string,
  onProgress: (doneBytes: number, totalBytes: number) => void,
  isCanceled: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const total = folderSize(sourceDir);
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(destFile);
    let done = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      output.destroy();
      fs.rmSync(destFile, { force: true });
      reject(err);
    };

    output.on('error', fail);
    output.on('close', () => {
      if (settled) return;
      if (isCanceled()) {
        settled = true;
        reject(new Error('canceled'));
        return;
      }
      settled = true;
      resolve();
    });

    zip.outputStream.pipe(output);
    zip.outputStream.on('error', fail);
    zip.on('error', fail);

    try {
      walk(sourceDir, (absolute, relative) => {
        zip.addFile(absolute, relative, { mtime: new Date(0) });
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    zip.end();

    // Poll the number of bytes flushed so far. Writing to the file is the
    // real bottleneck for large folders; this gives a usable percentage.
    const timer = setInterval(() => {
      try {
        const stat = fs.statSync(destFile);
        if (stat.size !== done) {
          done = stat.size;
          onProgress(done, total);
        }
      } catch {
        // file may not exist yet
      }
    }, 150);

    output.on('close', () => {
      clearInterval(timer);
    });
  });
}

/** Validate that a file is a readable ZIP archive. */
function validateZip(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(new Error(`Invalid backup archive: ${err.message}`));
        return;
      }
      zipfile.close();
      resolve();
    });
  });
}

/**
 * Extract a ZIP into `destDir` with byte progress. Safe paths only — any
 * entry that would escape destDir is rejected.
 */
function extractZip(
  filePath: string,
  destDir: string,
  onProgress: (doneBytes: number, totalBytes: number) => void,
  isCanceled: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(new Error(`Invalid backup archive: ${err.message}`));
        return;
      }
      let total = 0;
      let done = 0;
      let pending = 0;

      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (isCanceled()) {
          zipfile.close();
          reject(new Error('canceled'));
          return;
        }
        const resolved = path.resolve(destDir, entry.fileName);
        if (!resolved.startsWith(path.resolve(destDir) + path.sep)) {
          zipfile.close();
          reject(new Error('Backup archive contains an unsafe path'));
          return;
        }
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(resolved, { recursive: true });
          zipfile.readEntry();
          return;
        }
        total += entry.uncompressedSize;
        pending += 1;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            zipfile.close();
            reject(streamErr);
            return;
          }
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          const write = fs.createWriteStream(resolved);
          stream.on('data', (chunk: Buffer) => {
            done += chunk.length;
            onProgress(done, total);
          });
          stream.on('error', (e: Error) => {
            zipfile.close();
            reject(e);
          });
          write.on('error', (e: Error) => {
            zipfile.close();
            reject(e);
          });
          write.on('close', () => {
            pending -= 1;
            zipfile.readEntry();
          });
          stream.pipe(write);
        });
      });
      zipfile.on('end', () => {
        // All entries have been read; wait for in-flight writes to drain.
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
      zipfile.on('error', (e: Error) => reject(e));
    });
  });
}

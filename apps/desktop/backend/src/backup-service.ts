import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yazl from 'yazl';
import type {
  BackupEntry,
  BackupProgress,
  CreateBackupRequest,
  RestoreBackupRequest,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import type { WsBroadcast } from './world-service';
import {
  FilesystemTransactionCanceledError,
  replaceDirectoryAtomically,
} from './fs-transaction';
import { SERVER_OWNERSHIP_MARKER } from './path-policy';
import {
  ArchivePolicyError,
  safeJoin,
  walkZip,
  writeEntryStream,
} from './zip-utils';
import {
  ServerOperationConflictError,
  type ServerOperationCoordinator,
} from './server-operation-coordinator';

/** Result of starting a backup operation. */
export interface BackupOperationStart {
  /** Operation id for the broadcast + cancel lookup. */
  operationId: string;
  error?: string;
}

/** Default number of backups to keep per server. */
export const DEFAULT_RETENTION = 10;

interface BackupOperationState {
  cancelRequested: boolean;
  controller: AbortController;
  serverId: string;
}

class InvalidBackupArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidBackupArchiveError';
  }
}

/**
 * Creates ZIP backups of a server folder, lists/restores/deletes them, and
 * enforces a per-server retention limit. Backups live outside the active
 * server folder. Progress is broadcast over WebSocket.
 */
export class BackupService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly backupsDir: string;
  private readonly coordinator: ServerOperationCoordinator | null;
  private operations = new Map<string, BackupOperationState>();

  constructor(
    db: DatabaseResult,
    broadcast: WsBroadcast,
    backupsDir: string,
    coordinator: ServerOperationCoordinator | null = null,
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.backupsDir = backupsDir;
    this.coordinator = coordinator;
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
    try {
      this.coordinator?.acquire(request.serverId, 'backup', operationId);
    } catch (error) {
      if (error instanceof ServerOperationConflictError) {
        return { operationId: '', error: error.message };
      }
      throw error;
    }
    this.operations.set(operationId, {
      cancelRequested: false,
      controller: new AbortController(),
      serverId: request.serverId,
    });
    void this.runCreate(operationId, request, record.folderPath).catch(
      (err: unknown) => {
        this.finish(operationId, {
          status: 'failed',
          percent: null,
          message: err instanceof Error ? err.message : String(err),
          errorCode: 'io',
        });
      },
    ).finally(() => {
      this.coordinator?.release(request.serverId, operationId);
    });
    return { operationId };
  }

  /** Delete a backup by record id. Returns false when not found. */
  delete(backupId: string): boolean {
    const row = this.db.getBackup(backupId);
    if (!row) return false;
    const operationId = crypto.randomUUID();
    this.coordinator?.acquire(row.serverId, 'backup', operationId);
    try {
      return this.deleteUnlocked(row.id, row.filePath);
    } finally {
      this.coordinator?.release(row.serverId, operationId);
    }
  }

  private deleteUnlocked(backupId: string, filePath: string): boolean {
    // Preserve the database reference if removing the archive fails so the
    // orphan remains visible and the failure is not reported as success.
    fs.rmSync(filePath, { force: true });
    return this.db.deleteBackup(backupId);
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
    try {
      this.coordinator?.acquire(row.serverId, 'restore', operationId);
    } catch (error) {
      if (error instanceof ServerOperationConflictError) {
        return { operationId: '', error: error.message };
      }
      throw error;
    }
    this.operations.set(operationId, {
      cancelRequested: false,
      controller: new AbortController(),
      serverId: row.serverId,
    });
    void this.runRestore(operationId, row, record.folderPath).catch(
      (err: unknown) => {
        this.finish(operationId, {
          status: 'failed',
          percent: null,
          message: err instanceof Error ? err.message : String(err),
          errorCode:
            err instanceof InvalidBackupArchiveError || err instanceof ArchivePolicyError
              ? 'invalid-archive'
              : 'io',
        });
      },
    ).finally(() => {
      this.coordinator?.release(row.serverId, operationId);
    });
    return { operationId };
  }

  /** Request cancellation of a running backup create/restore. */
  cancel(operationId: string): boolean {
    const entry = this.operations.get(operationId);
    if (!entry) return false;
    if (
      this.coordinator &&
      !this.coordinator.requestCancel(entry.serverId, operationId)
    ) {
      return false;
    }
    entry.cancelRequested = true;
    entry.controller.abort();
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

    try {
      this.emit(operationId, {
        status: 'restoring',
        percent: 0,
        message: 'Verifying backup archive…',
      });

      const inspection = await inspectBackupArchive(row.filePath, entry?.controller.signal);
      if (inspection.fileCount === 0) {
        throw new InvalidBackupArchiveError('Invalid backup archive: archive contains no files');
      }

      this.emit(operationId, {
        status: 'restoring',
        percent: 30,
        message: 'Restoring backup…',
      });

      let extractedFiles = 0;
      await replaceDirectoryAtomically(
        serverFolder,
        async (stagingPath) => {
          extractedFiles = await extractBackupArchive(
            row.filePath,
            stagingPath,
            inspection.totalBytes,
            (done, total) => {
              const percent =
                total > 0 ? 30 + Math.min(69, Math.round((done / total) * 69)) : 30;
              this.emit(operationId, {
                status: 'restoring',
                percent,
                message: 'Restoring backup…',
              });
            },
            entry?.controller.signal,
          );
          await preserveOwnershipMarker(serverFolder, stagingPath);
        },
        async (stagingPath) => {
          const stat = await fs.promises.lstat(stagingPath);
          if (!stat.isDirectory() || extractedFiles !== inspection.fileCount) {
            throw new InvalidBackupArchiveError('Invalid backup archive: incomplete extraction');
          }
        },
        { signal: entry?.controller.signal },
      );

      this.finish(operationId, {
        status: 'complete',
        percent: 100,
        message: 'Backup restored',
      });
    } catch (error) {
      if (isCanceled() || isCancellationError(error)) {
        this.finish(operationId, {
          status: 'canceled',
          percent: null,
          message: 'Restore canceled',
          errorCode: 'cancelled',
        });
        return;
      }
      throw error;
    }
  }

  /** Keep at most DEFAULT_RETENTION backups per server (oldest removed). */
  private enforceRetention(serverId: string): void {
    const rows = this.db.getServerBackups(serverId);
    if (rows.length <= DEFAULT_RETENTION) return;
    // Database ordering is oldest first, so remove only the excess prefix and
    // retain the newest DEFAULT_RETENTION rows.
    for (const row of rows.slice(0, rows.length - DEFAULT_RETENTION)) {
      this.deleteUnlocked(row.id, row.filePath);
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

interface BackupArchiveInspection {
  fileCount: number;
  totalBytes: number;
}

async function inspectBackupArchive(
  filePath: string,
  signal?: AbortSignal,
): Promise<BackupArchiveInspection> {
  let fileCount = 0;
  let totalBytes = 0;
  try {
    await walkZip(
      filePath,
      async (entry, stream) => {
        fileCount += 1;
        totalBytes += entry.uncompressedSize;
        for await (const _chunk of stream) {
          // Reading every entry validates compressed data before live state is touched.
        }
      },
      { signal },
    );
  } catch (error) {
    if (isCancellationError(error)) throw error;
    if (error instanceof ArchivePolicyError) throw error;
    throw new InvalidBackupArchiveError(
      `Invalid backup archive: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return { fileCount, totalBytes };
}

async function extractBackupArchive(
  filePath: string,
  destDir: string,
  totalBytes: number,
  onProgress: (doneBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  let doneBytes = 0;
  let fileCount = 0;
  await walkZip(
    filePath,
    async (entry, stream) => {
      const target = safeJoin(destDir, entry.fileName);
      if (!target) {
        throw new InvalidBackupArchiveError(
          `Invalid backup archive: unsafe path ${entry.fileName}`,
        );
      }
      await writeEntryStream(stream, target, signal);
      doneBytes += entry.uncompressedSize;
      onProgress(doneBytes, totalBytes);
      fileCount += 1;
    },
    { signal },
  );
  return fileCount;
}

async function preserveOwnershipMarker(liveFolder: string, stagingFolder: string): Promise<void> {
  const liveMarker = path.join(liveFolder, SERVER_OWNERSHIP_MARKER);
  const stagedMarker = path.join(stagingFolder, SERVER_OWNERSHIP_MARKER);
  if (fs.existsSync(liveMarker) && !fs.existsSync(stagedMarker)) {
    const stat = await fs.promises.lstat(liveMarker);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      await fs.promises.copyFile(liveMarker, stagedMarker, fs.constants.COPYFILE_EXCL);
    }
  }
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof FilesystemTransactionCanceledError ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

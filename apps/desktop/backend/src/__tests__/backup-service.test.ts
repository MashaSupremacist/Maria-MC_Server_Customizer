import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { openDatabase, type DatabaseResult } from '../db';
import {
  BackupService,
  DEFAULT_RETENTION,
} from '../backup-service';
import { SERVER_OWNERSHIP_MARKER } from '../path-policy';
import {
  ServerOperationConflictError,
  ServerOperationCoordinator,
} from '../server-operation-coordinator';

describe('BackupService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let backupsDir: string;
  let serverFolder: string;
  let serverId: string;
  let service: BackupService;
  let coordinator: ServerOperationCoordinator;
  const events: Array<{ backupId: string; progress: unknown }> = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-backup-'));
    db = openDatabase(dataDir);
    backupsDir = path.join(dataDir, 'backups');
    serverFolder = path.join(dataDir, 'server');
    fs.mkdirSync(serverFolder, { recursive: true });
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'motd=hello\n');
    fs.writeFileSync(path.join(serverFolder, 'eula.txt'), 'eula=true\n');
    fs.mkdirSync(path.join(serverFolder, 'world'), { recursive: true });
    fs.writeFileSync(path.join(serverFolder, 'world', 'level.dat'), Buffer.alloc(64, 1));

    const record = db.createServer({
      name: 'Backup Test',
      edition: 'java',
      serverType: 'vanilla',
      folderPath: serverFolder,
      version: '1.21.4',
    });
    serverId = record.id;

    coordinator = new ServerOperationCoordinator();
    service = new BackupService(db, (event) => {
      if (event.type === 'backup:progress') {
        events.push({ backupId: event.backupId, progress: event.progress });
      }
    }, backupsDir, coordinator);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    events.length = 0;
  });

  function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = (): void => {
        if (predicate()) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error('waitFor timed out'));
        else setTimeout(poll, 25);
      };
      poll();
    });
  }

  function waitForComplete(operationId: string): Promise<void> {
    return waitFor(() =>
      events.some(
        (e) =>
          e.backupId === operationId &&
          (e.progress as { status?: string }).status === 'complete',
      ),
    );
  }

  function waitForStatus(operationId: string, status: string): Promise<void> {
    return waitFor(() =>
      events.some(
        (e) =>
          e.backupId === operationId &&
          (e.progress as { status?: string }).status === status,
      ),
    );
  }

  function createArchive(
    entries: Array<{ name: string; content: string | Buffer }>,
  ): Promise<string> {
    const archivePath = path.join(backupsDir, `fixture-${crypto.randomUUID()}.zip`);
    return new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile();
      const output = fs.createWriteStream(archivePath);
      output.on('error', reject);
      output.on('close', () => resolve(archivePath));
      zip.outputStream.on('error', reject);
      zip.outputStream.pipe(output);
      for (const entry of entries) {
        zip.addBuffer(
          Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content),
          entry.name,
        );
      }
      zip.end();
    });
  }

  async function registerArchive(
    entries: Array<{ name: string; content: string | Buffer }>,
  ): Promise<{ id: string; filePath: string }> {
    const filePath = await createArchive(entries);
    const row = db.createBackup({
      serverId,
      filePath,
      note: 'Fixture',
      sizeBytes: fs.statSync(filePath).size,
    });
    return { id: row.id, filePath };
  }

  function listZipEntries(zipPath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const entries: string[] = [];
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.readEntry();
        zipfile.on('entry', (entry: yauzl.Entry) => {
          entries.push(entry.fileName);
          zipfile.readEntry();
        });
        zipfile.on('end', () => {
          zipfile.close();
          resolve(entries);
        });
        zipfile.on('error', reject);
      });
    });
  }

  it('creates a ZIP backup and records it', async () => {
    const { operationId, error } = service.create({ serverId, note: 'Before mods' });
    expect(error).toBeUndefined();
    expect(operationId).toBeTruthy();
    await waitForComplete(operationId);

    const backups = service.list(serverId);
    expect(backups).toHaveLength(1);
    expect(backups[0].note).toBe('Before mods');
    expect(backups[0].sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(backups[0].filePath)).toBe(true);
    // Stored outside the server folder.
    expect(backups[0].filePath.startsWith(backupsDir)).toBe(true);

    const entries = await listZipEntries(backups[0].filePath);
    expect(entries).toContain('server.properties');
    expect(entries).toContain('eula.txt');
    expect(entries).toContain('world/level.dat');
  });

  it('defaults the note to a timestamp when omitted', async () => {
    const { operationId } = service.create({ serverId });
    await waitForComplete(operationId);
    const backups = service.list(serverId);
    expect(backups[0].note.length).toBeGreaterThan(0);
  });

  it('rejects creating a backup when the server is running', () => {
    service.setRunningServerId(() => serverId);
    const result = service.create({ serverId });
    expect(result.error).toMatch(/Stop the server/);
    expect(result.operationId).toBe('');
  });

  it('rejects creating a backup for a missing folder', () => {
    fs.rmSync(serverFolder, { recursive: true, force: true });
    const result = service.create({ serverId });
    expect(result.error).toMatch(/folder not found/i);
  });

  it('deletes a backup (record + file)', async () => {
    const { operationId } = service.create({ serverId });
    await waitForComplete(operationId);
    const backup = service.list(serverId)[0];

    const deleted = service.delete(backup.id);
    expect(deleted).toBe(true);
    expect(service.list(serverId)).toHaveLength(0);
    expect(fs.existsSync(backup.filePath)).toBe(false);

    expect(service.delete('nope')).toBe(false);
  });

  it('retains the database reference when deleting the archive fails', async () => {
    const { operationId } = service.create({ serverId });
    await waitForComplete(operationId);
    const backup = service.list(serverId)[0];
    const originalRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(backup.filePath)) {
        throw new Error('simulated delete failure');
      }
      return originalRmSync(target, options);
    });

    expect(() => service.delete(backup.id)).toThrow('simulated delete failure');
    rmSpy.mockRestore();

    expect(db.getBackup(backup.id)).not.toBeNull();
    expect(fs.existsSync(backup.filePath)).toBe(true);
  });

  it('restores a backup, replacing the current folder', async () => {
    const { operationId } = service.create({ serverId, note: 'Snapshot' });
    await waitForComplete(operationId);
    const backup = service.list(serverId)[0];

    // Modify the live folder after the backup.
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'motd=changed\n');
    fs.writeFileSync(path.join(serverFolder, 'extra.txt'), 'extra');
    const marker = '{"version":1,"owned":true}\n';
    fs.writeFileSync(path.join(serverFolder, SERVER_OWNERSHIP_MARKER), marker);

    const restore = service.restore({ backupId: backup.id });
    expect(restore.error).toBeUndefined();
    await waitForComplete(restore.operationId);

    // Original content restored; extra file removed.
    expect(fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8')).toBe(
      'motd=hello\n',
    );
    expect(fs.existsSync(path.join(serverFolder, 'extra.txt'))).toBe(false);
    expect(fs.existsSync(path.join(serverFolder, 'world', 'level.dat'))).toBe(true);
    // Old backups may predate ownership markers; preserve the live marker.
    expect(fs.readFileSync(path.join(serverFolder, SERVER_OWNERSHIP_MARKER), 'utf8')).toBe(marker);
    expect(fs.readdirSync(backupsDir).some((name) => name.startsWith('pre-restore-'))).toBe(false);
    expect(
      fs.readdirSync(dataDir).some((name) => name.includes('.staging-') || name.includes('.rollback-')),
    ).toBe(false);
  });

  it('preserves live files when the backup archive is corrupt', async () => {
    const filePath = path.join(backupsDir, 'corrupt.zip');
    fs.writeFileSync(filePath, 'not a zip');
    const backup = db.createBackup({
      serverId,
      filePath,
      note: 'Corrupt',
      sizeBytes: fs.statSync(filePath).size,
    });
    fs.writeFileSync(path.join(serverFolder, 'live.txt'), 'keep me');

    const restore = service.restore({ backupId: backup.id });
    await waitForStatus(restore.operationId, 'failed');

    expect(fs.readFileSync(path.join(serverFolder, 'live.txt'), 'utf8')).toBe('keep me');
    const terminal = events.find(
      (event) =>
        event.backupId === restore.operationId &&
        (event.progress as { status?: string }).status === 'failed',
    );
    expect((terminal?.progress as { errorCode?: string }).errorCode).toBe('invalid-archive');
  });

  it('preserves live files when extraction cannot write an entry', async () => {
    const backup = await registerArchive([
      { name: 'conflict/child.txt', content: 'child' },
      { name: 'conflict', content: 'cannot replace a directory with a file' },
    ]);
    fs.writeFileSync(path.join(serverFolder, 'live.txt'), 'keep me');

    const restore = service.restore({ backupId: backup.id });
    await waitForStatus(restore.operationId, 'failed');

    expect(fs.readFileSync(path.join(serverFolder, 'live.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(serverFolder, 'conflict'))).toBe(false);
  });

  it('preserves live files when restore is canceled before commit', async () => {
    const { operationId } = service.create({ serverId, note: 'Cancelable' });
    await waitForComplete(operationId);
    const backup = service.list(serverId)[0];
    fs.writeFileSync(path.join(serverFolder, 'live.txt'), 'keep me');

    const restore = service.restore({ backupId: backup.id });
    expect(service.cancel(restore.operationId)).toBe(true);
    await waitForStatus(restore.operationId, 'canceled');

    expect(fs.readFileSync(path.join(serverFolder, 'live.txt'), 'utf8')).toBe('keep me');
  });

  it('rejects restore for a missing backup', () => {
    const result = service.restore({ backupId: 'missing' });
    expect(result.error).toMatch(/not found/i);
  });

  it('rejects restore while the server is running', async () => {
    const { operationId } = service.create({ serverId });
    await waitForComplete(operationId);
    const backup = service.list(serverId)[0];

    service.setRunningServerId(() => serverId);
    const result = service.restore({ backupId: backup.id });
    expect(result.error).toMatch(/Stop the server/);
  });

  it('holds a restore lease until terminal cleanup and rejects a competing start', async () => {
    const { operationId } = service.create({ serverId });
    await waitForComplete(operationId);
    const backup = service.list(serverId)[0];
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'motd=changed\n');

    const restore = service.restore({ backupId: backup.id });
    expect(restore.error).toBeUndefined();
    expect(() => coordinator.acquire(serverId, 'start')).toThrow(ServerOperationConflictError);

    await waitForComplete(restore.operationId);
    const startLease = coordinator.acquire(serverId, 'start');
    expect(coordinator.release(serverId, startLease.operationId)).toBe(true);
  });

  it('enforces the retention limit (oldest removed)', async () => {
    // Create more than the retention limit.
    for (let i = 0; i < DEFAULT_RETENTION + 3; i += 1) {
      const { operationId } = service.create({ serverId, note: `Backup ${i}` });
      await waitForComplete(operationId);
    }

    const backups = service.list(serverId);
    expect(backups).toHaveLength(DEFAULT_RETENTION);
    expect(backups.some((b) => b.note === 'Backup 0')).toBe(false);
    expect(backups.some((b) => b.note === 'Backup 1')).toBe(false);
    expect(backups.some((b) => b.note === 'Backup 2')).toBe(false);
    expect(backups.some((b) => b.note === `Backup ${DEFAULT_RETENTION + 2}`)).toBe(true);
    // Files of pruned backups are deleted too.
    const keptFiles = new Set(backups.map((b) => b.filePath));
    const allZipFiles = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.zip'));
    for (const f of allZipFiles) {
      expect(keptFiles.has(path.join(backupsDir, f))).toBe(true);
    }
  });

  it('broadcasts creating → complete progress', async () => {
    const { operationId } = service.create({ serverId });
    await waitForComplete(operationId);
    const statuses = events
      .filter((e) => e.backupId === operationId)
      .map((e) => (e.progress as { status: string }).status);
    expect(statuses).toContain('creating');
    expect(statuses[statuses.length - 1]).toBe('complete');
  });
});

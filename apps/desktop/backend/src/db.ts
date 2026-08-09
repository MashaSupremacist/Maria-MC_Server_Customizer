import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AppSettings,
  type CreateServerInput,
  type ServerRecord,
  type UpdateServerInput,
} from '@msc/shared-types';
import { hasValidOwnershipMarker } from './path-policy';

export interface DatabaseResult {
  /** Resolves a dir to a canonical absolute path. */
  resolveDir: (dir: string) => string;
  listServers: () => ServerRecord[];
  getServer: (id: string) => ServerRecord | null;
  createServer: (input: CreateServerInput) => ServerRecord;
  updateServer: (id: string, input: UpdateServerInput) => ServerRecord | null;
  deleteServer: (id: string) => boolean;
  getSettings: () => AppSettings;
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => AppSettings;
  getServerBackups: (serverId: string) => BackupRecord[];
  getBackup: (id: string) => BackupRecord | null;
  createBackup: (input: CreateBackupInput) => BackupRecord;
  deleteBackup: (id: string) => boolean;
  close: () => void;
}

/** A backup archive record. */
export interface BackupRecord {
  id: string;
  serverId: string;
  filePath: string;
  note: string;
  sizeBytes: number;
  createdAt: string;
}

export interface CreateBackupInput {
  serverId: string;
  filePath: string;
  note: string;
  sizeBytes: number;
}

interface ServerRow {
  id: string;
  name: string;
  edition: string;
  server_type: string;
  folder_path: string;
  java_path: string | null;
  memory_mb: number;
  port: number;
  version: string | null;
  jvm_args: string;
  created_at: string;
  updated_at: string;
}

interface BackupRow {
  id: string;
  server_id: string;
  file_path: string;
  note: string;
  size_bytes: number;
  created_at: string;
}

/**
 * Create and open the application SQLite database. better-sqlite3 v12 ships
 * prebuilt binaries, so no compile toolchain is required on Windows.
 */
export function openDatabase(dataDir: string): DatabaseResult {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'msc.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      edition TEXT NOT NULL,
      server_type TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      java_path TEXT,
      memory_mb INTEGER NOT NULL DEFAULT 1024,
      port INTEGER NOT NULL DEFAULT 25565,
      version TEXT,
      jvm_args TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);

  // Migration: add jvm_args to databases created before Phase 3.
  const columns = db.prepare(`PRAGMA table_info(servers)`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === 'jvm_args')) {
    db.exec(`ALTER TABLE servers ADD COLUMN jvm_args TEXT NOT NULL DEFAULT '[]'`);
  }

  const rowToServer = (row: ServerRow): ServerRecord => {
    const canonicalFolderPath = canonicalizeBestEffort(row.folder_path);
    const libraryRoot = getSettings().serverLibraryPath;
    return {
      id: row.id,
      name: row.name,
      edition: row.edition as ServerRecord['edition'],
      serverType: row.server_type,
      folderPath: row.folder_path,
      javaPath: row.java_path,
      memoryMb: row.memory_mb,
      port: row.port,
      version: row.version,
      jvmArgs: safeJsonArray(row.jvm_args),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      folderExists: fs.existsSync(row.folder_path),
      canonicalFolderPath,
      folderOwned: hasValidOwnershipMarker(row.folder_path, libraryRoot),
    };
  };

  const safeJsonArray = (value: string): string[] => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };

  const listServers = (): ServerRecord[] =>
    (db.prepare('SELECT * FROM servers ORDER BY created_at ASC').all() as ServerRow[]).map(
      rowToServer,
    );

  const getServer = (id: string): ServerRecord | null => {
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as
      | ServerRow
      | undefined;
    return row ? rowToServer(row) : null;
  };

  const createServer = (input: CreateServerInput): ServerRecord => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const memoryMb = input.memoryMb ?? 1024;
    const port = input.port ?? 25565;

    db.prepare(
      `INSERT INTO servers (id, name, edition, server_type, folder_path, java_path, memory_mb, port, version, jvm_args, created_at, updated_at)
       VALUES (@id, @name, @edition, @serverType, @folderPath, @javaPath, @memoryMb, @port, @version, @jvmArgs, @createdAt, @updatedAt)`,
    ).run({
      id,
      name: input.name,
      edition: input.edition,
      serverType: input.serverType,
      folderPath: input.folderPath,
      javaPath: input.javaPath ?? null,
      memoryMb,
      port,
      version: input.version ?? null,
      jvmArgs: JSON.stringify(input.jvmArgs ?? []),
      createdAt: now,
      updatedAt: now,
    });

    const record = getServer(id);
    if (!record) throw new Error('Failed to create server record');
    return record;
  };

  const updateServer = (
    id: string,
    input: UpdateServerInput,
  ): ServerRecord | null => {
    const existing = getServer(id);
    if (!existing) return null;

    const next: ServerRecord = {
      ...existing,
      name: input.name ?? existing.name,
      serverType: input.serverType ?? existing.serverType,
      folderPath: input.folderPath ?? existing.folderPath,
      javaPath: input.javaPath !== undefined ? input.javaPath : existing.javaPath,
      memoryMb: input.memoryMb ?? existing.memoryMb,
      port: input.port ?? existing.port,
      version: input.version !== undefined ? input.version : existing.version,
      jvmArgs: input.jvmArgs ?? existing.jvmArgs,
      updatedAt: new Date().toISOString(),
    };

    db.prepare(
      `UPDATE servers
       SET name = @name, server_type = @serverType, folder_path = @folderPath,
           java_path = @javaPath, memory_mb = @memoryMb, port = @port,
           version = @version, jvm_args = @jvmArgs, updated_at = @updatedAt
       WHERE id = @id`,
    ).run({
      id: next.id,
      name: next.name,
      serverType: next.serverType,
      folderPath: next.folderPath,
      javaPath: next.javaPath,
      memoryMb: next.memoryMb,
      port: next.port,
      version: next.version,
      jvmArgs: JSON.stringify(next.jvmArgs),
      updatedAt: next.updatedAt,
    });

    return getServer(id);
  };

  const deleteServer = (id: string): boolean => {
    const result = db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    return result.changes > 0;
  };

  const getSettings = (): AppSettings => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const map: Record<string, string> = {};
    for (const row of rows) {
      try {
        map[row.key] = JSON.parse(row.value) as string;
      } catch {
        map[row.key] = row.value;
      }
    }
    return {
      serverLibraryPath: map.serverLibraryPath ?? null,
      playitPath: map.playitPath ?? null,
      playitPublicAddress: map.playitPublicAddress ?? null,
      lastJavaPath: map.lastJavaPath ?? null,
    };
  };

  const setSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): AppSettings => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key as string, JSON.stringify(value));
    return getSettings();
  };

  const resolveDir = (dir: string): string => path.resolve(dir);

  const rowToBackup = (row: BackupRow): BackupRecord => ({
    id: row.id,
    serverId: row.server_id,
    filePath: row.file_path,
    note: row.note,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  });

  const getServerBackups = (serverId: string): BackupRecord[] =>
    (
      db
        .prepare(
          'SELECT * FROM backups WHERE server_id = ? ORDER BY created_at ASC, rowid ASC',
        )
        .all(serverId) as BackupRow[]
    ).map(rowToBackup);

  const getBackup = (id: string): BackupRecord | null => {
    const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as
      | BackupRow
      | undefined;
    return row ? rowToBackup(row) : null;
  };

  const createBackup = (input: CreateBackupInput): BackupRecord => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO backups (id, server_id, file_path, note, size_bytes, created_at)
       VALUES (@id, @serverId, @filePath, @note, @sizeBytes, @createdAt)`,
    ).run({
      id,
      serverId: input.serverId,
      filePath: input.filePath,
      note: input.note,
      sizeBytes: input.sizeBytes,
      createdAt: now,
    });
    const record = getBackup(id);
    if (!record) throw new Error('Failed to create backup record');
    return record;
  };

  const deleteBackup = (id: string): boolean => {
    const result = db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    return result.changes > 0;
  };

  const close = (): void => {
    db.close();
  };

  return {
    resolveDir,
    listServers,
    getServer,
    createServer,
    updateServer,
    deleteServer,
    getSettings,
    setSetting,
    getServerBackups,
    getBackup,
    createBackup,
    deleteBackup,
    close,
  };
}

function canonicalizeBestEffort(folderPath: string): string {
  try {
    return path.resolve(fs.realpathSync.native(path.resolve(folderPath)));
  } catch {
    return path.resolve(folderPath);
  }
}

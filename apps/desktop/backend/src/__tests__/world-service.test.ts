import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDatabase, type DatabaseResult } from '../db';
import { WorldService } from '../world-service';
import { readWorldMetadata } from '../nbt';

/**
 * Build a minimal level.dat (gzip NBT) with a Data compound containing
 * LevelName, GameType, Version, LastPlayed.
 */
function makeLevelDat(overrides: Record<string, unknown> = {}): Buffer {
  const enc = new TextEncoder();
  const str = (s: string): Buffer => {
    const bytes = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  const int = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const long = (n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(n));
    return b;
  };

  const levelName = overrides.LevelName ?? 'My World';
  const gameType = overrides.GameType ?? 1;
  const version = overrides.Version ?? '1.21.4';
  const lastPlayed = overrides.LastPlayed ?? 1700000000000;

  const dataFields: Buffer[] = [
    Buffer.from([0x08]), str('LevelName'), str(String(levelName)),
    Buffer.from([0x03]), str('GameType'), int(Number(gameType)),
    Buffer.from([0x08]), str('Version'), str(String(version)),
    Buffer.from([0x04]), str('LastPlayed'), long(Number(lastPlayed)),
  ];

  // Real level.dat nests fields under a named "Data" compound.
  // Root: type compound + empty name, then entry type compound + "Data"
  // + fields + end, then root end.
  const root = Buffer.concat([
    Buffer.from([0x0a]),
    str(''),
    Buffer.from([0x0a]),
    str('Data'),
    ...dataFields,
    Buffer.from([0x00]), // end of Data compound
    Buffer.from([0x00]), // end of root compound
  ]);
  return zlib.gzipSync(root);
}

describe('readWorldMetadata (NBT)', () => {
  it('reads world metadata from a gzip level.dat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-nbt-'));
    const file = path.join(dir, 'level.dat');
    fs.writeFileSync(file, makeLevelDat({ LevelName: 'Cool World', GameType: 1, Version: '1.21.4' }));
    const meta = readWorldMetadata(file);
    expect(meta).not.toBeNull();
    expect(meta?.displayName).toBe('Cool World');
    expect(meta?.gameMode).toBe('creative');
    expect(meta?.lastPlayedVersion).toBe('1.21.4');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a missing file', () => {
    expect(readWorldMetadata(path.join(os.tmpdir(), 'nope-level.dat'))).toBeNull();
  });

  it('returns null for corrupt data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-nbt-'));
    const file = path.join(dir, 'level.dat');
    fs.writeFileSync(file, Buffer.from('not nbt at all'));
    expect(readWorldMetadata(file)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('WorldService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let serverId: string;
  let service: WorldService;
  const events: Array<{ importId: string; progress: unknown }> = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-world-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    fs.mkdirSync(serverFolder, { recursive: true });
    const record = db.createServer({
      name: 'World Test',
      edition: 'java',
      serverType: 'vanilla',
      folderPath: serverFolder,
      version: '1.21.4',
    });
    serverId = record.id;
    service = new WorldService(db, (event) => {
      if (event.type === 'world:import-progress') {
        events.push({ importId: event.importId, progress: event.progress });
      }
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    events.length = 0;
  });

  function makeWorld(folder: string, name: string): string {
    const worldDir = path.join(folder, name);
    fs.mkdirSync(path.join(worldDir, 'region'), { recursive: true });
    fs.mkdirSync(path.join(worldDir, 'playerdata'), { recursive: true });
    fs.writeFileSync(path.join(worldDir, 'level.dat'), makeLevelDat({ LevelName: name }));
    fs.writeFileSync(path.join(worldDir, 'region', 'r.0.0.mca'), Buffer.alloc(1024, 1));
    return worldDir;
  }

  it('discovers valid worlds and flags invalid folders', () => {
    const scanDir = path.join(dataDir, 'scan');
    fs.mkdirSync(scanDir, { recursive: true });
    makeWorld(scanDir, 'Alpha');
    makeWorld(scanDir, 'Beta');
    fs.mkdirSync(path.join(scanDir, 'NotAWorld'), { recursive: true });

    const result = service.discover(scanDir);
    expect(result.worlds).toHaveLength(2);
    expect(result.worlds.map((w) => w.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(result.invalid).toContain('NotAWorld');
    // Metadata read from level.dat.
    expect(result.worlds[0].displayName).toBe(result.worlds[0].name);
    expect(result.worlds[0].gameMode).toBe('creative');
  });

  it('imports a world into the server folder with duplicate handling', async () => {
    const source = makeWorld(dataDir, 'SourceWorld');
    const { importId, error } = service.import({ serverId, sourcePath: source });
    expect(error).toBeUndefined();
    expect(importId).toBeTruthy();

    await waitFor(() => events.some((e) => (e.progress as { status?: string }).status === 'complete'));

    // Imported at serverFolder/SourceWorld.
    const target = path.join(serverFolder, 'SourceWorld');
    expect(fs.existsSync(path.join(target, 'level.dat'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'region', 'r.0.0.mca'))).toBe(true);

    // Import again → duplicate name becomes SourceWorld-2.
    const { importId: importId2 } = service.import({ serverId, sourcePath: source });
    expect(importId2).toBeTruthy();
    await waitFor(() => events.some((e) => (e.progress as { status?: string }).status === 'complete' && e.importId === importId2));
    expect(fs.existsSync(path.join(serverFolder, 'SourceWorld-2', 'level.dat'))).toBe(true);
  });

  it('rejects a source without level.dat', () => {
    const notWorld = path.join(dataDir, 'not-world');
    fs.mkdirSync(notWorld, { recursive: true });
    const result = service.import({ serverId, sourcePath: notWorld });
    expect(result.error).toMatch(/level.dat/);
  });

  it('rejects a source that contains the destination server folder', () => {
    fs.writeFileSync(path.join(serverFolder, 'level.dat'), makeLevelDat({ LevelName: 'Server Root' }));
    const equal = service.import({ serverId, sourcePath: serverFolder });
    expect(equal.error).toMatch(/cannot contain/i);

    const ancestor = service.import({ serverId, sourcePath: dataDir });
    expect(ancestor.error).toMatch(/level.dat/);
    fs.writeFileSync(path.join(dataDir, 'level.dat'), makeLevelDat({ LevelName: 'Ancestor' }));
    const ancestorWithWorldMarker = service.import({ serverId, sourcePath: dataDir });
    expect(ancestorWithWorldMarker.error).toMatch(/cannot contain/i);
  });

  it('reports monotonic progress for nested world folders', async () => {
    const source = makeWorld(dataDir, 'NestedProgress');
    fs.mkdirSync(path.join(source, 'region', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'region', 'nested', 'large.mca'), Buffer.alloc(256 * 1024));
    const { importId } = service.import({ serverId, sourcePath: source });
    await waitFor(() => events.some((event) => event.importId === importId && (event.progress as { status?: string }).status === 'complete'));
    const percentages = events
      .filter((event) => event.importId === importId)
      .map((event) => (event.progress as { percent?: number | null }).percent)
      .filter((value): value is number => typeof value === 'number');
    expect(percentages).toEqual([...percentages].sort((left, right) => left - right));
  });

  it('rejects import while the server is running', () => {
    const source = makeWorld(dataDir, 'Running');
    service.setRunningServerId(() => serverId);
    const result = service.import({ serverId, sourcePath: source });
    expect(result.error).toMatch(/Stop the server/);
  });

  it('supports a custom target name', async () => {
    const source = makeWorld(dataDir, 'Renamed');
    const { importId } = service.import({ serverId, sourcePath: source, targetName: 'custom-name' });
    await waitFor(() => events.some((e) => (e.progress as { status?: string }).status === 'complete'));
    expect(fs.existsSync(path.join(serverFolder, 'custom-name', 'level.dat'))).toBe(true);
    void importId;
  });
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

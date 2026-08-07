import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { openDatabase, type DatabaseResult } from '../db';
import { ModpackService } from '../modpack-service';
import type { WsServerEvent } from '@msc/shared-types';

/** Build a .mrpack (Modrinth) with an index + overrides. */
function makeMrpack(filePath: string, options: { mcVersion?: string; loader?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: 'test-pack',
      name: 'Test Pack',
      dependencies: {
        minecraft: options.mcVersion ?? '1.21.1',
        ...(options.loader === 'fabric' ? { 'fabric-loader': '0.16.0' } : {}),
        ...(options.loader === 'forge' ? { 'forge-loader': '52.0.57' } : {}),
      },
      files: [],
      overrides: ['overrides'],
    };
    zip.addBuffer(Buffer.from(JSON.stringify(index)), 'modrinth.index.json');
    zip.addBuffer(Buffer.from('fake jar'), 'overrides/mods/coolmod.jar');
    zip.addBuffer(Buffer.from('some config'), 'overrides/config/pack.toml');
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

/** Build a CurseForge-style .zip with mods/ + manifest.json. */
function makeCurseZip(filePath: string, options: { mcVersion?: string; loader?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    if (options.mcVersion || options.loader) {
      const manifest = {
        minecraft: {
          version: options.mcVersion ?? '1.21.1',
          modLoaders: options.loader
            ? [{ id: options.loader === 'forge' ? 'forge-52.0.57' : 'fabric-0.16.0', primary: true }]
            : [],
        },
        files: [],
        overrides: 'overrides',
      };
      zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
    }
    zip.addBuffer(Buffer.from('fake jar'), 'mods/coolmod.jar');
    zip.addBuffer(Buffer.from('some config'), 'config/pack.toml');
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

describe.sequential('ModpackService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let service: ModpackService;
  let serverId: string;
  const events: WsServerEvent[] = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-modpack-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    fs.mkdirSync(serverFolder, { recursive: true });
    const record = db.createServer({
      name: 'Forge Server',
      edition: 'java',
      serverType: 'forge',
      folderPath: serverFolder,
      version: '1.21.1',
    });
    serverId = record.id;
    events.length = 0;
    service = new ModpackService(db, (e) => events.push(e));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('imports an mrpack overrides into a forge server', async () => {
    const pack = path.join(dataDir, 'pack.mrpack');
    await makeMrpack(pack, { mcVersion: '1.21.1', loader: 'forge' });
    const res = await service.import(serverId, pack);
    expect(res.ok).toBe(true);
    expect(res.modsAdded).toBe(1);
    expect(res.filesCopied).toBe(1);
    expect(fs.existsSync(path.join(serverFolder, 'mods', 'coolmod.jar'))).toBe(true);
    expect(fs.existsSync(path.join(serverFolder, 'config', 'pack.toml'))).toBe(true);
    // Progress events were emitted.
    expect(events.some((e) => e.type === 'install:progress')).toBe(true);
  });

  it('imports a curseforge zip mods/ + config', async () => {
    const pack = path.join(dataDir, 'pack.zip');
    await makeCurseZip(pack, { mcVersion: '1.21.1', loader: 'forge' });
    const res = await service.import(serverId, pack);
    expect(res.ok).toBe(true);
    expect(res.modsAdded).toBe(1);
    expect(res.filesCopied).toBe(1);
    expect(fs.existsSync(path.join(serverFolder, 'mods', 'coolmod.jar'))).toBe(true);
    expect(fs.existsSync(path.join(serverFolder, 'config', 'pack.toml'))).toBe(true);
  });

  it('rejects an mrpack whose loader does not match the server', async () => {
    const pack = path.join(dataDir, 'fabric.mrpack');
    await makeMrpack(pack, { mcVersion: '1.21.1', loader: 'fabric' });
    const res = await service.import(serverId, pack);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('fabric');
  });

  it('rejects a pack whose MC version does not match', async () => {
    const pack = path.join(dataDir, 'wrong-version.zip');
    await makeCurseZip(pack, { mcVersion: '1.20.4', loader: 'forge' });
    const res = await service.import(serverId, pack);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('1.20.4');
  });

  it('force bypasses the version match check', async () => {
    const pack = path.join(dataDir, 'force.zip');
    await makeCurseZip(pack, { mcVersion: '1.20.4', loader: 'forge' });
    const res = await service.import(serverId, pack, true);
    expect(res.ok).toBe(true);
  });

  it('rejects a non-server flavor (vanilla)', async () => {
    const vanillaFolder = path.join(dataDir, 'vanilla');
    fs.mkdirSync(vanillaFolder, { recursive: true });
    const vanilla = db.createServer({
      name: 'Vanilla',
      edition: 'java',
      serverType: 'vanilla',
      folderPath: vanillaFolder,
    });
    const pack = path.join(dataDir, 'pack.mrpack');
    await makeMrpack(pack, { mcVersion: '1.21.1' });
    const res = await service.import(vanilla.id, pack);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Fabric or Forge');
  });

  it('rejects imports while the server is running', async () => {
    service.setRunningServerId(() => serverId);
    const pack = path.join(dataDir, 'pack.mrpack');
    await makeMrpack(pack, { mcVersion: '1.21.1', loader: 'forge' });
    const res = await service.import(serverId, pack);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Stop the server');
  });

  it('rejects a file that is not a recognized pack', async () => {
    const pack = path.join(dataDir, 'random.zip');
    fs.writeFileSync(pack, 'not a zip');
    const res = await service.import(serverId, pack);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('expected');
  });

  it('skips live-server files (server.properties, world/)', async () => {
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), '# existing');
    fs.mkdirSync(path.join(serverFolder, 'world'), { recursive: true });
    fs.writeFileSync(path.join(serverFolder, 'world', 'level.dat'), 'world data');

    const pack = path.join(dataDir, 'skip.zip');
    await makeCurseZip(pack, { mcVersion: '1.21.1', loader: 'forge' });
    // Add a server.properties + world to the pack to prove they're skipped.
    await new Promise<void>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(JSON.stringify({ minecraft: { version: '1.21.1', modLoaders: [{ id: 'forge-52.0.57', primary: true }] }, files: [], overrides: 'overrides' })), 'manifest.json');
      zip.addBuffer(Buffer.from('fake jar'), 'mods/coolmod.jar');
      zip.addBuffer(Buffer.from('overwrite'), 'server.properties');
      zip.addBuffer(Buffer.from('level data'), 'world/level.dat');
      const output = fs.createWriteStream(pack);
      output.on('error', reject);
      output.on('close', resolve);
      zip.outputStream.pipe(output);
      zip.end();
    });

    const res = await service.import(serverId, pack);
    expect(res.ok).toBe(true);
    expect(res.modsAdded).toBe(1);
    // server.properties + world/level.dat skipped, no non-skip files copied.
    expect(res.filesCopied).toBe(0);
    expect(fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8')).toBe('# existing');
    expect(fs.readFileSync(path.join(serverFolder, 'world', 'level.dat'), 'utf8')).toBe('world data');
  });
});

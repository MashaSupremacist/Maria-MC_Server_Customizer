import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { openDatabase, type DatabaseResult } from '../db';
import { ModpackService } from '../modpack-service';
import type { WsServerEvent } from '@msc/shared-types';

/** Build a .mrpack (Modrinth) with an index + overrides. */
function makeMrpack(
  filePath: string,
  options: {
    mcVersion?: string;
    loader?: string;
    files?: unknown[];
    includeOverrides?: boolean;
    overrideEntries?: Record<string, string>;
  },
): Promise<void> {
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
      files: options.files ?? [],
      overrides: ['overrides'],
    };
    zip.addBuffer(Buffer.from(JSON.stringify(index)), 'modrinth.index.json');
    if (options.includeOverrides !== false) {
      const entries = options.overrideEntries ?? {
        'mods/coolmod.jar': 'fake jar',
        'config/pack.toml': 'some config',
      };
      for (const [name, content] of Object.entries(entries)) {
        zip.addBuffer(Buffer.from(content), `overrides/${name}`);
      }
    }
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

/** Build a CurseForge-style .zip with mods/ + manifest.json. */
function makeCurseZip(
  filePath: string,
  options: { mcVersion?: string; loader?: string; files?: unknown[] },
): Promise<void> {
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
        files: options.files ?? [],
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

function hash(algorithm: 'sha1' | 'sha512', content: Buffer): string {
  return crypto.createHash(algorithm).update(content).digest('hex');
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe.sequential('ModpackService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let service: ModpackService;
  let serverId: string;
  let downloadServer: Server | null;
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
    downloadServer = null;
    events.length = 0;
    service = new ModpackService(db, (e) => events.push(e));
  });

  afterEach(async () => {
    if (downloadServer) {
      downloadServer.closeAllConnections();
      await new Promise<void>((resolve) => downloadServer?.close(() => resolve()));
    }
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

  it('downloads and verifies standard Modrinth server files while skipping client-only files', async () => {
    const mod = Buffer.from('remote mod jar');
    const config = Buffer.from('remote config');
    downloadServer = createServer((request, response) => {
      const content = request.url === '/mod' ? mod : request.url === '/config' ? config : null;
      if (!content) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-length': content.length });
      response.end(content);
    });
    const baseUrl = await listen(downloadServer);
    const pack = path.join(dataDir, 'standard.mrpack');
    await makeMrpack(pack, {
      mcVersion: '1.21.1',
      loader: 'forge',
      includeOverrides: false,
      files: [
        {
          path: 'mods/remote.jar',
          hashes: { sha512: hash('sha512', mod), sha1: hash('sha1', mod) },
          downloads: [`${baseUrl}/mod`],
          fileSize: mod.length,
          env: { server: 'required', client: 'optional' },
        },
        {
          path: 'config/remote.toml',
          hashes: { sha1: hash('sha1', config) },
          downloads: [`${baseUrl}/config`],
          fileSize: config.length,
          env: { server: 'optional', client: 'optional' },
        },
        {
          path: 'mods/client-only.jar',
          downloads: [`${baseUrl}/client`],
          env: { server: 'unsupported', client: 'required' },
        },
      ],
    });

    const result = await service.import(serverId, pack);
    expect(result).toMatchObject({
      ok: true,
      modsAdded: 1,
      filesCopied: 1,
      downloaded: 2,
      skipped: 1,
      rejected: 0,
    });
    expect(fs.readFileSync(path.join(serverFolder, 'mods', 'remote.jar'))).toEqual(mod);
    expect(fs.readFileSync(path.join(serverFolder, 'config', 'remote.toml'))).toEqual(config);
    expect(fs.existsSync(path.join(serverFolder, 'mods', 'client-only.jar'))).toBe(false);
  });

  it('uses the strongest declared hash and rolls back every staged change on failure', async () => {
    const content = Buffer.from('downloaded bytes');
    downloadServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': content.length });
      response.end(content);
    });
    const baseUrl = await listen(downloadServer);
    fs.writeFileSync(path.join(serverFolder, 'sentinel.txt'), 'live data');

    const pack = path.join(dataDir, 'bad-hash.mrpack');
    await makeMrpack(pack, {
      loader: 'forge',
      overrideEntries: { 'config/from-overrides.toml': 'must not commit' },
      files: [{
        path: 'mods/bad.jar',
        hashes: { sha512: '0'.repeat(128), sha1: hash('sha1', content) },
        downloads: [`${baseUrl}/bad.jar`],
        fileSize: content.length,
      }],
    });

    const result = await service.import(serverId, pack);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('checksum');
    expect(result.rejected).toBe(1);
    expect(fs.readFileSync(path.join(serverFolder, 'sentinel.txt'), 'utf8')).toBe('live data');
    expect(fs.existsSync(path.join(serverFolder, 'mods', 'bad.jar'))).toBe(false);
    expect(fs.existsSync(path.join(serverFolder, 'config', 'from-overrides.toml'))).toBe(false);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('.server.staging-'))).toBe(false);
  });

  it('rejects client-only Modrinth packs without touching the live server', async () => {
    fs.writeFileSync(path.join(serverFolder, 'sentinel.txt'), 'unchanged');
    const pack = path.join(dataDir, 'client-only.mrpack');
    await makeMrpack(pack, {
      loader: 'forge',
      includeOverrides: false,
      files: [{
        path: 'mods/client.jar',
        env: { server: 'unsupported', client: 'required' },
        downloads: ['https://example.invalid/client.jar'],
      }],
    });

    const result = await service.import(serverId, pack);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('client-only');
    expect(fs.readFileSync(path.join(serverFolder, 'sentinel.txt'), 'utf8')).toBe('unchanged');
  });

  it('limits concurrent manifest downloads', async () => {
    let active = 0;
    let maximumActive = 0;
    service = new ModpackService(db, (event) => events.push(event), null, {
      maxConcurrentDownloads: 2,
      downloadService: {
        download: async (request) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          await fs.promises.mkdir(path.dirname(request.destination), { recursive: true });
          await fs.promises.writeFile(request.destination, request.destination);
          active -= 1;
          return { path: request.destination, bytes: request.destination.length };
        },
      },
    });
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `mods/mod-${index}.jar`,
      hashes: { sha1: `${index}`.repeat(40) },
      downloads: [`https://example.invalid/mod-${index}.jar`],
    }));
    const pack = path.join(dataDir, 'bounded.mrpack');
    await makeMrpack(pack, { loader: 'forge', includeOverrides: false, files });

    const result = await service.import(serverId, pack);
    expect(result.ok).toBe(true);
    expect(result.downloaded).toBe(5);
    expect(maximumActive).toBe(2);
  });

  it('rejects standard CurseForge manifests instead of reporting false success', async () => {
    const pack = path.join(dataDir, 'curse-standard.zip');
    await makeCurseZip(pack, {
      mcVersion: '1.21.1',
      loader: 'forge',
      files: [{ projectID: 123, fileID: 456, required: true }],
    });

    const result = await service.import(serverId, pack);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CurseForge');
    expect(result.error).toContain('unsupported');
    expect(result.rejected).toBe(1);
    expect(fs.existsSync(path.join(serverFolder, 'mods', 'coolmod.jar'))).toBe(false);
  });

  it('skips existing mods and protected paths case-insensitively by default', async () => {
    fs.mkdirSync(path.join(serverFolder, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(serverFolder, 'mods', 'coolmod.jar'), 'existing mod');
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'existing properties');
    const pack = path.join(dataDir, 'case-policy.mrpack');
    await makeMrpack(pack, {
      loader: 'forge',
      overrideEntries: {
        'Mods/COOLMOD.JAR': 'replacement mod',
        'SERVER.PROPERTIES': 'replacement properties',
      },
    });

    const result = await service.import(serverId, pack);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(2);
    expect(fs.readFileSync(path.join(serverFolder, 'mods', 'coolmod.jar'), 'utf8')).toBe('existing mod');
    expect(fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8')).toBe('existing properties');
    expect(fs.readdirSync(serverFolder)).not.toContain('Mods');
  });

  it('overwrites an existing embedded file only when force is explicitly selected', async () => {
    fs.mkdirSync(path.join(serverFolder, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(serverFolder, 'mods', 'coolmod.jar'), 'existing mod');
    const pack = path.join(dataDir, 'overwrite.mrpack');
    await makeMrpack(pack, {
      loader: 'forge',
      overrideEntries: { 'mods/coolmod.jar': 'replacement mod' },
    });

    const result = await service.import(serverId, pack, true);
    expect(result.ok).toBe(true);
    expect(result.modsAdded).toBe(1);
    expect(fs.readFileSync(path.join(serverFolder, 'mods', 'coolmod.jar'), 'utf8')).toBe('replacement mod');
  });

  it('propagates cancellation to downloads and rolls back staging', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    service = new ModpackService(db, (event) => events.push(event), null, {
      downloadService: {
        download: async (request) => {
          started();
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('download canceled')), { once: true });
          });
          return { path: request.destination, bytes: 0 };
        },
      },
    });
    fs.writeFileSync(path.join(serverFolder, 'sentinel.txt'), 'live data');
    const pack = path.join(dataDir, 'cancel.mrpack');
    await makeMrpack(pack, {
      loader: 'forge',
      includeOverrides: false,
      files: [{
        path: 'mods/slow.jar',
        hashes: { sha1: 'a'.repeat(40) },
        downloads: ['https://example.invalid/slow.jar'],
      }],
    });

    const importing = service.import(serverId, pack, false, { signal: controller.signal });
    await downloadStarted;
    controller.abort();
    const result = await importing;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('canceled');
    expect(fs.readFileSync(path.join(serverFolder, 'sentinel.txt'), 'utf8')).toBe('live data');
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('.server.staging-'))).toBe(false);
  });
});

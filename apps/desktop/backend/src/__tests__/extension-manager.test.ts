import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { openDatabase, type DatabaseResult } from '../db';
import { ExtensionManagerService, inspectJar } from '../extension-manager';

/** Build a minimal JAR with a fabric.mod.json manifest (or plugin.yml). */
function makeJar(filePath: string, manifest: { name?: string; version?: string }, flavor: 'fabric' | 'paper'): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const content =
      flavor === 'fabric'
        ? JSON.stringify({
            id: manifest.name ?? 'testmod',
            name: manifest.name ?? 'Test Mod',
            version: manifest.version ?? '1.0.0',
            description: 'A test mod',
            authors: [{ name: 'Tester' }],
            depends: { fabricloader: '>=0.15.0', minecraft: '1.21' },
          })
        : `name: ${manifest.name ?? 'testplugin'}\nversion: ${manifest.version ?? '1.0.0'}\ndescription: A test plugin\nauthors:\n  - Tester\napi-version: 1.21\n`;
    zip.addBuffer(Buffer.from(content), flavor === 'fabric' ? 'fabric.mod.json' : 'plugin.yml');
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

// Runs sequentially: zip fixture writes + metadata reads are timing-sensitive.
describe.sequential('ExtensionManagerService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let modsDir: string;
  let serverId: string;
  let service: ExtensionManagerService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-ext-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    modsDir = path.join(serverFolder, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const record = db.createServer({
      name: 'Mod Server',
      edition: 'java',
      serverType: 'fabric',
      folderPath: serverFolder,
      version: '1.21.1',
    });
    serverId = record.id;
    service = new ExtensionManagerService(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists mods with metadata and no extension folder for vanilla', async () => {
    await makeJar(path.join(modsDir, 'coolmod.jar'), { name: 'Cool Mod', version: '2.0.0' }, 'fabric');
    const res = await service.list(serverId);
    expect(res.flavor).toBe('fabric');
    expect(res.folder).toBe('mods');
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({
      name: 'coolmod.jar',
      enabled: true,
      displayName: 'Cool Mod',
      version: '2.0.0',
      kind: 'mod',
      authors: ['Tester'],
    });
    expect(res.entries[0].sizeBytes).toBeGreaterThan(0);
  });

  it('returns an empty list when the server is vanilla', async () => {
    const vanillaFolder = path.join(dataDir, 'vanilla');
    fs.mkdirSync(vanillaFolder, { recursive: true });
    const vanilla = db.createServer({
      name: 'Vanilla',
      edition: 'java',
      serverType: 'vanilla',
      folderPath: vanillaFolder,
    });
    const res = await service.list(vanilla.id);
    expect(res.folder).toBeNull();
    expect(res.entries).toHaveLength(0);
  });

  it('disables and enables via .disabled rename round-trip', async () => {
    await makeJar(path.join(modsDir, 'coolmod.jar'), { name: 'Cool Mod' }, 'fabric');

    const disabled = service.disable(serverId, 'coolmod.jar');
    expect(disabled.ok).toBe(true);
    expect(fs.existsSync(path.join(modsDir, 'coolmod.jar'))).toBe(false);
    expect(fs.existsSync(path.join(modsDir, 'coolmod.jar.disabled'))).toBe(true);

    let list = await service.list(serverId);
    expect(list.entries[0].enabled).toBe(false);

    const enabled = service.enable(serverId, 'coolmod.jar');
    expect(enabled.ok).toBe(true);
    expect(fs.existsSync(path.join(modsDir, 'coolmod.jar'))).toBe(true);
    expect(fs.existsSync(path.join(modsDir, 'coolmod.jar.disabled'))).toBe(false);

    list = await service.list(serverId);
    expect(list.entries[0].enabled).toBe(true);
  });

  it('deletes a mod', async () => {
    await makeJar(path.join(modsDir, 'coolmod.jar'), { name: 'Cool Mod' }, 'fabric');
    const res = service.delete(serverId, 'coolmod.jar');
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(modsDir, 'coolmod.jar'))).toBe(false);
  });

  it('rejects mutations while the server is running', async () => {
    service.setRunningServerId(() => serverId);
    await makeJar(path.join(modsDir, 'coolmod.jar'), { name: 'Cool Mod' }, 'fabric');
    const res = service.disable(serverId, 'coolmod.jar');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Stop the server');
  });

  it('rejects non-jar uploads and validates names', async () => {
    const bad = service.upload(serverId, [
      { name: 'notes.txt', contentBase64: Buffer.from('hi').toString('base64'), sizeBytes: 2 },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('.jar');

    const traversal = service.disable(serverId, '../escape.jar');
    expect(traversal.ok).toBe(false);
  });

  it('uploads a jar into the mods folder', async () => {
    const source = path.join(dataDir, 'newmod.jar');
    await makeJar(source, { name: 'New Mod' }, 'fabric');
    const contentBase64 = fs.readFileSync(source).toString('base64');
    const res = service.upload(serverId, [
      { name: 'newmod.jar', contentBase64, sizeBytes: fs.statSync(source).size },
    ]);
    expect(res.ok).toBe(true);
    expect(res.added).toEqual(['newmod.jar']);
    expect(fs.existsSync(path.join(modsDir, 'newmod.jar'))).toBe(true);
  });

  it('reads paper plugin metadata', async () => {
    const pluginsDir = path.join(serverFolder, '..', 'paper', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const paper = db.createServer({
      name: 'Paper',
      edition: 'java',
      serverType: 'paper',
      folderPath: path.join(dataDir, 'paper'),
      version: '1.21.1',
    });
    const pluginJar = path.join(pluginsDir, 'essentials.jar');
    await makeJar(pluginJar, { name: 'Essentials', version: '1.0.0' }, 'paper');
    const list = await service.list(paper.id);
    expect(list.entries[0]).toMatchObject({
      name: 'essentials.jar',
      displayName: 'Essentials',
      kind: 'plugin',
      version: '1.0.0',
      mcVersion: '1.21',
    });
  });
});

describe('inspectJar', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-inspect-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts fabric.mod.json metadata', async () => {
    const jar = path.join(tempDir, 'mod.jar');
    await makeJar(jar, { name: 'Fabric Mod', version: '3.1.0' }, 'fabric');
    const meta = await inspectJar(jar, 'fabric');
    expect(meta).toMatchObject({
      displayName: 'Fabric Mod',
      version: '3.1.0',
      kind: 'mod',
      dependencies: expect.arrayContaining(['minecraft']),
    });
  });

  it('extracts META-INF/mods.toml metadata for Forge mods', async () => {
    const jar = path.join(tempDir, 'forge-mod.jar');
    await makeForgeJar(jar);
    const meta = await inspectJar(jar, 'forge');
    expect(meta).toMatchObject({
      displayName: 'Forge Test Mod',
      version: '1.2.3',
      kind: 'mod',
      authors: ['Tester'],
      dependencies: expect.arrayContaining(['minecraft']),
    });
  });

  it('returns null for a non-mod jar', async () => {
    const jar = path.join(tempDir, 'empty.jar');
    fs.writeFileSync(jar, 'not a zip');
    const meta = await inspectJar(jar, 'fabric');
    expect(meta).toBeNull();
  });
});

/** Build a minimal Forge mod jar with META-INF/mods.toml. */
function makeForgeJar(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const toml = [
      'modLoader="javafml"',
      'loaderVersion="[47,)"',
      'license="MIT"',
      '',
      '[[mods]]',
      'modId="forgetest"',
      'version="1.2.3"',
      'displayName="Forge Test Mod"',
      'description="A forge test mod"',
      'authors="Tester"',
      '',
      '[[dependencies.forgetest]]',
      'modId="minecraft"',
      'type="required"',
      'versionRange="[1.21,)"',
      '',
    ].join('\n');
    zip.addBuffer(Buffer.from(toml), 'META-INF/mods.toml');
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

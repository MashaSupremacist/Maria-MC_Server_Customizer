import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { openDatabase, type DatabaseResult } from '../db';
import { PackInstallerService } from '../pack-installer';
import type { ServerInstallerService } from '../server-installer';
import type { WsServerEvent } from '@msc/shared-types';

/** Build a CurseForge-style .zip with mods/ + manifest.json. */
function makeCurseZip(
  filePath: string,
  options: { mcVersion?: string; loader?: string; withInstaller?: boolean; withUniversal?: boolean } = {},
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
        files: [],
        overrides: 'overrides',
      };
      zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
    }
    zip.addBuffer(Buffer.from('fake jar'), 'mods/coolmod.jar');
    zip.addBuffer(Buffer.from('some config'), 'config/pack.toml');
    if (options.withInstaller) {
      zip.addBuffer(Buffer.from('installer'), 'forge-installer.jar');
    }
    if (options.withUniversal) {
      zip.addBuffer(
        Buffer.from('server'),
        'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar',
      );
    }
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

/** Build a bare server-pack dump: just a forge universal jar + config. */
function makeBareServerZip(filePath: string, mcVersion = '1.7.10'): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('server'), `forge-${mcVersion}-10.13.4.1614-1.7.10-universal.jar`);
    zip.addBuffer(Buffer.from('some config'), 'config/server.cfg');
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

/** Create an in-memory zip buffer from an array of {name, content} pairs. */
function makeZipBuffer(
  entries: Array<{ name: string; content: string | Buffer }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    for (const e of entries) {
      zip.addBuffer(Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content), e.name);
    }
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

/** Build a mods-only zip with no manifest (e.g. a CurseForge client download).
 *  The mod JARs are real nested zips so the backend can peek inside them. */
async function makeModsOnlyZip(
  filePath: string,
  options: { fabric?: boolean; forge?: boolean; fabricMc?: string; forgeMc?: string } = {},
): Promise<void> {
  const mods: Array<{ name: string; content: string | Buffer }> = [];
  if (options.fabric) {
    const fabricMod = JSON.stringify({
      id: 'cool-fabric-mod',
      depends: { minecraft: options.fabricMc ?? '>=1.19 <1.21' },
    });
    mods.push({
      name: 'mods/fabric-mod.jar',
      content: await makeZipBuffer([{ name: 'fabric.mod.json', content: fabricMod }]),
    });
  }
  if (options.forge) {
    const toml = `modLoader="javafml"\n[[mods]]\nmodId="cool-forge-mod"\n[[dependencies.cool-forge-mod]]\nmodId="forge"\n[..forge]\nmcVersion="${options.forgeMc ?? '1.19.2'}"\n`;
    mods.push({
      name: 'mods/forge-mod.jar',
      content: await makeZipBuffer([{ name: 'META-INF/mods.toml', content: toml }]),
    });
  }
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const m of mods) {
      zip.addBuffer(Buffer.isBuffer(m.content) ? m.content : Buffer.from(m.content), m.name);
    }
    const output = fs.createWriteStream(filePath);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

describe.sequential('PackInstallerService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let service: PackInstallerService;
  const events: WsServerEvent[] = [];

  /** A fake installer that records bootstrap calls instead of downloading. */
  function fakeInstaller(): ServerInstallerService {
    return {
      bootstrapServerJar: async (req: {
        flavor: string;
        version: string;
        serverFolder: string;
      }) => {
        fs.writeFileSync(
          path.join(req.serverFolder, 'bootstrap-jar-was-here.txt'),
          `${req.flavor} ${req.version}`,
        );
      },
    } as unknown as ServerInstallerService;
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-pack-'));
    db = openDatabase(dataDir);
    // Point the library at a folder inside the temp dir.
    db.setSetting('serverLibraryPath', path.join(dataDir, 'library'));
    events.length = 0;
    service = new PackInstallerService(db, (e) => events.push(e), {
      installer: fakeInstaller(),
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('inspects a curseforge zip and reports version + loader + java', async () => {
    const pack = path.join(dataDir, 'pack.zip');
    await makeCurseZip(pack, { mcVersion: '1.7.10', loader: 'forge' });
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.mcVersion).toBe('1.7.10');
    expect(info.loader).toBe('forge');
    expect(info.requiredJava).toBe(8);
    expect(info.requiredJavaLabel).toBe('Java 8');
    expect(info.hasServerJar).toBe(false);
    expect(info.needsInstallStep).toBe(false);
  });

  it('sniffs a bare server-pack dump with only a forge universal jar', async () => {
    const pack = path.join(dataDir, 'bare.zip');
    await makeBareServerZip(pack, '1.7.10');
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.mcVersion).toBe('1.7.10');
    expect(info.loader).toBe('forge');
    expect(info.hasServerJar).toBe(true);
    expect(info.requiredJava).toBe(8);
  });

  it('detects a forge installer pack that needs an install step', async () => {
    const pack = path.join(dataDir, 'installer.zip');
    await makeCurseZip(pack, { mcVersion: '1.20.1', loader: 'forge', withInstaller: true });
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.needsInstallStep).toBe(true);
    expect(info.hasServerJar).toBe(false);
    // 1.20.1 needs Java 17.
    expect(info.requiredJava).toBe(17);
  });

  it('rejects a non-zip file', async () => {
    const pack = path.join(dataDir, 'random.txt');
    fs.writeFileSync(pack, 'hi');
    const info = await service.inspect(pack);
    expect(info.ok).toBe(false);
    expect(info.error).toContain('Unsupported');
  });

  it('creates a server from a curseforge pack (client-style, bootstraps the loader)', async () => {
    const pack = path.join(dataDir, 'create.zip');
    await makeCurseZip(pack, { mcVersion: '1.7.10', loader: 'forge' });
    const res = await service.create({
      filePath: pack,
      name: 'Lost Era Clone',
      acceptEula: true,
    });
    expect(res.ok).toBe(true);
    expect(res.server).toBeDefined();
    const record = res.server!;
    expect(record.serverType).toBe('forge');
    expect(record.version).toBe('1.7.10');
    expect(fs.existsSync(path.join(record.folderPath, 'mods', 'coolmod.jar'))).toBe(true);
    expect(fs.existsSync(path.join(record.folderPath, 'config', 'pack.toml'))).toBe(true);
    expect(fs.existsSync(path.join(record.folderPath, 'eula.txt'))).toBe(true);
    expect(fs.existsSync(path.join(record.folderPath, 'server.properties'))).toBe(true);
    // The fake installer bootstrapped the loader server jar.
    expect(
      fs.existsSync(path.join(record.folderPath, 'bootstrap-jar-was-here.txt')),
    ).toBe(true);
    expect(res.modsAdded).toBe(1);
    expect(res.filesCopied).toBe(1);
  });

  it('keeps the pack server jar in a bare dump', async () => {
    const pack = path.join(dataDir, 'bare-create.zip');
    await makeBareServerZip(pack, '1.7.10');
    const res = await service.create({
      filePath: pack,
      name: 'Bare Forge',
      acceptEula: true,
    });
    expect(res.ok).toBe(true);
    const record = res.server!;
    expect(record.serverType).toBe('forge');
    expect(record.version).toBe('1.7.10');
    // The universal jar is the runnable server jar — it must be present.
    expect(
      fs.existsSync(
        path.join(record.folderPath, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar'),
      ),
    ).toBe(true);
    expect(res.filesCopied).toBe(2); // the universal jar + config
  });

  it('rejects creation without EULA', async () => {
    const pack = path.join(dataDir, 'no-eula.zip');
    await makeCurseZip(pack, { mcVersion: '1.21.1', loader: 'forge' });
    const res = await service.create({ filePath: pack, name: 'No EULA', acceptEula: false });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('EULA');
  });

  it('rejects an unreadable file', async () => {
    const pack = path.join(dataDir, 'bad.zip');
    fs.writeFileSync(pack, 'not a zip');
    const res = await service.create({ filePath: pack, name: 'Bad', acceptEula: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('sniffs a fabric mods-only zip (no manifest) and reports fabric + mc', async () => {
    const pack = path.join(dataDir, 'fabric-mods.zip');
    await makeModsOnlyZip(pack, { fabric: true, fabricMc: '1.20.1' });
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.loader).toBe('fabric');
    expect(info.mcVersion).toBe('1.20.1');
  });

  it('sniffs a forge mods-only zip (no manifest) and reports forge + mc', async () => {
    const pack = path.join(dataDir, 'forge-mods.zip');
    await makeModsOnlyZip(pack, { forge: true, forgeMc: '1.19.2' });
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.loader).toBe('forge');
    expect(info.mcVersion).toBe('1.19.2');
  });

  it('defaults to vanilla for a mods-only zip with unrecognizable jars', async () => {
    const pack = path.join(dataDir, 'unknown-mods.zip');
    // A mods/ folder with a jar that has no fabric/forge metadata.
    await new Promise<void>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      zip.addBuffer(
        Buffer.from('jar'),
        'mods/unknown-mod.jar',
      );
      const output = fs.createWriteStream(pack);
      output.on('error', reject);
      output.on('close', resolve);
      zip.outputStream.pipe(output);
      zip.end();
    });
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.loader).toBe(null);
    expect(info.mcVersion).toBe(null);
  });

  it('honors flavorOverride when the pack is ambiguous', async () => {
    // A mods-only zip whose jars are unrecognizable (no metadata): detection
    // yields loader null, so the user forces forge and it bootstraps.
    const pack = path.join(dataDir, 'override.zip');
    await makeModsOnlyZip(pack, { forge: true, forgeMc: '1.19.2' });
    const res = await service.create({
      filePath: pack,
      name: 'Forced Forge',
      acceptEula: true,
      flavorOverride: 'forge',
    });
    expect(res.ok).toBe(true);
    const record = res.server!;
    expect(record.serverType).toBe('forge');
  });

  it('bootstraps the loader when flavorOverride disagrees with detection', async () => {
    // A zip with a vanilla server.jar and a mods/ folder whose jars are
    // unrecognizable: detection says vanilla (hasServerJar), the user forces
    // forge — the app must bootstrap a real forge jar, not keep the vanilla one.
    const pack = path.join(dataDir, 'mismatch.zip');
    await new Promise<void>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from('server'), 'server.jar');
      zip.addBuffer(Buffer.from('jar'), 'mods/unknown-mod.jar');
      const output = fs.createWriteStream(pack);
      output.on('error', reject);
      output.on('close', resolve);
      zip.outputStream.pipe(output);
      zip.end();
    });
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.hasServerJar).toBe(true);
    expect(info.loader).toBe(null); // mods jar unrecognizable → no loader

    const res = await service.create({
      filePath: pack,
      name: 'Forced Forge Mismatch',
      acceptEula: true,
      flavorOverride: 'forge',
      mcVersionOverride: '1.19.2',
    });
    expect(res.ok).toBe(true);
    const record = res.server!;
    expect(record.serverType).toBe('forge');
    // The fake installer bootstrapped the forge server jar.
    expect(
      fs.existsSync(path.join(record.folderPath, 'bootstrap-jar-was-here.txt')),
    ).toBe(true);
  });

  it('detects fabric mods inside a zip that also ships a vanilla server.jar', async () => {
    // A bare server.jar + a mods/ folder whose jars are Fabric: the mods
    // upgrade the detection from vanilla to fabric.
    const pack = path.join(dataDir, 'server-jar-with-fabric-mods.zip');
    await new Promise<void>(async (resolve, reject) => {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from('server'), 'server.jar');
      const fabricMod = await makeZipBuffer([{
        name: 'fabric.mod.json',
        content: JSON.stringify({
          id: 'cool-fabric-mod',
          depends: { minecraft: '1.20.1' },
        }),
      }]);
      zip.addBuffer(fabricMod, 'mods/fabric-mod.jar');
      const output = fs.createWriteStream(pack);
      output.on('error', reject);
      output.on('close', resolve);
      zip.outputStream.pipe(output);
      zip.end();
    });
    const info = await service.inspect(pack);
    expect(info.ok).toBe(true);
    expect(info.loader).toBe('fabric');
    expect(info.mcVersion).toBe('1.20.1');
  });
});

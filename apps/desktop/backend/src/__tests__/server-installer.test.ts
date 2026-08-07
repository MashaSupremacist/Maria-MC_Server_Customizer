import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseResult } from '../db';
import { ServerInstallerService } from '../server-installer';

/** Fake Mojang + Fabric + Paper endpoints over one local server. */
function startFakeServer(): Promise<{ baseUrl: string; server: Server; jarSha1: string }> {
  return new Promise((resolve) => {
    const jarContent = Buffer.from('fake-minecraft-server-jar');
    const sha1 = crypto.createHash('sha1').update(jarContent).digest('hex');
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/manifest') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            latest: { release: '1.21.1', snapshot: '25w01a' },
            versions: [
              { id: '1.21.1', type: 'release', url: 'http://fake/version/1.21.1', releaseTime: '2024-01-01T00:00:00Z' },
            ],
          }),
        );
      } else if (url === '/version/1.21.1') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ downloads: { server: { url: 'http://fake/jar', sha1, size: jarContent.length } } }));
      } else if (url === '/jar') {
        res.setHeader('content-type', 'application/java-archive');
        res.setHeader('content-length', String(jarContent.length));
        res.end(jarContent);
      } else if (url === '/fabric/game') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ version: '1.21.1', stable: true }]));
      } else if (url === '/fabric/loader/1.21.1') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ version: '0.16.9', stable: true }]));
      } else if (url === '/fabric/loader/1.21.1/0.16.9/server/jar') {
        res.setHeader('content-type', 'application/java-archive');
        res.end(jarContent);
      } else if (url === '/paper/project') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ versions: { '1.21.1': ['1.21.1'] } }));
      } else if (url === '/paper/project/versions/1.21.1') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ builds: [123] }));
      } else if (url === '/paper/project/versions/1.21.1/builds/123') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            downloads: {
              'server:default': {
                name: 'paper-1.21.1-123.jar',
                size: jarContent.length,
                checksums: { sha256: 'abc' },
                url: '/paper/project/versions/1.21.1/builds/123/downloads/paper-1.21.1-123.jar',
              },
            },
          }),
        );
      } else if (url === '/paper/project/versions/1.21.1/builds/123/downloads/paper-1.21.1-123.jar') {
        res.end(jarContent);
      } else if (url === '/forge/net/minecraftforge/forge/maven-metadata.xml') {
        res.setHeader('content-type', 'application/xml');
        res.end(
          `<?xml version="1.0"?><metadata><groupId>net.minecraftforge</groupId><artifactId>forge</artifactId><versioning><latest>1.21.1-52.0.57</latest><versions><version>1.21.1-52.0.57</version></versions></versioning></metadata>`,
        );
      } else if (url.startsWith('/forge/net/minecraftforge/forge/1.21.1-52.0.57/forge-1.21.1-52.0.57-installer.jar')) {
        res.setHeader('content-type', 'application/java-archive');
        res.end(jarContent);
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, jarSha1: sha1 });
    });
  });
}

function makeFetch(baseUrl: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const rewritten = url
      .replace('http://fake', baseUrl)
      .replace('https://meta.fabricmc.net/v2/versions', `${baseUrl}/fabric`)
      .replace('https://fill.papermc.io/v3/projects/paper', `${baseUrl}/paper/project`)
      .replace('https://maven.minecraftforge.net/net/minecraftforge/forge', `${baseUrl}/forge/net/minecraftforge/forge`)
      .replace(/^\/(paper|forge)\//, `${baseUrl}/$1/`);
    const req = new Request(rewritten, init);
    return fetch(req);
  };
}

// Runs sequentially: the fake HTTP server + tight progress waits are
// timing-sensitive and contended when test files run in parallel workers.
describe.sequential('ServerInstallerService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let library: string;
  let fake: { baseUrl: string; server: Server; jarSha1: string };
  let service: ServerInstallerService;
  const events: Array<{ installId: string; progress: { status?: string; serverId?: string } }> = [];

  afterEach(() => {
    fake.server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    events.length = 0;
  });

  async function setup(): Promise<void> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-install-'));
    library = path.join(dataDir, 'library');
    fs.mkdirSync(library, { recursive: true });
    db = openDatabase(dataDir);
    db.setSetting('serverLibraryPath', library);
    fake = await startFakeServer();
    service = new ServerInstallerService(db, (event) => {
      if (event.type === 'install:progress') {
        events.push({ installId: event.installId, progress: event.progress });
      }
    }, {
      fetchImpl: makeFetch(fake.baseUrl),
      vanillaManifestUrl: `${fake.baseUrl}/manifest`,
      fabricMetaUrl: `${fake.baseUrl}/fabric`,
      paperApiUrl: `${fake.baseUrl}/paper/project`,
      forgeMavenUrl: `${fake.baseUrl}/forge/net/minecraftforge/forge`,
    });
  }

  function waitForProgress(status: string, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = (): void => {
        if (events.some((e) => e.progress.status === status)) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error(`no ${status} progress`));
        else setTimeout(poll, 25);
      };
      poll();
    });
  }

  it('lists server types', async () => {
    await setup();
    const types = service.listServerTypes();
    expect(types.map((t) => t.id)).toEqual(['vanilla', 'fabric', 'forge', 'paper']);
    expect(types.find((t) => t.id === 'fabric')?.hasExtensions).toBe(true);
    expect(types.find((t) => t.id === 'forge')?.requiresInstallStep).toBe(true);
    expect(types.find((t) => t.id === 'vanilla')?.hasExtensions).toBe(false);
  });

  it('installs a vanilla server through the generic pipeline', async () => {
    await setup();
    const installId = await service.install({
      flavor: 'vanilla',
      name: 'My Vanilla',
      version: '1.21.1',
      acceptEula: true,
    });
    await waitForProgress('complete');
    const done = events.find((e) => e.progress.status === 'complete');
    expect(done?.progress.serverId).toBeTruthy();
    const record = db.getServer(done!.progress.serverId!);
    expect(record?.serverType).toBe('vanilla');
    expect(record?.folderPath).toContain('my-vanilla');
    expect(fs.existsSync(path.join(record!.folderPath, 'server.jar'))).toBe(true);
    expect(fs.readFileSync(path.join(record!.folderPath, 'eula.txt'), 'utf8')).toContain('eula=true');
  });

  it('rejects install without EULA', async () => {
    await setup();
    await expect(
      service.install({ flavor: 'vanilla', name: 'X', version: '1.21.1', acceptEula: false }),
    ).rejects.toThrow(/EULA/);
  });

  it('installs a fabric server (loader + no api)', async () => {
    await setup();
    const installId = await service.install({
      flavor: 'fabric',
      name: 'My Fabric',
      version: '1.21.1',
      acceptEula: true,
      loaderVersion: '0.16.9',
    });
    await waitForProgress('complete');
    const done = events.find((e) => e.progress.status === 'complete');
    const record = db.getServer(done!.progress.serverId!);
    expect(record?.serverType).toBe('fabric');
    expect(fs.existsSync(path.join(record!.folderPath, 'fabric-server-launch.jar'))).toBe(true);
  });

  it('installs a paper server', async () => {
    await setup();
    const installId = await service.install({
      flavor: 'paper',
      name: 'My Paper',
      version: '1.21.1',
      acceptEula: true,
    });
    await waitForProgress('complete');
    const done = events.find((e) => e.progress.status === 'complete');
    const record = db.getServer(done!.progress.serverId!);
    expect(record?.serverType).toBe('paper');
    const jars = fs.readdirSync(record!.folderPath).filter((f) => f.endsWith('.jar'));
    expect(jars.some((f) => f.startsWith('paper-'))).toBe(true);
  });

  it('converts a vanilla server to fabric in place', { timeout: 30000 }, async () => {
    await setup();
    const installId = await service.install({
      flavor: 'vanilla',
      name: 'Convert Me',
      version: '1.21.1',
      acceptEula: true,
    });
    await waitForProgress('complete');
    const done = events.find((e) => e.progress.status === 'complete');
    const serverId = done!.progress.serverId!;

    // Clear events so the convert's own 'complete' is what we wait for.
    events.length = 0;

    const { operationId, error } = await service.convert({ serverId, flavor: 'fabric' });
    expect(error).toBeUndefined();
    expect(operationId).toBeTruthy();
    await waitForProgress('complete');
    const record = db.getServer(serverId);
    expect(record?.serverType).toBe('fabric');
    expect(fs.existsSync(path.join(record!.folderPath, 'fabric-server-launch.jar'))).toBe(true);
  });

  it('refuses to convert a missing server', async () => {
    await setup();
    const res = await service.convert({ serverId: 'missing', flavor: 'paper' });
    expect(res.error).toContain('not found');
  });

  it('converts a server to forge, using the record javaPath for the installer', { timeout: 30000 }, async () => {
    await setup();
    const installId = await service.install({
      flavor: 'vanilla',
      name: 'Convert To Forge',
      version: '1.21.1',
      acceptEula: true,
    });
    await waitForProgress('complete');
    const done = events.find((e) => e.progress.status === 'complete');
    const serverId = done!.progress.serverId!;

    // A fake "java" that creates the Forge server jar the installer would.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-convert-java-'));
    const fakeJava = path.join(folder, 'fake-java.cmd');
    fs.writeFileSync(
      fakeJava,
      [
        '@echo off',
        `node -e "require('node:fs').writeFileSync(process.argv[1], 'x')" forge-1.21.1-52.0.57.jar`,
        '',
      ].join('\r\n'),
    );
    try {
      db.updateServer(serverId, { javaPath: fakeJava });
      events.length = 0;
      const { operationId, error } = await service.convert({ serverId, flavor: 'forge' });
      expect(error).toBeUndefined();
      expect(operationId).toBeTruthy();
      await waitForProgress('complete');
      const record = db.getServer(serverId);
      expect(record?.serverType).toBe('forge');
      expect(fs.existsSync(path.join(record!.folderPath, 'forge-1.21.1-52.0.57.jar'))).toBe(true);
      // Installer cleaned up; no temp dir left behind.
      expect(fs.existsSync(path.join(record!.folderPath, 'forge-installer.jar'))).toBe(false);
      expect(fs.existsSync(path.join(record!.folderPath, '.msc-convert'))).toBe(false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

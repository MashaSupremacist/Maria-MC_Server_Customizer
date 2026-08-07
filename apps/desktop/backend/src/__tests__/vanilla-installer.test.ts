import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseResult } from '../db';
import { VanillaInstallerService } from '../vanilla-installer';

/**
 * A fake Mojang API + server JAR served over local HTTP. The installer's
 * fetch is injected to hit these URLs instead of the real Mojang endpoints.
 */
function startFakeMojang(opts: { badSha1?: boolean } = {}): Promise<{
  baseUrl: string;
  server: Server;
  jarSha1: string;
}> {
  return new Promise((resolve) => {
    const jarContent = Buffer.from('fake-minecraft-server-jar');
    const sha1 = crypto.createHash('sha1').update(jarContent).digest('hex');
    const reportedSha1 = opts.badSha1 ? '0'.repeat(40) : sha1;

    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/manifest') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            latest: { release: '1.21.4', snapshot: '25w01a' },
            versions: [
              { id: '1.21.4', type: 'release', url: 'http://fake/version/1.21.4', releaseTime: '2024-12-03T13:09:58+00:00' },
              { id: '25w01a', type: 'snapshot', url: 'http://fake/version/25w01a', releaseTime: '2025-01-01T00:00:00+00:00' },
              { id: '1.8', type: 'release', url: 'http://fake/version/1.8', releaseTime: '2014-09-02T00:00:00+00:00' },
            ],
          }),
        );
      } else if (url === '/version/1.21.4') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            downloads: {
              server: { url: 'http://fake/jar', sha1: reportedSha1, size: jarContent.length },
            },
          }),
        );
      } else if (url === '/jar') {
        res.setHeader('content-type', 'application/java-archive');
        res.setHeader('content-length', String(jarContent.length));
        res.end(jarContent);
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server, jarSha1: sha1 });
    });
  });
}

/** Wraps the native fetch and rewrites fake:// URLs to the local server. */
function makeFetch(baseUrl: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const rewritten = url.replace('http://fake', baseUrl);
    const req = new Request(rewritten, init);
    return fetch(req);
  };
}

// Runs sequentially within this file: the fake Mojang HTTP server and tight
// progress waits are timing-sensitive and contended when test files run in
// parallel workers.
describe.sequential('VanillaInstallerService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let library: string;
  let fakeMojang: { baseUrl: string; server: Server; jarSha1: string };
  const events: Array<{ installId: string; progress: unknown }> = [];
  let onProgress: ((installId: string, status?: string) => void) | null = null;

  afterEach(() => {
    fakeMojang.server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    events.length = 0;
    onProgress = null;
  });

  async function setup(opts: { badSha1?: boolean } = {}): Promise<VanillaInstallerService> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-vanilla-'));
    library = path.join(dataDir, 'library');
    fs.mkdirSync(library, { recursive: true });
    db = openDatabase(dataDir);
    db.setSetting('serverLibraryPath', library);
    fakeMojang = await startFakeMojang(opts);
    const fetchImpl = makeFetch(fakeMojang.baseUrl);
    return new VanillaInstallerService(db, (event) => {
      if (event.type === 'install:progress') {
        events.push({ installId: event.installId, progress: event.progress });
        onProgress?.(event.installId, event.progress.status);
      }
    }, {
      fetchImpl,
      manifestUrl: `${fakeMojang.baseUrl}/manifest`,
    });
  }

  function waitForProgress(status: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = (): void => {
        const found = events.some(
          (e) => (e.progress as { status?: string }).status === status,
        );
        if (found) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error(`no ${status} progress`));
        else setTimeout(poll, 25);
      };
      poll();
    });
  }

  it('installs a server: downloads, verifies sha1, writes config, creates record', { timeout: 30000 }, async () => {
    const installer = await setup();
    const installId = await installer.install({
      name: 'My Vanilla',
      version: '1.21.4',
      acceptEula: true,
      memoryMb: 2048,
      port: 25566,
    });

    // Longer timeout: this file runs in parallel with other suites.
    await waitForProgress('complete', 15000);

    // A server record was created with the right values.
    const servers = db.listServers();
    expect(servers).toHaveLength(1);
    const record = servers[0];
    expect(record.name).toBe('My Vanilla');
    expect(record.serverType).toBe('vanilla');
    expect(record.version).toBe('1.21.4');
    expect(record.memoryMb).toBe(2048);
    expect(record.port).toBe(25566);

    // The server folder has the jar, eula.txt, and server.properties.
    const folder = record.folderPath;
    expect(fs.existsSync(path.join(folder, 'server.jar'))).toBe(true);
    const jarContent = fs.readFileSync(path.join(folder, 'server.jar'));
    expect(jarContent.toString()).toBe('fake-minecraft-server-jar');
    const eula = fs.readFileSync(path.join(folder, 'eula.txt'), 'utf8');
    expect(eula).toContain('eula=true');
    const props = fs.readFileSync(path.join(folder, 'server.properties'), 'utf8');
    expect(props).toContain('server-port=25566');
    expect(props).toContain('level-name=world');

    void installId;
  });

  it('rejects installation when the EULA is not accepted', async () => {
    const installer = await setup();
    await expect(
      installer.install({ name: 'X', version: '1.21.4', acceptEula: false }),
    ).rejects.toThrow(/EULA/);
  });

  it('fails with a checksum error when the sha1 does not match', { timeout: 30000 }, async () => {
    const installer = await setup({ badSha1: true });
    await installer.install({
      name: 'Bad Checksum',
      version: '1.21.4',
      acceptEula: true,
    });
    await waitForProgress('failed', 15000);

    const failed = events.find(
      (e) => (e.progress as { status?: string }).status === 'failed',
    )?.progress as { errorCode?: string };
    expect(failed.errorCode).toBe('checksum');
    // No server record, and the folder was cleaned up.
    expect(db.listServers()).toHaveLength(0);
  });

  it('cancels a download and removes partial files', async () => {
    const installer = await setup();
    let cancellationAccepted = false;
    onProgress = (installId, status) => {
      if (status !== 'downloading') return;
      cancellationAccepted = installer.cancel(installId);
      onProgress = null;
    };

    await installer.install({
      name: 'Cancel Me',
      version: '1.21.4',
      acceptEula: true,
    });

    await waitForProgress('canceled', 3000);
    expect(cancellationAccepted).toBe(true);

    // No server record or partial server folder should survive cancellation.
    expect(db.listServers()).toHaveLength(0);
    expect(fs.readdirSync(library)).toHaveLength(0);
  });
});

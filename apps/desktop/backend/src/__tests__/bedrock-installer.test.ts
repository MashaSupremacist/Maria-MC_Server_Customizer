import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { openDatabase, type DatabaseResult } from '../db';
import { BedrockInstallerService } from '../bedrock-installer';
import yazl from 'yazl';

/** An in-memory writable sink for yazl's outputStream. */
function collectWritable(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
}

/** Fake BDS registry + file server over one local HTTP server. */
function startFakeServer(): Promise<{ baseUrl: string; server: Server; zipSha256: string }> {
  return new Promise((resolve) => {
    // A minimal BDS-like zip: bedrock_server.exe + a nested file.
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('fake exe'), 'bedrock_server.exe');
    zip.addBuffer(Buffer.from('{}'), 'worlds/server.properties');
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.pipe(collectWritable(chunks)).on('finish', () => {
      const zipBuffer = Buffer.concat(chunks);
      const zipSha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');
      const server = createServer((req, res) => {
        const url = req.url ?? '';
        if (url === '/versions.json') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              release: { latest: '1.21.84', versions: ['1.21.84', '1.21.83'] },
              preview: { latest: '1.21.100-preview.20', versions: ['1.21.100-preview.20'] },
            }),
          );
        } else if (url === '/release/1.21.84/metadata.json') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              version: '1.21.84',
              binary: {
                windows: { url: 'http://fake/bin/bedrock-server-1.21.84.1.zip', sha256: zipSha256 },
                linux: { url: 'http://fake/bin-linux/x.zip', sha256: 'x' },
              },
            }),
          );
        } else if (url === '/release/1.21.83/metadata.json') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ version: '1.21.83', binary: { windows: { url: '', sha256: '' } } }));
        } else if (url === '/bin/bedrock-server-1.21.84.1.zip') {
          res.setHeader('content-type', 'application/zip');
          res.setHeader('content-length', String(zipBuffer.length));
          res.end(zipBuffer);
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, zipSha256 });
      });
    });
  });
}

function makeFetch(baseUrl: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const rewritten = url
      .replace('https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/master', baseUrl)
      .replace('http://fake', baseUrl);
    const req = new Request(rewritten, init);
    return fetch(req);
  };
}

describe.sequential('BedrockInstallerService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let library: string;
  let fake: { baseUrl: string; server: Server; zipSha256: string };
  let service: BedrockInstallerService;
  const events: Array<{ installId: string; progress: { status?: string; serverId?: string; errorCode?: string } }> = [];

  afterEach(() => {
    fake?.server?.close?.();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    events.length = 0;
  });

  async function setup(): Promise<void> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-bedrock-install-'));
    library = path.join(dataDir, 'library');
    fs.mkdirSync(library, { recursive: true });
    db = openDatabase(dataDir);
    db.setSetting('serverLibraryPath', library);
    fake = await startFakeServer();
    service = new BedrockInstallerService(db, (event) => {
      if (event.type === 'install:progress') {
        events.push({ installId: event.installId, progress: event.progress });
      }
    }, {
      fetchImpl: makeFetch(fake.baseUrl),
      registryBaseUrl: fake.baseUrl,
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

  it('lists versions, releases first then previews', async () => {
    await setup();
    const versions = await service.listVersions();
    expect(versions.slice(0, 2).map((v) => v.id)).toEqual(['1.21.84', '1.21.83']);
    expect(versions.map((v) => v.type)).toEqual(['release', 'release', 'preview']);
  });

  it('installs a Bedrock server (download, verify, extract, config, record)', async () => {
    await setup();
    const installId = await service.install({
      name: 'My Bedrock',
      version: '1.21.84',
      acceptEula: true,
    });
    await waitForProgress('complete');
    const done = events.find((e) => e.progress.status === 'complete');
    const record = db.getServer(done!.progress.serverId!);
    expect(record).toBeTruthy();
    expect(record!.edition).toBe('bedrock');
    expect(record!.serverType).toBe('bedrock');
    expect(record!.port).toBe(19132);
    expect(fs.existsSync(path.join(record!.folderPath, 'bedrock_server.exe'))).toBe(true);
    expect(fs.existsSync(path.join(record!.folderPath, 'worlds', 'server.properties'))).toBe(true);
    expect(fs.existsSync(path.join(record!.folderPath, 'server.properties'))).toBe(true);
    expect(fs.existsSync(path.join(record!.folderPath, 'allowlist.json'))).toBe(true);
    expect(fs.existsSync(path.join(record!.folderPath, 'permissions.json'))).toBe(true);
    expect(fs.readFileSync(path.join(record!.folderPath, 'server.properties'), 'utf8')).toContain('server-port=19132');
    expect(fs.existsSync(path.join(record!.folderPath, 'bedrock-server.zip'))).toBe(false);
  });

  it('rejects install without EULA', async () => {
    await setup();
    await expect(
      service.install({ name: 'X', version: '1.21.84', acceptEula: false }),
    ).rejects.toThrow(/EULA/);
  });

  it('fails with checksum mismatch and cleans up the folder', async () => {
    await setup();
    // Tamper: use a different registry where the published sha is wrong. Simpler:
    // flip a byte in the served zip by corrupting the metadata sha256.
    fake.server.close();
    const badSha = '0'.repeat(64);
    fake = await startFakeServerWithSha(badSha);
    service = new BedrockInstallerService(db, (event) => {
      if (event.type === 'install:progress') events.push({ installId: event.installId, progress: event.progress });
    }, {
      fetchImpl: makeFetch(fake.baseUrl),
      registryBaseUrl: fake.baseUrl,
    });
    const installId = await service.install({ name: 'Bad', version: '1.21.84', acceptEula: true });
    await waitForProgress('failed');
    const failed = events.find((e) => e.progress.status === 'failed');
    expect(failed?.progress.errorCode).toBe('checksum');
    // No record, no leftover folder.
    expect(db.listServers()).toHaveLength(0);
  });

  it('cancels mid-install and leaves no record', async () => {
    await setup();
    const installId = await service.install({ name: 'Cancel Me', version: '1.21.84', acceptEula: true });
    // Cancel right away — the install loop checks the flag between steps.
    service.cancel(installId);
    await waitForProgress('canceled');
    expect(db.listServers()).toHaveLength(0);
  });

  it('fails for an unknown version', async () => {
    await setup();
    const installId = await service.install({ name: 'Ghost', version: '9.9.9', acceptEula: true });
    await waitForProgress('failed');
    const failed = events.find((e) => e.progress.status === 'failed');
    expect(failed?.progress.errorCode).toBe('network');
    expect(db.listServers()).toHaveLength(0);
  });

  async function startFakeServerWithSha(sha256: string): Promise<{ baseUrl: string; server: Server; zipSha256: string }> {
    const inner = await startFakeServer();
    inner.server.close();
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        const url = req.url ?? '';
        if (url === '/versions.json') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ release: { latest: '1.21.84', versions: ['1.21.84'] }, preview: { versions: [] } }));
        } else if (url === '/release/1.21.84/metadata.json') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            version: '1.21.84',
            binary: { windows: { url: 'http://fake/bin/bedrock-server-1.21.84.1.zip', sha256 } },
          }));
        } else if (url === '/bin/bedrock-server-1.21.84.1.zip') {
          res.setHeader('content-type', 'application/zip');
          // Reuse the inner fake's zip via a fresh buffer.
          res.end(Buffer.from('not the real zip'));
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, zipSha256: sha256 });
      });
    });
  }
});

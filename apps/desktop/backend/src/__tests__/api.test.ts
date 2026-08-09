import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { ServerOperationCoordinator } from '../server-operation-coordinator';

const TOKEN = 'test-token';
const APP_VERSION = '0.0.0-test';

describe('backend API', () => {
  let app: FastifyInstance | null = null;
  let dataDir: string;
  let operationCoordinator: ServerOperationCoordinator;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-test-'));
    operationCoordinator = new ServerOperationCoordinator();
    app = await buildApp({
      dataDir,
      authToken: TOKEN,
      appVersion: APP_VERSION,
      operationCoordinator,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const authHeaders = { 'x-msc-token': TOKEN };

  /** The app instance is always set after beforeAll; assert for TS. */
  function getApp(): FastifyInstance {
    if (!app) throw new Error('app not initialized');
    return app;
  }

  describe('health', () => {
    it('returns ok without a token', async () => {
      const res = await getApp().inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.version).toBe(APP_VERSION);
      expect(body.uptimeSeconds).toBeTypeOf('number');
    });
  });

  describe('auth', () => {
    it('rejects requests without a token', async () => {
      const res = await getApp().inject({ method: 'GET', url: '/servers' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with a wrong token', async () => {
      const res = await getApp().inject({
        method: 'GET',
        url: '/servers',
        headers: { 'x-msc-token': 'nope' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('servers CRUD', () => {
    it('creates, lists, updates, and deletes a server record', async () => {
      const created = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: {
          name: 'Test Server',
          edition: 'java',
          serverType: 'vanilla',
          folderPath: path.join(dataDir, 'test-server'),
        },
      });
      expect(created.statusCode).toBe(200);
      const record = created.json();
      expect(record.id).toBeTypeOf('string');
      expect(record.name).toBe('Test Server');
      expect(record.edition).toBe('java');
      expect(record.memoryMb).toBe(1024);
      expect(record.port).toBe(25565);

      const list = await getApp().inject({
        method: 'GET',
        url: '/servers',
        headers: authHeaders,
      });
      const records = list.json();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(record.id);

      const updated = await getApp().inject({
        method: 'PUT',
        url: `/servers/${record.id}`,
        headers: authHeaders,
        payload: { name: 'Renamed', memoryMb: 2048, port: 25566 },
      });
      expect(updated.statusCode).toBe(200);
      const updatedRecord = updated.json();
      expect(updatedRecord.name).toBe('Renamed');
      expect(updatedRecord.memoryMb).toBe(2048);
      expect(updatedRecord.port).toBe(25566);
      expect(updatedRecord.folderPath).toBe(record.folderPath);

      const deleted = await getApp().inject({
        method: 'DELETE',
        url: `/servers/${record.id}`,
        headers: authHeaders,
      });
      expect(deleted.json().deleted).toBe(true);

      const listAfter = await getApp().inject({
        method: 'GET',
        url: '/servers',
        headers: authHeaders,
      });
      expect(listAfter.json()).toHaveLength(0);
    });

    it('rejects invalid create payloads', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: { name: '', edition: 'java', serverType: 'vanilla', folderPath: '/x' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects start, delete, import, convert, and settings writes during restore', async () => {
      const serverFolder = path.join(dataDir, 'busy-server');
      const worldSource = path.join(dataDir, 'busy-world');
      fs.mkdirSync(serverFolder, { recursive: true });
      fs.mkdirSync(worldSource, { recursive: true });
      fs.writeFileSync(path.join(worldSource, 'level.dat'), 'fixture');
      const created = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: {
          name: 'Busy Server',
          edition: 'java',
          serverType: 'vanilla',
          folderPath: serverFolder,
          version: '1.21.1',
        },
      });
      const serverId = (created.json() as { id: string }).id;
      const restore = operationCoordinator.acquire(serverId, 'restore', 'restore-in-progress');

      try {
        const start = await getApp().inject({
          method: 'POST',
          url: '/process/start',
          headers: authHeaders,
          payload: { serverId },
        });
        expect((start.json() as { error: { code: string } }).error.code).toBe('server-busy');

        const deletion = await getApp().inject({
          method: 'DELETE',
          url: `/servers/${serverId}`,
          headers: authHeaders,
        });
        expect(deletion.json()).toMatchObject({ deleted: false, error: expect.stringMatching(/busy/) });

        const worldImport = await getApp().inject({
          method: 'POST',
          url: '/worlds/import',
          headers: authHeaders,
          payload: { serverId, sourcePath: worldSource },
        });
        expect(worldImport.json()).toMatchObject({ importId: '', error: expect.stringMatching(/busy/) });

        const conversion = await getApp().inject({
          method: 'POST',
          url: '/servers/convert',
          headers: authHeaders,
          payload: { serverId, flavor: 'fabric' },
        });
        expect(conversion.json()).toMatchObject({ operationId: '', error: expect.stringMatching(/busy/) });

        const settingsWrite = await getApp().inject({
          method: 'PUT',
          url: `/servers/${serverId}`,
          headers: authHeaders,
          payload: { name: 'Should Not Change' },
        });
        expect(settingsWrite.statusCode).toBe(409);
        expect(settingsWrite.json()).toMatchObject({ code: 'server-busy' });
      } finally {
        operationCoordinator.release(serverId, restore.operationId);
      }

      const cleanup = await getApp().inject({
        method: 'DELETE',
        url: `/servers/${serverId}`,
        headers: authHeaders,
      });
      expect(cleanup.json().deleted).toBe(true);
    });

    it('writes eula.txt and stores the version when acceptEula is true', async () => {
      const serverFolder = path.join(dataDir, 'eula-server');
      fs.mkdirSync(serverFolder, { recursive: true });
      fs.writeFileSync(path.join(serverFolder, 'server.jar'), 'x');

      const res = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: {
          name: 'EULA Server',
          edition: 'java',
          serverType: 'vanilla',
          folderPath: serverFolder,
          version: '1.7.10',
          acceptEula: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe('1.7.10');
      const eula = fs.readFileSync(path.join(serverFolder, 'eula.txt'), 'utf8');
      expect(eula).toContain('eula=true');
    });

    it('does not write eula.txt when acceptEula is false', async () => {
      const serverFolder = path.join(dataDir, 'no-eula-server');
      fs.mkdirSync(serverFolder, { recursive: true });
      fs.writeFileSync(path.join(serverFolder, 'server.jar'), 'x');

      const res = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: {
          name: 'No EULA Server',
          edition: 'java',
          serverType: 'vanilla',
          folderPath: serverFolder,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(path.join(serverFolder, 'eula.txt'))).toBe(false);
    });

    it('returns 404 for updating a missing server', async () => {
      const res = await getApp().inject({
        method: 'PUT',
        url: '/servers/missing-id',
        headers: authHeaders,
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('servers detect', () => {
    it('requires a token', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/servers/detect',
        payload: { folderPath: path.join(dataDir, 'x') },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns edition + serverType for a folder with server.jar', async () => {
      const serverDir = path.join(dataDir, 'detect-vanilla');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(path.join(serverDir, 'server.jar'), 'x');

      const res = await getApp().inject({
        method: 'POST',
        url: '/servers/detect',
        headers: authHeaders,
        payload: { folderPath: serverDir },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: serverDir,
        edition: 'java',
        serverType: 'vanilla',
        version: null,
      });
    });

    it('sniffs the version from a forge jar name', async () => {
      const serverDir = path.join(dataDir, 'detect-forge');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(path.join(serverDir, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar'), 'x');

      const res = await getApp().inject({
        method: 'POST',
        url: '/servers/detect',
        headers: authHeaders,
        payload: { folderPath: serverDir },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: serverDir,
        edition: 'java',
        serverType: 'forge',
        version: '1.7.10',
      });
    });

    it('detects a bedrock folder', async () => {
      const serverDir = path.join(dataDir, 'detect-bedrock');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(path.join(serverDir, 'bedrock_server.exe'), 'x');

      const res = await getApp().inject({
        method: 'POST',
        url: '/servers/detect',
        headers: authHeaders,
        payload: { folderPath: serverDir },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: serverDir,
        edition: 'bedrock',
        serverType: 'bedrock',
        version: null,
      });
    });

    it('returns nulls for an empty folder', async () => {
      const dir = path.join(dataDir, 'detect-empty');
      fs.mkdirSync(dir, { recursive: true });

      const res = await getApp().inject({
        method: 'POST',
        url: '/servers/detect',
        headers: authHeaders,
        payload: { folderPath: dir },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: dir,
        edition: null,
        serverType: null,
        version: null,
      });
    });

    it('rejects a missing folderPath', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/servers/detect',
        headers: authHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('settings', () => {
    it('persists the server library path and survives a re-open', async () => {
      const libPath = path.join(dataDir, 'library');

      const set = await getApp().inject({
        method: 'PUT',
        url: '/settings',
        headers: authHeaders,
        payload: { serverLibraryPath: libPath },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().serverLibraryPath).toBe(libPath);

      const get = await getApp().inject({
        method: 'GET',
        url: '/settings',
        headers: authHeaders,
      });
      expect(get.json().serverLibraryPath).toBe(libPath);
    });
  });

  describe('edition and deletion safety', () => {
    it('rejects Java routes for Bedrock and Bedrock routes for Java', async () => {
      const javaFolder = path.join(dataDir, 'edition-java');
      const bedrockFolder = path.join(dataDir, 'edition-bedrock');
      fs.mkdirSync(javaFolder, { recursive: true });
      fs.mkdirSync(bedrockFolder, { recursive: true });
      fs.writeFileSync(path.join(javaFolder, 'server.properties'), 'motd=java\n');
      fs.writeFileSync(path.join(bedrockFolder, 'server.properties'), 'server-name=bedrock\n');

      const create = async (edition: 'java' | 'bedrock', folderPath: string) =>
        (await getApp().inject({
          method: 'POST',
          url: '/servers',
          headers: authHeaders,
          payload: { name: edition, edition, serverType: edition === 'java' ? 'vanilla' : 'bedrock', folderPath },
        })).json() as { id: string };
      const javaServer = await create('java', javaFolder);
      const bedrockServer = await create('bedrock', bedrockFolder);

      const javaOnBedrock = await getApp().inject({ method: 'GET', url: `/servers/${bedrockServer.id}/properties`, headers: authHeaders });
      const bedrockOnJava = await getApp().inject({ method: 'GET', url: `/servers/${javaServer.id}/bedrock-properties`, headers: authHeaders });
      const extensionsOnBedrock = await getApp().inject({ method: 'GET', url: `/servers/${bedrockServer.id}/extensions`, headers: authHeaders });
      const packsOnJava = await getApp().inject({ method: 'GET', url: `/servers/${javaServer.id}/packs?kind=behavior`, headers: authHeaders });

      expect(javaOnBedrock.statusCode).toBe(400);
      expect(bedrockOnJava.statusCode).toBe(400);
      expect(extensionsOnBedrock.statusCode).toBe(400);
      expect(packsOnJava.statusCode).toBe(400);

      await getApp().inject({ method: 'DELETE', url: `/servers/${javaServer.id}`, headers: authHeaders });
      await getApp().inject({ method: 'DELETE', url: `/servers/${bedrockServer.id}`, headers: authHeaders });
    });

    it('preserves an unowned external folder when recursive deletion is requested', async () => {
      const externalFolder = path.join(dataDir, 'external-server-folder');
      fs.mkdirSync(externalFolder, { recursive: true });
      fs.writeFileSync(path.join(externalFolder, 'important.txt'), 'keep');
      const created = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: { name: 'External', edition: 'java', serverType: 'vanilla', folderPath: externalFolder },
      });
      const record = created.json() as { id: string; folderOwned: boolean };
      expect(record.folderOwned).toBe(false);

      const deleted = await getApp().inject({
        method: 'DELETE',
        url: `/servers/${record.id}?deleteFolder=true`,
        headers: authHeaders,
      });
      expect(deleted.json()).toMatchObject({ deleted: false, folderDeleted: false });
      expect(fs.readFileSync(path.join(externalFolder, 'important.txt'), 'utf8')).toBe('keep');
      await getApp().inject({ method: 'DELETE', url: `/servers/${record.id}`, headers: authHeaders });
    });
  });

  describe('backups', () => {
    it('creates, lists, restores, and deletes a backup over the API', async () => {
      const serverFolder = path.join(dataDir, 'backup-server');
      fs.mkdirSync(serverFolder, { recursive: true });
      fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'motd=api\n');

      const created = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: {
          name: 'Backup API',
          edition: 'java',
          serverType: 'vanilla',
          folderPath: serverFolder,
        },
      });
      const record = created.json();
      expect(record.id).toBeTypeOf('string');

      // Create a backup.
      const backupRes = await getApp().inject({
        method: 'POST',
        url: '/backups',
        headers: authHeaders,
        payload: { serverId: record.id, note: 'API backup' },
      });
      expect(backupRes.statusCode).toBe(200);
      const { operationId } = backupRes.json();
      expect(operationId).toBeTypeOf('string');

      // Wait for completion via the list endpoint (record appears when done).
      await waitFor(() => {
        return getApp()
          .inject({ method: 'GET', url: `/servers/${record.id}/backups`, headers: authHeaders })
          .then((r) => (r.json() as unknown[]).length === 1);
      });

      const list = await getApp().inject({
        method: 'GET',
        url: `/servers/${record.id}/backups`,
        headers: authHeaders,
      });
      const backups = list.json() as Array<{ id: string; note: string; sizeBytes: number }>;
      expect(backups).toHaveLength(1);
      expect(backups[0].note).toBe('API backup');
      expect(backups[0].sizeBytes).toBeGreaterThan(0);

      // Modify the folder, then restore.
      fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'motd=changed\n');
      const restoreRes = await getApp().inject({
        method: 'POST',
        url: '/backups/restore',
        headers: authHeaders,
        payload: { backupId: backups[0].id },
      });
      expect(restoreRes.statusCode).toBe(200);
      const restoreBody = restoreRes.json() as { operationId: string; error?: string };
      expect(restoreBody.error).toBeUndefined();

      await waitFor(async () => {
        // Restore is async; poll until the file matches the backup.
        return fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8') === 'motd=api\n';
      });
      await waitFor(() => operationCoordinator.inspect(record.id) === null);

      // Delete the backup.
      const delRes = await getApp().inject({
        method: 'DELETE',
        url: `/backups/${backups[0].id}`,
        headers: authHeaders,
      });
      expect(delRes.json().deleted).toBe(true);

      const listAfter = await getApp().inject({
        method: 'GET',
        url: `/servers/${record.id}/backups`,
        headers: authHeaders,
      });
      expect(listAfter.json()).toHaveLength(0);
    });
  });

  describe('bedrock routes', () => {
    it('rejects without a token', async () => {
      const res = await getApp().inject({ method: 'GET', url: '/bedrock/versions' });
      expect(res.statusCode).toBe(401);
    });

    it('reads and writes bedrock properties, allowlist, and permissions', async () => {
      const serverFolder = path.join(dataDir, 'bedrock-server');
      fs.mkdirSync(serverFolder, { recursive: true });
      fs.writeFileSync(
        path.join(serverFolder, 'server.properties'),
        'server-port=19132\n',
      );

      const created = await getApp().inject({
        method: 'POST',
        url: '/servers',
        headers: authHeaders,
        payload: {
          name: 'Bedrock API',
          edition: 'bedrock',
          serverType: 'bedrock',
          folderPath: serverFolder,
        },
      });
      const record = created.json();
      expect(record.edition).toBe('bedrock');
      const id = record.id as string;

      // Properties
      const props = await getApp().inject({
        method: 'GET',
        url: `/servers/${id}/bedrock-properties`,
        headers: authHeaders,
      });
      expect(props.statusCode).toBe(200);
      const propsDoc = props.json();
      expect(propsDoc.fields.find((f: { field: { key: string } }) => f.field.key === 'server-port').value).toBe(19132);

      const updateProps = await getApp().inject({
        method: 'PUT',
        url: `/servers/${id}/bedrock-properties`,
        headers: authHeaders,
        payload: { values: { 'max-players': '25' } },
      });
      expect(updateProps.json().validation.ok).toBe(true);
      expect(fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8')).toContain('max-players=25');

      // Allowlist
      const allow = await getApp().inject({
        method: 'PUT',
        url: `/servers/${id}/allowlist`,
        headers: authHeaders,
        payload: [{ name: 'Steve', xuid: '123' }],
      });
      expect(allow.json().ok).toBe(true);
      const allowList = await getApp().inject({
        method: 'GET',
        url: `/servers/${id}/allowlist`,
        headers: authHeaders,
      });
      expect(allowList.json()).toHaveLength(1);

      // Permissions
      const perms = await getApp().inject({
        method: 'PUT',
        url: `/servers/${id}/permissions`,
        headers: authHeaders,
        payload: [{ permission: 'operator', name: 'Steve' }],
      });
      expect(perms.json().ok).toBe(true);
      const permList = await getApp().inject({
        method: 'GET',
        url: `/servers/${id}/permissions`,
        headers: authHeaders,
      });
      expect(permList.json()).toHaveLength(1);

      // Packs (empty list)
      const packs = await getApp().inject({
        method: 'GET',
        url: `/servers/${id}/packs?kind=behavior`,
        headers: authHeaders,
      });
      expect(packs.statusCode).toBe(200);
      expect(packs.json().entries).toEqual([]);
    });
  });
});

/** Poll until the predicate resolves true (for async backend work). */
function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      const retryOrReject = (err?: unknown): void => {
        if (Date.now() - start > timeoutMs) {
          reject(err instanceof Error ? err : new Error('waitFor timed out'));
        } else {
          setTimeout(poll, 25);
        }
      };

      void Promise.resolve()
        .then(predicate)
        .then((matched) => {
          if (matched) resolve();
          else retryOrReject();
        }, retryOrReject);
    };
    poll();
  });
}

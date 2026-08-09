import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type BackendApp } from '../app';
import { createSignalShutdownHandler } from '../backend-shutdown';
import { ServerOperationCoordinator } from '../server-operation-coordinator';

const TOKEN = 'shutdown-test-token';

describe.sequential('backend graceful shutdown', () => {
  let app: BackendApp | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    await app?.gracefulShutdown().catch(() => undefined);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    app = null;
    dataDir = null;
  });

  async function createApp(coordinator = new ServerOperationCoordinator()): Promise<BackendApp> {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-shutdown-'));
    app = await buildApp({
      dataDir,
      authToken: TOKEN,
      appVersion: 'test',
      operationCoordinator: coordinator,
      shutdownOperationDrainMs: 250,
      shutdownProcessGraceMs: 100,
      shutdownForceWaitMs: 50,
      shutdownWebSocketCloseMs: 25,
    });
    await app.ready();
    return app;
  }

  it('rejects new mutations after shutdown begins while leaving reads available', async () => {
    const instance = await createApp();
    instance.beginShutdown();

    const mutation = await instance.inject({
      method: 'POST',
      url: '/servers/detect',
      headers: { 'x-msc-token': TOKEN },
      payload: { folderPath: dataDir },
    });
    expect(mutation.statusCode).toBe(503);
    expect(mutation.json()).toMatchObject({ code: 'shutting-down' });

    const read = await instance.inject({
      method: 'GET',
      url: '/servers',
      headers: { 'x-msc-token': TOKEN },
    });
    expect(read.statusCode).toBe(200);
  });

  it('requests cancellation and waits for active operations to drain', async () => {
    const coordinator = new ServerOperationCoordinator();
    const instance = await createApp(coordinator);
    const active = coordinator.acquire('server-1', 'restore', 'restore-1');

    const shutdown = instance.gracefulShutdown();
    await waitFor(() => coordinator.isCancellationRequested('server-1', active.operationId));
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    coordinator.release('server-1', active.operationId);
    await shutdown;
    expect(settled).toBe(true);
  });

  it('acknowledges the authenticated shutdown route before draining and is idempotent', async () => {
    const coordinator = new ServerOperationCoordinator();
    const instance = await createApp(coordinator);
    const active = coordinator.acquire('server-1', 'settings-write', 'write-1');

    const unauthorized = await instance.inject({ method: 'POST', url: '/shutdown' });
    expect(unauthorized.statusCode).toBe(401);
    expect(instance.isShuttingDown()).toBe(false);

    const started = Date.now();
    const response = await instance.inject({
      method: 'POST',
      url: '/shutdown',
      headers: { 'x-msc-token': TOKEN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(200);

    await waitFor(() => instance.isShuttingDown());
    const first = instance.gracefulShutdown();
    const second = instance.gracefulShutdown();
    expect(first).toBe(second);
    coordinator.release('server-1', active.operationId);
    await first;
  });
});

describe('signal shutdown handler', () => {
  it('starts shutdown and exits only once when repeated signals arrive', async () => {
    let resolveShutdown!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    let shutdownCalls = 0;
    const exits: number[] = [];
    const messages: string[] = [];
    const handler = createSignalShutdownHandler(
      {
        gracefulShutdown: () => {
          shutdownCalls += 1;
          return pending;
        },
      },
      (code) => exits.push(code),
      { log: (message) => messages.push(String(message)), error: () => undefined },
    );

    handler('SIGTERM');
    handler('SIGINT');
    expect(shutdownCalls).toBe(1);
    expect(messages).toHaveLength(1);
    resolveShutdown();
    await pending;
    await Promise.resolve();
    expect(exits).toEqual([0]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

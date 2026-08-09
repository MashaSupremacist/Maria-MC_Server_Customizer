import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BackendClient,
  terminateProcessTree,
  type SpawnedBackend,
} from '../electron/backend-client';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function response(body: unknown = { ok: true }, status = 200): Response {
  return new Response(body === null ? '' : JSON.stringify(body), { status });
}

function spawned(child: FakeChild, token = `token-${child.pid}`): SpawnedBackend {
  return { child: child.asChild(), token };
}

async function waitUntil(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

describe('BackendClient startup lifecycle', () => {
  it('line-buffers readiness split across arbitrary stdout chunks', async () => {
    const child = new FakeChild(101);
    const client = new BackendClient({
      spawnBackend: () => spawned(child, 'secret'),
    });

    const ready = client.ensureBackend();
    child.stdout.write('boot output\r\nMSC_RE');
    child.stdout.write('ADY 31');
    child.stdout.end('234');

    await expect(ready).resolves.toEqual({
      url: 'http://127.0.0.1:31234',
      token: 'secret',
    });
  });

  it('cleans up a spawn error without waiting for close and allows a later start', async () => {
    const first = new FakeChild(102);
    const second = new FakeChild(103);
    const children = [first, second];
    const spawnBackend = vi.fn(() => spawned(children.shift()!));
    const client = new BackendClient({
      spawnBackend,
      maxStartupAttempts: 1,
      startupReapTimeoutMs: 1,
    });

    const failed = client.ensureBackend();
    first.emit('error', new Error('spawn failed'));
    await expect(failed).rejects.toThrow('spawn failed');

    const ready = client.ensureBackend();
    second.stdout.write('MSC_READY 32001\n');
    await expect(ready).resolves.toEqual({
      url: 'http://127.0.0.1:32001',
      token: 'token-103',
    });
    expect(spawnBackend).toHaveBeenCalledTimes(2);
  });

  it('bounds startup retries with capped exponential backoff', async () => {
    const sleep = vi.fn(async () => undefined);
    const spawnBackend = vi.fn((): SpawnedBackend => {
      throw new Error('cannot spawn');
    });
    const client = new BackendClient({
      spawnBackend,
      sleep,
      maxStartupAttempts: 3,
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 15,
    });

    await expect(client.ensureBackend()).rejects.toThrow('cannot spawn');
    expect(spawnBackend).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [15]]);
  });

  it('kills and reaps a timed-out child, then permits a subsequent start', async () => {
    const first = new FakeChild(104);
    const second = new FakeChild(105);
    const children = [first, second];
    const terminateTree = vi.fn(async (child: ChildProcess) => {
      (child as unknown as FakeChild).exit(1, 'SIGKILL');
    });
    const client = new BackendClient({
      spawnBackend: () => spawned(children.shift()!),
      terminateTree,
      maxStartupAttempts: 1,
      startupTimeoutMs: 5,
      startupReapTimeoutMs: 5,
    });

    await expect(client.ensureBackend()).rejects.toThrow('readiness in time');
    expect(terminateTree).toHaveBeenCalledWith(first.asChild(), true);

    const ready = client.ensureBackend();
    second.stdout.write('MSC_READY 32002\n');
    await expect(ready).resolves.toMatchObject({ url: 'http://127.0.0.1:32002' });
  });

  it('ignores stale child events and resets state after the active backend exits', async () => {
    const first = new FakeChild(106);
    const second = new FakeChild(107);
    const third = new FakeChild(108);
    const children = [first, second, third];
    const fetchImpl = vi.fn(async () => response());
    const client = new BackendClient({
      spawnBackend: () => spawned(children.shift()!),
      fetchImpl,
    });

    const firstReady = client.ensureBackend();
    first.stdout.write('MSC_READY 32003\n');
    await firstReady;
    first.exit(1);

    const secondReady = client.ensureBackend();
    second.stdout.write('MSC_READY 32004\n');
    await secondReady;

    first.emit('exit', 1, null);
    await expect(client.ensureBackend()).resolves.toMatchObject({
      url: 'http://127.0.0.1:32004',
    });
    expect(children).toEqual([third]);

    second.exit(1);
    const thirdReady = client.ensureBackend();
    third.stdout.write('MSC_READY 32005\n');
    await expect(thirdReady).resolves.toMatchObject({ url: 'http://127.0.0.1:32005' });
  });

  it('health-checks cached connection data and replaces an unhealthy child', async () => {
    const first = new FakeChild(109);
    const second = new FakeChild(110);
    const children = [first, second];
    const terminateTree = vi.fn(async (child: ChildProcess) => {
      (child as unknown as FakeChild).exit(1, 'SIGKILL');
    });
    const client = new BackendClient({
      spawnBackend: () => spawned(children.shift()!),
      fetchImpl: vi.fn(async () => response({ ok: false }, 503)),
      terminateTree,
    });

    const firstReady = client.ensureBackend();
    first.stdout.write('MSC_READY 32006\n');
    await firstReady;

    const replacement = client.ensureBackend();
    await waitUntil(() => expect(children).toHaveLength(0));
    second.stdout.write('MSC_READY 32007\n');
    await expect(replacement).resolves.toMatchObject({ url: 'http://127.0.0.1:32007' });
    expect(terminateTree).toHaveBeenCalledWith(first.asChild(), true);
  });
});

describe('BackendClient requests and shutdown', () => {
  it('adds authentication and an AbortSignal timeout to health and API fetches', async () => {
    const child = new FakeChild(111);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return response(init?.method === 'POST' ? { saved: true } : { ok: true });
    });
    const client = new BackendClient({
      spawnBackend: () => spawned(child, 'request-secret'),
      fetchImpl,
    });

    const ready = client.ensureBackend();
    child.stdout.write('MSC_READY 32008\n');
    await ready;
    await expect(client.fetch('POST', '/settings', { value: 1 })).resolves.toEqual({ saved: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, healthInit] = fetchImpl.mock.calls[0];
    const [requestUrl, requestInit] = fetchImpl.mock.calls[1];
    expect(String(requestUrl)).toBe('http://127.0.0.1:32008/settings');
    expect(healthInit?.signal).toBeInstanceOf(AbortSignal);
    expect(requestInit).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ value: 1 }),
      headers: {
        'x-msc-token': 'request-secret',
        'content-type': 'application/json',
      },
    });
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a backend request when its deadline expires', async () => {
    const child = new FakeChild(115);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (fetchImpl.mock.calls.length === 1) return response();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = new BackendClient({
      spawnBackend: () => spawned(child),
      fetchImpl,
      requestTimeoutMs: 5,
    });

    const ready = client.ensureBackend();
    child.stdout.write('MSC_READY 32011\n');
    await ready;

    await expect(client.fetch('GET', '/slow')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('posts authenticated shutdown and does not force a child that exits in time', async () => {
    const child = new FakeChild(112);
    const terminateTree = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/shutdown')) child.exit(0);
      return response(null);
    });
    const client = new BackendClient({
      spawnBackend: () => spawned(child, 'shutdown-secret'),
      fetchImpl,
      terminateTree,
    });

    const ready = client.ensureBackend();
    child.stdout.write('MSC_READY 32009\n');
    await ready;
    const firstShutdown = client.shutdown();
    expect(client.shutdown()).toBe(firstShutdown);
    await firstShutdown;

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:32009/shutdown',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-msc-token': 'shutdown-secret' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it('force-terminates the process tree when graceful shutdown does not reap it', async () => {
    const child = new FakeChild(113);
    const terminateTree = vi.fn(async (target: ChildProcess) => {
      (target as unknown as FakeChild).exit(null, 'SIGKILL');
    });
    const client = new BackendClient({
      spawnBackend: () => spawned(child),
      fetchImpl: vi.fn(async () => {
        throw new Error('listener closed');
      }),
      terminateTree,
      shutdownGraceMs: 5,
      shutdownReapMs: 5,
    });

    const ready = client.ensureBackend();
    child.stdout.write('MSC_READY 32010\n');
    await ready;
    await client.shutdown();

    expect(terminateTree).toHaveBeenCalledWith(child.asChild(), true);
  });
});

describe('terminateProcessTree', () => {
  it('uses taskkill with descendant and force flags on Windows', async () => {
    const child = new FakeChild(114);
    const killer = new EventEmitter();
    const spawnProcess = vi.fn(() => {
      setImmediate(() => killer.emit('exit', 0));
      return killer;
    });

    await terminateProcessTree(child.asChild(), true, {
      platform: 'win32',
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '114', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
  });
});

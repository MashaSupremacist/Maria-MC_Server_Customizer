import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DownloadError,
  DownloadService,
  type DownloadDigestAlgorithm,
} from '../download-service';

function fetchResponse(
  body: Uint8Array | string,
  options: { status?: number; contentLength?: number } = {},
): typeof fetch {
  return (async () => {
    const headers = new Headers();
    if (options.contentLength !== undefined) {
      headers.set('content-length', String(options.contentLength));
    }
    const responseBody = typeof body === 'string' ? body : Uint8Array.from(body).buffer;
    return new Response(responseBody, { status: options.status ?? 200, headers });
  }) as typeof fetch;
}

function stalledFetch(firstChunk: string = 'a'): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(firstChunk));
        signal?.addEventListener(
          'abort',
          () => controller.error(signal.reason ?? new Error('aborted')),
          { once: true },
        );
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe('DownloadService', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-download-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('streams to a unique part file, waits for close, and commits the result', async () => {
    const destination = path.join(tempDir, 'server.jar');
    const service = new DownloadService({ fetchImpl: fetchResponse('downloaded') });
    const result = await service.download({
      url: 'https://example.invalid/server.jar',
      destination,
      expectedBytes: 10,
      maximumBytes: 20,
    });

    expect(result).toMatchObject({ path: destination, bytes: 10 });
    expect(fs.readFileSync(destination, 'utf8')).toBe('downloaded');
    expect(fs.readdirSync(tempDir).filter((name) => name.endsWith('.part'))).toEqual([]);

    // On Windows this rename fails while a write handle is still open.
    const renamed = path.join(tempDir, 'renamed.jar');
    fs.renameSync(destination, renamed);
    expect(fs.readFileSync(renamed, 'utf8')).toBe('downloaded');
  });

  it.each(['sha1', 'sha256', 'sha512'] as const)(
    'verifies an algorithm-tagged %s digest',
    async (algorithm: DownloadDigestAlgorithm) => {
      const content = Buffer.from(`verified-${algorithm}`);
      const digest = crypto.createHash(algorithm).update(content).digest('hex').toUpperCase();
      const destination = path.join(tempDir, `${algorithm}.bin`);
      const service = new DownloadService({ fetchImpl: fetchResponse(content) });

      const result = await service.download({
        url: 'https://example.invalid/file',
        destination,
        expectedDigest: { algorithm, value: digest },
      });

      expect(result.digest).toEqual({ algorithm, value: digest.toLowerCase() });
      expect(fs.readFileSync(destination)).toEqual(content);
    },
  );

  it('rejects a checksum mismatch and removes the part file', async () => {
    const destination = path.join(tempDir, 'bad.jar');
    fs.writeFileSync(destination, 'previous-valid-file');
    const service = new DownloadService({ fetchImpl: fetchResponse('corrupt') });

    await expect(
      service.download({
        url: 'https://example.invalid/bad.jar',
        destination,
        expectedDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'checksum' });
    expect(fs.readFileSync(destination, 'utf8')).toBe('previous-valid-file');
    expect(fs.readdirSync(tempDir)).toEqual(['bad.jar']);
  });

  it('enforces expected bytes even when Content-Length is absent', async () => {
    const destination = path.join(tempDir, 'short.bin');
    const service = new DownloadService({ fetchImpl: fetchResponse('short') });

    await expect(
      service.download({
        url: 'https://example.invalid/short',
        destination,
        expectedBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'size', expected: 10, actual: 5 });
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('stops streaming when the maximum byte bound is exceeded', async () => {
    const destination = path.join(tempDir, 'large.bin');
    const service = new DownloadService({ fetchImpl: fetchResponse('too-large') });

    await expect(
      service.download({
        url: 'https://example.invalid/large',
        destination,
        maximumBytes: 3,
      }),
    ).rejects.toMatchObject({ code: 'size', expected: 3 });
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('rejects an oversized declared Content-Length before opening a part file', async () => {
    const destination = path.join(tempDir, 'declared-large.bin');
    const service = new DownloadService({
      fetchImpl: fetchResponse('small', { contentLength: 100 }),
    });

    await expect(
      service.download({
        url: 'https://example.invalid/declared-large',
        destination,
        maximumBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'size', expected: 10, actual: 100 });
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('aborts a request that exceeds the connect timeout', async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(init.signal?.reason);
        });
      })) as typeof fetch;
    const destination = path.join(tempDir, 'connect.bin');
    const service = new DownloadService({ fetchImpl });
    const promise = service.download({
      url: 'https://example.invalid/connect',
      destination,
      timeouts: { connectMs: 10, idleMs: 100, overallMs: 100 },
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'connect-timeout' });

    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(observedAbort).toBe(true);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('aborts a response body that exceeds the idle timeout', async () => {
    vi.useFakeTimers();
    const destination = path.join(tempDir, 'idle.bin');
    const service = new DownloadService({ fetchImpl: stalledFetch() });
    const promise = service.download({
      url: 'https://example.invalid/idle',
      destination,
      timeouts: { connectMs: 100, idleMs: 10, overallMs: 100 },
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'idle-timeout' });

    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('aborts the complete operation at the overall timeout', async () => {
    vi.useFakeTimers();
    const destination = path.join(tempDir, 'overall.bin');
    const service = new DownloadService({ fetchImpl: stalledFetch() });
    const promise = service.download({
      url: 'https://example.invalid/overall',
      destination,
      timeouts: { connectMs: 100, idleMs: 100, overallMs: 10 },
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'overall-timeout' });

    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('immediately aborts active network reads on caller cancellation', async () => {
    const destination = path.join(tempDir, 'cancel.bin');
    const abort = new AbortController();
    const service = new DownloadService({ fetchImpl: stalledFetch('partial') });
    const promise = service.download({
      url: 'https://example.invalid/cancel',
      destination,
      signal: abort.signal,
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'cancelled' });

    await waitFor(() => fs.readdirSync(tempDir).some((name) => name.endsWith('.part')));
    abort.abort();
    await assertion;
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('returns structured HTTP, network, and disk errors', async () => {
    const http = new DownloadService({ fetchImpl: fetchResponse('no', { status: 503 }) });
    await expect(
      http.download({ url: 'https://example.invalid/http', destination: path.join(tempDir, 'http') }),
    ).rejects.toMatchObject({ code: 'http', statusCode: 503 });

    const network = new DownloadService({
      fetchImpl: (async () => {
        throw new Error('socket failed');
      }) as typeof fetch,
    });
    await expect(
      network.download({
        url: 'https://example.invalid/network',
        destination: path.join(tempDir, 'network'),
      }),
    ).rejects.toMatchObject({ code: 'network' });

    const destinationDirectory = path.join(tempDir, 'cannot-replace-directory');
    fs.mkdirSync(destinationDirectory);
    const disk = new DownloadService({ fetchImpl: fetchResponse('data') });
    await expect(
      disk.download({ url: 'https://example.invalid/disk', destination: destinationDirectory }),
    ).rejects.toMatchObject({ code: 'disk' });
    expect(fs.statSync(destinationDirectory).isDirectory()).toBe(true);
    expect(fs.readdirSync(tempDir).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('does not let a progress callback failure corrupt the download', async () => {
    const destination = path.join(tempDir, 'progress.bin');
    const service = new DownloadService({ fetchImpl: fetchResponse('valid') });
    await expect(
      service.download({
        url: 'https://example.invalid/progress',
        destination,
        onProgress: () => {
          throw new Error('renderer disconnected');
        },
      }),
    ).resolves.toMatchObject({ bytes: 5 });
    expect(fs.readFileSync(destination, 'utf8')).toBe('valid');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new DownloadError('network', 'Timed out waiting for test state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

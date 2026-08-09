import { describe, expect, it, vi } from 'vitest';
import { fetchMetadata, fetchMetadataJson, MetadataFetchError } from '../metadata-fetch';

describe('fetchMetadata', () => {
  it('reads bounded JSON metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"ok":true}'));
    await expect(fetchMetadataJson<{ ok: boolean }>('https://metadata.test', { fetchImpl }))
      .resolves.toMatchObject({ ok: true, value: { ok: true } });
  });

  it('rejects declared and streamed responses above the maximum', async () => {
    await expect(fetchMetadata('https://metadata.test', {
      maximumBytes: 3,
      fetchImpl: async () => new Response('four', { headers: { 'content-length': '4' } }),
    })).rejects.toMatchObject({ code: 'too-large' });
    await expect(fetchMetadata('https://metadata.test', {
      maximumBytes: 3,
      fetchImpl: async () => new Response('four'),
    })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('aborts a stalled request at its deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    await expect(fetchMetadata('https://metadata.test', { fetchImpl, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('propagates caller cancellation distinctly from timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const pending = fetchMetadata('https://metadata.test', {
      fetchImpl,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await pending.catch((error: unknown) => {
      expect(error).not.toBeInstanceOf(MetadataFetchError);
    });
  });
});

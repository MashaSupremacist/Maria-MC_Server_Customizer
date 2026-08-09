import { describe, expect, it, vi } from 'vitest';
import { ReconnectingWebSocketClient } from '../renderer/src/lib/socket';

class FakeSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  close = vi.fn();

  open(): void {
    this.onopen?.();
  }

  disconnect(): void {
    this.onclose?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

interface ScheduledTimer {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ReconnectingWebSocketClient', () => {
  it('keeps one socket, preserves handlers across reconnect, and refreshes backend info', async () => {
    const sockets: Array<{ url: string; socket: FakeSocket }> = [];
    const timers: ScheduledTimer[] = [];
    const getBackendInfo = vi
      .fn()
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:4100', token: 'first' })
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:4200', token: 'second' });
    const client = new ReconnectingWebSocketClient({
      getBackendInfo,
      createSocket: (url) => {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancelTimer: (handle) => {
        (handle as ScheduledTimer).cancelled = true;
      },
      random: () => 0.5,
    });
    const handler = vi.fn();
    const unsubscribe = client.onEvent(handler);

    client.start();
    client.start();
    await flushPromises();
    expect(sockets).toHaveLength(1);
    expect(getBackendInfo).toHaveBeenCalledOnce();
    expect(sockets[0].url).toBe('ws://127.0.0.1:4100/ws?token=first');

    sockets[0].socket.open();
    sockets[0].socket.message({ type: 'hello', at: 'first' });
    expect(handler).toHaveBeenCalledOnce();

    sockets[0].socket.disconnect();
    sockets[0].socket.disconnect();
    expect(timers).toHaveLength(1);
    timers[0].callback();
    await flushPromises();

    expect(getBackendInfo).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toBe('ws://127.0.0.1:4200/ws?token=second');
    sockets[1].socket.open();
    sockets[1].socket.message({ type: 'hello', at: 'second' });
    expect(handler).toHaveBeenCalledTimes(2);

    unsubscribe();
    unsubscribe();
    sockets[1].socket.message({ type: 'hello', at: 'ignored' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('deduplicates the same handler', async () => {
    const socket = new FakeSocket();
    const client = new ReconnectingWebSocketClient({
      getBackendInfo: async () => ({ url: 'http://127.0.0.1:4100', token: 'token' }),
      createSocket: () => socket,
    });
    const handler = vi.fn();

    client.onEvent(handler);
    client.onEvent(handler);
    client.start();
    await flushPromises();
    socket.open();
    socket.message({ type: 'hello', at: 'now' });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('uses capped exponential backoff with jitter after consecutive failures', async () => {
    const timers: ScheduledTimer[] = [];
    const client = new ReconnectingWebSocketClient({
      getBackendInfo: vi.fn().mockRejectedValue(new Error('backend unavailable')),
      createSocket: () => new FakeSocket(),
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancelTimer: vi.fn(),
      random: () => 1,
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 250,
      jitterRatio: 0.2,
    });

    client.start();
    await flushPromises();
    expect(timers[0].delayMs).toBe(120);

    timers[0].callback();
    await flushPromises();
    expect(timers[1].delayMs).toBe(240);

    timers[1].callback();
    await flushPromises();
    expect(timers[2].delayMs).toBe(250);
  });
});

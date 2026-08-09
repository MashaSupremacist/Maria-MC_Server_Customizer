import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '@msc/shared-types';

const mocks = vi.hoisted(() => ({
  getServerStatus: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    getServerStatus: mocks.getServerStatus,
    startServer: vi.fn(), stopServer: vi.fn(), restartServer: vi.fn(),
    forceKillServer: vi.fn(), sendServerCommand: vi.fn(),
  },
}));

vi.mock('../lib/socket', () => ({
  connectWebSocket: vi.fn().mockResolvedValue({ onEvent: () => () => undefined }),
}));

import { useServerRuntime } from './useServerRuntime';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function status(serverId: string, state: ServerStatus['state'], pid: number): ServerStatus {
  return {
    serverId, state, pid, startedAt: null, uptimeSeconds: 5, exitCode: null,
    logs: [], stats: {
      cpuPercent: null, memoryMb: null, processIds: [], sampledAt: null, isStale: false,
      playerCount: null, onlinePlayers: [],
    },
    address: null,
  };
}

describe('useServerRuntime server changes', () => {
  beforeEach(() => mocks.getServerStatus.mockReset());

  it('resets immediately and ignores a late response for the previous server', async () => {
    const responseA = deferred<ServerStatus>();
    const responseB = deferred<ServerStatus>();
    const responseC = deferred<ServerStatus>();
    mocks.getServerStatus
      .mockReturnValueOnce(responseA.promise)
      .mockReturnValueOnce(responseB.promise)
      .mockReturnValueOnce(responseC.promise);

    const { result, rerender } = renderHook(({ id }) => useServerRuntime(id), {
      initialProps: { id: 'server-a' as string | null },
    });
    rerender({ id: 'server-b' });
    await act(async () => responseB.resolve(status('server-b', 'online', 202)));
    await waitFor(() => expect(result.current.pid).toBe(202));

    await act(async () => responseA.resolve(status('server-a', 'crashed', 101)));
    expect(result.current.state).toBe('online');
    expect(result.current.pid).toBe(202);

    rerender({ id: 'server-c' });
    expect(result.current.state).toBe('offline');
    expect(result.current.pid).toBeNull();
  });
});

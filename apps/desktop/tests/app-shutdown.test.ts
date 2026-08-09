import { describe, expect, it, vi } from 'vitest';
import { createBeforeQuitHandler } from '../electron/app-shutdown';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createBeforeQuitHandler', () => {
  it('runs shutdown and final quit only once across re-entrant quit events', async () => {
    const pending = deferred();
    const shutdownBackend = vi.fn(() => pending.promise);
    const quit = vi.fn();
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };
    const handler = createBeforeQuitHandler({ shutdownBackend, quit });

    handler(firstEvent);
    handler(secondEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(shutdownBackend).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    expect(quit).toHaveBeenCalledOnce();

    const finalEvent = { preventDefault: vi.fn() };
    handler(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(shutdownBackend).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('reports shutdown failure and still completes quitting', async () => {
    const error = new Error('shutdown failed');
    const onError = vi.fn();
    const quit = vi.fn();
    const handler = createBeforeQuitHandler({
      shutdownBackend: () => Promise.reject(error),
      quit,
      onError,
    });

    handler({ preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
    expect(quit).toHaveBeenCalledOnce();
  });
});

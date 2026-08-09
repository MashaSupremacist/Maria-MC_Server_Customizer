import { describe, expect, it } from 'vitest';
import {
  ServerOperationConflictError,
  ServerOperationCoordinator,
} from '../server-operation-coordinator';

describe('ServerOperationCoordinator', () => {
  it('rejects conflicting operations on one server', () => {
    const coordinator = new ServerOperationCoordinator();
    coordinator.acquire('one', 'restore', 'restore-1');
    expect(() => coordinator.acquire('one', 'start')).toThrow(ServerOperationConflictError);
    expect(coordinator.inspect('one')).toMatchObject({ kind: 'restore', operationId: 'restore-1' });
  });

  it('allows operations on different servers', () => {
    const coordinator = new ServerOperationCoordinator();
    coordinator.acquire('one', 'backup');
    coordinator.acquire('two', 'backup');
    expect(coordinator.list()).toHaveLength(2);
  });

  it('releases a lease after a thrown task', async () => {
    const coordinator = new ServerOperationCoordinator();
    await expect(
      coordinator.run('one', 'delete', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(coordinator.inspect('one')).toBeNull();
  });

  it('only cancels or releases the matching operation', () => {
    const coordinator = new ServerOperationCoordinator();
    coordinator.acquire('one', 'world-import', 'current');
    expect(coordinator.requestCancel('one', 'stale')).toBe(false);
    expect(coordinator.release('one', 'stale')).toBe(false);
    expect(coordinator.requestCancel('one', 'current')).toBe(true);
    expect(coordinator.isCancellationRequested('one', 'current')).toBe(true);
    expect(coordinator.release('one', 'current')).toBe(true);
  });

  it('prevents start racing a destructive mutation', () => {
    const coordinator = new ServerOperationCoordinator();
    for (const kind of ['restore', 'world-import', 'convert', 'delete'] as const) {
      const operation = coordinator.acquire('one', kind);
      expect(() => coordinator.acquire('one', 'start')).toThrow(ServerOperationConflictError);
      coordinator.release('one', operation.operationId);
    }
  });
});

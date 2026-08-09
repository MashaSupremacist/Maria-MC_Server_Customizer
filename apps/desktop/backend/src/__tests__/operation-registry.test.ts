import { describe, expect, it } from 'vitest';
import { OperationRegistry } from '../operation-registry';

describe('OperationRegistry', () => {
  it('normalizes progress events and retains terminal status', () => {
    let now = 1_000;
    const registry = new OperationRegistry({ now: () => now });
    registry.recordEvent({
      type: 'install:progress',
      installId: 'install-1',
      progress: { status: 'downloading', percent: 20, message: 'Downloading' },
    });
    now += 100;
    registry.recordEvent({
      type: 'install:progress',
      installId: 'install-1',
      progress: { status: 'complete', percent: 100, message: 'Done', serverId: 'server-1' },
    });
    expect(registry.get('install-1')).toMatchObject({
      kind: 'server-install',
      state: 'succeeded',
      status: 'complete',
      serverId: 'server-1',
    });
  });

  it('preserves conversion identity and Java completion output across events', () => {
    const registry = new OperationRegistry();
    registry.record({
      operationId: 'convert-1',
      kind: 'server-conversion',
      status: 'preparing',
      percent: null,
      message: 'Preparing',
      serverId: 'server-1',
    });
    registry.recordEvent({
      type: 'install:progress',
      installId: 'convert-1',
      progress: { status: 'installing', percent: 50, message: 'Installing' },
    });
    expect(registry.get('convert-1')).toMatchObject({
      kind: 'server-conversion',
      serverId: 'server-1',
      state: 'active',
    });

    registry.recordEvent({
      type: 'java:progress',
      javaInstallId: 'java-1',
      progress: {
        status: 'complete',
        percent: 100,
        message: 'Installed',
        javaPath: 'C:\\runtimes\\java-21\\bin\\java.exe',
        installPath: 'C:\\runtimes\\java-21',
      },
    });
    expect(registry.get('java-1')).toMatchObject({
      kind: 'java-install',
      state: 'succeeded',
      javaPath: 'C:\\runtimes\\java-21\\bin\\java.exe',
    });
  });

  it('expires terminal entries but keeps active operations', () => {
    let now = 1_000;
    const registry = new OperationRegistry({ now: () => now, terminalTtlMs: 500 });
    registry.record({ operationId: 'active', kind: 'backup', status: 'creating', percent: 1, message: 'Working' });
    registry.record({ operationId: 'done', kind: 'backup', status: 'complete', percent: 100, message: 'Done' });
    now = 1_501;
    expect(registry.get('done')).toBeNull();
    expect(registry.get('active')?.state).toBe('active');
  });

  it('bounds history by evicting terminal work before active work', () => {
    const registry = new OperationRegistry({ maximumEntries: 2 });
    registry.record({ operationId: 'active', kind: 'backup', status: 'creating', percent: 1, message: 'Working' });
    registry.record({ operationId: 'old', kind: 'backup', status: 'complete', percent: 100, message: 'Done' });
    registry.record({ operationId: 'new', kind: 'world-import', status: 'copying', percent: 1, message: 'Working' });
    expect(registry.get('old')).toBeNull();
    expect(registry.get('active')).not.toBeNull();
    expect(registry.get('new')).not.toBeNull();
  });
});

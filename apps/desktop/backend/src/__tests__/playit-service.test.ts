import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseResult } from '../db';
import { PlayitService, findSetupLink, findPublicAddress } from '../playit-service';

/** A tiny fake Playit agent used for launch/stop/claim tests. */
const FAKE_PLAYIT_CMD = `@echo off\r\nnode "%~dp0fake-playit.js" %*\r\n`;

const FAKE_PLAYIT_SCRIPT = `
const readline = require('readline');
console.log('Your setup link is: https://playit.gg/claim/fake-claim-123');
console.log('Public address: myserver.playit.gg');
setTimeout(() => {
  console.log('2026-08-06T19:59:28.104395Z  INFO playitd::daemon: Starting playitd daemon socket_path=None');
}, 300);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {});
// Keep the process alive like the real agent (it is a long-running daemon).
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;

describe('PlayitService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let service: PlayitService;
  const events: Array<{ type: string; state?: string; log?: unknown }> = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-playit-'));
    db = openDatabase(dataDir);
    service = new PlayitService(db, (event) => {
      if (event.type === 'playit:state') {
        events.push({ type: 'playit:state', state: event.state });
      } else if (event.type === 'playit:log') {
        events.push({ type: 'playit:log', log: event.log });
      }
    });
    writeFakePlayit(dataDir);
  });

  afterEach(async () => {
    service.shutdown();
    await new Promise((r) => setTimeout(r, 150));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    events.length = 0;
  });

  function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = (): void => {
        if (predicate()) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error('waitFor timed out'));
        else setTimeout(poll, 25);
      };
      poll();
    });
  }

  it('detects an existing executable and reports settings', () => {
    expect(service.detect(path.join(dataDir, 'fake-playit.cmd'))).toBe(true);
    expect(service.detect(path.join(dataDir, 'missing.exe'))).toBe(false);
    expect(service.detect(null)).toBe(false);

    const settings = service.getSettings();
    expect(settings.playitPath).toBeNull();
    expect(settings.playitPublicAddress).toBeNull();
  });

  it('persists the selected executable and public address', () => {
    const p = path.join(dataDir, 'fake-playit.cmd');
    let settings = service.setPlayitPath(p);
    expect(settings.playitPath).toBe(p);

    settings = service.setPublicAddress('myserver.playit.gg');
    expect(settings.playitPublicAddress).toBe('myserver.playit.gg');

    // Survives a service re-creation (same DB).
    const service2 = new PlayitService(db, () => undefined);
    const reread = service2.getSettings();
    expect(reread.playitPath).toBe(p);
    expect(reread.playitPublicAddress).toBe('myserver.playit.gg');
  });

  it('refuses to start without an executable or with a missing one', () => {
    const noExe = service.start('');
    expect(noExe?.code).toBe('no-executable');

    const missing = service.start(path.join(dataDir, 'missing.exe'));
    expect(missing?.code).toBe('missing-executable');

    expect(service.stateOf()).toBe('offline');
  });

  it('starts, detects claim link + address, and reports online', async () => {
    const err = service.start(path.join(dataDir, 'fake-playit.cmd'));
    expect(err).toBeNull();
    expect(service.isRunning()).toBe(true);
    expect(service.stateOf()).toBe('starting');

    await waitFor(() => service.stateOf() === 'online');

    const status = service.getStatus();
    expect(status.state).toBe('online');
    expect(status.pid).toBeTypeOf('number');
    expect(status.links.some((l) => l.kind === 'claim' && l.url.includes('fake-claim-123'))).toBe(true);
    expect(status.detectedAddress).toBe('myserver.playit.gg');

    // Events were broadcast.
    expect(events.some((e) => e.type === 'playit:state' && e.state === 'online')).toBe(true);
    expect(events.some((e) => e.type === 'playit:log')).toBe(true);
  });

  it('blocks a second start while running', async () => {
    service.start(path.join(dataDir, 'fake-playit.cmd'));
    await waitFor(() => service.stateOf() === 'online');
    const err = service.start(path.join(dataDir, 'fake-playit.cmd'));
    expect(err?.code).toBe('already-running');
  });

  it('stops gracefully and reports offline', async () => {
    service.start(path.join(dataDir, 'fake-playit.cmd'));
    await waitFor(() => service.stateOf() === 'online');
    service.stop();
    await waitFor(() => !service.isRunning());
    expect(service.stateOf()).toBe('offline');
  });

  it('force-kill ends the process', async () => {
    service.start(path.join(dataDir, 'fake-playit.cmd'));
    await waitFor(() => service.stateOf() === 'online');
    service.forceKill();
    await waitFor(() => !service.isRunning());
    expect(service.stateOf()).toBe('crashed');
  });

  it('detects an unexpected exit as crashed', async () => {
    service.start(path.join(dataDir, 'fake-playit.cmd'));
    await waitFor(() => service.stateOf() === 'online');
    service.forceKill();
    await waitFor(() => !service.isRunning());
    const last = events
      .filter((e) => e.type === 'playit:state')
      .map((e) => e.state)
      .pop();
    expect(last).toBe('crashed');
  });

  it('reports online when the daemon writes its status to stderr', async () => {
    // The real MSI playitd (v1) writes INFO logs to stderr; the service must
    // treat stderr as a first-class stream for online/claim/address detection.
    const stderrScript = `
const readline = require('readline');
console.error('2026-08-06T19:59:28.104395Z  INFO playitd::daemon: Starting playitd socket_path=None');
setTimeout(() => {
  console.error('tunnel established, public address: stderr-server.playit.gg');
}, 200);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {});
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;
    fs.writeFileSync(path.join(dataDir, 'stderr-fake.js'), stderrScript);
    fs.writeFileSync(
      path.join(dataDir, 'stderr-fake.cmd'),
      `@echo off\r\nnode "%~dp0stderr-fake.js" %*\r\n`,
    );

    const err = service.start(path.join(dataDir, 'stderr-fake.cmd'));
    expect(err).toBeNull();
    await waitFor(() => service.stateOf() === 'online');
    await waitFor(() => service.getStatus().detectedAddress === 'stderr-server.playit.gg');

    const status = service.getStatus();
    expect(status.state).toBe('online');
    expect(status.detectedAddress).toBe('stderr-server.playit.gg');
    expect(events.some((e) => e.type === 'playit:state' && e.state === 'online')).toBe(true);
    // The online line was also surfaced as a (warn) log from stderr.
    expect(events.some((e) => e.type === 'playit:log' && JSON.stringify(e).includes('tunnel established'))).toBe(true);
  });

  it('falls back to online after the grace period when the agent stays silent', async () => {
    // Simulates a daemon that starts, prints nothing recognizable, and just
    // keeps running (the real playitd often has no stdout/stderr chatter).
    const silentScript = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {});
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;
    fs.writeFileSync(path.join(dataDir, 'silent-fake.js'), silentScript);
    fs.writeFileSync(
      path.join(dataDir, 'silent-fake.cmd'),
      `@echo off\r\nnode "%~dp0silent-fake.js" %*\r\n`,
    );

    const err = service.start(path.join(dataDir, 'silent-fake.cmd'));
    expect(err).toBeNull();
    expect(service.stateOf()).toBe('starting');

    // The grace fallback (5s) should flip it to online.
    await waitFor(() => service.stateOf() === 'online', 8000);
    expect(service.getStatus().state).toBe('online');
    expect(service.isRunning()).toBe(true);
    expect(events.some((e) => e.type === 'playit:state' && e.state === 'online')).toBe(true);
  });
});

describe('findSetupLink', () => {
  it('detects a claim link', () => {
    const link = findSetupLink(
      'Your setup link is: https://playit.gg/claim/abc-123_XYZ please open it',
    );
    expect(link).toEqual({ kind: 'claim', url: 'https://playit.gg/claim/abc-123_XYZ' });
  });

  it('detects a tunnel management link', () => {
    const link = findSetupLink('Open https://playit.gg/account/tunnels to manage');
    expect(link).toEqual({ kind: 'setup', url: 'https://playit.gg/account/tunnels' });
  });

  it('returns null for unrelated lines', () => {
    expect(findSetupLink('Starting playit...')).toBeNull();
    expect(findSetupLink('')).toBeNull();
  });
});

describe('findPublicAddress', () => {
  it('detects a playit.gg public address', () => {
    expect(findPublicAddress('Public address: myserver.playit.gg')).toBe('myserver.playit.gg');
    expect(findPublicAddress('https://join.me/123 also x.playit.gg')).toBe('x.playit.gg');
  });

  it('returns null for unrelated lines', () => {
    expect(findPublicAddress('hello world')).toBeNull();
    expect(findPublicAddress('playit.gg')).toBeNull();
  });
});

function writeFakePlayit(dir: string): void {
  fs.writeFileSync(path.join(dir, 'fake-playit.cmd'), FAKE_PLAYIT_CMD);
  fs.writeFileSync(path.join(dir, 'fake-playit.js'), FAKE_PLAYIT_SCRIPT);
}

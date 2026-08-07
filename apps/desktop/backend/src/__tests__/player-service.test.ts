import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseResult } from '../db';
import { ServerManagerService } from '../server-manager';
import { PlayerService } from '../player-service';

describe('PlayerService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let worldFolder: string;
  let serverId: string;
  let manager: ServerManagerService;
  let service: PlayerService;
  const sentCommands: string[] = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-players-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    worldFolder = path.join(serverFolder, 'world');
    fs.mkdirSync(worldFolder, { recursive: true });
    const record = db.createServer({
      name: 'Players Test',
      edition: 'java',
      serverType: 'vanilla',
      folderPath: serverFolder,
      version: '1.21.4',
    });
    serverId = record.id;

    // A server-manager whose runningServerId reports this server only when
    // we say so; sendCommand records what it receives.
    let running = false;
    const fakeManager = {
      runningServerId: () => (running ? serverId : null),
      sendCommand: (_sid: string, command: string) => {
        sentCommands.push(command);
        return running;
      },
    };
    manager = fakeManager as unknown as ServerManagerService;

    service = new PlayerService(db, manager);
    // Provide a way for tests to flip the running flag.
    Object.defineProperty(service, '__setRunning', {
      value: (v: boolean) => {
        running = v;
      },
      configurable: true,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    sentCommands.length = 0;
  });

  function setRunning(v: boolean): void {
    (service as unknown as { __setRunning: (x: boolean) => void }).__setRunning(v);
  }

  it('reads default gamerules offline from catalog defaults', () => {
    const doc = service.readGamerules(serverId);
    expect(doc.offline).toBe(true);
    expect(doc.rules.length).toBeGreaterThan(20);
    const keepInventory = doc.rules.find((r) => r.key === 'keepInventory');
    expect(keepInventory?.value).toBe(false);
    expect(keepInventory?.type).toBe('boolean');
  });

  it('filters gamerules by server version', () => {
    // 1.8 server should not include playersSleepingPercentage (1.17+).
    db.updateServer(serverId, { version: '1.8' });
    const doc = service.readGamerules(serverId);
    expect(doc.rules.some((r) => r.key === 'playersSleepingPercentage')).toBe(false);
  });

  it('reads gamerules from the world gamerules.json when present', () => {
    fs.writeFileSync(
      path.join(worldFolder, 'gamerules.json'),
      JSON.stringify({ keepInventory: true, randomTickSpeed: 5 }),
    );
    const doc = service.readGamerules(serverId);
    const keep = doc.rules.find((r) => r.key === 'keepInventory');
    const tick = doc.rules.find((r) => r.key === 'randomTickSpeed');
    expect(keep?.value).toBe(true);
    expect(tick?.value).toBe(5);
  });

  it('updates a gamerule offline by writing settings/gamerules.json', () => {
    const result = service.updateGamerule(serverId, 'keepInventory', 'true');
    expect(result.ok).toBe(true);
    const file = JSON.parse(
      fs.readFileSync(path.join(worldFolder, 'settings', 'gamerules.json'), 'utf8'),
    );
    expect(file.keepInventory).toBe(true);
  });

  it('reads gamerules from the legacy world gamerules.json', () => {
    fs.writeFileSync(
      path.join(worldFolder, 'gamerules.json'),
      JSON.stringify({ doFireTick: false }),
    );
    const doc = service.readGamerules(serverId);
    const fireTick = doc.rules.find((r) => r.key === 'doFireTick');
    expect(fireTick?.value).toBe(false);
  });

  it('rejects invalid gamerule values', () => {
    const result = service.updateGamerule(serverId, 'playersSleepingPercentage', '200');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most 100/);
  });

  it('sends gamerule commands when online', () => {
    setRunning(true);
    const result = service.updateGamerule(serverId, 'keepInventory', 'true');
    expect(result.ok).toBe(true);
    expect(sentCommands).toContain('gamerule keepInventory true');
  });

  it('edits whitelist.json offline', () => {
    service.updateWhitelist(serverId, [{ uuid: 'abc-123', name: 'Steve' }]);
    const list = service.readWhitelist(serverId);
    expect(list).toEqual([{ uuid: 'abc-123', name: 'Steve' }]);
  });

  it('refuses whitelist file edits while online', () => {
    setRunning(true);
    const result = service.updateWhitelist(serverId, [{ uuid: 'x', name: 'Y' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Stop the server/);
  });

  it('edits ops.json offline', () => {
    service.updateOperators(serverId, [{ uuid: 'def-456', name: 'Alex' }]);
    const list = service.readOperators(serverId);
    expect(list).toEqual([{ uuid: 'def-456', name: 'Alex' }]);
  });

  it('runs player commands online and reports offline otherwise', () => {
    const offline = service.runCommand(serverId, 'kick Steve');
    expect(offline.ok).toBe(false);
    expect(offline.offline).toBe(true);

    setRunning(true);
    const online = service.runCommand(serverId, 'kick Steve');
    expect(online.ok).toBe(true);
    expect(sentCommands).toContain('kick Steve');
  });
});

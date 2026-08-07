import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseResult } from '../db';
import { BedrockPlayerService } from '../bedrock-player-service';

describe('BedrockPlayerService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let serverId: string;
  let online: boolean;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-bedrock-players-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    fs.mkdirSync(serverFolder, { recursive: true });
    const record = db.createServer({
      name: 'Bedrock Players',
      edition: 'bedrock',
      serverType: 'bedrock',
      folderPath: serverFolder,
    });
    serverId = record.id;
    online = false;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const service = (): BedrockPlayerService => new BedrockPlayerService(db, (id) => online && id === serverId);

  it('reads an empty allowlist when the file is missing', () => {
    expect(service().readAllowlist(serverId)).toEqual([]);
  });

  it('reads allowlist entries from allowlist.json', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'allowlist.json'),
      JSON.stringify([{ name: 'Steve', xuid: '123' }]),
    );
    const entries = service().readAllowlist(serverId);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Steve');
  });

  it('writes allowlist entries while offline', () => {
    const result = service().updateAllowlist(serverId, [{ name: 'Alex', xuid: '456' }]);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(serverFolder, 'allowlist.json'), 'utf8')) as Array<{ name: string }>;
    expect(parsed).toEqual([{ name: 'Alex', xuid: '456' }]);
  });

  it('refuses to edit the allowlist while the server is online', () => {
    online = true;
    const result = service().updateAllowlist(serverId, [{ name: 'Steve' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Stop the server/);
  });

  it('validates allowlist entries need a name', () => {
    const result = service().updateAllowlist(serverId, [{ name: '  ' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/name/);
  });

  it('reads permissions.json', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'permissions.json'),
      JSON.stringify([{ permission: 'operator', name: 'Steve' }]),
    );
    expect(service().readPermissions(serverId)).toEqual([{ permission: 'operator', name: 'Steve' }]);
  });

  it('writes permission entries with validation', () => {
    const result = service().updatePermissions(serverId, [
      { permission: 'operator', name: 'Steve' },
      { permission: 'visitor', name: 'Alex' },
    ]);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(serverFolder, 'permissions.json'), 'utf8')) as Array<{ permission: string }>;
    expect(parsed.map((p) => p.permission)).toEqual(['operator', 'visitor']);
  });

  it('rejects an invalid permission level', () => {
    const result = service().updatePermissions(serverId, [{ permission: 'admin', name: 'Steve' } as never]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Permission must be one of/);
  });

  it('refuses to edit permissions while the server is online', () => {
    online = true;
    const result = service().updatePermissions(serverId, [{ permission: 'operator', name: 'Steve' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Stop the server/);
  });
});

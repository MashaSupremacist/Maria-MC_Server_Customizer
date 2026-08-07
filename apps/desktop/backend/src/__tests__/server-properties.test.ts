import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseResult } from '../db';
import { ServerPropertiesService } from '../server-properties';
import { parseProperties, serializeProperties } from '../properties';

describe('properties parser', () => {
  it('parses keys and values, ignoring comments and blanks', () => {
    const text = [
      '#Minecraft server properties',
      'server-port=25565',
      'motd=A Minecraft\\ Server',
      'online-mode=true',
      '',
      '! some comment',
      'white-list:false',
    ].join('\n');
    const file = parseProperties(text);
    expect(file.entries.get('server-port')).toBe('25565');
    expect(file.entries.get('motd')).toBe('A Minecraft Server');
    expect(file.entries.get('online-mode')).toBe('true');
    expect(file.entries.get('white-list')).toBe('false');
    expect(file.rawLines.length).toBe(7);
  });

  it('round-trips preserving comments and unknown keys', () => {
    const text = [
      '#Minecraft server properties',
      'server-port=25565',
      'custom-key=keep-me',
      'motd=Hello World',
    ].join('\n');
    const file = parseProperties(text);
    const out = serializeProperties(file, new Map([['server-port', '25566']]));
    expect(out).toContain('#Minecraft server properties');
    expect(out).toContain('server-port=25566');
    expect(out).toContain('custom-key=keep-me');
    expect(out).toContain('motd=Hello World');
  });

  it('appends new keys not present in the original', () => {
    const file = parseProperties('server-port=25565\n');
    const out = serializeProperties(file, new Map([['motd', 'New']]));
    expect(out).toContain('server-port=25565');
    expect(out).toContain('motd=New');
  });
});

describe('ServerPropertiesService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let serverId: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-props-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    fs.mkdirSync(serverFolder, { recursive: true });
    const record = db.createServer({
      name: 'Props Test',
      edition: 'java',
      serverType: 'vanilla',
      folderPath: serverFolder,
    });
    serverId = record.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads defaults when the file is missing', () => {
    const service = new ServerPropertiesService(db);
    const doc = service.read(serverId);
    const motd = doc.fields.find((f) => f.field.key === 'motd');
    expect(motd?.value).toBe('A Minecraft Server');
    expect(doc.fields.length).toBeGreaterThan(10);
  });

  it('reads existing values from the file', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'server.properties'),
      'server-port=25566\nmotd=Custom MOTD\n',
    );
    const service = new ServerPropertiesService(db);
    const doc = service.read(serverId);
    const port = doc.fields.find((f) => f.field.key === 'server-port');
    const motd = doc.fields.find((f) => f.field.key === 'motd');
    expect(port?.value).toBe(25566);
    expect(motd?.value).toBe('Custom MOTD');
  });

  it('validates values and rejects invalid ones', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'server.properties'),
      'server-port=25565\n',
    );
    const service = new ServerPropertiesService(db);
    const result = service.update(serverId, { values: { 'max-players': 'not-a-number' } });
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors['max-players']).toBeTruthy();
    // File unchanged.
    expect(fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8')).toContain('server-port=25565');
  });

  it('rejects an out-of-range port', () => {
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'server-port=25565\n');
    const service = new ServerPropertiesService(db);
    const result = service.update(serverId, { values: { 'server-port': '999999' } });
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors['server-port']).toMatch(/at most/);
  });

  it('saves valid values and preserves unknown keys', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'server.properties'),
      '#Minecraft server properties\nserver-port=25565\ncustom-key=keep\n',
    );
    const service = new ServerPropertiesService(db);
    const result = service.update(serverId, { values: { 'server-port': '25566' } });
    expect(result.validation.ok).toBe(true);
    const text = fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8');
    expect(text).toContain('server-port=25566');
    expect(text).toContain('custom-key=keep');
    expect(text).toContain('#Minecraft server properties');
  });

  it('creates a backup before saving', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'server.properties'),
      'server-port=25565\n',
    );
    const service = new ServerPropertiesService(db);
    const result = service.update(serverId, { values: { 'server-port': '25566' } });
    expect(result.document.lastBackupPath).not.toBeNull();
    const backup = fs.readFileSync(result.document.lastBackupPath as string, 'utf8');
    expect(backup).toContain('server-port=25565');
  });
});

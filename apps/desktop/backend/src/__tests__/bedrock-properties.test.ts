import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseResult } from '../db';
import { BedrockPropertiesService } from '../bedrock-properties';

describe('BedrockPropertiesService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let serverId: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-bedrock-props-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    fs.mkdirSync(serverFolder, { recursive: true });
    const record = db.createServer({
      name: 'Bedrock Props',
      edition: 'bedrock',
      serverType: 'bedrock',
      folderPath: serverFolder,
    });
    serverId = record.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads defaults when the file is missing', () => {
    const service = new BedrockPropertiesService(db);
    const doc = service.read(serverId);
    const port = doc.fields.find((f) => f.field.key === 'server-port');
    const maxPlayers = doc.fields.find((f) => f.field.key === 'max-players');
    expect(port?.value).toBe(19132);
    expect(maxPlayers?.value).toBe(10);
    expect(doc.fields.length).toBeGreaterThan(10);
  });

  it('reads existing values from the file', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'server.properties'),
      'server-port=19142\nmotd=Custom Bedrock\n',
    );
    const service = new BedrockPropertiesService(db);
    const doc = service.read(serverId);
    expect(doc.fields.find((f) => f.field.key === 'server-port')?.value).toBe(19142);
    expect(doc.fields.find((f) => f.field.key === 'motd')?.value).toBe('Custom Bedrock');
  });

  it('rejects an invalid enum value', () => {
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'server-port=19132\n');
    const service = new BedrockPropertiesService(db);
    const result = service.update(serverId, { values: { gamemode: 'creativee' } });
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors.gamemode).toMatch(/one of/);
  });

  it('rejects an out-of-range view distance', () => {
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'server-port=19132\n');
    const service = new BedrockPropertiesService(db);
    const result = service.update(serverId, { values: { 'view-distance': '999' } });
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors['view-distance']).toMatch(/at most/);
  });

  it('saves valid values and preserves unknown keys + comments', () => {
    fs.writeFileSync(
      path.join(serverFolder, 'server.properties'),
      '#Minecraft Bedrock server properties\nserver-port=19132\ncustom-key=keep\n',
    );
    const service = new BedrockPropertiesService(db);
    const result = service.update(serverId, { values: { 'server-port': '19133' } });
    expect(result.validation.ok).toBe(true);
    const text = fs.readFileSync(path.join(serverFolder, 'server.properties'), 'utf8');
    expect(text).toContain('server-port=19133');
    expect(text).toContain('custom-key=keep');
    expect(text).toContain('#Minecraft Bedrock server properties');
  });

  it('creates a backup before saving', () => {
    fs.writeFileSync(path.join(serverFolder, 'server.properties'), 'server-port=19132\n');
    const service = new BedrockPropertiesService(db);
    const result = service.update(serverId, { values: { 'server-port': '19133' } });
    expect(result.document.lastBackupPath).not.toBeNull();
    const backup = fs.readFileSync(result.document.lastBackupPath as string, 'utf8');
    expect(backup).toContain('server-port=19132');
  });
});

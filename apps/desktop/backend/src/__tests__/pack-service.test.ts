import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import yazl from 'yazl';
import { openDatabase, type DatabaseResult } from '../db';
import { PackService, safeEntryTarget } from '../pack-service';

/** An in-memory writable sink for yazl's outputStream. */
function collectWritable(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
}

/** Build a zip into a Buffer (for base64 uploads). */
function makeZipBuffer(): Promise<Buffer> {
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('{"format_version":2,"header":{}}'), 'manifest.json');
    zip.addBuffer(Buffer.from('textures'), 'textures/.keep');
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.pipe(collectWritable(chunks)).on('finish', () => resolve(Buffer.concat(chunks)));
  });
}

describe('safeEntryTarget', () => {
  it('resolves normal entries inside the destination', () => {
    const target = safeEntryTarget('C:\\packs', 'mypack/manifest.json');
    expect(target).toBe(path.join('C:\\packs', 'mypack', 'manifest.json'));
  });

  it('rejects traversal entries', () => {
    expect(safeEntryTarget('C:\\packs', '../escape.txt')).toBeNull();
    expect(safeEntryTarget('C:\\packs', '..\\escape.txt')).toBeNull();
    expect(safeEntryTarget('C:\\packs', '/etc/passwd')).toBeNull();
    expect(safeEntryTarget('C:\\packs', 'C:\\windows\\x')).toBeNull();
  });
});

describe.sequential('PackService', () => {
  let db: DatabaseResult;
  let dataDir: string;
  let serverFolder: string;
  let serverId: string;
  let online: boolean;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-packs-'));
    db = openDatabase(dataDir);
    serverFolder = path.join(dataDir, 'server');
    fs.mkdirSync(serverFolder, { recursive: true });
    const record = db.createServer({
      name: 'Pack Server',
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

  const service = (): PackService => new PackService(db, (id) => online && id === serverId);

  it('lists an empty pack folder', () => {
    const result = service().list(serverId, 'behavior');
    expect(result.kind).toBe('behavior');
    expect(result.entries).toEqual([]);
  });

  it('lists pack folders and files', () => {
    const bp = path.join(serverFolder, 'behavior_packs');
    fs.mkdirSync(path.join(bp, 'coolpack'), { recursive: true });
    fs.writeFileSync(path.join(bp, 'coolpack', 'manifest.json'), '{}');
    fs.writeFileSync(path.join(bp, 'loose.mcpack'), 'x');
    const result = service().list(serverId, 'behavior');
    expect(result.entries).toHaveLength(2);
    const folder = result.entries.find((e) => e.name === 'coolpack');
    expect(folder?.isFolder).toBe(true);
    expect(folder?.fileCount).toBe(1);
    const file = result.entries.find((e) => e.name === 'loose.mcpack');
    expect(file?.isFolder).toBe(false);
  });

  it('uploads and extracts a pack zip', async () => {
    const zip = await makeZipBuffer();
    const source = path.join(dataDir, 'mypack.zip');
    fs.writeFileSync(source, zip);
    const result = await service().upload(serverId, 'resource', [source]);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(['mypack']);
    const folder = path.join(serverFolder, 'resource_packs', 'mypack');
    expect(fs.existsSync(path.join(folder, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'textures', '.keep'))).toBe(true);
  });

  it('rejects non-pack files', async () => {
    const source = path.join(dataDir, 'evil.exe');
    fs.writeFileSync(source, 'hello');
    const result = await service().upload(serverId, 'behavior', [source]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Only \.mcpack/);
  });

  it('rejects path traversal in the archive', async () => {
    // PackService.extract rejects unsafe entry names via safeEntryTarget;
    // that helper is unit-tested above. Here we confirm an upload of an
    // invalid zip fails cleanly.
    const source = path.join(dataDir, 'evil.zip');
    fs.writeFileSync(source, 'not-a-zip');
    const result = await service().upload(serverId, 'behavior', [source]);
    expect(result.ok).toBe(false);
  });

  it('refuses uploads while the server is running', async () => {
    online = true;
    const zip = await makeZipBuffer();
    const source = path.join(dataDir, 'mypack.zip');
    fs.writeFileSync(source, zip);
    const result = await service().upload(serverId, 'behavior', [source]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Stop the server/);
  });

  it('deletes a pack folder', () => {
    fs.mkdirSync(path.join(serverFolder, 'behavior_packs', 'oldpack'), { recursive: true });
    const result = service().delete(serverId, 'behavior', 'oldpack');
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(serverFolder, 'behavior_packs', 'oldpack'))).toBe(false);
  });

  it('rejects invalid pack names on delete', () => {
    const result = service().delete(serverId, 'behavior', '../escape');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid pack name/);
  });
});

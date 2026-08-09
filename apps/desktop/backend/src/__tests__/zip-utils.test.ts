import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import {
  ArchivePolicyError,
  DEFAULT_ARCHIVE_POLICY,
  listZipEntries,
  readZipEntryText,
  shouldSkip,
  walkZip,
  writeEntryStream,
} from '../zip-utils';

describe('ZIP utilities', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-zip-utils-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('awaits asynchronous visitors before completing', async () => {
    const archive = await makeZip(root, [{ name: 'one.txt', content: 'one' }]);
    let completed = false;
    await walkZip(archive, async (_entry, stream) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeEntryStream(stream, path.join(root, 'out', 'one.txt'));
      completed = true;
    });
    expect(completed).toBe(true);
    expect(fs.readFileSync(path.join(root, 'out', 'one.txt'), 'utf8')).toBe('one');
  });

  it('propagates destination write errors', async () => {
    const archive = await makeZip(root, [{ name: 'one.txt', content: 'one' }]);
    const parentFile = path.join(root, 'not-a-folder');
    fs.writeFileSync(parentFile, 'x');
    await expect(
      walkZip(archive, async (_entry, stream) => {
        await writeEntryStream(stream, path.join(parentFile, 'one.txt'));
      }),
    ).rejects.toThrow();
  });

  it('rejects truncated archives', async () => {
    const archive = await makeZip(root, [{ name: 'one.txt', content: 'one' }]);
    const bytes = fs.readFileSync(archive);
    fs.writeFileSync(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(walkZip(archive, () => undefined)).rejects.toThrow();
  });

  it('protects paths case-insensitively', () => {
    expect(shouldSkip('SERVER.PROPERTIES')).toBe(true);
    expect(shouldSkip('World/level.dat')).toBe(true);
    expect(shouldSkip('BACKUPS/old.zip')).toBe(true);
  });

  it('rejects duplicate paths that differ only by case', async () => {
    const archive = await makeZip(root, [
      { name: 'config/Test.toml', content: 'one' },
      { name: 'CONFIG/test.toml', content: 'two' },
    ]);
    await expect(listZipEntries(archive)).rejects.toBeInstanceOf(ArchivePolicyError);
  });

  it('enforces entry-count and expanded-size limits', async () => {
    const archive = await makeZip(root, [
      { name: 'one.txt', content: '1234' },
      { name: 'two.txt', content: '5678' },
    ]);
    await expect(
      listZipEntries(archive, { ...DEFAULT_ARCHIVE_POLICY, maxEntries: 1 }),
    ).rejects.toThrow(/more than 1 entries/);
    await expect(
      listZipEntries(archive, {
        ...DEFAULT_ARCHIVE_POLICY,
        maxTotalUncompressedBytes: 7,
      }),
    ).rejects.toThrow(/expands beyond 7 bytes/);
  });

  it('bounds metadata before allocating it', async () => {
    const archive = await makeZip(root, [
      { name: 'modrinth.index.json', content: '1234567890' },
    ]);
    await expect(
      readZipEntryText(archive, 'modrinth.index.json', {
        ...DEFAULT_ARCHIVE_POLICY,
        maxMetadataBytes: 5,
      }),
    ).rejects.toThrow(/metadata entry exceeds 5 bytes/);
  });
});

function makeZip(
  root: string,
  entries: Array<{ name: string; content: string | Buffer }>,
): Promise<string> {
  const archive = path.join(root, `archive-${crypto.randomUUID()}.zip`);
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(archive);
    output.on('close', () => resolve(archive));
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
    for (const entry of entries) {
      zip.addBuffer(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content), entry.name);
    }
    zip.end();
  });
}

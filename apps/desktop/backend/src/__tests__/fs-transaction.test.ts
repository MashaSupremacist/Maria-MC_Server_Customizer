import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FilesystemTransactionCanceledError,
  replaceDirectoryAtomically,
} from '../fs-transaction';

describe('replaceDirectoryAtomically', () => {
  let root: string;
  let target: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-fs-transaction-'));
    target = path.join(root, 'server');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'state.txt'), 'old');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('commits a validated replacement', async () => {
    await replaceDirectoryAtomically(
      target,
      async (staging) => fs.promises.writeFile(path.join(staging, 'state.txt'), 'new'),
      async (staging) => expect(fs.existsSync(path.join(staging, 'state.txt'))).toBe(true),
    );
    expect(fs.readFileSync(path.join(target, 'state.txt'), 'utf8')).toBe('new');
  });

  it('preserves the target after validation failure', async () => {
    await expect(
      replaceDirectoryAtomically(
        target,
        async (staging) => fs.promises.writeFile(path.join(staging, 'bad.txt'), 'bad'),
        async () => {
          throw new Error('invalid');
        },
      ),
    ).rejects.toThrow('invalid');
    expect(fs.readFileSync(path.join(target, 'state.txt'), 'utf8')).toBe('old');
  });

  it('restores the target when the commit rename fails', async () => {
    let calls = 0;
    await expect(
      replaceDirectoryAtomically(
        target,
        async (staging) => fs.promises.writeFile(path.join(staging, 'state.txt'), 'new'),
        async () => undefined,
        {
          rename: async (from, to) => {
            calls += 1;
            if (calls === 2) throw new Error('rename failed');
            await fs.promises.rename(from, to);
          },
        },
      ),
    ).rejects.toThrow('rename failed');
    expect(fs.readFileSync(path.join(target, 'state.txt'), 'utf8')).toBe('old');
  });

  it('does not commit after cancellation', async () => {
    const controller = new AbortController();
    await expect(
      replaceDirectoryAtomically(
        target,
        async (staging) => {
          await fs.promises.writeFile(path.join(staging, 'state.txt'), 'new');
          controller.abort();
        },
        async () => undefined,
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(FilesystemTransactionCanceledError);
    expect(fs.readFileSync(path.join(target, 'state.txt'), 'utf8')).toBe('old');
  });

  it('cleans staging and rollback directories', async () => {
    await replaceDirectoryAtomically(
      target,
      async (staging) => fs.promises.writeFile(path.join(staging, 'state.txt'), 'new'),
      async () => undefined,
    );
    expect(fs.readdirSync(root).filter((name) => name.includes('.staging-') || name.includes('.rollback-'))).toEqual([]);
  });
});

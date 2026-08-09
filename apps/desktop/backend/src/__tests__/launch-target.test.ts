import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findBatchLauncher,
  findCommonArchiveRoot,
  isRootBatchLauncherEntry,
  stripArchiveRoot,
} from '../launch-target';

const temporary: string[] = [];

afterEach(() => {
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe('launch target classification', () => {
  it('accepts launchers only at the effective root', () => {
    expect(isRootBatchLauncherEntry('run.bat')).toBe(true);
    expect(isRootBatchLauncherEntry('RUN.BAT')).toBe(true);
    expect(isRootBatchLauncherEntry('outer/run.bat')).toBe(false);
    expect(isRootBatchLauncherEntry('scripts/run.bat')).toBe(false);
  });

  it('finds only regular root launcher files on disk', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-launch-'));
    temporary.push(folder);
    fs.mkdirSync(path.join(folder, 'run.bat'));
    fs.mkdirSync(path.join(folder, 'nested'));
    fs.writeFileSync(path.join(folder, 'nested', 'start.bat'), 'echo nested');
    expect(findBatchLauncher(folder)).toBeNull();
    fs.writeFileSync(path.join(folder, 'START.BAT'), 'echo root');
    expect(findBatchLauncher(folder)).toBe(path.join(folder, 'START.BAT'));
  });

  it('detects and strips exactly one common wrapper folder', () => {
    const entries = ['Pack/server.jar', 'Pack/config/server.properties', 'Pack/mods/a.jar'];
    const root = findCommonArchiveRoot(entries);
    expect(root).toBe('Pack/');
    expect(entries.map((entry) => stripArchiveRoot(entry, root))).toEqual([
      'server.jar',
      'config/server.properties',
      'mods/a.jar',
    ]);
    expect(findCommonArchiveRoot(['Pack/server.jar', 'readme.txt'])).toBeNull();
    expect(findCommonArchiveRoot(['One/server.jar', 'Two/run.bat'])).toBeNull();
    expect(findCommonArchiveRoot(['mods/a.jar', 'mods/b.jar'])).toBeNull();
  });
});

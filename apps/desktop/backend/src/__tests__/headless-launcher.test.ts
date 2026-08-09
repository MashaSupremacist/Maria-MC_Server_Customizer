import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectBatchLauncherForHeadlessMode,
  resolveModernForgeLaunch,
} from '../headless-launcher';

const folders: string[] = [];

function makeFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-headless-'));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  while (folders.length) fs.rmSync(folders.pop() as string, { recursive: true, force: true });
});

describe('resolveModernForgeLaunch', () => {
  it('converts Forge response-file run.bat into a direct headless Java invocation', () => {
    const folder = makeFolder();
    const forgeArgs = path.join(folder, 'libraries', 'net', 'minecraftforge', 'forge', '1.21.1-52.0.57');
    fs.mkdirSync(forgeArgs, { recursive: true });
    fs.writeFileSync(path.join(folder, 'user_jvm_args.txt'), '# JVM settings\n');
    fs.writeFileSync(path.join(forgeArgs, 'win_args.txt'), '-Dforge=true\n');
    fs.writeFileSync(
      path.join(folder, 'run.bat'),
      '@echo off\r\njava @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.21.1-52.0.57/win_args.txt %*\r\n',
    );

    expect(resolveModernForgeLaunch(folder)).toEqual({
      launcherPath: path.join(folder, 'run.bat'),
      args: [
        '@user_jvm_args.txt',
        '@libraries/net/minecraftforge/forge/1.21.1-52.0.57/win_args.txt',
        'nogui',
      ],
    });
  });
});

describe('inspectBatchLauncherForHeadlessMode', () => {
  it('passes nogui to launchers that forward arguments', () => {
    const folder = makeFolder();
    const launcher = path.join(folder, 'start.bat');
    fs.writeFileSync(launcher, '@echo off\r\njava -jar server.jar %*\r\n');
    expect(inspectBatchLauncherForHeadlessMode(launcher)).toEqual({ kind: 'run-batch', appendNogui: true });
  });

  it('accepts a launcher that already specifies nogui', () => {
    const folder = makeFolder();
    const launcher = path.join(folder, 'start.bat');
    fs.writeFileSync(launcher, '@echo off\r\njava -jar server.jar nogui\r\n');
    expect(inspectBatchLauncherForHeadlessMode(launcher)).toEqual({ kind: 'run-batch', appendNogui: false });
  });

  it('rejects a launcher that cannot be proven headless or supervised', () => {
    const folder = makeFolder();
    const launcher = path.join(folder, 'start.bat');
    fs.writeFileSync(launcher, '@echo off\r\nstart java -jar server.jar\r\n');
    expect(inspectBatchLauncherForHeadlessMode(launcher)).toMatchObject({
      kind: 'unsupported',
      message: expect.stringContaining('START'),
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectServerFolder,
  detectedServerLabel,
  detectedServerType,
  sniffVersionFromJar,
} from '../server-detector';

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-detect-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('detectServerFolder', () => {
  it('returns null for a missing folder', () => {
    expect(detectServerFolder(path.join(os.tmpdir(), 'does-not-exist-msc'))).toBeNull();
  });

  it('returns null for an empty folder', () => {
    expect(detectServerFolder(makeTempDir())).toBeNull();
  });

  it('returns null for a folder with unrelated files', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'hi');
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(detectServerFolder(dir)).toBeNull();
  });

  it('detects a vanilla server from server.jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'vanilla', version: null });
  });

  it('detects a vanilla server from a single other jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'my-server.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'vanilla', version: null });
  });

  it('returns null for multiple non-recognized jars', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'a.jar'), 'x');
    fs.writeFileSync(path.join(dir, 'b.jar'), 'x');
    expect(detectServerFolder(dir)).toBeNull();
  });

  it('detects a fabric server', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'fabric', version: null });
  });

  it('detects a forge server and ignores forge-installer.jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'forge-installer.jar'), 'x');
    expect(detectServerFolder(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'forge-1.21.1-52.0.4.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({
      edition: 'java',
      flavor: 'forge',
      version: '1.21.1',
    });
  });

  it('sniffs the version from an old 1.7.10 forge universal jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar'),
      'x',
    );
    expect(detectServerFolder(dir)).toEqual({
      edition: 'java',
      flavor: 'forge',
      version: '1.7.10',
    });
  });

  it('detects a paper server', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'paper-1.21.1-131.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({
      edition: 'java',
      flavor: 'paper',
      version: '1.21.1',
    });
  });

  it('detects a bedrock server from bedrock_server.exe', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'bedrock_server.exe'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'bedrock', flavor: 'vanilla', version: null });
  });

  it('detects a bedrock server from a .cmd wrapper', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'bedrock_server.cmd'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'bedrock', flavor: 'vanilla', version: null });
  });

  it('prefers specific flavors over a plain server.jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
    fs.writeFileSync(path.join(dir, 'paper-1.21.1-131.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({
      edition: 'java',
      flavor: 'paper',
      version: '1.21.1',
    });
  });

  it('rejects a non-directory path', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(detectServerFolder(file)).toBeNull();
  });
});

describe('sniffVersionFromJar', () => {
  it('parses old forge universal jars', () => {
    expect(sniffVersionFromJar('forge-1.7.10-10.13.4.1614-1.7.10-universal.jar')).toBe('1.7.10');
  });

  it('parses modern forge jars', () => {
    expect(sniffVersionFromJar('forge-1.21.1-52.0.57.jar')).toBe('1.21.1');
  });

  it('parses paper jars', () => {
    expect(sniffVersionFromJar('paper-1.21.1-131.jar')).toBe('1.21.1');
  });

  it('parses old vanilla server jars', () => {
    expect(sniffVersionFromJar('minecraft_server.1.7.10.jar')).toBe('1.7.10');
    expect(sniffVersionFromJar('minecraft_server.1.12.2.jar')).toBe('1.12.2');
  });

  it('returns null for jars with no embedded version', () => {
    expect(sniffVersionFromJar('server.jar')).toBeNull();
    expect(sniffVersionFromJar('fabric-server-launch.jar')).toBeNull();
    expect(sniffVersionFromJar('forge-installer.jar')).toBeNull();
  });
});

describe('detectedServerType / detectedServerLabel', () => {
  it('maps java flavors to server_type strings', () => {
    expect(
      detectedServerType({ edition: 'java', flavor: 'paper', version: null }),
    ).toBe('paper');
    expect(
      detectedServerType({ edition: 'bedrock', flavor: 'vanilla', version: null }),
    ).toBe('bedrock');
  });

  it('maps flavors to human labels', () => {
    expect(
      detectedServerLabel({ edition: 'java', flavor: 'forge', version: null }),
    ).toBe('Forge');
    expect(
      detectedServerLabel({ edition: 'bedrock', flavor: 'vanilla', version: null }),
    ).toBe('Bedrock');
  });
});

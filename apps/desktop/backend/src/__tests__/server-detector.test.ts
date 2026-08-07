import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectServerFolder,
  detectedServerLabel,
  detectedServerType,
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
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'vanilla' });
  });

  it('detects a vanilla server from a single other jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'my-server.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'vanilla' });
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
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'fabric' });
  });

  it('detects a forge server and ignores forge-installer.jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'forge-installer.jar'), 'x');
    expect(detectServerFolder(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'forge-1.21.1-52.0.4.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'forge' });
  });

  it('detects a paper server', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'paper-1.21.1-131.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'paper' });
  });

  it('detects a bedrock server from bedrock_server.exe', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'bedrock_server.exe'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'bedrock', flavor: 'vanilla' });
  });

  it('detects a bedrock server from a .cmd wrapper', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'bedrock_server.cmd'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'bedrock', flavor: 'vanilla' });
  });

  it('prefers specific flavors over a plain server.jar', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
    fs.writeFileSync(path.join(dir, 'paper-1.21.1-131.jar'), 'x');
    expect(detectServerFolder(dir)).toEqual({ edition: 'java', flavor: 'paper' });
  });

  it('rejects a non-directory path', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(detectServerFolder(file)).toBeNull();
  });
});

describe('detectedServerType / detectedServerLabel', () => {
  it('maps java flavors to server_type strings', () => {
    expect(detectedServerType({ edition: 'java', flavor: 'paper' })).toBe('paper');
    expect(detectedServerType({ edition: 'bedrock', flavor: 'vanilla' })).toBe('bedrock');
  });

  it('maps flavors to human labels', () => {
    expect(detectedServerLabel({ edition: 'java', flavor: 'forge' })).toBe('Forge');
    expect(detectedServerLabel({ edition: 'bedrock', flavor: 'vanilla' })).toBe('Bedrock');
  });
});

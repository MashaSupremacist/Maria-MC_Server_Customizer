import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JavaService, requiredJavaForMinecraft } from '../java-service';

/**
 * Fake Adoptium API + binary download. Serves the assets JSON and a fake
 * "zip" (we don't actually extract in these tests, so a plain file works).
 */
function startFakeAdoptium(): Promise<{ baseUrl: string; server: Server }> {
  return new Promise((resolve) => {
    const zipContent = Buffer.from('fake-jdk-zip');
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url.includes('/assets/latest/')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            {
              binary: {
                os: 'windows',
                architecture: 'x64',
                image_type: 'jdk',
                package: {
                  name: 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.1_12.zip',
                  link: 'http://fake-adoptium/download.zip',
                  size: zipContent.length,
                },
              },
            },
          ]),
        );
      } else if (url === '/download.zip') {
        res.setHeader('content-type', 'application/zip');
        res.setHeader('content-length', String(zipContent.length));
        res.end(zipContent);
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server });
    });
  });
}

/** A fake java.exe: a node script that prints a version line to stderr. */
const FAKE_JAVA = `
const version = process.argv[2] || '21.0.1';
process.stderr.write('openjdk version "' + version + '" 2024-10-15\\n');
process.stderr.write('OpenJDK Runtime Environment (build 21.0.1+12)\\n');
process.exit(0);
`;

/** A fake Java 8 runtime: prints the legacy 1.8 version string. */
const FAKE_JAVA_8 = `
process.stderr.write('java version "1.8.0_421"\\n');
process.stderr.write('Java(TM) SE Runtime Environment (build 1.8.0_421-b09)\\n');
process.exit(0);
`;

describe('requiredJavaForMinecraft', () => {
  it('maps versions to the right Java feature version', () => {
    expect(requiredJavaForMinecraft('1.21.4')).toBe(21);
    expect(requiredJavaForMinecraft('1.21')).toBe(21);
    expect(requiredJavaForMinecraft('1.20.5')).toBe(21);
    expect(requiredJavaForMinecraft('1.20.4')).toBe(17);
    expect(requiredJavaForMinecraft('1.18')).toBe(17);
    expect(requiredJavaForMinecraft('1.17.1')).toBe(16);
    expect(requiredJavaForMinecraft('1.16.5')).toBe(8);
    expect(requiredJavaForMinecraft('1.12.2')).toBe(8);
    // Old versions — including the 1.7.10 era — run on Java 8.
    expect(requiredJavaForMinecraft('1.7.10')).toBe(8);
    expect(requiredJavaForMinecraft('1.8.9')).toBe(8);
    expect(requiredJavaForMinecraft('1.6.4')).toBe(8);
    expect(requiredJavaForMinecraft('1.2.5')).toBe(8);
    // New-style year-based versions (25+) require Java 25.
    expect(requiredJavaForMinecraft('26.2')).toBe(25);
    expect(requiredJavaForMinecraft('25.1')).toBe(25);
    // 21.x-24.x require Java 21.
    expect(requiredJavaForMinecraft('24.2')).toBe(21);
    expect(requiredJavaForMinecraft('21.0')).toBe(21);
  });
});

describe('JavaService', () => {
  let tempDir: string;
  let fakeAdoptium: { baseUrl: string; server: Server };

  afterEach(() => {
    fakeAdoptium.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setup(): Promise<{ java: JavaService; fakeJavaPath: string }> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-java-'));
    fakeAdoptium = await startFakeAdoptium();
    // A fake java.exe: a cmd wrapper that runs the node "java" script and
    // ignores any args (detect only passes -version).
    const fakeJavaPath = path.join(tempDir, 'fake-java.cmd');
    fs.writeFileSync(path.join(tempDir, 'fake-java.js'), FAKE_JAVA);
    fs.writeFileSync(fakeJavaPath, `@echo off\r\nnode "%~dp0fake-java.js"\r\n`);
    const java = new JavaService(() => undefined, {
      runtimesDir: path.join(tempDir, 'runtimes'),
      fetchImpl: (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        return fetch(url.replace('https://api.adoptium.net', fakeAdoptium.baseUrl), init);
      },
    });
    return { java, fakeJavaPath };
  }

  it('reads the java version from a fake java', async () => {
    const { java, fakeJavaPath } = await setup();
    const detected = await java.detect(fakeJavaPath);
    expect(detected).not.toBeNull();
    expect(detected?.majorVersion).toBe(21);
    expect(detected?.version).toContain('21.0.1');
  });

  it('detects Java 8 from its legacy 1.8 version string', async () => {
    const { java } = await setup();
    // Java 8 reports "java version 1.8.0_421" — the major is 8, not 1.
    fs.writeFileSync(path.join(tempDir, 'fake-java-8.js'), FAKE_JAVA_8);
    const fakeJava8Path = path.join(tempDir, 'fake-java-8.cmd');
    fs.writeFileSync(fakeJava8Path, `@echo off\r\nnode "%~dp0fake-java-8.js"\r\n`);
    const detected = await java.detect(fakeJava8Path);
    expect(detected).not.toBeNull();
    expect(detected?.majorVersion).toBe(8);
    expect(detected?.version).toContain('1.8.0');
  });

  it('reports a compatible requirement for java 8 + MC 1.16', async () => {
    const { java } = await setup();
    fs.writeFileSync(path.join(tempDir, 'fake-java-8.js'), FAKE_JAVA_8);
    const fakeJava8Path = path.join(tempDir, 'fake-java-8.cmd');
    fs.writeFileSync(fakeJava8Path, `@echo off\r\nnode "%~dp0fake-java-8.js"\r\n`);
    const req = await java.getRequirement('1.16.5', fakeJava8Path);
    expect(req.requiredJava).toBe(8);
    expect(req.compatible).toBe(true);
    expect(req.detected?.majorVersion).toBe(8);
  });

  it('reports a compatible requirement for java 21 + MC 1.21', async () => {
    const { java, fakeJavaPath } = await setup();
    const req = await java.getRequirement('1.21.4', fakeJavaPath);
    expect(req.requiredJava).toBe(21);
    expect(req.compatible).toBe(true);
  });

  it('reports an incompatible requirement for java 21 + MC 1.16', async () => {
    const { java, fakeJavaPath } = await setup();
    const req = await java.getRequirement('1.16.5', fakeJavaPath);
    expect(req.requiredJava).toBe(8);
    expect(req.compatible).toBe(false);
    expect(req.detected?.majorVersion).toBe(21);
  });

  it('returns null detection for a bad path', async () => {
    const { java } = await setup();
    const detected = await java.detect(path.join(tempDir, 'missing-java.exe'));
    expect(detected).toBeNull();
  });

  it('gets download info for a major version', async () => {
    const { java } = await setup();
    const info = await java.getDownloadInfo(21);
    expect(info.majorVersion).toBe(21);
    expect(info.label).toBe('Java 21');
    expect(info.installPath).toContain('java-21');
    expect(info.downloadSizeMb).toBeGreaterThanOrEqual(0);
  });

  it('finds java.exe in a nested extracted folder', async () => {
    const { java } = await setup();
    const runtimeFolder = path.join(tempDir, 'extracted');
    const nested = path.join(runtimeFolder, 'jdk-21.0.1', 'bin');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'java.exe'), 'x');
    expect(java.findJavaExecutable(runtimeFolder)).toBe(path.join(nested, 'java.exe'));
  });
});

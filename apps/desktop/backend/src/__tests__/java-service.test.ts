import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import yazl from 'yazl';
import { JavaService, requiredJavaForMinecraft } from '../java-service';

/**
 * Fake Adoptium API + a small runnable Windows-style JDK archive.
 */
async function startFakeAdoptium(options: {
  javaVersion?: string;
  badChecksum?: boolean;
  slowDownload?: boolean;
} = {}): Promise<{ baseUrl: string; server: Server }> {
  const zipContent = await createJavaArchive(options.javaVersion ?? '21.0.1');
  const checksum = options.badChecksum
    ? '0'.repeat(64)
    : crypto.createHash('sha256').update(zipContent).digest('hex');
  return new Promise((resolve) => {
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
                  link: 'https://api.adoptium.net/download.zip',
                  size: zipContent.length,
                  checksum,
                  checksum_link: 'https://api.adoptium.net/download.zip.sha256',
                  signature_link: 'https://api.adoptium.net/download.zip.sig',
                },
              },
            },
          ]),
        );
      } else if (url === '/download.zip') {
        res.setHeader('content-type', 'application/zip');
        res.setHeader('content-length', String(zipContent.length));
        if (options.slowDownload) {
          const midpoint = Math.max(1, Math.floor(zipContent.length / 2));
          res.write(zipContent.subarray(0, midpoint));
          setTimeout(() => res.end(zipContent.subarray(midpoint)), 1_000);
        } else {
          res.end(zipContent);
        }
      } else if (url === '/download.zip.sha256') {
        res.end(checksum);
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

function createJavaArchive(javaVersion: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      Buffer.from('@echo off\r\nnode "%~dp0java-version.js"\r\n'),
      'jdk-test/bin/java.cmd',
    );
    zip.addBuffer(
      Buffer.from(`process.stderr.write('openjdk version "${javaVersion}" 2026-01-01\\n');\n`),
      'jdk-test/bin/java-version.js',
    );
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream
      .pipe(new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }))
      .on('finish', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
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

  async function setup(options: {
    javaVersion?: string;
    badChecksum?: boolean;
    slowDownload?: boolean;
    progressHistoryLimit?: number;
  } = {}): Promise<{
    java: JavaService;
    fakeJavaPath: string;
    events: Array<{ installId: string; status: string }>;
  }> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-java-'));
    fakeAdoptium = await startFakeAdoptium(options);
    // A fake java.exe: a cmd wrapper that runs the node "java" script and
    // ignores any args (detect only passes -version).
    const fakeJavaPath = path.join(tempDir, 'fake-java.cmd');
    fs.writeFileSync(path.join(tempDir, 'fake-java.js'), FAKE_JAVA);
    fs.writeFileSync(fakeJavaPath, `@echo off\r\nnode "%~dp0fake-java.js"\r\n`);
    const events: Array<{ installId: string; status: string }> = [];
    const java = new JavaService((event) => {
      if (event.type === 'java:progress') {
        events.push({ installId: event.javaInstallId, status: event.progress.status });
      }
    }, {
      runtimesDir: path.join(tempDir, 'runtimes'),
      progressHistoryLimit: options.progressHistoryLimit,
      fetchImpl: (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        return fetch(url.replace('https://api.adoptium.net', fakeAdoptium.baseUrl), init);
      },
    });
    return { java, fakeJavaPath, events };
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

  it('downloads, verifies, extracts, validates, and atomically installs Java', async () => {
    const { java } = await setup();
    const installId = java.install(21);
    await waitFor(() => java.getInstallStatus(installId)?.status === 'complete');

    const runtime = java.runtimeFolder(21);
    const executable = java.findJavaExecutable(runtime);
    expect(executable).toContain('java.cmd');
    expect((await java.detect(executable))?.majorVersion).toBe(21);
    expect(
      fs.readdirSync(path.dirname(runtime)).filter((name) =>
        name.includes('.staging-') || name.includes('.rollback-') || name.endsWith('.zip'),
      ),
    ).toEqual([]);
  });

  it('deduplicates concurrent installs of the same Java major', async () => {
    const { java } = await setup({ slowDownload: true });
    const first = java.install(21);
    const second = java.install(21);
    expect(second).toBe(first);
    expect(java.cancel(first)).toBe(true);
    await waitFor(() => java.getInstallStatus(first)?.status === 'canceled');
    await waitFor(() => java.cancel(first) === false);
    const retry = java.install(21);
    expect(retry).not.toBe(first);
    expect(java.cancel(retry)).toBe(true);
    await waitFor(() => java.getInstallStatus(retry)?.status === 'canceled');
  });

  it('bounds retained progress after failed installs and releases the major lock', async () => {
    const { java } = await setup({ badChecksum: true, progressHistoryLimit: 2 });
    const ids: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = java.install(21);
      ids.push(id);
      await waitFor(() => java.getInstallStatus(id)?.status === 'failed');
      await waitFor(() => java.cancel(id) === false);
    }

    expect(new Set(ids).size).toBe(3);
    expect(java.getInstallStatus(ids[0])).toBeNull();
    expect(java.getInstallStatus(ids[1])?.status).toBe('failed');
    expect(java.getInstallStatus(ids[2])?.status).toBe('failed');
  });

  it('preserves a working runtime when checksum verification fails', async () => {
    const { java } = await setup({ badChecksum: true });
    const runtime = java.runtimeFolder(21);
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'keep.txt'), 'working runtime');

    const installId = java.install(21);
    await waitFor(() => java.getInstallStatus(installId)?.status === 'failed');
    expect(fs.readFileSync(path.join(runtime, 'keep.txt'), 'utf8')).toBe('working runtime');
    expect(fs.readdirSync(path.dirname(runtime)).some((name) => name.endsWith('.zip'))).toBe(false);
  });

  it('preserves a working runtime when the extracted Java major is wrong', async () => {
    const { java } = await setup({ javaVersion: '17.0.12' });
    const runtime = java.runtimeFolder(21);
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'keep.txt'), 'working runtime');

    const installId = java.install(21);
    await waitFor(() => java.getInstallStatus(installId)?.status === 'failed');
    expect(java.getInstallStatus(installId)?.message).toMatch(/Java 17, expected Java 21/);
    expect(fs.readFileSync(path.join(runtime, 'keep.txt'), 'utf8')).toBe('working runtime');
  });

  it('selects only the compatible app-managed runtime and skips broken candidates', async () => {
    const { java } = await setup();
    writeRuntime(java.runtimeFolder(8), '1.8.0_421');
    fs.mkdirSync(java.runtimeFolder(16), { recursive: true });
    fs.writeFileSync(path.join(java.runtimeFolder(16), 'broken.txt'), 'not Java');
    writeRuntime(java.runtimeFolder(17), '17.0.12');
    writeRuntime(java.runtimeFolder(21), '21.0.4');

    expect((await java.findCompatibleRuntime('1.16.5'))?.majorVersion).toBe(8);
    expect((await java.findCompatibleRuntime('1.20.4'))?.majorVersion).toBe(17);
    expect((await java.findCompatibleRuntime('1.21.4'))?.majorVersion).toBe(21);
    expect(await java.findCompatibleRuntime('1.17.1')).toBeNull();
  });

  function writeRuntime(runtimeFolder: string, version: string): void {
    const bin = path.join(runtimeFolder, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'java.cmd'),
      `@echo off\r\nnode -e "process.stderr.write('openjdk version \\"${version}\\"\\n')"\r\n`,
    );
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Java operation');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

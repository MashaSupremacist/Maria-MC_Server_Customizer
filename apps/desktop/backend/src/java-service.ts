import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  JavaDownloadInfo,
  JavaInstallation,
  JavaProgress,
  JavaRequirement,
  WsServerEvent,
} from '@msc/shared-types';

const ADOPTIUM_API_BASE = 'https://api.adoptium.net/v3';
const ADOPTIUM_ASSET_BASE = 'https://api.adoptium.net/v3/binary';

export type WsBroadcast = (event: WsServerEvent) => void;

export interface JavaServiceOptions {
  fetchImpl?: typeof fetch;
  /** Root folder for private runtimes. Defaults to <dataDir>/runtimes/java. */
  runtimesDir?: string;
}

interface AdoptiumAsset {
  binary: {
    os: string;
    architecture: string;
    image_type: string;
    package: {
      name: string;
      link: string;
      size: number;
    };
  };
}

/** Minecraft major version → required Java feature version (1.21+ → Java 21). */
export function requiredJavaForMinecraft(minecraftVersion: string): number {
  const parts = minecraftVersion.split('.').map((n) => parseInt(n, 10));
  const [a, b] = parts;
  // New-style year-based version numbers (e.g. 25.1, 26.2). Minecraft
  // switched from 1.x to year-based naming at 25.0; those require Java 25
  // (the Launcher bundles Java SE 25 as of 26.1).
  if (a >= 25) {
    return 25;
  }
  // 1.21+ / 21.x-24.x → Java 21.
  if (a >= 21) {
    return 21;
  }
  if (a === 1 && b >= 21) {
    return 21;
  }
  // 1.20.5+ and 1.21.x → 21; 1.18–1.20.4 → 17; 1.17 → 16; 1.16 and below → 8.
  if (a === 1 && b === 20 && (parts[2] ?? 0) >= 5) {
    return 21;
  }
  if (a === 1 && b >= 18) return 17;
  if (a === 1 && b === 17) return 16;
  return 8;
}

/** Human label for a Java feature version. */
export function javaLabel(major: number): string {
  return `Java ${major}`;
}

/**
 * Manages Java runtimes: detects installed Java, reports requirements for a
 * Minecraft version, and installs a private runtime into the app data folder.
 */
export class JavaService {
  private readonly broadcast: WsBroadcast;
  private readonly fetchImpl: typeof fetch;
  private readonly runtimesDir: string;
  private installs = new Map<string, { cancelRequested: boolean }>();
  private progressByInstall = new Map<string, JavaProgress>();

  constructor(broadcast: WsBroadcast, options: JavaServiceOptions = {}) {
    this.broadcast = broadcast;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runtimesDir = options.runtimesDir ?? '';
  }

  /** Latest known progress for an install, or null if unknown/completed. */
  getInstallStatus(installId: string): JavaProgress | null {
    return this.progressByInstall.get(installId) ?? null;
  }

  /** Path where a private runtime for a Java major version will live. */
  runtimeFolder(majorVersion: number): string {
    return path.join(this.runtimesDir, `java-${majorVersion}`);
  }

  /** Find the java.exe inside an extracted Adoptium runtime folder. */
  findJavaExecutable(runtimeFolder: string): string | null {
    if (!fs.existsSync(runtimeFolder)) return null;
    const candidates = [
      path.join(runtimeFolder, 'bin', 'java.exe'),
      path.join(runtimeFolder, 'bin', 'java'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    // Some archives nest one level deep: <root>/jdk-<version>/bin/java.exe
    try {
      const entries = fs.readdirSync(runtimeFolder);
      for (const entry of entries) {
        const nested = path.join(runtimeFolder, entry, 'bin', 'java.exe');
        if (fs.existsSync(nested)) return nested;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /** Read the Java version by running `java -version`. */
  async readJavaVersion(javaPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const isCmdWrapper = /\.(cmd|bat)$/i.test(javaPath);
        const child = isCmdWrapper
          ? spawn(
              process.env.ComSpec ?? 'cmd.exe',
              // spawn passes args without shell quoting; cmd /c takes the
              // script path as a single argument.
              ['/d', '/s', '/c', javaPath, '-version'],
              { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
            )
          : spawn(javaPath, ['-version'], {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            });
        let output = '';
        child.stdout?.on('data', (c: Buffer) => {
          output += c.toString();
        });
        child.stderr?.on('data', (c: Buffer) => {
          output += c.toString();
        });
        child.on('error', () => resolve(null));
        child.on('exit', () => {
          // Capture the full version (e.g. "21.0.1") and separately the major.
          const match = output.match(/"([\d._]+)"/);
          resolve(match ? match[1] : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** Detect Java at a specific path (or the JAVA_HOME java if no path given). */
  async detect(javaPath?: string | null): Promise<JavaInstallation | null> {
    const target = javaPath || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : '');
    if (!target) return null;
    const version = await this.readJavaVersion(target);
    if (!version) return null;
    const major = extractMajor(version);
    if (major === null) return null;
    return { javaPath: target, version, majorVersion: major };
  }

  /** Build the requirement report for a Minecraft version against a javaPath. */
  async getRequirement(
    minecraftVersion: string,
    javaPath: string | null,
  ): Promise<JavaRequirement> {
    const requiredJava = requiredJavaForMinecraft(minecraftVersion);
    const detected = javaPath ? await this.detect(javaPath) : null;
    const compatible = detected !== null && detected.majorVersion === requiredJava;
    return {
      minecraftVersion,
      requiredJava,
      requiredLabel: javaLabel(requiredJava),
      detected,
      compatible,
      serverJavaPath: javaPath,
    };
  }

  /** Get download info for a private runtime (for the pre-download notice). */
  async getDownloadInfo(majorVersion: number): Promise<JavaDownloadInfo> {
    const pkg = await this.resolveAdoptiumPackage(majorVersion);
    return {
      majorVersion,
      label: javaLabel(majorVersion),
      downloadSizeMb: Math.round(pkg.size / (1024 * 1024)),
      installPath: this.runtimeFolder(majorVersion),
    };
  }

  /** Install a private Java runtime. Returns the install id. */
  install(majorVersion: number): string {
    const installId = crypto.randomUUID();
    this.installs.set(installId, { cancelRequested: false });
    void this.runInstall(installId, majorVersion).catch((err: unknown) => {
      this.emit(installId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
      });
      this.installs.delete(installId);
    });
    return installId;
  }

  cancel(installId: string): boolean {
    const entry = this.installs.get(installId);
    if (!entry) return false;
    entry.cancelRequested = true;
    return true;
  }

  private emit(installId: string, progress: JavaProgress): void {
    this.progressByInstall.set(installId, progress);
    this.broadcast({
      type: 'java:progress',
      javaInstallId: installId,
      progress,
    } satisfies WsServerEvent);
  }

  private async runInstall(installId: string, majorVersion: number): Promise<void> {
    const entry = this.installs.get(installId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;
    const folder = this.runtimeFolder(majorVersion);

    if (isCanceled()) {
      this.finish(installId, 'canceled', 'Installation canceled');
      return;
    }

    const pkg = await this.resolveAdoptiumPackage(majorVersion);
    if (isCanceled()) {
      this.finish(installId, 'canceled', 'Installation canceled');
      return;
    }

    fs.mkdirSync(this.runtimesDir, { recursive: true });
    const zipPath = path.join(this.runtimesDir, `temp-jdk-${majorVersion}.zip`);

    // Download.
    this.emit(installId, {
      status: 'downloading',
      percent: 0,
      message: `Downloading ${javaLabel(majorVersion)}…`,
    });
    await this.downloadFile(pkg.link, zipPath, (percent) => {
      this.emit(installId, {
        status: 'downloading',
        percent,
        message: `Downloading ${javaLabel(majorVersion)}…`,
      });
    }, isCanceled);

    if (isCanceled()) {
      this.cleanupFile(zipPath);
      this.finish(installId, 'canceled', 'Installation canceled');
      return;
    }

    // Extract.
    this.emit(installId, { status: 'extracting', percent: null, message: 'Extracting runtime…' });
    await this.extractZip(zipPath, folder, isCanceled);
    this.cleanupFile(zipPath);

    if (isCanceled()) {
      fs.rmSync(folder, { recursive: true, force: true });
      this.finish(installId, 'canceled', 'Installation canceled');
      return;
    }

    // Verify java.exe exists.
    const javaExe = this.findJavaExecutable(folder);
    if (!javaExe) {
      fs.rmSync(folder, { recursive: true, force: true });
      this.finish(installId, 'failed', 'Extracted runtime has no java executable');
      return;
    }

    this.installs.delete(installId);
    this.emit(installId, {
      status: 'complete',
      percent: 100,
      message: 'Java runtime installed',
      installPath: folder,
      javaPath: javaExe,
    });
  }

  private finish(
    installId: string,
    status: JavaProgress['status'],
    message: string,
  ): void {
    this.installs.delete(installId);
    this.emit(installId, { status, percent: null, message });
  }

  private async resolveAdoptiumPackage(
    majorVersion: number,
  ): Promise<{ link: string; size: number }> {
    const url = `${ADOPTIUM_API_BASE}/assets/latest/${majorVersion}/hotspot?os=windows&architecture=x64&image_type=jdk&vendor=eclipse`;
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`Failed to query Adoptium for Java ${majorVersion} (${res.status})`);
    }
    const assets = (await res.json()) as AdoptiumAsset[];
    const pkg = assets?.[0]?.binary?.package;
    if (!pkg || !pkg.link) {
      throw new Error(`No Adoptium build available for Java ${majorVersion}`);
    }
    return { link: pkg.link, size: pkg.size };
  }

  private cleanupFile(filePath: string): void {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // best effort
    }
  }

  private async downloadFile(
    url: string,
    dest: string,
    onProgress: (percent: number) => void,
    isCanceled: () => boolean,
  ): Promise<void> {
    const res = await this.fetchImpl(url);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status})`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    let received = 0;
    const reader = res.body.getReader();
    const file = fs.createWriteStream(dest);
    try {
      for (;;) {
        if (isCanceled()) {
          file.destroy();
          throw new Error('Download canceled');
        }
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0) {
          onProgress(Math.min(100, Math.round((received / total) * 100)));
        }
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => file.once('drain', resolve));
        }
      }
    } finally {
      file.end();
    }
  }

  /** Extract a zip using PowerShell (available on all supported Windows). */
  private async extractZip(
    zipPath: string,
    dest: string,
    isCanceled: () => boolean,
  ): Promise<void> {
    if (isCanceled()) return;
    fs.mkdirSync(dest, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const ps = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      ps.on('error', reject);
      ps.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Extraction failed with exit code ${code}`));
      });
    });
  }
}

function extractMajor(versionString: string): number | null {
  const match = versionString.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

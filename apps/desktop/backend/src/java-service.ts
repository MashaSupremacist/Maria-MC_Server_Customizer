import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildChildProcessEnvironment } from './child-process-env';
import { DownloadError, DownloadService } from './download-service';
import { replaceDirectoryAtomically } from './fs-transaction';
import { safeJoin, walkZip, writeEntryStream } from './zip-utils';
import { fetchMetadata, fetchMetadataJson } from './metadata-fetch';
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
  /** Maximum retained terminal/in-progress status entries. */
  progressHistoryLimit?: number;
  metadataTimeoutMs?: number;
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
      checksum?: string;
      checksum_link?: string;
      signature_link?: string;
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
  // Everything from 1.0 through 1.16.x — including 1.7.10 — runs on Java 8.
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
  private readonly downloader: DownloadService;
  private readonly progressHistoryLimit: number;
  private readonly metadataTimeoutMs: number;
  private installs = new Map<string, {
    abortController: AbortController;
    majorVersion: number;
  }>();
  private activeInstallByMajor = new Map<number, string>();
  private progressByInstall = new Map<string, JavaProgress>();

  constructor(broadcast: WsBroadcast, options: JavaServiceOptions = {}) {
    this.broadcast = broadcast;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runtimesDir = options.runtimesDir ?? '';
    this.downloader = new DownloadService({ fetchImpl: this.fetchImpl });
    this.progressHistoryLimit = Math.max(1, options.progressHistoryLimit ?? 100);
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
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
      path.join(runtimeFolder, 'bin', 'java.cmd'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    // Some archives nest one level deep: <root>/jdk-<version>/bin/java.exe
    try {
      const entries = fs.readdirSync(runtimeFolder);
      for (const entry of entries) {
        for (const executable of ['java.exe', 'java', 'java.cmd']) {
          const nested = path.join(runtimeFolder, entry, 'bin', executable);
          if (fs.existsSync(nested)) return nested;
        }
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
              {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: buildChildProcessEnvironment(),
              },
            )
          : spawn(javaPath, ['-version'], {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
              env: buildChildProcessEnvironment(),
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

  /** Deterministically select an installed app runtime matching Minecraft. */
  async findCompatibleRuntime(minecraftVersion: string): Promise<JavaInstallation | null> {
    const requiredMajor = requiredJavaForMinecraft(minecraftVersion);
    if (!fs.existsSync(this.runtimesDir)) return null;
    let folders: string[];
    try {
      folders = fs
        .readdirSync(this.runtimesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(this.runtimesDir, entry.name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } catch {
      return null;
    }

    const preferred = this.runtimeFolder(requiredMajor);
    folders = [preferred, ...folders.filter((folder) => path.resolve(folder) !== path.resolve(preferred))];
    for (const folder of folders) {
      const javaPath = this.findJavaExecutable(folder);
      if (!javaPath) continue;
      const detected = await this.detect(javaPath);
      if (detected?.majorVersion === requiredMajor) return detected;
    }
    return null;
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
    const active = this.activeInstallByMajor.get(majorVersion);
    if (active && this.installs.has(active)) return active;
    const installId = crypto.randomUUID();
    this.installs.set(installId, {
      abortController: new AbortController(),
      majorVersion,
    });
    this.activeInstallByMajor.set(majorVersion, installId);
    void this.runInstall(installId, majorVersion).catch((err: unknown) => {
      const canceled =
        (err instanceof DownloadError && err.code === 'cancelled') ||
        (err instanceof DOMException && err.name === 'AbortError') ||
        this.installs.get(installId)?.abortController.signal.aborted;
      this.emit(installId, canceled
        ? { status: 'canceled', percent: null, message: 'Installation canceled' }
        : {
            status: 'failed',
            percent: null,
            message: err instanceof Error ? err.message : String(err),
          });
    }).finally(() => {
      this.installs.delete(installId);
      if (this.activeInstallByMajor.get(majorVersion) === installId) {
        this.activeInstallByMajor.delete(majorVersion);
      }
    });
    return installId;
  }

  cancel(installId: string): boolean {
    const entry = this.installs.get(installId);
    if (!entry) return false;
    entry.abortController.abort();
    return true;
  }

  cancelAll(): number {
    let canceled = 0;
    for (const installId of [...this.installs.keys()]) {
      if (this.cancel(installId)) canceled += 1;
    }
    return canceled;
  }

  activeInstallCount(): number {
    return this.installs.size;
  }

  private emit(installId: string, progress: JavaProgress): void {
    this.progressByInstall.delete(installId);
    this.progressByInstall.set(installId, progress);
    while (this.progressByInstall.size > this.progressHistoryLimit) {
      const oldest = this.progressByInstall.keys().next().value as string | undefined;
      if (!oldest) break;
      this.progressByInstall.delete(oldest);
    }
    this.broadcast({
      type: 'java:progress',
      javaInstallId: installId,
      progress,
    } satisfies WsServerEvent);
  }

  private async runInstall(installId: string, majorVersion: number): Promise<void> {
    const entry = this.installs.get(installId);
    if (!entry) throw new Error('Java installation state was lost');
    const signal = entry.abortController.signal;
    const folder = this.runtimeFolder(majorVersion);
    if (signal.aborted) throw new DOMException('Installation canceled', 'AbortError');
    const pkg = await this.resolveAdoptiumPackage(majorVersion, signal);
    if (signal.aborted) throw new DOMException('Installation canceled', 'AbortError');
    await fs.promises.mkdir(this.runtimesDir, { recursive: true });
    const zipPath = path.join(this.runtimesDir, `.java-${majorVersion}-${installId}.zip`);

    try {
      this.emit(installId, {
        status: 'downloading',
        percent: 0,
        message: `Downloading ${javaLabel(majorVersion)}…`,
      });
      await this.downloader.download({
        url: pkg.link,
        destination: zipPath,
        expectedBytes: pkg.size,
        expectedDigest: { algorithm: 'sha256', value: pkg.checksum },
        signal,
        onProgress: ({ percent }) => {
          this.emit(installId, {
            status: 'downloading',
            percent,
            message: `Downloading ${javaLabel(majorVersion)}…`,
          });
        },
      });

      this.emit(installId, { status: 'extracting', percent: null, message: 'Extracting runtime…' });
      await replaceDirectoryAtomically(
        folder,
        (staging) => this.extractZip(zipPath, staging, signal),
        async (staging) => {
          const javaExe = this.findJavaExecutable(staging);
          if (!javaExe) throw new Error('Extracted runtime has no Java executable');
          const detected = await this.detect(javaExe);
          if (!detected) throw new Error('Extracted Java runtime could not be started');
          if (detected.majorVersion !== majorVersion) {
            throw new Error(
              `Extracted runtime is Java ${detected.majorVersion}, expected Java ${majorVersion}`,
            );
          }
        },
        { signal },
      );
    } finally {
      await fs.promises.rm(zipPath, { force: true }).catch(() => undefined);
    }

    const javaExe = this.findJavaExecutable(folder);
    if (!javaExe) throw new Error('Committed runtime has no Java executable');
    this.emit(installId, {
      status: 'complete',
      percent: 100,
      message: 'Java runtime installed',
      installPath: folder,
      javaPath: javaExe,
    });
  }

  private async resolveAdoptiumPackage(
    majorVersion: number,
    signal?: AbortSignal,
  ): Promise<{ link: string; size: number; checksum: string; signatureLink?: string }> {
    const url = `${ADOPTIUM_API_BASE}/assets/latest/${majorVersion}/hotspot?os=windows&architecture=x64&image_type=jdk&vendor=eclipse`;
    const res = await fetchMetadataJson<AdoptiumAsset[]>(url, {
      fetchImpl: this.fetchImpl,
      signal,
      timeoutMs: this.metadataTimeoutMs,
    });
    if (!res.ok) {
      throw new Error(`Failed to query Adoptium for Java ${majorVersion} (${res.status})`);
    }
    const assets = res.value;
    const pkg = assets?.[0]?.binary?.package;
    if (!pkg || !pkg.link) {
      throw new Error(`No Adoptium build available for Java ${majorVersion}`);
    }
    let checksum = pkg.checksum?.trim().toLowerCase() ?? '';
    if (!checksum && pkg.checksum_link) {
      const checksumResponse = await fetchMetadata(pkg.checksum_link, {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: this.metadataTimeoutMs,
      });
      if (!checksumResponse.ok) {
        throw new Error(`Failed to fetch Adoptium checksum (${checksumResponse.status})`);
      }
      checksum = checksumResponse.text.trim().split(/\s+/)[0].toLowerCase();
    }
    if (!/^[a-f\d]{64}$/.test(checksum)) {
      throw new Error(`Adoptium did not provide a valid SHA-256 checksum for Java ${majorVersion}`);
    }
    return {
      link: pkg.link,
      size: pkg.size,
      checksum,
      signatureLink: pkg.signature_link,
    };
  }

  /** Extract with the shared bounded, traversal-safe ZIP implementation. */
  private async extractZip(zipPath: string, dest: string, signal: AbortSignal): Promise<void> {
    await walkZip(zipPath, async (entry, stream) => {
      const target = safeJoin(dest, entry.fileName);
      if (!target) {
        stream.destroy();
        throw new Error(`Unsafe path in Java runtime archive: ${entry.fileName}`);
      }
      await writeEntryStream(stream, target, signal);
    }, { signal });
  }
}

function extractMajor(versionString: string): number | null {
  // Java 8 and earlier report "1.8.0_421" (major is the second segment).
  const match = versionString.match(/^1\.(\d+)(?:[.\-_]|$)/);
  if (match) return parseInt(match[1], 10);
  // Java 9+ reports "21.0.1" (major is the first segment).
  const modern = versionString.match(/^(\d+)/);
  return modern ? parseInt(modern[1], 10) : null;
}

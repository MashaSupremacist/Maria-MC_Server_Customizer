import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import type {
  BedrockVersion,
  InstallBedrockRequest,
  InstallProgress,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { createServerFolder } from './server-installer';

const REGISTRY_BASE = 'https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/master';
const DEFAULT_PORT = 19132;

export type WsBroadcast = (event: WsServerEvent) => void;

interface RegistryVersions {
  release: { latest: string; versions: string[] };
  preview: { latest: string; versions: string[] };
}

interface RegistryMetadata {
  version: string;
  binary: {
    windows: { url: string; sha256: string };
    linux?: { url: string; sha256: string };
  };
}

export interface BedrockInstallerOptions {
  fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to the community version registry. */
  registryBaseUrl?: string;
}

/**
 * Installs Bedrock Dedicated Servers: resolves the official Windows binary
 * (via the community version registry, which mirrors minecraft.net), downloads
 * + verifies the ZIP (SHA-256), extracts it into the server folder, writes
 * starter config, then creates the server record. Progress is broadcast over
 * WebSocket.
 */
export class BedrockInstallerService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly fetchImpl: typeof fetch;
  private readonly registryBaseUrl: string;
  private installs = new Map<string, { cancelRequested: boolean }>();

  constructor(db: DatabaseResult, broadcast: WsBroadcast, options: BedrockInstallerOptions = {}) {
    this.db = db;
    this.broadcast = broadcast;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.registryBaseUrl = options.registryBaseUrl ?? REGISTRY_BASE;
  }

  /** Fetch the Bedrock version list: releases first (newest), then previews. */
  async listVersions(): Promise<BedrockVersion[]> {
    const res = await this.fetchImpl(`${this.registryBaseUrl}/versions.json`);
    if (!res.ok) {
      throw new Error(`Failed to fetch Bedrock versions (${res.status})`);
    }
    const registry = (await res.json()) as RegistryVersions;
    const releases: BedrockVersion[] = (registry.release?.versions ?? []).map((v) => ({
      id: v,
      type: 'release',
    }));
    const previews: BedrockVersion[] = (registry.preview?.versions ?? []).map((v) => ({
      id: v,
      type: 'preview',
    }));
    return [...releases, ...previews];
  }

  /** Start a new Bedrock install. Throws on immediate (pre-download) errors. */
  async install(request: InstallBedrockRequest): Promise<string> {
    if (!request.acceptEula) {
      throw new Error('The Minecraft EULA must be accepted before installing');
    }
    const installId = crypto.randomUUID();
    this.installs.set(installId, { cancelRequested: false });
    void this.runInstall(installId, request).catch((err: unknown) => {
      this.emit(installId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        errorCode: 'network',
      });
      this.installs.delete(installId);
    });
    return installId;
  }

  /** Cancel a running install by id. */
  cancel(installId: string): boolean {
    const entry = this.installs.get(installId);
    if (!entry) return false;
    entry.cancelRequested = true;
    return true;
  }

  private emit(installId: string, progress: InstallProgress): void {
    this.broadcast({
      type: 'install:progress',
      installId,
      progress,
    } satisfies WsServerEvent);
  }

  private async runInstall(installId: string, request: InstallBedrockRequest): Promise<void> {
    const entry = this.installs.get(installId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;
    try {
      if (isCanceled()) {
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 1. Resolve the version's Windows binary (url + sha256).
      const download = await this.resolveWindowsBinary(request.version);
      if (isCanceled()) {
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 2. Create the server folder.
      const serverFolder = createServerFolder(this.db, request.name, request.folderName);
      if (isCanceled()) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 3. Download the ZIP with progress + cancellation.
      this.emit(installId, {
        status: 'downloading',
        percent: 0,
        message: `Downloading ${path.basename(download.url)}…`,
      });
      const zipPath = path.join(serverFolder, 'bedrock-server.zip');
      await this.downloadFile(zipPath, download.url, (percent) => {
        this.emit(installId, {
          status: 'downloading',
          percent,
          message: `Downloading Bedrock server…`,
        });
      }, isCanceled);
      if (isCanceled()) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 4. Verify SHA-256.
      this.emit(installId, { status: 'verifying', percent: null, message: 'Verifying download…' });
      const sha256 = await sha256File(zipPath);
      if (sha256 !== download.sha256) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'failed', 'Download checksum mismatch — file may be corrupt', 'checksum');
        return;
      }
      if (isCanceled()) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 5. Extract the ZIP into the server folder.
      this.emit(installId, { status: 'installing', percent: null, message: 'Extracting server files…' });
      await this.extractZip(zipPath, serverFolder, (percent) => {
        this.emit(installId, {
          status: 'installing',
          percent,
          message: 'Extracting server files…',
        });
      }, isCanceled);
      if (isCanceled()) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }
      fs.rmSync(zipPath, { force: true });

      // 6. Write starter config (server.properties, allowlist, permissions).
      this.emit(installId, { status: 'writing-config', percent: null, message: 'Writing configuration…' });
      writeBedrockServerProperties(path.join(serverFolder, 'server.properties'), {
        port: request.port ?? DEFAULT_PORT,
      });
      fs.writeFileSync(path.join(serverFolder, 'allowlist.json'), '[]\n', 'utf8');
      fs.writeFileSync(path.join(serverFolder, 'permissions.json'), '[]\n', 'utf8');
      fs.writeFileSync(
        path.join(serverFolder, 'eula.txt'),
        `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toISOString()}\neula=true\n`,
      );

      // 7. Create the server record.
      const record = this.db.createServer({
        name: request.name,
        edition: 'bedrock',
        serverType: 'bedrock',
        folderPath: serverFolder,
        javaPath: null,
        memoryMb: 1024,
        port: request.port ?? DEFAULT_PORT,
        version: request.version,
        jvmArgs: [],
      });

      this.installs.delete(installId);
      this.emit(installId, {
        status: 'complete',
        percent: 100,
        message: 'Installation complete',
        serverId: record.id,
      });
    } catch (err) {
      this.installs.delete(installId);
      if (err instanceof DownloadCanceledError) {
        this.emit(installId, { status: 'canceled', percent: null, message: 'Installation canceled' });
        return;
      }
      this.emit(installId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        errorCode: 'network',
      });
    }
  }

  private finish(
    installId: string,
    status: InstallProgress['status'],
    message: string,
    errorCode?: InstallProgress['errorCode'],
  ): void {
    this.installs.delete(installId);
    this.emit(installId, { status, percent: null, message, errorCode });
  }

  /** Resolve the official Windows binary for a Bedrock version. */
  private async resolveWindowsBinary(
    version: string,
  ): Promise<{ url: string; sha256: string }> {
    const metadata = (await (
      await this.fetchImpl(`${this.registryBaseUrl}/release/${version}/metadata.json`)
    ).json()) as RegistryMetadata;
    const windows = metadata.binary?.windows;
    if (!windows?.url || !windows.sha256) {
      throw new Error(`Unknown Bedrock version: ${version}`);
    }
    return { url: windows.url, sha256: windows.sha256 };
  }

  private cleanupFolder(folder: string): void {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  /** Stream a file download with progress (0-100) and cancellation support. */
  private async downloadFile(
    dest: string,
    url: string,
    onProgress: (percent: number) => void,
    isCanceled: () => boolean,
  ): Promise<void> {
    const res = await this.fetchImpl(url);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status})`);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    let received = 0;
    let lastMbMarker = 0;
    const reader = res.body.getReader();
    const file = fs.createWriteStream(dest);
    try {
      for (;;) {
        if (isCanceled()) {
          throw new DownloadCanceledError();
        }
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0) {
          onProgress(Math.min(100, Math.round((received / total) * 100)));
        } else {
          const approx = received / (1024 * 1024);
          if (approx >= lastMbMarker + 5) {
            lastMbMarker = approx;
            onProgress(Math.min(99, Math.round((approx / (approx + 8)) * 100)));
          }
        }
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            file.once('drain', resolve);
            file.once('error', reject);
          });
        }
      }
      file.end();
      await new Promise<void>((resolve, reject) => {
        file.once('finish', resolve);
        file.once('error', reject);
      });
    } catch (err) {
      file.destroy();
      throw err;
    }
  }

  /**
   * Extract a ZIP into destFolder, streaming entries with byte-based progress.
   * Rejects paths that escape the destination (path traversal).
   */
  private async extractZip(
    zipPath: string,
    destFolder: string,
    onProgress: (percent: number) => void,
    isCanceled: () => boolean,
  ): Promise<void> {
    const totalBytes = fs.statSync(zipPath).size;
    let processed = 0;
    await new Promise<void>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) {
          reject(err ?? new Error('Failed to open zip'));
          return;
        }
        let pending = 0;
        zipfile.readEntry();
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (isCanceled()) {
            zipfile.close();
            reject(new DownloadCanceledError());
            return;
          }
          const target = path.join(destFolder, entry.fileName);
          // Reject absolute paths and traversal outside the destination.
          const relative = path.relative(destFolder, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            zipfile.close();
            reject(new Error(`Unsafe path in archive: ${entry.fileName}`));
            return;
          }
          processed += entry.compressedSize;
          onProgress(Math.min(99, Math.round((processed / totalBytes) * 100)));
          if (/\/$/.test(entry.fileName)) {
            fs.mkdirSync(target, { recursive: true });
            zipfile.readEntry();
            return;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          pending += 1;
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              zipfile.close();
              reject(streamErr ?? new Error('Failed to open zip entry'));
              return;
            }
            const out = fs.createWriteStream(target);
            stream.on('error', (e) => {
              out.destroy();
              zipfile.close();
              reject(e);
            });
            out.on('error', (e) => {
              zipfile.close();
              reject(e);
            });
            out.on('close', () => {
              pending -= 1;
              zipfile.readEntry();
            });
            stream.pipe(out);
          });
        });
        zipfile.on('end', () => {
          const check = (): void => {
            if (pending === 0) {
              zipfile.close();
              resolve();
            } else {
              setTimeout(check, 10);
            }
          };
          check();
        });
        zipfile.on('error', (e) => reject(e));
      });
    });
  }
}

export class DownloadCanceledError extends Error {
  constructor() {
    super('Download canceled');
    this.name = 'DownloadCanceledError';
  }
}

/** Compute the SHA-256 of a file (hex). */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function writeBedrockServerProperties(
  filePath: string,
  options: { port: number },
): void {
  const lines = [
    '#Minecraft Bedrock server properties',
    `server-port=${options.port}`,
    'server-portv6=19133',
    'level-name=Bedrock level',
    'level-seed=',
    'online-mode=true',
    'white-list=false',
    'motd=Dedicated Server',
    'max-players=10',
    'gamemode=survival',
    'difficulty=easy',
    'allow-cheats=false',
    'view-distance=32',
    'tick-distance=4',
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

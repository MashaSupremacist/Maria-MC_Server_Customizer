import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { finished } from 'node:stream/promises';
import type {
  InstallProgress,
  InstallVanillaRequest,
  ServerRecord,
  VanillaVersion,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';

const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_PORT = 25565;

export type WsBroadcast = (event: WsServerEvent) => void;

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: Array<{ id: string; type: string; url: string; releaseTime: string }>;
}

interface VersionManifestEntry {
  id: string;
  type: string;
  url: string;
  releaseTime: string;
}

interface VersionJson {
  downloads: {
    server?: { url: string; sha1: string; size: number };
  };
}

/**
 * Installs new Vanilla servers: resolves the official server JAR for a
 * Minecraft version, downloads + verifies it (SHA-1), writes eula.txt and a
 * starter server.properties, then creates the server record. Progress is
 * broadcast over WebSocket. Only one install runs at a time.
 */
export interface VanillaInstallerOptions {
  fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to the official Mojang manifest. */
  manifestUrl?: string;
}

export class VanillaInstallerService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly fetchImpl: typeof fetch;
  private readonly manifestUrl: string;
  private installs = new Map<string, { cancelRequested: boolean }>();

  constructor(
    db: DatabaseResult,
    broadcast: WsBroadcast,
    options: VanillaInstallerOptions = {},
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.manifestUrl = options.manifestUrl ?? MOJANG_MANIFEST_URL;
  }

  /** Fetch the official version list, newest first, releases first. */
  async listVersions(): Promise<VanillaVersion[]> {
    const res = await this.fetchImpl(this.manifestUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch Minecraft versions (${res.status})`);
    }
    const manifest = (await res.json()) as VersionManifest;
    const map = new Map<string, VersionManifestEntry>();
    for (const v of manifest.versions) {
      if (!map.has(v.id)) map.set(v.id, v);
    }
    const sorted = [...map.values()].sort((a, b) =>
      b.releaseTime.localeCompare(a.releaseTime),
    );
    // Releases first, then snapshots and older types.
    const rank = (type: string): number => (type === 'release' ? 0 : 1);
    sorted.sort((a, b) => rank(a.type) - rank(b.type) || b.releaseTime.localeCompare(a.releaseTime));
    return sorted.map((v) => ({
      id: v.id,
      type: v.type as VanillaVersion['type'],
      releaseTime: v.releaseTime,
    }));
  }

  /** Install a new Vanilla server. Throws on immediate (pre-download) errors. */
  async install(request: InstallVanillaRequest): Promise<string> {
    if (!request.acceptEula) {
      throw new Error('The Minecraft EULA must be accepted before installing');
    }
    const installId = crypto.randomUUID();
    this.installs.set(installId, { cancelRequested: false });
    const cancel = (): boolean => {
      this.installs.get(installId)!.cancelRequested = true;
      return true;
    };

    void this.runInstall(installId, request, cancel).catch((err: unknown) => {
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

  private async runInstall(
    installId: string,
    request: InstallVanillaRequest,
    cancel: () => boolean,
  ): Promise<void> {
    let serverFolder: string | null = null;
    try {
      const entry = this.installs.get(installId);
      const isCanceled = (): boolean => entry?.cancelRequested ?? false;

      if (isCanceled()) {
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 1. Resolve the version's server download.
      const download = await this.resolveServerDownload(request.version);
      if (isCanceled()) {
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 2. Create the server folder.
      serverFolder = this.createServerFolder(request.name, request.folderName);
      if (isCanceled()) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 3. Download the JAR with progress + cancellation.
      this.emit(installId, {
        status: 'downloading',
        percent: 0,
        message: `Downloading ${path.basename(download.url)}…`,
      });
      const jarPath = path.join(serverFolder, 'server.jar');
      await this.downloadFile(
        download.url,
        jarPath,
        (percent) => this.emit(installId, {
          status: 'downloading',
          percent,
          message: `Downloading server JAR…`,
        }),
        isCanceled,
      );
      if (isCanceled()) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 4. Verify SHA-1.
      this.emit(installId, { status: 'verifying', percent: null, message: 'Verifying download…' });
      const sha1 = await sha1File(jarPath);
      if (sha1 !== download.sha1) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'failed', 'Download checksum mismatch — file may be corrupt', 'checksum');
        return;
      }

      // 5. Write eula.txt + server.properties.
      this.emit(installId, { status: 'writing-config', percent: null, message: 'Writing configuration…' });
      fs.writeFileSync(
        path.join(serverFolder, 'eula.txt'),
        `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toISOString()}\neula=true\n`,
      );
      writeServerProperties(path.join(serverFolder, 'server.properties'), {
        port: request.port ?? DEFAULT_PORT,
        levelName: 'world',
        motd: `A Minecraft Server`,
        maxPlayers: 20,
      });

      // 6. Create the server record.
      const record = this.db.createServer({
        name: request.name,
        edition: 'java',
        serverType: 'vanilla',
        folderPath: serverFolder,
        javaPath: request.javaPath ?? null,
        memoryMb: request.memoryMb ?? DEFAULT_MEMORY_MB,
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
      if (serverFolder) {
        this.cleanupFolder(serverFolder);
      }
      if (err instanceof DownloadCanceledError) {
        this.emit(installId, {
          status: 'canceled',
          percent: null,
          message: 'Installation canceled',
        });
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

  /** Resolve the official server download for a version id. */
  private async resolveServerDownload(
    versionId: string,
  ): Promise<{ url: string; sha1: string }> {
    const manifest = (await (
      await this.fetchImpl(this.manifestUrl)
    ).json()) as VersionManifest;
    const entry = manifest.versions.find((v) => v.id === versionId);
    if (!entry) {
      throw new Error(`Unknown Minecraft version: ${versionId}`);
    }
    const versionJson = (await (
      await this.fetchImpl(entry.url)
    ).json()) as VersionJson;
    const server = versionJson.downloads?.server;
    if (!server) {
      throw new Error(`Version ${versionId} has no official server download`);
    }
    return { url: server.url, sha1: server.sha1 };
  }

  private createServerFolder(name: string, folderName?: string): string {
    const library = this.db.getSettings().serverLibraryPath;
    if (!library) {
      throw new Error('No server library folder configured');
    }
    const slug = sanitizeFolderName(folderName || name);
    let folder = path.join(library, slug);
    let i = 2;
    while (fs.existsSync(folder)) {
      folder = path.join(library, `${slug}-${i}`);
      i += 1;
    }
    fs.mkdirSync(folder, { recursive: true });
    return folder;
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
    let lastMbMarker = 0;
    const reader = res.body.getReader();
    const file = fs.createWriteStream(dest);
    const fileFinished = finished(file);
    // Keep an error handler attached while the response body is being read;
    // the awaited promise below still propagates the failure.
    void fileFinished.catch(() => undefined);
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
          // No content-length: report progress in 5% steps so the bar still
          // visibly advances even though the total size is unknown.
          const approx = received / (1024 * 1024);
          if (approx >= lastMbMarker + 5) {
            lastMbMarker = approx;
            onProgress(Math.min(99, Math.round((approx / (approx + 8)) * 100)));
          }
        }
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => file.once('drain', resolve));
        }
      }
      file.end();
      await fileFinished;
    } catch (err) {
      try {
        await reader.cancel();
      } catch {
        // The response may already be closed.
      }
      file.destroy();
      try {
        await fileFinished;
      } catch {
        // Preserve the original download/cancellation error.
      }
      throw err;
    }
  }
}

export class DownloadCanceledError extends Error {
  constructor() {
    super('Download canceled');
    this.name = 'DownloadCanceledError';
  }
}

/** Compute the SHA-1 of a file. */
async function sha1File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function writeServerProperties(
  filePath: string,
  options: { port: number; levelName: string; motd: string; maxPlayers: number },
): void {
  const lines = [
    '#Minecraft server properties',
    `server-port=${options.port}`,
    `level-name=${options.levelName}`,
    `motd=${options.motd}`,
    `max-players=${options.maxPlayers}`,
    'online-mode=true',
    'difficulty=easy',
    'gamemode=survival',
    'pvp=true',
    'white-list=false',
    'enable-command-block=false',
    'view-distance=10',
    'max-tick-time=60000',
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function sanitizeFolderName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'server';
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ConvertServerRequest,
  InstallProgress,
  InstallServerRequest,
  ServerFlavor,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { flavorMeta, listServerTypes } from './server-types';
import { VanillaResolver } from './resolvers/vanilla';
import { FabricResolver } from './resolvers/fabric';
import { ForgeResolver } from './resolvers/forge';
import { PaperResolver } from './resolvers/paper';
import type { FlavorResolver, ResolvedDownload } from './resolvers/types';

const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_PORT = 25565;

export type WsBroadcast = (event: WsServerEvent) => void;

export interface ServerInstallerOptions {
  fetchImpl?: typeof fetch;
  vanillaManifestUrl?: string;
  fabricMetaUrl?: string;
  modrinthUrl?: string;
  forgeMavenUrl?: string;
  paperApiUrl?: string;
}

/**
 * Generic server installer for all Java flavors. One pipeline handles folder
 * creation, EULA, starter server.properties, JAR download with progress/cancel
 * + SHA-1 verify, and flavor-specific install steps (e.g. Forge
 * --installServer). Also supports converting an existing server to a new
 * flavor in place.
 */
export class ServerInstallerService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly fetchImpl: typeof fetch;
  private readonly resolvers: Record<ServerFlavor, FlavorResolver>;
  private installs = new Map<string, { cancelRequested: boolean }>();

  constructor(db: DatabaseResult, broadcast: WsBroadcast, options: ServerInstallerOptions = {}) {
    this.db = db;
    this.broadcast = broadcast;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolvers = {
      vanilla: new VanillaResolver({
        fetchImpl: this.fetchImpl,
        manifestUrl: options.vanillaManifestUrl,
      }),
      fabric: new FabricResolver({
        fetchImpl: this.fetchImpl,
        metaUrl: options.fabricMetaUrl,
        modrinthUrl: options.modrinthUrl,
      }),
      forge: new ForgeResolver({
        fetchImpl: this.fetchImpl,
        mavenUrl: options.forgeMavenUrl,
      }),
      paper: new PaperResolver({
        fetchImpl: this.fetchImpl,
        apiUrl: options.paperApiUrl,
      }),
    };
  }

  /** List selectable server types (labels + descriptions) for the form. */
  listServerTypes(): ReturnType<typeof listServerTypes> {
    return listServerTypes();
  }

  /** Fetch the official Vanilla version list (shared with the form). */
  listVersions(): ReturnType<VanillaResolver['listVersions']> {
    return (this.resolvers.vanilla as VanillaResolver).listVersions();
  }

  /** Fabric loader versions for a game version. */
  listFabricLoaders(gameVersion: string): Promise<string[]> {
    return (this.resolvers.fabric as FabricResolver).listLoaderVersions(gameVersion);
  }

  /** Start a new install of any flavor. Throws on immediate errors. */
  async install(request: InstallServerRequest): Promise<string> {
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

  /**
   * Convert an existing server to a new flavor in place: swap the server jar
   * (and run the Forge installer step when needed). The world folder and
   * config are preserved. Only works while the server is offline.
   */
  async convert(request: ConvertServerRequest): Promise<{ operationId: string; error?: string }> {
    const record = this.db.getServer(request.serverId);
    if (!record) return { operationId: '', error: 'Server not found' };
    if (!fs.existsSync(record.folderPath)) {
      return { operationId: '', error: `Server folder not found: ${record.folderPath}` };
    }
    const target = flavorMeta(request.flavor);
    if (!target) return { operationId: '', error: `Unknown server type: ${request.flavor}` };
    if (target.id === record.serverType) {
      return { operationId: '', error: `This server is already ${target.label}` };
    }

    const operationId = crypto.randomUUID();
    this.installs.set(operationId, { cancelRequested: false });
    void this.runConvert(operationId, request, record.folderPath).catch((err: unknown) => {
      this.emit(operationId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        errorCode: 'network',
      });
      this.installs.delete(operationId);
    });
    return { operationId };
  }

  private emit(installId: string, progress: InstallProgress): void {
    this.broadcast({
      type: 'install:progress',
      installId,
      progress,
    } satisfies WsServerEvent);
  }

  private async runInstall(installId: string, request: InstallServerRequest): Promise<void> {
    const entry = this.installs.get(installId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;
    try {
      if (isCanceled()) {
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 1. Resolve the flavor's downloads.
      const resolver = this.resolvers[request.flavor];
      if (!resolver) throw new Error(`Unknown server type: ${request.flavor}`);
      const downloads = await resolver.resolveDownloads({
        version: request.version,
        loaderVersion: request.loaderVersion,
        includeFabricApi: request.includeFabricApi,
        paperBuild: request.paperBuild,
        forgeBuild: request.forgeBuild,
      });
      if (isCanceled()) {
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 2. Create the server folder.
      const serverFolder = this.createServerFolder(request.name, request.folderName);
      if (isCanceled()) {
        this.cleanupFolder(serverFolder);
        this.finish(installId, 'canceled', 'Installation canceled');
        return;
      }

      // 3. Download each artifact with progress.
      for (const download of downloads) {
        this.emit(installId, {
          status: 'downloading',
          percent: 0,
          message: `Downloading ${download.fileName}…`,
        });
        const dest = path.join(serverFolder, download.fileName);
        await this.downloadFile(download.url, dest, (percent) => {
          this.emit(installId, {
            status: 'downloading',
            percent,
            message: `Downloading ${download.fileName}…`,
          });
        }, isCanceled);
        if (isCanceled()) {
          this.cleanupFolder(serverFolder);
          this.finish(installId, 'canceled', 'Installation canceled');
          return;
        }
        // Verify SHA-1 when provided.
        if (download.sha1) {
          this.emit(installId, { status: 'verifying', percent: null, message: `Verifying ${download.fileName}…` });
          const sha1 = await sha1File(dest);
          if (sha1 !== download.sha1) {
            this.cleanupFolder(serverFolder);
            this.finish(installId, 'failed', 'Download checksum mismatch — file may be corrupt', 'checksum');
            return;
          }
        }
      }

      // 4. Flavor install step (e.g. Forge --installServer).
      if (resolver.installStep) {
        this.emit(installId, { status: 'installing', percent: null, message: 'Running server installer…' });
        await resolver.installStep({ version: request.version, serverFolder, loaderVersion: request.loaderVersion, forgeBuild: request.forgeBuild });
        if (isCanceled()) {
          this.cleanupFolder(serverFolder);
          this.finish(installId, 'canceled', 'Installation canceled');
          return;
        }
      }

      // 5. Write eula.txt + starter server.properties.
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
        serverType: request.flavor,
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

  private async runConvert(
    operationId: string,
    request: ConvertServerRequest,
    serverFolder: string,
  ): Promise<void> {
    const entry = this.installs.get(operationId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;
    try {
      const resolver = this.resolvers[request.flavor];
      if (!resolver) throw new Error(`Unknown server type: ${request.flavor}`);

      // Download the new flavor's artifacts into a temp dir, then swap in.
      const record = this.db.getServer(request.serverId);
      const mcVersion = record?.version ?? '';
      const tempDir = path.join(serverFolder, '.msc-convert');
      fs.mkdirSync(tempDir, { recursive: true });
      const downloads = await resolver.resolveDownloads({
        version: mcVersion,
        loaderVersion: request.loaderVersion,
        includeFabricApi: request.includeFabricApi,
        paperBuild: request.paperBuild,
        forgeBuild: request.forgeBuild,
      });

      const cleaned: string[] = [];
      for (const download of downloads) {
        this.emit(operationId, {
          status: 'downloading',
          percent: null,
          message: `Downloading ${download.fileName}…`,
        });
        const dest = path.join(tempDir, download.fileName);
        await this.downloadFile(download.url, dest, () => undefined, isCanceled);
        if (isCanceled()) {
          this.cleanupFolder(tempDir);
          this.finish(operationId, 'canceled', 'Conversion canceled');
          return;
        }
        cleaned.push(download.fileName);
      }

      // Move new artifacts into the server folder.
      for (const name of cleaned) {
        const target = path.join(serverFolder, name);
        fs.rmSync(target, { force: true });
        fs.renameSync(path.join(tempDir, name), target);
      }
      this.cleanupFolder(tempDir);

      // Run the flavor install step (e.g. Forge --installServer) in place.
      if (resolver.installStep) {
        this.emit(operationId, { status: 'installing', percent: null, message: 'Running server installer…' });
        await resolver.installStep({
          version: this.db.getServer(request.serverId)?.version ?? '',
          serverFolder,
          loaderVersion: request.loaderVersion,
          forgeBuild: request.forgeBuild,
        });
      }

      // Update the record to the new flavor.
      this.db.updateServer(request.serverId, { serverType: request.flavor });

      this.installs.delete(operationId);
      this.emit(operationId, {
        status: 'complete',
        percent: 100,
        message: 'Server type converted',
      });
    } catch (err) {
      this.installs.delete(operationId);
      this.emit(operationId, {
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

  private createServerFolder(name: string, folderName?: string): string {
    return createServerFolder(this.db, name, folderName);
  }

  private cleanupFolder(folder: string): void {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  /** Stream a file download with progress + cancellation. */
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
    try {
      for (;;) {
        if (isCanceled()) {
          file.destroy();
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
          await new Promise<void>((resolve) => file.once('drain', resolve));
        }
      }
    } finally {
      file.end();
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
export async function sha1File(filePath: string): Promise<string> {
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

/**
 * Create a new, unused server folder inside the configured library.
 * Exported so other installers (e.g. Bedrock) reuse the same dedupe logic.
 */
export function createServerFolder(
  db: { getSettings: () => { serverLibraryPath: string | null } },
  name: string,
  folderName?: string,
): string {
  const library = db.getSettings().serverLibraryPath;
  if (!library) throw new Error('No server library folder configured');
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

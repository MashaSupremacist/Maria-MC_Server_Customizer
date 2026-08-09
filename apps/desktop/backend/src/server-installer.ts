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
import { markOwnedServerFolder } from './path-policy';
import { VanillaResolver } from './resolvers/vanilla';
import { FabricResolver } from './resolvers/fabric';
import { ForgeResolver } from './resolvers/forge';
import { PaperResolver } from './resolvers/paper';
import type { FlavorResolver, ResolvedDownload } from './resolvers/types';
import { DownloadError, DownloadService } from './download-service';
import {
  FilesystemTransactionCanceledError,
  replaceDirectoryAtomically,
} from './fs-transaction';
import { findServerExecutable } from './process-manager';
import {
  ServerOperationConflictError,
  type ServerOperationCoordinator,
} from './server-operation-coordinator';

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
  coordinator?: ServerOperationCoordinator | null;
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
  private readonly coordinator: ServerOperationCoordinator | null;
  private readonly downloader: DownloadService;
  private runningServerId: (() => string | null) | null = null;
  private installs = new Map<string, {
    cancelRequested: boolean;
    abortController: AbortController;
    serverId?: string;
  }>();

  constructor(db: DatabaseResult, broadcast: WsBroadcast, options: ServerInstallerOptions = {}) {
    this.db = db;
    this.broadcast = broadcast;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.downloader = new DownloadService({ fetchImpl: this.fetchImpl });
    this.coordinator = options.coordinator ?? null;
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

  setRunningServerId(fn: () => string | null): void {
    this.runningServerId = fn;
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
    this.installs.set(installId, {
      cancelRequested: false,
      abortController: new AbortController(),
    });
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
    if (
      entry.serverId &&
      this.coordinator &&
      !this.coordinator.requestCancel(entry.serverId, installId)
    ) {
      return false;
    }
    entry.cancelRequested = true;
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

  /**
   * Download a loader's server jar into an existing server folder (used by
   * "create from pack" when a pack declares forge/fabric but ships no server
   * jar or installer). Downloads the flavor's artifacts, runs the install
   * step (Forge --installServer), and writes eula.txt.
   */
  async bootstrapServerJar(request: {
    flavor: ServerFlavor;
    version: string;
    serverFolder: string;
    javaPath?: string | null;
  }): Promise<void> {
    const resolver = this.resolvers[request.flavor];
    if (!resolver) throw new Error(`Unknown server type: ${request.flavor}`);
    if (!(await resolver.supports(request.version))) {
      throw new Error(`No ${request.flavor} server available for Minecraft ${request.version}`);
    }
    const downloads = await resolver.resolveDownloads({ version: request.version });
    for (const download of downloads) {
      const dest = path.join(request.serverFolder, download.fileName);
      await this.downloadArtifact(download, dest, () => undefined);
    }
    if (resolver.installStep) {
      await resolver.installStep({
        version: request.version,
        serverFolder: request.serverFolder,
        javaPath: request.javaPath ?? null,
      });
    }
    fs.writeFileSync(
      path.join(request.serverFolder, 'eula.txt'),
      `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toISOString()}\neula=true\n`,
    );
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
    if (this.runningServerId?.() === request.serverId) {
      return { operationId: '', error: 'Stop the server before converting it' };
    }

    const operationId = crypto.randomUUID();
    try {
      this.coordinator?.acquire(request.serverId, 'convert', operationId);
    } catch (error) {
      if (error instanceof ServerOperationConflictError) {
        return { operationId: '', error: error.message };
      }
      throw error;
    }
    this.installs.set(operationId, {
      cancelRequested: false,
      abortController: new AbortController(),
      serverId: request.serverId,
    });
    void this.runConvert(operationId, request, record.folderPath).catch((err: unknown) => {
      this.emit(operationId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        errorCode: 'network',
      });
      this.installs.delete(operationId);
    }).finally(() => {
      this.coordinator?.release(request.serverId, operationId);
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
    const reservation = reserveServerFolder(this.db, request.name, request.folderName);
    let committed = false;
    try {
      throwIfInstallCanceled(entry?.abortController.signal);

      // 1. Resolve the flavor's downloads.
      const resolver = this.resolvers[request.flavor];
      if (!resolver) throw new Error(`Unknown server type: ${request.flavor}`);
      const downloads = await resolver.resolveDownloads({
        version: request.version,
        loaderVersion: request.loaderVersion,
        includeFabricApi: request.includeFabricApi,
        paperBuild: request.paperBuild,
        forgeBuild: request.forgeBuild,
        signal: entry?.abortController.signal,
      });
      throwIfInstallCanceled(entry?.abortController.signal);

      // 2–5. Build and validate the complete server beside its final path.
      await replaceDirectoryAtomically(
        reservation.folder,
        async (stagingFolder) => {
          for (const download of downloads) {
            this.emit(installId, {
              status: 'downloading',
              percent: 0,
              message: `Downloading ${download.fileName}…`,
            });
            const dest = path.join(stagingFolder, download.fileName);
            await this.downloadArtifact(download, dest, (percent) => {
              this.emit(installId, {
                status: 'downloading',
                percent,
                message: `Downloading ${download.fileName}…`,
              });
            }, entry?.abortController.signal);
            throwIfInstallCanceled(entry?.abortController.signal);
            if (download.digest) {
              this.emit(installId, {
                status: 'verifying',
                percent: null,
                message: `Verified ${download.fileName}`,
              });
            }
          }

          if (resolver.installStep) {
            this.emit(installId, {
              status: 'installing',
              percent: null,
              message: 'Running server installer…',
            });
            await resolver.installStep({
              version: request.version,
              serverFolder: stagingFolder,
              loaderVersion: request.loaderVersion,
              forgeBuild: request.forgeBuild,
              javaPath: request.javaPath ?? null,
              signal: entry?.abortController.signal,
            });
            throwIfInstallCanceled(entry?.abortController.signal);
          }

          this.emit(installId, {
            status: 'writing-config',
            percent: null,
            message: 'Writing configuration…',
          });
          fs.writeFileSync(
            path.join(stagingFolder, 'eula.txt'),
            `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toISOString()}\neula=true\n`,
          );
          writeServerProperties(path.join(stagingFolder, 'server.properties'), {
            port: request.port ?? DEFAULT_PORT,
            levelName: 'world',
            motd: 'A Minecraft Server',
            maxPlayers: 20,
          });
        },
        (stagingFolder) => validateJavaServerInstall(
          stagingFolder,
          request.flavor,
          request.port ?? DEFAULT_PORT,
        ),
        { signal: entry?.abortController.signal },
      );
      committed = true;
      throwIfInstallCanceled(entry?.abortController.signal);

      // The marker describes the final canonical path, so write it only after rename.
      markOwnedServerFolder(reservation.folder, reservation.library);

      // 6. Register only after the fully validated folder has committed. If the
      // database transaction fails, the newly committed folder is removed.
      const record = this.db.createServer({
        name: request.name,
        edition: 'java',
        serverType: request.flavor,
        folderPath: reservation.folder,
        javaPath: request.javaPath ?? null,
        memoryMb: request.memoryMb ?? DEFAULT_MEMORY_MB,
        port: request.port ?? DEFAULT_PORT,
        version: request.version,
        jvmArgs: [],
      });
      committed = false;

      this.installs.delete(installId);
      this.emit(installId, {
        status: 'complete',
        percent: 100,
        message: 'Installation complete',
        serverId: record.id,
      });
    } catch (err) {
      if (committed) this.cleanupFolder(reservation.folder);
      this.installs.delete(installId);
      if (
        isCanceled() ||
        err instanceof FilesystemTransactionCanceledError ||
        (err instanceof DownloadError && err.code === 'cancelled') ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        this.emit(installId, { status: 'canceled', percent: null, message: 'Installation canceled' });
        return;
      }
      this.emit(installId, {
        status: 'failed',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof DownloadError && err.code === 'checksum' ? 'checksum' : 'network',
      });
    } finally {
      reservation.release();
    }
  }

  private async runConvert(
    operationId: string,
    request: ConvertServerRequest,
    serverFolder: string,
  ): Promise<void> {
    const entry = this.installs.get(operationId);
    const isCanceled = (): boolean => entry?.cancelRequested ?? false;
    const tempDir = path.join(serverFolder, '.msc-convert');
    let movedJars: string[] = [];
    try {
      const resolver = this.resolvers[request.flavor];
      if (!resolver) throw new Error(`Unknown server type: ${request.flavor}`);

      // Download the new flavor's artifacts into a temp dir, then swap in.
      const record = this.db.getServer(request.serverId);
      const mcVersion = record?.version ?? '';
      const javaPath = record?.javaPath ?? null;
      fs.mkdirSync(tempDir, { recursive: true });
      const downloads = await resolver.resolveDownloads({
        version: mcVersion,
        loaderVersion: request.loaderVersion,
        includeFabricApi: request.includeFabricApi,
        paperBuild: request.paperBuild,
        forgeBuild: request.forgeBuild,
        signal: entry?.abortController.signal,
      });

      const cleaned: string[] = [];
      for (const download of downloads) {
        this.emit(operationId, {
          status: 'downloading',
          percent: null,
          message: `Downloading ${download.fileName}…`,
        });
        const dest = path.join(tempDir, download.fileName);
        await this.downloadArtifact(
          download,
          dest,
          () => undefined,
          entry?.abortController.signal,
        );
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
        movedJars.push(name);
      }
      this.cleanupFolder(tempDir);

      // Run the flavor install step (e.g. Forge --installServer) in place.
      if (resolver.installStep) {
        this.emit(operationId, { status: 'installing', percent: null, message: 'Running server installer…' });
        await resolver.installStep({
          version: mcVersion,
          serverFolder,
          loaderVersion: request.loaderVersion,
          forgeBuild: request.forgeBuild,
          javaPath,
          signal: entry?.abortController.signal,
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
      // Roll back the swapped-in jars so the server is not left in a broken
      // half-converted state, and drop the temp dir.
      this.cleanupFolder(tempDir);
      for (const name of movedJars) {
        try {
          fs.rmSync(path.join(serverFolder, name), { force: true });
        } catch {
          // best effort
        }
      }
      this.installs.delete(operationId);
      if (err instanceof DownloadError && err.code === 'cancelled') {
        this.emit(operationId, {
          status: 'canceled',
          percent: null,
          message: 'Conversion canceled',
        });
        return;
      }
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

  private cleanupFolder(folder: string): void {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  /** Download and verify a resolved artifact through the common bounded path. */
  private async downloadArtifact(
    download: ResolvedDownload,
    dest: string,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.downloader.download({
      url: download.url,
      destination: dest,
      expectedBytes: download.sizeBytes,
      expectedDigest: download.digest ?? (download.sha1
        ? { algorithm: 'sha1', value: download.sha1 }
        : undefined),
      signal,
      onProgress: ({ percent }) => {
        if (percent !== null) onProgress(percent);
      },
    });
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

const reservedServerFolders = new Set<string>();

export interface ServerFolderReservation {
  folder: string;
  library: string;
  release: () => void;
}

/** Reserve a unique final path without exposing a partial server directory. */
export function reserveServerFolder(
  db: { getSettings: () => { serverLibraryPath: string | null } },
  name: string,
  folderName?: string,
): ServerFolderReservation {
  const configuredLibrary = db.getSettings().serverLibraryPath;
  if (!configuredLibrary) throw new Error('No server library folder configured');
  const library = path.resolve(configuredLibrary);
  fs.mkdirSync(library, { recursive: true });
  const slug = sanitizeFolderName(folderName || name);
  let suffix = 1;
  for (;;) {
    const folder = path.join(library, suffix === 1 ? slug : `${slug}-${suffix}`);
    const key = path.resolve(folder).toLowerCase();
    if (!fs.existsSync(folder) && !reservedServerFolders.has(key)) {
      reservedServerFolders.add(key);
      let released = false;
      return {
        folder,
        library,
        release: () => {
          if (released) return;
          released = true;
          reservedServerFolders.delete(key);
        },
      };
    }
    suffix += 1;
  }
}

function throwIfInstallCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Installation canceled', 'AbortError');
}

function validateJavaServerInstall(
  folder: string,
  flavor: ServerFlavor,
  expectedPort: number,
): void {
  if (!findServerExecutable(folder, 'java', flavor)) {
    throw new Error(`Installed ${flavor} server has no runnable launch target`);
  }
  validateStarterConfiguration(folder, expectedPort, false);
}

export function validateStarterConfiguration(
  folder: string,
  expectedPort: number,
  bedrock: boolean,
): void {
  const eula = readConfig(path.join(folder, 'eula.txt'));
  if (eula.eula?.toLowerCase() !== 'true') {
    throw new Error('Installed server has no accepted EULA configuration');
  }
  const properties = readConfig(path.join(folder, 'server.properties'));
  if (properties['server-port'] !== String(expectedPort)) {
    throw new Error('Installed server has an invalid starter port configuration');
  }
  if (bedrock) {
    for (const name of ['allowlist.json', 'permissions.json']) {
      const value = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error(`Installed server has invalid ${name}`);
    }
  }
}

function readConfig(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return result;
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
  const reservation = reserveServerFolder(db, name, folderName);
  try {
    fs.mkdirSync(reservation.folder, { recursive: false });
    markOwnedServerFolder(reservation.folder, reservation.library);
    return reservation.folder;
  } finally {
    reservation.release();
  }
}

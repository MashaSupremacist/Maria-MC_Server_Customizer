import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BedrockVersion,
  InstallBedrockRequest,
  InstallProgress,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { reserveServerFolder, validateStarterConfiguration } from './server-installer';
import { DownloadError, DownloadService } from './download-service';
import {
  FilesystemTransactionCanceledError,
  replaceDirectoryAtomically,
} from './fs-transaction';
import { findServerExecutable } from './process-manager';
import { markOwnedServerFolder } from './path-policy';
import { safeJoin, walkZip, writeEntryStream } from './zip-utils';
import { fetchMetadataJson } from './metadata-fetch';

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
  metadataTimeoutMs?: number;
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
  private readonly downloader: DownloadService;
  private readonly metadataTimeoutMs: number;
  private installs = new Map<string, {
    cancelRequested: boolean;
    abortController: AbortController;
  }>();

  constructor(db: DatabaseResult, broadcast: WsBroadcast, options: BedrockInstallerOptions = {}) {
    this.db = db;
    this.broadcast = broadcast;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.downloader = new DownloadService({ fetchImpl: this.fetchImpl });
    this.registryBaseUrl = options.registryBaseUrl ?? REGISTRY_BASE;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
  }

  /** Fetch the Bedrock version list: releases first (newest), then previews. */
  async listVersions(): Promise<BedrockVersion[]> {
    const res = await fetchMetadataJson<RegistryVersions>(`${this.registryBaseUrl}/versions.json`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.metadataTimeoutMs,
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch Bedrock versions (${res.status})`);
    }
    const registry = res.value;
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
    const reservation = reserveServerFolder(this.db, request.name, request.folderName);
    let committed = false;
    try {
      throwIfCanceled(entry?.abortController.signal);

      // 1. Resolve the version's Windows binary (url + sha256).
      const download = await this.resolveWindowsBinary(
        request.version,
        entry?.abortController.signal,
      );
      throwIfCanceled(entry?.abortController.signal);

      // 2–6. Build and validate entirely in a sibling staging directory.
      await replaceDirectoryAtomically(
        reservation.folder,
        async (stagingFolder) => {
          this.emit(installId, {
            status: 'downloading',
            percent: 0,
            message: `Downloading ${path.basename(download.url)}…`,
          });
          const zipPath = path.join(stagingFolder, 'bedrock-server.zip');
          await this.downloader.download({
            url: download.url,
            destination: zipPath,
            expectedDigest: { algorithm: 'sha256', value: download.sha256 },
            signal: entry?.abortController.signal,
            onProgress: ({ percent }) => {
              this.emit(installId, {
                status: 'downloading',
                percent,
                message: 'Downloading Bedrock server…',
              });
            },
          });
          throwIfCanceled(entry?.abortController.signal);

          this.emit(installId, {
            status: 'verifying',
            percent: null,
            message: 'Download verified',
          });
          this.emit(installId, {
            status: 'installing',
            percent: null,
            message: 'Extracting server files…',
          });
          await this.extractZip(zipPath, stagingFolder, entry?.abortController.signal, (percent) => {
            this.emit(installId, {
              status: 'installing',
              percent,
              message: 'Extracting server files…',
            });
          });
          await fs.promises.rm(zipPath, { force: true });
          throwIfCanceled(entry?.abortController.signal);

          this.emit(installId, {
            status: 'writing-config',
            percent: null,
            message: 'Writing configuration…',
          });
          writeBedrockServerProperties(path.join(stagingFolder, 'server.properties'), {
            port: request.port ?? DEFAULT_PORT,
          });
          fs.writeFileSync(path.join(stagingFolder, 'allowlist.json'), '[]\n', 'utf8');
          fs.writeFileSync(path.join(stagingFolder, 'permissions.json'), '[]\n', 'utf8');
          fs.writeFileSync(
            path.join(stagingFolder, 'eula.txt'),
            `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toISOString()}\neula=true\n`,
          );
        },
        (stagingFolder) => {
          if (!findServerExecutable(stagingFolder, 'bedrock')) {
            throw new Error('Installed Bedrock server has no runnable launch target');
          }
          validateStarterConfiguration(stagingFolder, request.port ?? DEFAULT_PORT, true);
        },
        { signal: entry?.abortController.signal },
      );
      committed = true;
      throwIfCanceled(entry?.abortController.signal);
      markOwnedServerFolder(reservation.folder, reservation.library);

      // 7. Register only after commit. Registration failure removes the new
      // folder so the filesystem and database cannot disagree.
      const record = this.db.createServer({
        name: request.name,
        edition: 'bedrock',
        serverType: 'bedrock',
        folderPath: reservation.folder,
        javaPath: null,
        memoryMb: 1024,
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
    signal?: AbortSignal,
  ): Promise<{ url: string; sha256: string }> {
    const response = await fetchMetadataJson<RegistryMetadata>(
      `${this.registryBaseUrl}/release/${version}/metadata.json`,
      { fetchImpl: this.fetchImpl, signal, timeoutMs: this.metadataTimeoutMs },
    );
    if (!response.ok) throw new Error(`Unknown Bedrock version: ${version}`);
    const metadata = response.value;
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

  /** Extract through the shared bounded, traversal-safe ZIP implementation. */
  private async extractZip(
    zipPath: string,
    destFolder: string,
    signal: AbortSignal | undefined,
    onProgress: (percent: number) => void,
  ): Promise<void> {
    const totalBytes = fs.statSync(zipPath).size;
    let processed = 0;
    await walkZip(zipPath, async (entry, stream) => {
      const target = safeJoin(destFolder, entry.fileName);
      if (!target) {
        stream.destroy();
        throw new Error(`Unsafe path in archive: ${entry.fileName}`);
      }
      processed += entry.compressedSize;
      onProgress(Math.min(99, Math.round((processed / Math.max(1, totalBytes)) * 100)));
      await writeEntryStream(stream, target, signal);
    }, { signal });
  }
}

function throwIfCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Installation canceled', 'AbortError');
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

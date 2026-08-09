import type { FlavorResolver, ResolvedDownload } from './types';
import { fetchMetadataJson } from '../metadata-fetch';

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions';
const MODRINTH_FABRIC_API = 'https://api.modrinth.com/v2/project/fabric-api/version';

interface LoaderEntry {
  version: string;
  stable: boolean;
}

interface GameEntry {
  version: string;
  stable: boolean;
}

/** Resolver for Fabric servers: loader selection + optional Fabric API. */
export class FabricResolver implements FlavorResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly metaUrl: string;
  private readonly modrinthUrl: string;
  private readonly metadataTimeoutMs: number;

  constructor(options: {
    fetchImpl?: typeof fetch;
    metaUrl?: string;
    modrinthUrl?: string;
    metadataTimeoutMs?: number;
  } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.metaUrl = options.metaUrl ?? FABRIC_META;
    this.modrinthUrl = options.modrinthUrl ?? MODRINTH_FABRIC_API;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
  }

  /** Supported Minecraft versions (stable first). */
  async listGameVersions(): Promise<string[]> {
    const res = await fetchMetadataJson<GameEntry[]>(`${this.metaUrl}/game`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.metadataTimeoutMs,
    });
    if (!res.ok) throw new Error(`Failed to fetch Fabric game versions (${res.status})`);
    const list = res.value;
    return list.map((g) => g.version);
  }

  /** Available Fabric loader versions, newest first. */
  async listLoaderVersions(gameVersion: string, signal?: AbortSignal): Promise<string[]> {
    const res = await fetchMetadataJson<LoaderEntry[]>(`${this.metaUrl}/loader/${gameVersion}`, {
      fetchImpl: this.fetchImpl,
      signal,
      timeoutMs: this.metadataTimeoutMs,
    });
    if (!res.ok) throw new Error(`Failed to fetch Fabric loader versions (${res.status})`);
    const list = res.value;
    return list.map((l) => l.version);
  }
  async supports(version: string): Promise<boolean> {
    const games = await this.listGameVersions();
    return games.includes(version);
  }

  async resolveDownloads(request: {
    version: string;
    loaderVersion?: string;
    includeFabricApi?: boolean;
    signal?: AbortSignal;
  }): Promise<ResolvedDownload[]> {
    const loaders = await this.listLoaderVersions(request.version, request.signal);
    const loader = request.loaderVersion ?? loaders[0];
    if (!loader) {
      throw new Error(`No Fabric loader available for Minecraft ${request.version}`);
    }
    const downloads: ResolvedDownload[] = [
      {
        url: `${this.metaUrl}/loader/${request.version}/${loader}/server/jar`,
        fileName: 'fabric-server-launch.jar',
      },
    ];
    if (request.includeFabricApi) {
      const api = await this.resolveFabricApi(request.version, request.signal);
      if (api) downloads.push(api);
    }
    return downloads;
  }

  /** The most recent Fabric API build compatible with the game version. */
  private async resolveFabricApi(
    gameVersion: string,
    signal?: AbortSignal,
  ): Promise<ResolvedDownload | null> {
    try {
      const res = await fetchMetadataJson<Array<{
        files: Array<{
          url: string;
          primary?: boolean;
          filename?: string;
          size?: number;
          hashes?: { sha512?: string; sha1?: string };
        }>;
      }>>(
        `${this.modrinthUrl}?game_versions=["${gameVersion}"]&loaders=["fabric"]`,
        { fetchImpl: this.fetchImpl, signal, timeoutMs: this.metadataTimeoutMs },
      );
      if (!res.ok) return null;
      const versions = res.value;
      const latest = versions[0];
      const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0];
      if (!file) return null;
      const digest = file.hashes?.sha512
        ? { algorithm: 'sha512' as const, value: file.hashes.sha512 }
        : file.hashes?.sha1
          ? { algorithm: 'sha1' as const, value: file.hashes.sha1 }
          : undefined;
      return {
        url: file.url,
        fileName: 'fabric-api.jar',
        digest,
        sizeBytes: file.size,
        sha1: file.hashes?.sha1,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return null; // Fabric API is optional; never fail the install over it
    }
  }
}

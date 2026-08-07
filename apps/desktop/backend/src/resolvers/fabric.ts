import type { FlavorResolver, ResolvedDownload } from './types';

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

  constructor(options: {
    fetchImpl?: typeof fetch;
    metaUrl?: string;
    modrinthUrl?: string;
  } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.metaUrl = options.metaUrl ?? FABRIC_META;
    this.modrinthUrl = options.modrinthUrl ?? MODRINTH_FABRIC_API;
  }

  /** Supported Minecraft versions (stable first). */
  async listGameVersions(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.metaUrl}/game`);
    if (!res.ok) throw new Error(`Failed to fetch Fabric game versions (${res.status})`);
    const list = (await res.json()) as GameEntry[];
    return list.map((g) => g.version);
  }

  /** Available Fabric loader versions, newest first. */
  async listLoaderVersions(gameVersion: string): Promise<string[]> {
    const res = await this.fetchImpl(`${this.metaUrl}/loader/${gameVersion}`);
    if (!res.ok) throw new Error(`Failed to fetch Fabric loader versions (${res.status})`);
    const list = (await res.json()) as LoaderEntry[];
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
  }): Promise<ResolvedDownload[]> {
    const loaders = await this.listLoaderVersions(request.version);
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
      const api = await this.resolveFabricApi(request.version);
      if (api) downloads.push(api);
    }
    return downloads;
  }

  /** The most recent Fabric API build compatible with the game version. */
  private async resolveFabricApi(gameVersion: string): Promise<ResolvedDownload | null> {
    try {
      const res = await this.fetchImpl(
        `${this.modrinthUrl}?game_versions=["${gameVersion}"]&loaders=["fabric"]`,
      );
      if (!res.ok) return null;
      const versions = (await res.json()) as Array<{
        files: Array<{ url: string; primary?: boolean; filename?: string }>;
      }>;
      const latest = versions[0];
      const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0];
      if (!file) return null;
      return { url: file.url, fileName: 'fabric-api.jar' };
    } catch {
      return null; // Fabric API is optional; never fail the install over it
    }
  }
}

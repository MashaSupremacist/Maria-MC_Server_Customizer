import type { FlavorResolver, ResolvedDownload } from './types';
import { fetchMetadataJson } from '../metadata-fetch';

const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';

interface ProjectResponse {
  versions: Record<string, string[]>;
}

interface BuildsResponse {
  builds: number[];
}

interface BuildResponse {
  downloads: {
    'server:default'?: {
      name: string;
      size: number;
      checksums: { sha256?: string };
      url: string;
    };
  };
}

/**
 * Resolver for Paper servers. Paper publishes a single server jar per
 * version/build; the latest stable build is used unless overridden.
 * Uses the current v3 API (the v2 API was sunset; fill.papermc.io is the
 * canonical replacement).
 */
export class PaperResolver implements FlavorResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly metadataTimeoutMs: number;

  constructor(options: {
    fetchImpl?: typeof fetch;
    apiUrl?: string;
    metadataTimeoutMs?: number;
  } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? PAPER_API;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
  }

  /** Minecraft versions with Paper builds, newest first. */
  async listVersions(): Promise<string[]> {
    const res = await fetchMetadataJson<ProjectResponse>(this.apiUrl, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.metadataTimeoutMs,
    });
    if (!res.ok) throw new Error(`Failed to fetch Paper versions (${res.status})`);
    const data = res.value;
    return Object.keys(data.versions).sort(compareVersions).reverse();
  }

  /** Build numbers for a version, newest first. */
  async listBuilds(version: string, signal?: AbortSignal): Promise<number[]> {
    const res = await fetchMetadataJson<BuildsResponse>(`${this.apiUrl}/versions/${version}`, {
      fetchImpl: this.fetchImpl,
      signal,
      timeoutMs: this.metadataTimeoutMs,
    });
    if (!res.ok) throw new Error(`Failed to fetch Paper builds for ${version} (${res.status})`);
    const data = res.value;
    return [...data.builds].reverse();
  }

  async supports(version: string): Promise<boolean> {
    const versions = await this.listVersions();
    return versions.includes(version);
  }

  async resolveDownloads(request: {
    version: string;
    paperBuild?: string;
    signal?: AbortSignal;
  }): Promise<ResolvedDownload[]> {
    const builds = await this.listBuilds(request.version, request.signal);
    if (builds.length === 0) {
      throw new Error(`No Paper build available for Minecraft ${request.version}`);
    }
    const build = request.paperBuild ? parseInt(request.paperBuild, 10) : builds[0];
    if (!builds.includes(build)) {
      throw new Error(`Paper build ${build} not found for Minecraft ${request.version}`);
    }
    const res = await fetchMetadataJson<BuildResponse>(
      `${this.apiUrl}/versions/${request.version}/builds/${build}`,
      {
        fetchImpl: this.fetchImpl,
        signal: request.signal,
        timeoutMs: this.metadataTimeoutMs,
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch Paper build ${build} (${res.status})`);
    }
    const data = res.value;
    const app = data.downloads?.['server:default'];
    if (!app) {
      throw new Error(`Paper build ${build} has no server download`);
    }
    return [{
      url: app.url,
      digest: app.checksums.sha256
        ? { algorithm: 'sha256', value: app.checksums.sha256 }
        : undefined,
      sizeBytes: app.size,
      fileName: `paper-${request.version}-${build}.jar`,
    }];
  }
}

/** Compare MC version strings numerically by dotted segment (e.g. 1.21.1 > 1.21). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

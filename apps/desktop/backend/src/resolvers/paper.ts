import type { FlavorResolver, ResolvedDownload } from './types';

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

  constructor(options: { fetchImpl?: typeof fetch; apiUrl?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? PAPER_API;
  }

  /** Minecraft versions with Paper builds, newest first. */
  async listVersions(): Promise<string[]> {
    const res = await this.fetchImpl(this.apiUrl);
    if (!res.ok) throw new Error(`Failed to fetch Paper versions (${res.status})`);
    const data = (await res.json()) as ProjectResponse;
    return Object.keys(data.versions).sort(compareVersions).reverse();
  }

  /** Build numbers for a version, newest first. */
  async listBuilds(version: string): Promise<number[]> {
    const res = await this.fetchImpl(`${this.apiUrl}/versions/${version}`);
    if (!res.ok) throw new Error(`Failed to fetch Paper builds for ${version} (${res.status})`);
    const data = (await res.json()) as BuildsResponse;
    return [...data.builds].reverse();
  }

  async supports(version: string): Promise<boolean> {
    const versions = await this.listVersions();
    return versions.includes(version);
  }

  async resolveDownloads(request: {
    version: string;
    paperBuild?: string;
  }): Promise<ResolvedDownload[]> {
    const builds = await this.listBuilds(request.version);
    if (builds.length === 0) {
      throw new Error(`No Paper build available for Minecraft ${request.version}`);
    }
    const build = request.paperBuild ? parseInt(request.paperBuild, 10) : builds[0];
    if (!builds.includes(build)) {
      throw new Error(`Paper build ${build} not found for Minecraft ${request.version}`);
    }
    const res = await this.fetchImpl(
      `${this.apiUrl}/versions/${request.version}/builds/${build}`,
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch Paper build ${build} (${res.status})`);
    }
    const data = (await res.json()) as BuildResponse;
    const app = data.downloads?.['server:default'];
    if (!app) {
      throw new Error(`Paper build ${build} has no server download`);
    }
    return [{
      url: app.url,
      sha1: undefined,
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

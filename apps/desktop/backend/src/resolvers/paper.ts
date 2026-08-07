import type { FlavorResolver, ResolvedDownload } from './types';

const PAPER_API = 'https://papermc.io/api/v2/projects/paper';

interface ProjectResponse {
  versions: string[];
}

interface BuildsResponse {
  builds: number[];
}

interface BuildResponse {
  downloads: {
    application: { name: string; sha256: string };
  };
}

/**
 * Resolver for Paper servers. Paper publishes a single server jar per
 * version/build; the latest stable build is used unless overridden.
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
    return [...data.versions].reverse();
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
    const app = data.downloads?.application;
    if (!app) {
      throw new Error(`Paper build ${build} has no application download`);
    }
    return [{ url: `${this.apiUrl}/versions/${request.version}/builds/${build}/downloads/${app.name}`, sha1: undefined, fileName: `paper-${request.version}-${build}.jar` }];
  }
}

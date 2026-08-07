import type { VanillaVersion } from '@msc/shared-types';
import type { FlavorResolver, ResolvedDownload } from './types';

const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: Array<{ id: string; type: string; url: string; releaseTime: string }>;
}

interface VersionJson {
  downloads: {
    server?: { url: string; sha1: string; size: number };
  };
}

/** Resolver for the official Mojang (Vanilla) server jar. */
export class VanillaResolver implements FlavorResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly manifestUrl: string;

  constructor(options: { fetchImpl?: typeof fetch; manifestUrl?: string } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.manifestUrl = options.manifestUrl ?? MOJANG_MANIFEST_URL;
  }

  /** The official version list, newest first, releases first. */
  async listVersions(): Promise<VanillaVersion[]> {
    const res = await this.fetchImpl(this.manifestUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch Minecraft versions (${res.status})`);
    }
    const manifest = (await res.json()) as VersionManifest;
    const map = new Map<string, VersionManifest['versions'][number]>();
    for (const v of manifest.versions) {
      if (!map.has(v.id)) map.set(v.id, v);
    }
    const sorted = [...map.values()].sort((a, b) =>
      b.releaseTime.localeCompare(a.releaseTime),
    );
    const rank = (type: string): number => (type === 'release' ? 0 : 1);
    sorted.sort((a, b) => rank(a.type) - rank(b.type) || b.releaseTime.localeCompare(a.releaseTime));
    return sorted.map((v) => ({
      id: v.id,
      type: v.type as VanillaVersion['type'],
      releaseTime: v.releaseTime,
    }));
  }

  async supports(version: string): Promise<boolean> {
    try {
      await this.resolveDownloads({ version });
      return true;
    } catch {
      return false;
    }
  }

  async resolveDownloads(request: { version: string }): Promise<ResolvedDownload[]> {
    const manifest = (await (
      await this.fetchImpl(this.manifestUrl)
    ).json()) as VersionManifest;
    const entry = manifest.versions.find((v) => v.id === request.version);
    if (!entry) {
      throw new Error(`Unknown Minecraft version: ${request.version}`);
    }
    const versionJson = (await (
      await this.fetchImpl(entry.url)
    ).json()) as VersionJson;
    const server = versionJson.downloads?.server;
    if (!server) {
      throw new Error(`Version ${request.version} has no official server download`);
    }
    return [{ url: server.url, sha1: server.sha1, fileName: 'server.jar' }];
  }
}

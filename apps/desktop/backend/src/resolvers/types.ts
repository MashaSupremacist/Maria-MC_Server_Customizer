import type { ServerFlavor } from '@msc/shared-types';

/** A resolved server download: where to fetch the JAR and its SHA-1. */
export interface ResolvedDownload {
  url: string;
  sha1?: string;
  /** Local file name inside the server folder (defaults to url basename). */
  fileName: string;
}

/**
 * A flavor resolver supplies the concrete downloads + install steps for a
 * Minecraft version. The generic installer drives the pipeline; resolvers are
 * thin adapters over each project's API.
 */
export interface FlavorResolver {
  /** Whether this resolver can produce a server for `version`. */
  supports(version: string): Promise<boolean>;
  /** Downloads needed to bootstrap the server (jar + any extras). */
  resolveDownloads(request: {
    version: string;
    loaderVersion?: string;
    includeFabricApi?: boolean;
    paperBuild?: string;
    forgeBuild?: string;
  }): Promise<ResolvedDownload[]>;
  /** Extra flavor-specific post-download steps (e.g. Forge --installServer). */
  installStep?(request: {
    version: string;
    serverFolder: string;
    loaderVersion?: string;
    forgeBuild?: string;
    /** A configured java.exe to use (falls back to JAVA_HOME / PATH). */
    javaPath?: string | null;
  }): Promise<void>;
}

export type { ServerFlavor };

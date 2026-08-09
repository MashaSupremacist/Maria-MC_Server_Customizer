import type { ServerFlavor } from '@msc/shared-types';
import type { DownloadDigest } from '../download-service';

/** A resolved server artifact with any upstream integrity metadata. */
export interface ResolvedDownload {
  url: string;
  /** Preferred algorithm-tagged upstream digest, when published. */
  digest?: DownloadDigest;
  /** Legacy SHA-1 field retained until all installer callers use `digest`. */
  sha1?: string;
  /** Exact artifact size declared by the upstream metadata. */
  sizeBytes?: number;
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
    signal?: AbortSignal;
  }): Promise<ResolvedDownload[]>;
  /** Extra flavor-specific post-download steps (e.g. Forge --installServer). */
  installStep?(request: {
    version: string;
    serverFolder: string;
    loaderVersion?: string;
    forgeBuild?: string;
    /** A configured java.exe to use (falls back to JAVA_HOME / PATH). */
    javaPath?: string | null;
    signal?: AbortSignal;
  }): Promise<void>;
}

export type { ServerFlavor };

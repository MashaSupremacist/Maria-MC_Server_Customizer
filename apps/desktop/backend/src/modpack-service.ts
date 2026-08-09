import fs from 'node:fs';
import path from 'node:path';
import type {
  ModpackImportResult,
  ServerRecord,
  ServerFlavor,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { DownloadService, type DownloadDigest, type DownloadRequest } from './download-service';
import { replaceDirectoryAtomically } from './fs-transaction';
import { requireServerEdition } from './server-edition';
import {
  ServerOperationConflictError,
  type ServerOperationCoordinator,
} from './server-operation-coordinator';
import {
  listZipEntries,
  PACK_EXTENSIONS,
  readZipEntryText,
  safeJoin,
  shouldSkip,
  walkZip,
  writeEntryStream,
} from './zip-utils';

export type WsBroadcast = (event: WsServerEvent) => void;

interface ModrinthIndex {
  game?: string;
  dependencies?: Record<string, string>;
  overrides?: string[];
  files?: ModrinthFile[];
}

interface ModrinthFile {
  path?: string;
  hashes?: { sha1?: string; sha512?: string };
  env?: {
    client?: 'required' | 'optional' | 'unsupported';
    server?: 'required' | 'optional' | 'unsupported';
  };
  downloads?: string[];
  fileSize?: number;
}

interface CurseforgeManifest {
  minecraft?: { version?: string; modLoaders?: Array<{ id?: string; primary?: boolean }> };
  files?: unknown[];
  overrides?: string;
}

interface PackInfo {
  kind: 'mrpack' | 'embedded-zip' | 'curseforge';
  /** Declared loader from the pack, if any (e.g. "fabric", "forge"). */
  loader?: string;
  /** Declared Minecraft version from the pack, if any. */
  mcVersion?: string;
  modrinthIndex?: ModrinthIndex;
  curseforgeFileCount?: number;
}

export interface ModpackImportOptions {
  signal?: AbortSignal;
}

export interface ModpackServiceOptions {
  downloadService?: Pick<DownloadService, 'download'>;
  maxConcurrentDownloads?: number;
}

interface ImportCounts {
  modsAdded: number;
  filesCopied: number;
  skipped: number;
  downloaded: number;
  rejected: number;
}

const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
const MAX_MODPACK_FILE_BYTES = 512 * 1024 * 1024;

/**
 * Imports a modpack (.mrpack / .zip) onto an existing Fabric/Forge server:
 * validates loader + MC version, extracts mod JARs into mods/ and other
 * files into the server folder, streaming progress over the WebSocket.
 */
export class ModpackService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly coordinator: ServerOperationCoordinator | null;
  private readonly downloadService: Pick<DownloadService, 'download'>;
  private readonly maxConcurrentDownloads: number;
  private runningServerId: (() => string | null) | null = null;

  constructor(
    db: DatabaseResult,
    broadcast: WsBroadcast,
    coordinator: ServerOperationCoordinator | null = null,
    options: ModpackServiceOptions = {},
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.coordinator = coordinator;
    this.downloadService = options.downloadService ?? new DownloadService();
    this.maxConcurrentDownloads = Math.max(
      1,
      Math.floor(options.maxConcurrentDownloads ?? DEFAULT_DOWNLOAD_CONCURRENCY),
    );
  }

  setRunningServerId(fn: () => string | null): void {
    this.runningServerId = fn;
  }

  private emit(message: string): void {
    this.broadcast({
      type: 'install:progress',
      installId: 'modpack-import',
      progress: { status: 'installing', percent: null, message },
    } satisfies WsServerEvent);
  }

  /** Import a pack file onto a server. Returns a summary of what happened. */
  async import(
    serverId: string,
    filePath: string,
    force = false,
    options: ModpackImportOptions = {},
  ): Promise<ModpackImportResult> {
    let record: ServerRecord;
    const counts = emptyCounts();
    try {
      record = requireServerEdition(this.db, serverId, 'java');
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
    if (!fs.existsSync(record.folderPath)) {
      return this.fail(`Server folder not found: ${record.folderPath}`);
    }
    if (this.runningServerId?.() === serverId) {
      return this.fail('Stop the server before importing a modpack');
    }
    let operationId: string | null = null;
    try {
      const operation = this.coordinator?.acquire(serverId, 'modpack-import');
      operationId = operation?.operationId ?? null;
    } catch (error) {
      if (error instanceof ServerOperationConflictError) return this.fail(error.message);
      throw error;
    }

    try {
      const flavor = record.serverType as ServerFlavor;
      if (flavor !== 'fabric' && flavor !== 'forge') {
        return this.fail(
          `Modpacks require a Fabric or Forge server. This server is ${flavor}. Convert it first.`,
        );
      }

      if (!filePath || !fs.existsSync(filePath)) {
        return this.fail('Pack file not found. Select the .mrpack/.zip you downloaded.');
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!PACK_EXTENSIONS.has(ext)) {
        return this.fail(`Unsupported file type: ${ext}. Use a .mrpack or .zip.`);
      }

      this.throwIfCanceled(options.signal);
      this.emit('Opening pack…');
      const info = await this.inspectPack(filePath);
      if (!info) {
        return this.fail(
          'No supported pack found: expected a .mrpack (modrinth.index.json) or an embedded server ZIP.',
        );
      }
      if (info.kind === 'curseforge') {
        return this.fail(
          `Standard CurseForge manifests are unsupported because authorized file resolution is unavailable (${info.curseforgeFileCount ?? 0} declared file(s)). Use a Modrinth .mrpack or an embedded server ZIP.`,
          { rejected: info.curseforgeFileCount ?? 0 },
        );
      }

      if (!force) {
        const conflict = this.matchCheck(flavor, record.version ?? null, info);
        if (conflict) return this.fail(conflict);
      }

      await replaceDirectoryAtomically(
        record.folderPath,
        async (stagingFolder) => {
          this.throwIfCanceled(options.signal);
          await fs.promises.cp(record.folderPath, stagingFolder, {
            recursive: true,
            force: true,
            errorOnExist: false,
          });
          this.throwIfCanceled(options.signal);

          if (info.kind === 'mrpack') {
            await this.downloadModrinthFiles(
              stagingFolder,
              info.modrinthIndex ?? {},
              counts,
              force,
              options.signal,
            );
          }

          this.emit(`Extracting ${info.kind === 'mrpack' ? 'overrides' : 'embedded server'} files…`);
          await this.extract(stagingFolder, filePath, info, counts, force, options.signal);
        },
        () => this.throwIfCanceled(options.signal),
        { signal: options.signal },
      );

      const result = this.success(counts);
      this.emit(
        `Import complete: ${result.modsAdded} mod(s), ${result.filesCopied} file(s) copied, ${counts.downloaded} downloaded, ${result.skipped} skipped`,
      );
      return result;
    } catch (error) {
      if (counts.rejected === 0) counts.rejected = 1;
      return this.fail(error instanceof Error ? error.message : String(error), counts);
    } finally {
      if (operationId) this.coordinator?.release(serverId, operationId);
    }
  }

  /**
   * Read the pack's index/manifest to determine format + declared
   * loader/MC version. Returns null when the file is not a recognized pack.
   */
  async inspectPack(filePath: string): Promise<PackInfo | null> {
    const entries = await listZipEntries(filePath);
    if (!entries) return null;
    const lowerEntries = entries.map((entry) => entry.toLowerCase());

    if (lowerEntries.includes('modrinth.index.json')) {
      const text = await readZipEntryText(filePath, 'modrinth.index.json');
      if (text) {
        try {
          const index = JSON.parse(text) as ModrinthIndex;
          const deps = index.dependencies ?? {};
          const mcVersion = deps.minecraft;
          const loader =
            deps['fabric-loader'] ?? deps['quilt-loader']
              ? 'fabric'
              : deps['forge-loader'] || deps.forge
                ? 'forge'
                : undefined;
          return { kind: 'mrpack', loader, mcVersion, modrinthIndex: index };
        } catch {
          return null;
        }
      }
    }

    // CurseForge / embedded server ZIP: standard CurseForge manifests contain
    // provider IDs, not directly downloadable URLs. Do not pretend they were
    // installed; only ZIPs that actually embed their server files are handled.
    const hasMods = lowerEntries.some((entry) => entry === 'mods' || entry.startsWith('mods/'));
    const hasManifest = lowerEntries.includes('manifest.json');
    if (!hasMods && !hasManifest) return null;

    let loader: string | undefined;
    let mcVersion: string | undefined;
    let curseforgeFileCount = 0;
    if (hasManifest) {
      const text = await readZipEntryText(filePath, 'manifest.json');
      if (text) {
        try {
          const manifest = JSON.parse(text) as CurseforgeManifest;
          curseforgeFileCount = Array.isArray(manifest.files) ? manifest.files.length : 0;
          mcVersion = manifest.minecraft?.version;
          const loaderId = manifest.minecraft?.modLoaders?.find((l) => l.primary)?.id;
          if (loaderId?.includes('forge')) loader = 'forge';
          else if (loaderId?.includes('fabric')) loader = 'fabric';
          else if (loaderId) loader = loaderId.split('-')[0];
        } catch {
          // manifest malformed; treat as plain zip
        }
      }
    }

    return {
      kind: curseforgeFileCount > 0 ? 'curseforge' : 'embedded-zip',
      loader,
      mcVersion,
      curseforgeFileCount,
    };
  }

  /** Returns an error string when the pack conflicts with the server. */
  private matchCheck(
    serverFlavor: ServerFlavor,
    serverMcVersion: string | null,
    info: PackInfo,
  ): string | null {
    if (info.loader && info.loader !== serverFlavor) {
      return `This pack is for ${info.loader}, but the server is ${serverFlavor}. Convert the server to ${info.loader} first, or import with force.`;
    }
    if (info.mcVersion && serverMcVersion && info.mcVersion !== serverMcVersion) {
      return `This pack targets Minecraft ${info.mcVersion}, but the server is ${serverMcVersion}. Align the versions or import with force.`;
    }
    return null;
  }

  private async downloadModrinthFiles(
    stagingFolder: string,
    index: ModrinthIndex,
    counts: ImportCounts,
    overwrite: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (index.game && index.game.toLowerCase() !== 'minecraft') {
      counts.rejected += 1;
      throw new Error(`Unsupported Modrinth game: ${index.game}`);
    }

    const declared = index.files ?? [];
    const eligible: ModrinthFile[] = [];
    for (const file of declared) {
      if (
        file.env?.server !== undefined &&
        !['required', 'optional', 'unsupported'].includes(file.env.server)
      ) {
        counts.rejected += 1;
        throw new Error(`Invalid Modrinth server environment for ${file.path ?? '(missing path)'}`);
      }
      if (file.env?.server === 'unsupported') {
        counts.skipped += 1;
        continue;
      }
      eligible.push(file);
    }
    if (declared.length > 0 && eligible.length === 0) {
      counts.rejected += declared.length;
      throw new Error('This Modrinth pack is client-only and declares no server-compatible files');
    }

    const canonicalPaths = new Set<string>();
    const jobs: Array<{
      file: ModrinthFile;
      relativePath: string;
      destination: string;
      existingDestination: string | null;
      digest: DownloadDigest;
    }> = [];
    for (const file of eligible) {
      this.throwIfCanceled(signal);
      const relativePath = normalizeRelativePath(file.path ?? '');
      const destination = safeJoin(stagingFolder, relativePath);
      const canonical = relativePath.toLowerCase();
      if (!relativePath || !destination || shouldSkip(relativePath)) {
        counts.rejected += 1;
        throw new Error(`Modrinth manifest contains an unsafe or protected path: ${file.path ?? '(missing)'}`);
      }
      assertNoSymlinkPath(stagingFolder, relativePath);
      if (canonicalPaths.has(canonical)) {
        counts.rejected += 1;
        throw new Error(`Modrinth manifest contains a duplicate or case-colliding path: ${relativePath}`);
      }
      canonicalPaths.add(canonical);

      const digest = strongestDigest(file);
      const downloads = validDownloadUrls(file.downloads);
      if (downloads.length === 0) {
        counts.rejected += 1;
        throw new Error(`Modrinth manifest file has no valid download URL: ${relativePath}`);
      }
      validateFileSize(file.fileSize, relativePath);

      const existingDestination = findExistingPathCaseInsensitive(stagingFolder, relativePath);
      if (existingDestination && !overwrite) {
        counts.skipped += 1;
        continue;
      }
      jobs.push({ file, relativePath, destination, existingDestination, digest });
    }

    await mapWithConcurrency(jobs, this.maxConcurrentDownloads, async (job) => {
      this.throwIfCanceled(signal);
      await fs.promises.mkdir(path.dirname(job.destination), { recursive: true });
      if (overwrite && job.existingDestination) {
        await fs.promises.rm(job.existingDestination, { recursive: true, force: true });
      }
      const urls = validDownloadUrls(job.file.downloads);
      let lastError: unknown;
      for (const url of urls) {
        this.throwIfCanceled(signal);
        const request: DownloadRequest = {
          url,
          destination: job.destination,
          expectedDigest: job.digest,
          expectedBytes: job.file.fileSize,
          maximumBytes: MAX_MODPACK_FILE_BYTES,
          signal,
        };
        try {
          await this.downloadService.download(request);
          counts.downloaded += 1;
          if (isModJar(job.relativePath)) counts.modsAdded += 1;
          else counts.filesCopied += 1;
          return;
        } catch (error) {
          lastError = error;
          await fs.promises.rm(job.destination, { force: true });
        }
      }
      counts.rejected += 1;
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Failed to download ${job.relativePath}: ${reason}`);
    });
  }

  /** Extract embedded overrides into the disposable staging copy. */
  private async extract(
    stagingFolder: string,
    filePath: string,
    info: PackInfo,
    counts: ImportCounts,
    overwrite: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await walkZip(filePath, async (entry, stream) => {
      this.throwIfCanceled(signal);
      const raw = normalizeRelativePath(entry.fileName);
      const rawLower = raw.toLowerCase();
      let rel: string;

      if (info.kind === 'mrpack') {
        rel = stripPrefixInsensitive(raw, 'server-overrides/');
        if (rel === raw) rel = stripPrefixInsensitive(raw, 'overrides/');
        if (rel === raw) {
          counts.skipped += rawLower === 'modrinth.index.json' ? 0 : 1;
          stream.resume();
          return;
        }
      } else {
        rel = stripPrefixInsensitive(raw, 'overrides/');
      }

      if (!rel || rel.endsWith('/')) {
        stream.resume();
        return;
      }
      const relLower = rel.toLowerCase();
      if (relLower === 'modrinth.index.json' || relLower === 'manifest.json') {
        stream.resume();
        return;
      }

      const target = safeJoin(stagingFolder, rel);
      if (!target || shouldSkip(rel)) {
        counts.skipped += 1;
        stream.resume();
        return;
      }
      assertNoSymlinkPath(stagingFolder, rel);
      if (relLower.startsWith('mods/') && !relLower.endsWith('.jar')) {
        counts.skipped += 1;
        stream.resume();
        return;
      }
      const existingTarget = findExistingPathCaseInsensitive(stagingFolder, rel);
      if (existingTarget) {
        if (!overwrite) {
          counts.skipped += 1;
          stream.resume();
          return;
        }
        await fs.promises.rm(existingTarget, { recursive: true, force: true });
      }

      await writeEntryStream(stream, target, signal);
      if (isModJar(rel)) counts.modsAdded += 1;
      else counts.filesCopied += 1;
    });
  }

  private throwIfCanceled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Modpack import canceled');
  }

  private success(counts: ImportCounts): ModpackImportResult {
    return { ok: true, ...counts };
  }

  private fail(error: string, counts: Partial<ImportCounts> = {}): ModpackImportResult {
    return { ok: false, error, ...emptyCounts(), ...counts };
  }
}

function emptyCounts(): ImportCounts {
  return { modsAdded: 0, filesCopied: 0, skipped: 0, downloaded: 0, rejected: 0 };
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripPrefixInsensitive(value: string, prefix: string): string {
  return value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length) : value;
}

function isModJar(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  return normalized.startsWith('mods/') && normalized.endsWith('.jar');
}

function findExistingPathCaseInsensitive(root: string, relativePath: string): string | null {
  let current = root;
  for (const part of normalizeRelativePath(relativePath).split('/').filter(Boolean)) {
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return null;
    const match = fs.readdirSync(current).find((entry) => entry.toLowerCase() === part.toLowerCase());
    if (!match) return null;
    current = path.join(current, match);
  }
  return current;
}

function strongestDigest(file: ModrinthFile): DownloadDigest {
  const sha512 = file.hashes?.sha512?.trim();
  if (sha512 !== undefined) {
    if (!/^[a-f\d]{128}$/i.test(sha512)) throw new Error(`Invalid SHA-512 for ${file.path ?? '(missing path)'}`);
    return { algorithm: 'sha512', value: sha512 };
  }
  const sha1 = file.hashes?.sha1?.trim();
  if (sha1 !== undefined) {
    if (!/^[a-f\d]{40}$/i.test(sha1)) throw new Error(`Invalid SHA-1 for ${file.path ?? '(missing path)'}`);
    return { algorithm: 'sha1', value: sha1 };
  }
  throw new Error(`Modrinth manifest file has no verifiable SHA-512 or SHA-1 hash: ${file.path ?? '(missing path)'}`);
}

function validDownloadUrls(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  });
}

function validateFileSize(value: number | undefined, relativePath: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MODPACK_FILE_BYTES) {
    throw new Error(`Invalid or excessive declared size for ${relativePath}`);
  }
}

async function mapWithConcurrency<T>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  const run = async (): Promise<void> => {
    while (next < values.length && firstError === undefined) {
      const index = next;
      next += 1;
      try {
        await worker(values[index]);
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  if (firstError !== undefined) throw firstError;
}

function assertNoSymlinkPath(root: string, relativePath: string): void {
  let current = root;
  for (const part of normalizeRelativePath(relativePath).split('/').filter(Boolean)) {
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return;
    const existing = fs.readdirSync(current).find((entry) => entry.toLowerCase() === part.toLowerCase());
    current = path.join(current, existing ?? part);
    if (!existing) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Modpack path traverses a symbolic link or junction: ${relativePath}`);
    }
  }
}

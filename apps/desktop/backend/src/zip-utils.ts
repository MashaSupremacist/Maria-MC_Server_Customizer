import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export interface ArchivePolicy {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
  maxMetadataBytes: number;
}

export const DEFAULT_ARCHIVE_POLICY: Readonly<ArchivePolicy> = {
  maxEntries: 20_000,
  maxEntryUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1_000,
  maxMetadataBytes: 4 * 1024 * 1024,
};

export class ArchivePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePolicyError';
  }
}

/** Paths that a pack import must never overwrite. Comparisons are lowercase. */
export const SKIP_PATHS = new Set([
  'server.properties',
  'eula.txt',
  'banned-ips.json',
  'banned-players.json',
  'ops.json',
  'whitelist.json',
  'usercache.json',
  'playit.key',
  'playit.toml',
]);

export const SKIP_TOP_LEVEL_DIRS = new Set(['world', 'logs', 'crash-reports']);
export const PACK_EXTENSIONS = new Set(['.mrpack', '.zip']);

export function stripPrefix(rel: string, prefix: string): string {
  return rel === prefix || rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
}

export function shouldSkip(rel: string): boolean {
  const normalized = normalizeEntryName(rel).toLowerCase();
  const top = normalized.split('/')[0];
  return (
    SKIP_TOP_LEVEL_DIRS.has(top) ||
    SKIP_PATHS.has(normalized) ||
    normalized.endsWith('.jar.disabled') ||
    normalized.startsWith('backups/')
  );
}

export function safeJoin(root: string, rel: string): string | null {
  const normalized = normalizeEntryName(rel);
  if (!normalized || normalized.includes('\0') || path.win32.isAbsolute(normalized)) return null;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalized);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (target !== resolvedRoot && !target.startsWith(rootWithSep)) return null;
  return target;
}

export async function listZipEntries(
  filePath: string,
  policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
): Promise<string[] | null> {
  try {
    const names: string[] = [];
    await walkZip(filePath, async (entry, stream) => {
      names.push(normalizeEntryName(entry.fileName));
      await drainStream(stream);
    }, { policy });
    return names;
  } catch (error) {
    if (error instanceof ArchivePolicyError) throw error;
    return null;
  }
}

export async function readZipEntryText(
  filePath: string,
  entryName: string,
  policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
): Promise<string | null> {
  let result: string | null = null;
  const wanted = normalizeEntryName(entryName).toLowerCase();
  try {
    await walkZip(filePath, async (entry, stream) => {
      const name = normalizeEntryName(entry.fileName).toLowerCase();
      if (name !== wanted) {
        await drainStream(stream);
        return;
      }
      if (entry.uncompressedSize > policy.maxMetadataBytes) {
        stream.destroy();
        throw new ArchivePolicyError(`Archive metadata entry exceeds ${policy.maxMetadataBytes} bytes`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream as Readable) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > policy.maxMetadataBytes) {
          throw new ArchivePolicyError(`Archive metadata entry exceeds ${policy.maxMetadataBytes} bytes`);
        }
        chunks.push(buffer);
      }
      result = Buffer.concat(chunks, bytes).toString('utf8');
    }, { policy });
    return result;
  } catch (error) {
    if (error instanceof ArchivePolicyError) throw error;
    return null;
  }
}

export async function extractZipEntryToFile(
  filePath: string,
  entryName: string,
  destPath: string,
  options: WalkZipOptions = {},
): Promise<boolean> {
  let found = false;
  const wanted = normalizeEntryName(entryName).toLowerCase();
  await walkZip(filePath, async (entry, stream) => {
    if (normalizeEntryName(entry.fileName).toLowerCase() !== wanted) {
      await drainStream(stream);
      return;
    }
    found = true;
    await writeEntryStream(stream, destPath, options.signal);
  }, options);
  return found;
}

export interface WalkZipOptions {
  policy?: ArchivePolicy;
  signal?: AbortSignal;
}

/** Walk a ZIP serially and wait for each visitor before reading the next entry. */
export function walkZip(
  filePath: string,
  visitor: (entry: yauzl.Entry, stream: Readable) => Promise<void> | void,
  options: WalkZipOptions = {},
): Promise<void> {
  const policy = options.policy ?? DEFAULT_ARCHIVE_POLICY;
  return (async () => {
    const zipfile = await openZip(filePath);
    let entryCount = 0;
    let totalUncompressed = 0;
    const canonicalPaths = new Set<string>();
    try {
      while (true) {
        throwIfAborted(options.signal);
        const entry = await nextZipEntry(zipfile);
        if (!entry) break;
        validateEntry(entry, canonicalPaths, policy, ++entryCount, totalUncompressed);
        totalUncompressed += entry.uncompressedSize;
        if (/\/$/.test(normalizeEntryName(entry.fileName))) continue;

        const stream = await openZipEntry(zipfile, entry);
        const onAbort = (): void => {
          stream.destroy(abortError());
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await visitor(entry, stream);
          if (!stream.readableEnded && !stream.destroyed) {
            await drainStream(stream);
          }
        } finally {
          options.signal?.removeEventListener('abort', onAbort);
        }
      }
    } finally {
      try { zipfile.close(); } catch { /* already closed */ }
    }
  })();
}

export async function writeEntryStream(
  stream: NodeJS.ReadableStream,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest, { flags: 'wx' });
  try {
    await pipeline(stream as Readable, out, { signal });
  } catch (error) {
    await fs.promises.rm(dest, { force: true });
    throw error;
  }
}

function validateEntry(
  entry: yauzl.Entry,
  canonicalPaths: Set<string>,
  policy: ArchivePolicy,
  entryCount: number,
  totalBefore: number,
): void {
  const name = normalizeEntryName(entry.fileName);
  if (!name || name.includes('\0') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new ArchivePolicyError(`Unsafe archive entry path: ${entry.fileName}`);
  }
  if (name.split('/').some((part) => part === '..')) {
    throw new ArchivePolicyError(`Archive entry escapes destination: ${entry.fileName}`);
  }
  const canonical = name.replace(/\/$/, '').toLowerCase();
  if (canonicalPaths.has(canonical)) {
    throw new ArchivePolicyError(`Duplicate or case-colliding archive path: ${entry.fileName}`);
  }
  canonicalPaths.add(canonical);
  if (entryCount > policy.maxEntries) {
    throw new ArchivePolicyError(`Archive contains more than ${policy.maxEntries} entries`);
  }
  if (entry.uncompressedSize > policy.maxEntryUncompressedBytes) {
    throw new ArchivePolicyError(`Archive entry exceeds ${policy.maxEntryUncompressedBytes} bytes: ${entry.fileName}`);
  }
  if (totalBefore + entry.uncompressedSize > policy.maxTotalUncompressedBytes) {
    throw new ArchivePolicyError(`Archive expands beyond ${policy.maxTotalUncompressedBytes} bytes`);
  }
  if (
    entry.uncompressedSize > 0 &&
    (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > policy.maxCompressionRatio)
  ) {
    throw new ArchivePolicyError(`Archive entry compression ratio is too high: ${entry.fileName}`);
  }
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error || !zipfile) reject(error ?? new Error('Failed to open ZIP archive'));
      else resolve(zipfile);
    });
  });
}

function nextZipEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zipfile.removeListener('entry', onEntry);
      zipfile.removeListener('end', onEnd);
      zipfile.removeListener('error', onError);
    };
    const onEntry = (entry: yauzl.Entry): void => { cleanup(); resolve(entry); };
    const onEnd = (): void => { cleanup(); resolve(null); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    zipfile.once('entry', onEntry);
    zipfile.once('end', onEnd);
    zipfile.once('error', onError);
    zipfile.readEntry();
  });
}

function openZipEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Failed to read ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException('Archive extraction canceled', 'AbortError');
}

async function drainStream(stream: Readable): Promise<void> {
  for await (const _chunk of stream) {
    // Intentionally discard skipped archive content.
  }
}

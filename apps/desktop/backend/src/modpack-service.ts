import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import type {
  ModpackImportResult,
  ServerFlavor,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';

export type WsBroadcast = (event: WsServerEvent) => void;

/**
 * Paths that are never overwritten by a pack import. These are live server
 * state or generated on first launch; clobbering them would destroy a
 * running setup (or the world).
 */
const SKIP_PATHS = new Set([
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

/** Top-level folders that are never touched by a pack import. */
const SKIP_TOP_LEVEL_DIRS = new Set(['world', 'logs', 'crash-reports']);

/** Modpack file extensions we accept. */
const PACK_EXTENSIONS = new Set(['.mrpack', '.zip']);

interface ModrinthIndex {
  game?: string;
  dependencies?: Record<string, string>;
  overrides?: string[];
}

interface CurseforgeManifest {
  minecraft?: { version?: string; modLoaders?: Array<{ id?: string; primary?: boolean }> };
  files?: unknown[];
  overrides?: string;
}

interface PackInfo {
  kind: 'mrpack' | 'zip';
  /** Declared loader from the pack, if any (e.g. "fabric", "forge"). */
  loader?: string;
  /** Declared Minecraft version from the pack, if any. */
  mcVersion?: string;
}

/**
 * Imports a modpack (.mrpack / .zip) onto an existing Fabric/Forge server:
 * validates loader + MC version, extracts mod JARs into mods/ and other
 * files into the server folder, streaming progress over the WebSocket.
 */
export class ModpackService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private runningServerId: (() => string | null) | null = null;

  constructor(db: DatabaseResult, broadcast: WsBroadcast) {
    this.db = db;
    this.broadcast = broadcast;
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
  async import(serverId: string, filePath: string, force = false): Promise<ModpackImportResult> {
    const record = this.db.getServer(serverId);
    if (!record) return this.fail('Server not found');
    if (!fs.existsSync(record.folderPath)) {
      return this.fail(`Server folder not found: ${record.folderPath}`);
    }
    if (this.runningServerId?.() === serverId) {
      return this.fail('Stop the server before importing a modpack');
    }
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

    this.emit('Opening pack…');
    const info = await this.inspectPack(filePath);
    if (!info) {
      return this.fail(
        'No supported pack found: expected a .mrpack (modrinth.index.json) or a .zip with a mods/ folder or manifest.json.',
      );
    }

    if (!force) {
      const conflict = this.matchCheck(flavor, record.version ?? null, info);
      if (conflict) return this.fail(conflict);
    }

    this.emit(`Extracting ${info.kind === 'mrpack' ? 'overrides' : 'pack'} files…`);

    const result = await this.extract(record.folderPath, filePath, info);
    this.emit(`Import complete: ${result.modsAdded} mod(s), ${result.filesCopied} file(s) copied`);
    return result;
  }

  /**
   * Read the pack's index/manifest to determine format + declared
   * loader/MC version. Returns null when the file is not a recognized pack.
   */
  async inspectPack(filePath: string): Promise<PackInfo | null> {
    const entries = await listZipEntries(filePath);
    if (!entries) return null;

    if (entries.includes('modrinth.index.json')) {
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
          return { kind: 'mrpack', loader, mcVersion };
        } catch {
          return null;
        }
      }
    }

    // CurseForge / plain zip: mods/ folder or manifest.json.
    const hasMods = entries.some((e) => e === 'mods' || e.startsWith('mods/'));
    const hasManifest = entries.includes('manifest.json');
    if (!hasMods && !hasManifest) return null;

    let loader: string | undefined;
    let mcVersion: string | undefined;
    if (hasManifest) {
      const text = await readZipEntryText(filePath, 'manifest.json');
      if (text) {
        try {
          const manifest = JSON.parse(text) as CurseforgeManifest;
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

    return { kind: 'zip', loader, mcVersion };
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

  /**
   * Extract the pack into the server folder: .jar files go into mods/,
   * everything else into the server folder, skipping live-server paths.
   */
  private async extract(
    serverFolder: string,
    filePath: string,
    info: PackInfo,
  ): Promise<ModpackImportResult> {
    const modsDir = path.join(serverFolder, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });

    const modsAdded: string[] = [];
    const filesCopied: string[] = [];
    const skipped: string[] = [];

    await walkZip(filePath, (entry, stream) => {
      const raw = entry.fileName.replace(/\\/g, '/');
      // Strip the mrpack overrides/ prefix (Modrinth packs wrap everything).
      let rel = info.kind === 'mrpack' ? stripPrefix(raw, 'overrides/') : raw;
      // Strip the CurseForge overrides/ prefix too, when present.
      if (info.kind === 'zip') rel = stripPrefix(rel, 'overrides/');
      if (!rel || rel.endsWith('/')) {
        stream.resume();
        return;
      }

      // The pack's own metadata files are not server files.
      if (rel === 'modrinth.index.json' || rel === 'manifest.json') {
        skipped.push(rel);
        stream.resume();
        return;
      }

      const target = safeJoin(serverFolder, rel);
      if (!target || shouldSkip(rel)) {
        skipped.push(rel);
        stream.resume();
        return;
      }

      // Only .jar files belong in mods/ (drop everything else under mods/).
      if (rel.startsWith('mods/')) {
        if (!rel.endsWith('.jar')) {
          skipped.push(rel);
          stream.resume();
          return;
        }
        const dest = path.join(modsDir, path.basename(rel));
        if (fs.existsSync(dest)) skipped.push(rel);
        writeEntryStream(stream, dest);
        modsAdded.push(path.basename(rel));
        return;
      }

      writeEntryStream(stream, target);
      filesCopied.push(rel);
    });

    return {
      ok: true,
      modsAdded: modsAdded.length,
      filesCopied: filesCopied.length,
      skipped: skipped.length,
    };
  }

  private fail(error: string): ModpackImportResult {
    return { ok: false, error, modsAdded: 0, filesCopied: 0, skipped: 0 };
  }
}

/** Strip a leading prefix from a slash-normalized relative path, if present. */
function stripPrefix(rel: string, prefix: string): string {
  return rel === prefix || rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
}

/** Whether a pack file path must never overwrite server state. */
function shouldSkip(rel: string): boolean {
  const top = rel.split('/')[0];
  if (SKIP_TOP_LEVEL_DIRS.has(top)) return true;
  if (SKIP_PATHS.has(rel)) return true;
  // Never install disabled-mod artifacts or other servers' backups.
  if (rel.endsWith('.jar.disabled')) return true;
  if (rel.startsWith('backups/')) return true;
  return false;
}

/** Join a relative path under a root, refusing anything that escapes. */
function safeJoin(root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  const rootWithSep = path.resolve(root) + path.sep;
  if (target !== path.resolve(root) && !target.startsWith(rootWithSep)) return null;
  return target;
}

/** List all entry names in a zip, or null if the file is not a valid zip. */
function listZipEntries(filePath: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve(null);
        return;
      }
      const names: string[] = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        names.push(entry.fileName.replace(/\\/g, '/'));
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', () => resolve(null));
    });
  });
}

/** Read a single entry's full text content. */
function readZipEntryText(filePath: string, entryName: string): Promise<string | null> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve(null);
        return;
      }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.close();
            resolve(null);
            return;
          }
          let text = '';
          stream.on('data', (c: Buffer) => (text += c.toString()));
          stream.on('end', () => {
            zipfile.close();
            resolve(text);
          });
          stream.on('error', () => {
            zipfile.close();
            resolve(null);
          });
        });
      });
      zipfile.on('end', () => {
        zipfile.close();
        resolve(null);
      });
      zipfile.on('error', () => resolve(null));
    });
  });
}

/** Walk a zip, calling the visitor for each file entry. */
function walkZip(
  filePath: string,
  visitor: (entry: yauzl.Entry, stream: NodeJS.ReadableStream) => void,
): Promise<void> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        resolve();
        return;
      }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.readEntry();
            return;
          }
          let advanced = false;
          const advance = (): void => {
            if (advanced) return;
            advanced = true;
            zipfile.readEntry();
          };
          stream.on('end', advance);
          stream.on('error', advance);
          try {
            visitor(entry, stream);
          } catch {
            advance();
          }
        });
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', () => resolve());
    });
  });
}

/** Stream a zip entry into a destination file (creating parent dirs). */
function writeEntryStream(stream: NodeJS.ReadableStream, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  stream.pipe(out);
  out.on('error', () => stream.resume());
}

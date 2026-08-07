import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import type { ExtensionEntry, ExtensionListResponse, ServerFlavor } from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { extensionFolderFor, flavorMeta } from './server-types';

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB safety cap
const DISABLED_SUFFIX = '.disabled';

/**
 * Manages a server's extension folder: mods/ (Fabric/Forge) or plugins/
 * (Paper). Lists files with JAR metadata, enables/disables via renames
 * (<name>.jar <-> <name>.jar.disabled), deletes, and validates uploads.
 * Refuses all mutations while the server is running.
 */
export class ExtensionManagerService {
  private readonly db: DatabaseResult;
  private runningServerId: (() => string | null) | null = null;

  constructor(db: DatabaseResult) {
    this.db = db;
  }

  setRunningServerId(fn: () => string | null): void {
    this.runningServerId = fn;
  }

  private isServerRunning(serverId: string): boolean {
    return this.runningServerId?.() === serverId;
  }

  /** Absolute path to the server's extension folder, or null for Vanilla. */
  private extensionDir(serverId: string): { flavor: ServerFlavor; dir: string | null } {
    const record = this.db.getServer(serverId);
    if (!record) return { flavor: 'vanilla', dir: null };
    const meta = flavorMeta(record.serverType);
    if (!meta?.extensionFolder) return { flavor: record.serverType as ServerFlavor, dir: null };
    return { flavor: record.serverType as ServerFlavor, dir: path.join(record.folderPath, meta.extensionFolder) };
  }

  /** List all extensions (enabled + disabled) with metadata. */
  async list(serverId: string): Promise<ExtensionListResponse> {
    const { flavor, dir } = this.extensionDir(serverId);
    if (!dir || !fs.existsSync(dir)) {
      return { serverId, flavor, folder: dir ? path.basename(dir) : null, entries: [] };
    }
    const entries: ExtensionEntry[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jar') && !name.endsWith(`${DISABLED_SUFFIX}`)) continue;
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const enabled = !name.endsWith(DISABLED_SUFFIX);
      const baseName = enabled ? name : name.slice(0, -DISABLED_SUFFIX.length);
      const entry: ExtensionEntry = {
        name: baseName,
        enabled,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
      // Read metadata for enabled .jar files only (disabled are renamed).
      if (enabled && name.endsWith('.jar')) {
        const meta = await inspectJar(full, flavor);
        if (meta) {
          entry.displayName = meta.displayName;
          entry.version = meta.version;
          entry.description = meta.description;
          entry.authors = meta.authors;
          entry.kind = meta.kind;
          entry.mcVersion = meta.mcVersion;
          entry.dependencies = meta.dependencies;
        } else {
          entry.metadataError = 'Could not read metadata (not a mod/plugin jar?)';
        }
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { serverId, flavor, folder: dir ? path.basename(dir) : null, entries };
  }

  /** Enable a disabled extension: rename <name>.jar.disabled -> <name>.jar. */
  enable(serverId: string, name: string): { ok: boolean; error?: string } {
    const err = this.mutationGuard(serverId, name);
    if (err) return err;
    const { dir } = this.extensionDir(serverId);
    if (!dir) return { ok: false, error: 'This server type does not support mods/plugins' };
    const disabled = path.join(dir, `${name}${DISABLED_SUFFIX}`);
    if (!fs.existsSync(disabled)) return { ok: false, error: `Disabled file not found: ${name}` };
    fs.renameSync(disabled, path.join(dir, name));
    return { ok: true };
  }

  /** Disable an enabled extension: rename <name>.jar -> <name>.jar.disabled. */
  disable(serverId: string, name: string): { ok: boolean; error?: string } {
    const err = this.mutationGuard(serverId, name);
    if (err) return err;
    const { dir } = this.extensionDir(serverId);
    if (!dir) return { ok: false, error: 'This server type does not support mods/plugins' };
    const active = path.join(dir, name);
    if (!fs.existsSync(active)) return { ok: false, error: `File not found: ${name}` };
    fs.renameSync(active, `${active}${DISABLED_SUFFIX}`);
    return { ok: true };
  }

  /** Delete an extension file (enabled or disabled). */
  delete(serverId: string, name: string): { ok: boolean; error?: string } {
    const err = this.mutationGuard(serverId, name);
    if (err) return err;
    const { dir } = this.extensionDir(serverId);
    if (!dir) return { ok: false, error: 'This server type does not support mods/plugins' };
    for (const candidate of [path.join(dir, name), path.join(dir, `${name}${DISABLED_SUFFIX}`)]) {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { force: true });
        return { ok: true };
      }
    }
    return { ok: false, error: `File not found: ${name}` };
  }

  /** Copy uploaded files into the extension folder, validating type + size. */
  upload(
    serverId: string,
    files: Array<{ name: string; contentBase64: string; sizeBytes: number }>,
  ): { ok: boolean; error?: string; added: string[] } {
    const { dir } = this.extensionDir(serverId);
    if (!dir) return { ok: false, error: 'This server type does not support mods/plugins', added: [] };
    const record = this.db.getServer(serverId);
    if (!record) return { ok: false, error: 'Server not found', added: [] };
    if (this.isServerRunning(serverId)) {
      return { ok: false, error: 'Stop the server before adding mods/plugins', added: [] };
    }
    fs.mkdirSync(dir, { recursive: true });
    const added: string[] = [];
    for (const file of files) {
      const base = path.basename(file.name);
      if (!base.endsWith('.jar')) {
        return { ok: false, error: `Only .jar files are allowed (${base})`, added: [] };
      }
      if (file.sizeBytes > MAX_UPLOAD_BYTES) {
        return { ok: false, error: `${base} exceeds the 1 GB upload limit`, added: [] };
      }
      if (!file.contentBase64) {
        return { ok: false, error: `File is empty: ${base}`, added: [] };
      }
      // Sanitize the destination name (no path traversal).
      const dest = path.join(dir, base);
      fs.writeFileSync(dest, Buffer.from(file.contentBase64, 'base64'));
      added.push(base);
    }
    return { ok: true, added };
  }

  private mutationGuard(serverId: string, name: string): { ok: false; error: string } | null {
    if (path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
      return { ok: false, error: 'Invalid file name' };
    }
    const { dir } = this.extensionDir(serverId);
    if (!dir) return { ok: false, error: 'This server type does not support mods/plugins' };
    if (this.isServerRunning(serverId)) {
      return { ok: false, error: 'Stop the server before changing mods/plugins' };
    }
    return null;
  }
}

/** Metadata extracted from a mod/plugin JAR. */
interface JarMeta {
  displayName: string;
  version?: string;
  description?: string;
  authors?: string[];
  kind?: 'mod' | 'plugin';
  mcVersion?: string;
  dependencies?: string[];
}

/**
 * Read metadata from a JAR without extracting it: fabric.mod.json for Fabric,
 * META-INF/mods.toml for Forge, plugin.yml / paper-plugin.yml for Paper.
 * Returns null when no recognized manifest is present.
 */
export async function inspectJar(
  jarPath: string,
  flavor: ServerFlavor,
): Promise<JarMeta | null> {
  try {
    if (flavor === 'fabric' || flavor === 'forge') {
      const fabric = await readZipEntry(jarPath, 'fabric.mod.json');
      if (fabric) {
        try {
          const json = JSON.parse(fabric) as {
            id?: string;
            name?: string;
            version?: string;
            description?: string;
            authors?: Array<{ name?: string } | string>;
            depends?: Record<string, unknown>;
          };
          return {
            displayName: json.name ?? json.id ?? path.basename(jarPath, '.jar'),
            version: json.version,
            description: json.description,
            authors: (json.authors ?? []).map((a) =>
              typeof a === 'string' ? a : a.name ?? '',
            ).filter(Boolean),
            kind: 'mod',
            mcVersion: undefined,
            dependencies: json.depends ? Object.keys(json.depends) : undefined,
          };
        } catch {
          // fall through
        }
      }
    }
    // Forge mods ship META-INF/mods.toml (NeoForge: META-INF/neoforge.mods.toml).
    if (flavor === 'forge') {
      for (const entryName of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
        const toml = await readZipEntry(jarPath, entryName);
        if (!toml) continue;
        const parsed = parseModsToml(toml);
        if (parsed) {
          return {
            displayName: parsed.displayName,
            version: parsed.version,
            description: parsed.description,
            authors: parsed.authors,
            kind: 'mod',
            mcVersion: parsed.mcVersion,
            dependencies: parsed.dependencies,
          };
        }
      }
    }
    if (flavor === 'paper') {
      for (const entryName of ['paper-plugin.yml', 'plugin.yml']) {
        const text = await readZipEntry(jarPath, entryName);
        if (!text) continue;
        const parsed = parseSimpleYaml(text);
        return {
          displayName: typeof parsed.name === 'string' ? parsed.name : path.basename(jarPath, '.jar'),
          version: typeof parsed.version === 'string' ? parsed.version : undefined,
          description: typeof parsed.description === 'string' ? parsed.description : undefined,
          authors: Array.isArray(parsed.authors)
            ? (parsed.authors as string[]).filter((a): a is string => typeof a === 'string')
            : undefined,
          kind: 'plugin',
          mcVersion: typeof parsed['api-version'] === 'string' ? parsed['api-version'] : undefined,
          dependencies: Array.isArray(parsed.depend)
            ? (parsed.depend as string[])
            : Array.isArray(parsed.softdepend)
              ? (parsed.softdepend as string[])
              : undefined,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Read a single entry's text content from a zip (returns null if missing). */
function readZipEntry(zipPath: string, entryName: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        resolve(null);
        return;
      }
      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName === entryName) {
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              zipfile.close();
              resolve(null);
              return;
            }
            let text = '';
            stream.on('data', (chunk: Buffer) => (text += chunk.toString()));
            stream.on('end', () => {
              zipfile.close();
              resolve(text);
            });
            stream.on('error', () => {
              zipfile.close();
              resolve(null);
            });
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => {
        zipfile.close();
        resolve(null);
      });
      zipfile.on('error', () => resolve(null));
    });
  });
}

/**
 * Parse Forge/NeoForge META-INF/mods.toml into the metadata we surface.
 * A TOML-lite parser: reads the [mods] table's first entry and the
 * [[dependencies.<modId>]] entries. Returns null when nothing usable.
 */
function parseModsToml(text: string): {
  displayName: string;
  version?: string;
  description?: string;
  authors?: string[];
  mcVersion?: string;
  dependencies?: string[];
} | null {
  const lines = text.split(/\r?\n/);
  let inMods = false;
  let inDepMod = false;
  const depMods: string[] = [];
  const mod: Record<string, string> = {};
  let modId: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const tableMatch = /^\[\[?([A-Za-z0-9_.-]+)\]?\]?$/.exec(line);
    if (tableMatch) {
      const table = tableMatch[1];
      inMods = table === 'mods';
      inDepMod = table.startsWith('dependencies.');
      continue;
    }
    if (inDepMod) {
      const m = line.match(/^modId\s*=\s*"([^"]+)"/);
      if (m && m[1] !== modId) depMods.push(m[1]);
      continue;
    }
    if (!inMods) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|\[.*\]|\{.*\}|[^\s]+)/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    mod[m[1]] = value;
    if (m[1] === 'modId') modId = value;
  }

  if (!modId && !mod.displayName) return null;
  const displayName = mod.displayName ?? mod.name ?? modId ?? '';
  return {
    displayName,
    version: mod.version,
    description: mod.description,
    authors: mod.authors
      ? mod.authors
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((a) => a.trim().replace(/^"|"$/g, ''))
          .filter(Boolean)
      : undefined,
    mcVersion: undefined,
    dependencies: depMods.length > 0 ? depMods : undefined,
  };
}

/** Minimal YAML parser for plugin.yml metadata. Handles top-level scalar keys
 * and indented list items under a key (e.g. "authors:").
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let listKey: string | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent > 0 && listKey) {
      const item = trimmed.replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
      const list = result[listKey];
      if (Array.isArray(list)) list.push(item);
      continue;
    }
    listKey = null;
    const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (value) {
      result[key] = value.replace(/^["']|["']$/g, '');
    } else {
      result[key] = [];
      listKey = key;
    }
  }
  return result;
}

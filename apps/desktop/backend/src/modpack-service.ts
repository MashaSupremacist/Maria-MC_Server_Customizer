import fs from 'node:fs';
import path from 'node:path';
import type {
  ModpackImportResult,
  ServerFlavor,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import {
  listZipEntries,
  PACK_EXTENSIONS,
  readZipEntryText,
  safeJoin,
  shouldSkip,
  stripPrefix,
  walkZip,
  writeEntryStream,
} from './zip-utils';

export type WsBroadcast = (event: WsServerEvent) => void;

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


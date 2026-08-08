import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import type {
  CreateFromPackRequest,
  CreateFromPackResult,
  PackInspection,
  ServerFlavor,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { createServerFolder, type ServerInstallerService } from './server-installer';
import {
  sniffVersionFromJar,
  sniffVersionFromLauncherContent,
} from './server-detector';
import { requiredJavaForMinecraft, javaLabel } from './java-service';
import {
  extractZipEntryToFile,
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

interface InternalPackInfo {
  kind: 'mrpack' | 'zip';
  name?: string;
  loader?: 'forge' | 'fabric' | 'vanilla' | null;
  mcVersion?: string | null;
}

const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_PORT = 25565;

/**
 * Creates a brand-new server from a server-pack zip (.zip / .mrpack): sniffs
 * the MC version + loader (manifest.json, modrinth.index.json, or jar names),
 * extracts into a fresh library folder, runs the Forge install step when the
 * pack ships an installer, and registers the server record. This is the
 * "just upload the server pack" flow for packs like Lost Era.
 */
export class PackInstallerService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly installer: ServerInstallerService | null;

  constructor(
    db: DatabaseResult,
    broadcast: WsBroadcast,
    options: { installer?: ServerInstallerService | null } = {},
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.installer = options.installer ?? null;
  }

  private emit(message: string): void {
    this.broadcast({
      type: 'install:progress',
      installId: 'pack-create',
      progress: { status: 'installing', percent: null, message },
    } satisfies WsServerEvent);
  }

  /**
   * Inspect a server-pack file without extracting: returns what MC version,
   * loader, and Java it needs, plus whether it ships a runnable jar or a
   * Forge installer. Used by the "New Server from Pack" form to show the
   * detected requirements before creating anything.
   */
  async inspect(filePath: string): Promise<PackInspection> {
    if (!filePath || !fs.existsSync(filePath)) {
      return this.inspectionFail('Pack file not found.');
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!PACK_EXTENSIONS.has(ext)) {
      return this.inspectionFail(`Unsupported file type: ${ext}. Use a .zip or .mrpack.`);
    }

    const info = await this.readPackInfo(filePath);
    if (!info) {
      return this.inspectionFail(
        'No supported pack found: expected a .mrpack (modrinth.index.json) or a .zip with a mods/ folder, manifest.json, or server jar.',
      );
    }

    const mcVersion = info.mcVersion ?? null;
    const requiredJava = mcVersion ? requiredJavaForMinecraft(mcVersion) : 8;
    const baseName = path.basename(filePath, ext);

    return {
      ok: true,
      name: info.name || baseName,
      mcVersion,
      loader: info.loader ?? null,
      hasServerJar: info.hasServerJar,
      hasLauncher: info.hasLauncher,
      needsInstallStep: info.needsInstallStep,
      requiredJava,
      requiredJavaLabel: javaLabel(requiredJava),
    };
  }

  /**
   * Create a new server from a pack: validate eula, inspect, create a fresh
   * folder in the library, extract (mods → mods/, everything else → folder),
   * run the Forge install step if the pack needs it, write eula +
   * server.properties, and register the record.
   */
  async create(request: CreateFromPackRequest): Promise<CreateFromPackResult> {
    if (!request.acceptEula) {
      return this.fail('The Minecraft EULA must be accepted before creating the server');
    }
    if (!request.name?.trim()) {
      return this.fail('Server name is required');
    }

    const inspection = await this.inspect(request.filePath);
    if (!inspection.ok) {
      return { ok: false, error: inspection.error ?? 'Failed to inspect pack' };
    }

    // The pack defines the flavor; it cannot be a vanilla server jar if it
    // ships mods/ or an installer. Default to vanilla only for bare jars.
    // The user can override detection with flavorOverride (e.g. a CurseForge
    // zip whose mods are Forge but whose manifest is missing).
    const loader = request.flavorOverride ?? inspection.loader ?? 'vanilla';
    if (loader !== 'forge' && loader !== 'fabric' && loader !== 'vanilla') {
      return this.fail(`Unsupported loader for pack: ${String(loader)}`);
    }
    const flavor = (loader === 'vanilla' ? 'vanilla' : loader) as ServerFlavor;

    this.emit('Creating server folder…');
    let serverFolder: string;
    try {
      serverFolder = createServerFolder(this.db, request.name.trim(), request.folderName);
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err));
    }

    try {
      // Extract the pack.
      this.emit('Extracting pack…');
      const counts = await this.extract(serverFolder, request.filePath);
      if (counts.error) {
        this.cleanup(serverFolder);
        return this.fail(counts.error);
      }

      // A client-style pack declares forge/fabric but ships no runnable
      // server jar or installer. Bootstrap the loader's server jar so the
      // result is actually launchable (e.g. Lost Era: 1.7.10 Forge).
      // Also bootstraps when the user's flavorOverride differs from what the
      // pack actually contains (e.g. a CurseForge zip detected as vanilla
      // because the mod JARs had no manifest, but the user forces Forge) —
      // in that case the extracted server.jar is the wrong flavor.
      const detectedLoader = inspection.loader ?? null;
      const overrideMismatch =
        request.flavorOverride && request.flavorOverride !== detectedLoader;
      if (
        (flavor === 'forge' || flavor === 'fabric') &&
        (!inspection.hasServerJar || overrideMismatch) &&
        !inspection.needsInstallStep
      ) {
        const mcVersion = request.mcVersionOverride ?? inspection.mcVersion;
        if (!mcVersion) {
          this.cleanup(serverFolder);
          return this.fail(
            'This pack uses a mod loader but does not declare a Minecraft version, so the server jar cannot be bootstrapped.',
          );
        }
        if (!this.installer) {
          this.cleanup(serverFolder);
          return this.fail('Server bootstrap is unavailable in this environment.');
        }
        this.emit(`Downloading ${flavor} server for MC ${mcVersion}…`);
        try {
          await this.installer.bootstrapServerJar({
            flavor,
            version: mcVersion,
            serverFolder,
            javaPath: request.javaPath ?? null,
          });
        } catch (err) {
          this.cleanup(serverFolder);
          return this.fail(err instanceof Error ? err.message : String(err));
        }
      }

      // Run the Forge installer when the pack ships one (server packs often
      // ship the installer + libraries instead of the runnable jar).
      if (inspection.needsInstallStep && inspection.mcVersion) {
        this.emit('Running Forge installer…');
        if (!this.installer) {
          this.cleanup(serverFolder);
          return this.fail('Server bootstrap is unavailable in this environment.');
        }
        try {
          await this.installer.bootstrapServerJar({
            flavor: 'forge',
            version: inspection.mcVersion,
            serverFolder,
            javaPath: request.javaPath ?? null,
          });
        } catch (err) {
          this.cleanup(serverFolder);
          return this.fail(err instanceof Error ? err.message : String(err));
        }
      }

      // Write eula + starter server.properties.
      this.emit('Writing configuration…');
      fs.writeFileSync(
        path.join(serverFolder, 'eula.txt'),
        `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toISOString()}\neula=true\n`,
      );
      writeServerProperties(path.join(serverFolder, 'server.properties'), {
        port: request.port ?? DEFAULT_PORT,
      });

      const record = this.db.createServer({
        name: request.name.trim(),
        edition: 'java',
        serverType: flavor,
        folderPath: serverFolder,
        javaPath: request.javaPath ?? null,
        memoryMb: request.memoryMb ?? DEFAULT_MEMORY_MB,
        port: request.port ?? DEFAULT_PORT,
        version: request.mcVersionOverride ?? inspection.mcVersion,
        jvmArgs: [],
      });

      this.emit('Server created from pack');
      return {
        ok: true,
        server: record,
        inspection,
        modsAdded: counts.modsAdded,
        filesCopied: counts.filesCopied,
        skipped: counts.skipped,
      };
    } catch (err) {
      this.cleanup(serverFolder);
      return this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Read the pack's manifest/index + sniff jar names for version/loader. */
  private async readPackInfo(filePath: string): Promise<
    (InternalPackInfo & {
      hasServerJar: boolean;
      needsInstallStep: boolean;
      hasLauncher: boolean;
    }) | null
  > {
    const entries = await listZipEntries(filePath);
    if (!entries) return null;

    let info: InternalPackInfo | null = null;

    if (entries.includes('modrinth.index.json')) {
      const text = await readZipEntryText(filePath, 'modrinth.index.json');
      if (text) {
        try {
          const index = JSON.parse(text) as ModrinthIndex;
          const deps = index.dependencies ?? {};
          const mcVersion = deps.minecraft;
          const loader = deps['fabric-loader'] ?? deps['quilt-loader']
            ? 'fabric'
            : deps['forge-loader'] || deps.forge
              ? 'forge'
              : undefined;
          info = { kind: 'mrpack', mcVersion, loader };
        } catch {
          info = null;
        }
      }
    }

    if (!info && entries.includes('manifest.json')) {
      const text = await readZipEntryText(filePath, 'manifest.json');
      if (text) {
        try {
          const manifest = JSON.parse(text) as CurseforgeManifest;
          const mcVersion = manifest.minecraft?.version;
          const loaders = manifest.minecraft?.modLoaders ?? [];
          // Prefer the marked-primary loader; fall back to the first listed
          // (some CurseForge exports omit the primary flag).
          const loaderId = (loaders.find((l) => l.primary) ?? loaders[0])?.id;
          let loader: 'forge' | 'fabric' | undefined;
          if (loaderId?.includes('forge')) loader = 'forge';
          else if (loaderId?.includes('fabric')) loader = 'fabric';
          info = { kind: 'zip', mcVersion, loader };
        } catch {
          info = null;
        }
      }
    }

    // Fallback for bare server dumps: sniff the version from any recognizable
    // server jar name (forge-..., paper-..., minecraft_server.<ver>.jar).
    // Jars under mods/ are mods, not server jars — they must not make a
    // modpack look like a vanilla server dump.
    if (!info) {
      const jarEntries = entries.filter(
        (e) =>
          e.endsWith('.jar') &&
          !e.endsWith('/') &&
          !e.startsWith('mods/') &&
          !e.startsWith('overrides/mods/'),
      );
      const forgeJar = jarEntries.find((e) => {
        const base = path.basename(e);
        return base.startsWith('forge-') && base !== 'forge-installer.jar';
      });
      const mcVersion = jarEntries
        .map((e) => sniffVersionFromJar(path.basename(e)))
        .find(Boolean);
      const hasForgeInstaller = entries.some((e) => path.basename(e) === 'forge-installer.jar');
      if (mcVersion || hasForgeInstaller || jarEntries.length > 0) {
        info = {
          kind: 'zip',
          mcVersion,
          loader: forgeJar || hasForgeInstaller ? 'forge' : undefined,
        };
      }
    }

    // Last fallback: a zip with a mods/ folder is a modpack even without a
    // manifest or recognizable jar. Sniff the mod JARs for their loader
    // (fabric.mod.json / META-INF/mods.toml) + MC version. This also upgrades
    // a bare server.jar dump whose mods are actually Forge/Fabric. When the
    // sniff yields nothing, the user picks the loader manually (flavorOverride).
    if (!info || (entries.some((e) => e === 'mods' || e.startsWith('mods/')) && !info.loader)) {
      const hasMods = entries.some((e) => e === 'mods' || e.startsWith('mods/'));
      if (hasMods) {
        const sniffed = await sniffModsForLoader(filePath, entries);
        const jarMc = entries
          .filter((e) => e.startsWith('mods/') && e.endsWith('.jar') && !e.endsWith('/'))
          .map((e) => sniffVersionFromJar(path.basename(e)))
          .find(Boolean);
        info = {
          kind: 'zip',
          mcVersion: sniffed.mcVersion ?? info?.mcVersion ?? jarMc ?? null,
          loader: sniffed.loader ?? info?.loader,
        };
      }
    }

    // A batch launcher (start.bat / run.bat) with no manifest, jar, or mods/
    // is still a Java server pack: the .bat wraps `java -jar <server jar>`
    // (the real jar often lives under libraries/ or a subfolder). Sniff the
    // launcher's content for a versioned jar name. This also upgrades a
    // mods-only zip whose launcher references a versioned server jar.
    if (!info || (hasLauncherCandidates(entries) && !info.mcVersion)) {
      const launcherEntry = entries.find((e) => isBatchLauncherEntry(e));
      if (launcherEntry) {
        const content = await readZipEntryText(filePath, launcherEntry);
        const mcVersion = content ? sniffVersionFromLauncherContent(content) : null;
        info = {
          kind: 'zip',
          mcVersion: mcVersion ?? info?.mcVersion ?? null,
          loader: info?.loader,
        };
      }
    }

    if (!info) return null;

    const hasMods = entries.some((e) => e === 'mods' || e.startsWith('mods/'));
    // A "runnable server jar" must sit at the zip root — that's what the app
    // would launch directly (findServerJar only looks at the folder root).
    // A server.jar under libraries/ (typical of start.bat packs) is not the
    // launch target; the batch launcher is.
    const hasServerJar =
      entries.some((e) => !e.includes('/') && path.basename(e) === 'server.jar') ||
      entries.some((e) => {
        if (e.includes('/')) return false;
        const base = path.basename(e);
        return base.startsWith('forge-') && base !== 'forge-installer.jar' && base.includes('universal');
      });
    const hasForgeInstaller = entries.some((e) => path.basename(e) === 'forge-installer.jar');
    const hasLauncher = entries.some((e) => {
      const base = path.basename(e).toLowerCase();
      return (
        base.endsWith('.bat') &&
        ['start', 'run', 'start-server', 'startserver', 'launch', 'server'].includes(
          base.replace(/\.bat$/, ''),
        )
      );
    });

    return {
      ...info,
      hasServerJar,
      needsInstallStep: !!hasForgeInstaller && !hasServerJar,
      hasLauncher,
    };
  }

  /**
   * Extract a pack into the server folder: .jar files under mods/ → mods/,
   * everything else → the folder, skipping live-server paths. Returns counts.
   */
  private async extract(
    serverFolder: string,
    filePath: string,
  ): Promise<{ modsAdded: number; filesCopied: number; skipped: number; error?: string }> {
    const modsDir = path.join(serverFolder, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });

    const kind = filePath.toLowerCase().endsWith('.mrpack') ? 'mrpack' : 'zip';
    let modsAdded = 0;
    let filesCopied = 0;
    let skipped = 0;

    await walkZip(filePath, (entry, stream) => {
      const raw = entry.fileName.replace(/\\/g, '/');
      let rel = kind === 'mrpack' ? stripPrefix(raw, 'overrides/') : raw;
      if (kind === 'zip') rel = stripPrefix(rel, 'overrides/');
      if (!rel || rel.endsWith('/')) {
        stream.resume();
        return;
      }

      // The pack's own metadata files are not server files.
      if (rel === 'modrinth.index.json' || rel === 'manifest.json') {
        skipped += 1;
        stream.resume();
        return;
      }

      const target = safeJoin(serverFolder, rel);
      if (!target || shouldSkip(rel)) {
        skipped += 1;
        stream.resume();
        return;
      }

      if (rel.startsWith('mods/')) {
        if (!rel.endsWith('.jar')) {
          skipped += 1;
          stream.resume();
          return;
        }
        const dest = path.join(modsDir, path.basename(rel));
        if (fs.existsSync(dest)) {
          skipped += 1;
          stream.resume();
          return;
        }
        writeEntryStream(stream, dest);
        modsAdded += 1;
        return;
      }

      // Everything else (config, libraries/, the pack's own runnable jar,
      // a forge-installer.jar) lands in the folder root. A forge-installer
      // is either run by the install step or ignored by findServerJar.
      writeEntryStream(stream, target);
      filesCopied += 1;
    });

    return { modsAdded, filesCopied, skipped };
  }

  private inspectionFail(error: string): PackInspection {
    return {
      ok: false,
      error,
      name: '',
      mcVersion: null,
      loader: null,
      hasServerJar: false,
      hasLauncher: false,
      needsInstallStep: false,
      requiredJava: 8,
      requiredJavaLabel: 'Java 8',
    };
  }

  private fail(error: string): CreateFromPackResult {
    return { ok: false, error };
  }

  private cleanup(folder: string): void {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Peek into up to MOD_SNIFF_LIMIT mod JARs inside the pack to infer the
 * loader (fabric.mod.json → Fabric; META-INF/mods.toml → Forge) and the
 * Minecraft version from the mods' declared dependencies / mods.toml.
 * Returns nulls when nothing recognizable is found (e.g. resource packs,
 * datapacks, or pure vanilla).
 */
async function sniffModsForLoader(
  filePath: string,
  entries: string[],
): Promise<{ loader?: 'forge' | 'fabric'; mcVersion?: string }> {
  const MOD_SNIFF_LIMIT = 5;
  const modJars = entries
    .filter((e) => e.startsWith('mods/') && e.endsWith('.jar') && !e.endsWith('/'))
    .slice(0, MOD_SNIFF_LIMIT);
  if (modJars.length === 0) return {};

  // Temp scratch dir for extracting a mod JAR so we can peek inside.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-pack-sniff-'));
  let loader: 'forge' | 'fabric' | undefined;
  let mcVersion: string | undefined;

  try {
    for (const jarEntry of modJars) {
      const jarPath = path.join(scratch, path.basename(jarEntry));
      const extracted = await extractZipEntryToFile(filePath, jarEntry, jarPath);
      if (!extracted) continue;

      // Fabric mods carry fabric.mod.json at the JAR root.
      const fabricJson = await readZipEntryText(jarPath, 'fabric.mod.json');
      if (fabricJson) {
        try {
          const json = JSON.parse(fabricJson) as {
            depends?: Record<string, unknown>;
            id?: string;
          };
          loader = 'fabric';
          const mc = json.depends?.minecraft;
          if (typeof mc === 'string' && mc && !mcVersion) {
            // Depends may be ">=1.19 <1.21" style; grab the first concrete
            // version token.
            const match = mc.match(/(\d+\.\d+(?:\.\d+)?)/);
            if (match) mcVersion = match[1];
          }
          break;
        } catch {
          // not a fabric mod
        }
      }

      // Forge mods ship META-INF/mods.toml (NeoForge: neoforge.mods.toml).
      const toml = await readZipEntryText(jarPath, 'META-INF/mods.toml') ??
        (await readZipEntryText(jarPath, 'META-INF/neoforge.mods.toml'));
      if (toml) {
        loader = 'forge';
        // MC version in mods.toml is inconsistent; try the common shapes:
        //   "minecraft"="1.19.2"        (some mods)
        //   [..forge] mcVersion="1.19.2" (NeoForge-style blocks)
        if (!mcVersion) {
          const mc =
            toml.match(/"minecraft"\s*=\s*\[?\s*"([^"]+)"/) ??
            toml.match(/mcVersion\s*=\s*"([^"]+)"/);
          if (mc) mcVersion = mc[1];
        }
        break;
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return { loader, mcVersion };
}

function writeServerProperties(
  filePath: string,
  options: { port: number },
): void {
  const lines = [
    '#Minecraft server properties',
    `server-port=${options.port}`,
    'level-name=world',
    'motd=A Minecraft Server',
    'max-players=20',
    'online-mode=true',
    'difficulty=easy',
    'gamemode=survival',
    'pvp=true',
    'white-list=false',
    'enable-command-block=false',
    'view-distance=10',
    'max-tick-time=60000',
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

/** Names of batch launcher files recognized as server launch scripts. */
const BATCH_LAUNCHER_NAMES = new Set([
  'start.bat',
  'run.bat',
  'start-server.bat',
  'startserver.bat',
  'launch.bat',
  'server.bat',
]);

/** True when a zip entry path is a recognized batch launcher at its root. */
function isBatchLauncherEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, '/');
  const base = normalized.split('/').pop()?.toLowerCase() ?? '';
  return BATCH_LAUNCHER_NAMES.has(base) && normalized.indexOf('/') === normalized.lastIndexOf('/') || false;
}

/** True when the zip contains any recognized batch launcher entry. */
function hasLauncherCandidates(entries: string[]): boolean {
  return entries.some((e) => isBatchLauncherEntry(e));
}

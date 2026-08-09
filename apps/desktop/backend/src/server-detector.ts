import fs from 'node:fs';
import path from 'node:path';
import type { ServerFlavor } from '@msc/shared-types';
import { isBatchLauncherName } from './launch-target';

/** A Minecraft server detected in an existing folder. */
export interface DetectedServer {
  edition: 'java' | 'bedrock';
  /** For java edition: which flavor of server jar is present. */
  flavor: ServerFlavor;
  /** Minecraft version sniffed from the server jar name, when readable. */
  version: string | null;
  /** True when recognized via a batch launcher (start.bat) instead of a jar. */
  isBatchLauncher?: boolean;
}

const BEDROCK_EXECUTABLES = ['bedrock_server.exe', 'bedrock_server.cmd', 'bedrock_server.bat'];

/**
 * Sniff a Minecraft version out of a server jar file name. Understands the
 * naming conventions used across loaders and eras:
 *
 *   forge-1.7.10-10.13.4.1614-1.7.10-universal.jar  -> 1.7.10
 *   forge-1.21.1-52.0.57.jar                        -> 1.21.1
 *   paper-1.21.1-131.jar                            -> 1.21.1
 *   fabric-server-launch.jar (no version)           -> null
 *   server.jar (no version)                         -> null
 *   minecraft_server.1.7.10.jar                     -> 1.7.10
 *
 * Returns null when no recognizable version is embedded in the name.
 */
export function sniffVersionFromJar(fileName: string): string | null {
  const base = fileName.replace(/\.jar$/i, '');

  // minecraft_server.<version>.jar (vanilla server, old naming).
  let match = base.match(/^minecraft_server\.([\d.]+)$/);
  if (match) return match[1];

  // minecraft_server.<version>(-...).jar variants.
  match = base.match(/^minecraft_server\.([\d.]+)/);
  if (match) return match[1];

  // forge-<mc>-<build>... (newer) and forge-<mc>-<build>-<mc>-universal (1.7.x era).
  match = base.match(/^forge-([\d.]+)/);
  if (match) return match[1];

  // paper-<mc>-<build>.
  match = base.match(/^paper-([\d.]+)/);
  if (match) return match[1];

  // Generic "<mc>.jar" (single renamed server jar) and "spigot-<mc>.jar".
  match = base.match(/(?:^|[-_])(1\.\d{1,2}(?:\.\d{1,2})?)$/);
  if (match) return match[1];

  return null;
}

/**
 * Inspects a folder and returns what kind of Minecraft server it contains,
 * or null when it does not look like a server folder.
 *
 * Detection mirrors `findServerJar` / `findServerExecutable` in
 * process-manager.ts so "can this folder run" and "what is in this folder"
 * never disagree. Order matters: Bedrock wins on its executable, then the
 * Java flavors from most to least specific.
 */
export function detectServerFolder(folderPath: string): DetectedServer | null {
  if (!folderPath || !fs.existsSync(folderPath)) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(folderPath);
  } catch {
    return null;
  }

  // Bedrock dedicated server.
  for (const name of BEDROCK_EXECUTABLES) {
    if (entries.includes(name)) return { edition: 'bedrock', flavor: 'vanilla', version: null };
  }

  const jars = entries.filter((f) => f.endsWith('.jar'));

  // A folder with no *runnable* jar but a batch launcher (start.bat /
  // run.bat / …) is a Java server pack: the .bat wraps `java -jar <server
  // jar>`, so it is a Java server even though the real jar sits under
  // libraries/ or another subfolder. Installer jars (forge-installer.jar /
  // forge-<mc>-<build>-installer.jar) are bootstrap GUIs, not runnable
  // servers, so they don't count as a real jar either — a Forge pack that
  // ships only the installer plus a launcher is still a batch-launcher pack.
  const runnableJars = jars.filter((f) => !f.includes('-installer.'));
  if (runnableJars.length === 0) {
    const launcher = entries.find(isBatchLauncherName);
    if (launcher) {
      return {
        edition: 'java',
        flavor: 'vanilla',
        version: sniffVersionFromLauncher(path.join(folderPath, launcher)),
        isBatchLauncher: true,
      };
    }
    return null;
  }

  if (jars.includes('fabric-server-launch.jar')) {
    return { edition: 'java', flavor: 'fabric', version: sniffVersionFromJar('fabric-server-launch.jar') };
  }
  const forgeJars = jars.filter(
    (f) =>
      f.startsWith('forge-') &&
      // Exclude installer jars — both legacy forge-installer.jar and modern
      // forge-<mc>-<build>-installer.jar are bootstrap GUIs, not servers.
      !f.includes('-installer.'),
  );
  if (forgeJars.length > 0) {
    return {
      edition: 'java',
      flavor: 'forge',
      version: sniffVersionFromJar(forgeJars[0]),
    };
  }
  // A Forge installer (forge-<mc>-<build>-installer.jar) marks a Forge pack
  // even when the real server jar sits under libraries/. If a recognized
  // batch launcher is present too, the pack is launched by the script — a
  // root server.jar in that case is the Forge shim/wrapper, not vanilla.
  const hasForgeInstaller = jars.some(
    (f) => f.startsWith('forge-') && f.includes('-installer.'),
  );
  if (hasForgeInstaller) {
    const launcher = entries.find(isBatchLauncherName);
    if (launcher) {
      return {
        edition: 'java',
        flavor: 'vanilla',
        version: sniffVersionFromLauncher(path.join(folderPath, launcher)),
        isBatchLauncher: true,
      };
    }
  }
  const paperJars = jars.filter((f) => f.startsWith('paper-'));
  if (paperJars.length > 0) {
    return {
      edition: 'java',
      flavor: 'paper',
      version: sniffVersionFromJar(paperJars[0]),
    };
  }
  if (jars.includes('server.jar')) {
    return { edition: 'java', flavor: 'vanilla', version: null };
  }
  // A lone other jar (e.g. a renamed server jar) is treated as vanilla,
  // matching findServerJar's single-jar fallback. A lone forge installer is
  // not a runnable server, so it is excluded.
  const launcherJars = jars.filter((f) => f !== 'forge-installer.jar');
  if (launcherJars.length === 1) {
    return {
      edition: 'java',
      flavor: 'vanilla',
      version: sniffVersionFromJar(launcherJars[0]),
    };
  }
  return null;
}

/** Convenience for building a server_type string from a DetectedServer. */
export function detectedServerType(detected: DetectedServer): string {
  return detected.edition === 'bedrock' ? 'bedrock' : detected.flavor;
}

/** Human-readable label for the detected flavor. */
export function detectedServerLabel(detected: DetectedServer): string {
  if (detected.edition === 'bedrock') return 'Bedrock';
  const labels: Record<ServerFlavor, string> = {
    vanilla: 'Vanilla',
    fabric: 'Fabric',
    forge: 'Forge',
    paper: 'Paper',
  };
  return labels[detected.flavor];
}

/** Default folder basename for naming a detected server. */
export function folderBaseName(folderPath: string): string {
  return path.basename(folderPath);
}

/**
 * Sniff a Minecraft version out of a batch launcher (start.bat / run.bat).
 * Packs that ship only a launcher typically reference the server jar inside
 * it (e.g. `java -jar libraries/net/minecraft/server/1.7.10/server.jar`), so
 * scan the file content for a recognizable versioned jar name — either a jar
 * with a version embedded in its filename, or a version-like path segment
 * (the `1.7.10/` folder in a Maven-style server.jar path). Returns null when
 * the launcher is missing/unreadable or names no versioned jar.
 */
export function sniffVersionFromLauncher(launcherPath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(launcherPath, 'utf8');
  } catch {
    return null;
  }
  return sniffVersionFromLauncherContent(content);
}

/** Sniff a Minecraft version out of batch launcher text content. */
export function sniffVersionFromLauncherContent(content: string): string | null {
  const jarNames = content.match(/[\w./\\-]*[\w-]\.jar/gi) ?? [];
  for (const jar of jarNames) {
    // 1) Version in the jar filename (e.g. minecraft_server.1.7.10.jar).
    const base = jar.split(/[\\/]/).pop() ?? jar;
    const filenameVersion = sniffVersionFromJar(base);
    if (filenameVersion) return filenameVersion;
    // 2) Version as a Maven path segment (e.g. .../server/1.7.10/server.jar).
    const pathSegments = jar.split(/[\\/]/);
    for (const segment of pathSegments) {
      if (/^1\.\d{1,2}(\.\d{1,2})?$/.test(segment)) return segment;
    }
  }
  return null;
}

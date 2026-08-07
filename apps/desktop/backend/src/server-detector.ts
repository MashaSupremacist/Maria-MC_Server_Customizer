import fs from 'node:fs';
import path from 'node:path';
import type { ServerFlavor } from '@msc/shared-types';

/** A Minecraft server detected in an existing folder. */
export interface DetectedServer {
  edition: 'java' | 'bedrock';
  /** For java edition: which flavor of server jar is present. */
  flavor: ServerFlavor;
}

const BEDROCK_EXECUTABLES = ['bedrock_server.exe', 'bedrock_server.cmd', 'bedrock_server.bat'];

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
    if (entries.includes(name)) return { edition: 'bedrock', flavor: 'vanilla' };
  }

  const jars = entries.filter((f) => f.endsWith('.jar'));
  if (jars.length === 0) return null;

  if (jars.includes('fabric-server-launch.jar')) {
    return { edition: 'java', flavor: 'fabric' };
  }
  const forgeJars = jars.filter((f) => f.startsWith('forge-') && f !== 'forge-installer.jar');
  if (forgeJars.length > 0) {
    return { edition: 'java', flavor: 'forge' };
  }
  const paperJars = jars.filter((f) => f.startsWith('paper-'));
  if (paperJars.length > 0) {
    return { edition: 'java', flavor: 'paper' };
  }
  if (jars.includes('server.jar')) {
    return { edition: 'java', flavor: 'vanilla' };
  }
  // A lone other jar (e.g. a renamed server jar) is treated as vanilla,
  // matching findServerJar's single-jar fallback. A lone forge installer is
  // not a runnable server, so it is excluded.
  const launcherJars = jars.filter((f) => f !== 'forge-installer.jar');
  if (launcherJars.length === 1) {
    return { edition: 'java', flavor: 'vanilla' };
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

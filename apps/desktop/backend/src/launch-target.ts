import fs from 'node:fs';
import path from 'node:path';

/** Launcher scripts supported consistently by inspection, detection and runtime. */
export const BATCH_LAUNCHER_NAMES = Object.freeze([
  'start.bat',
  'run.bat',
  'start-server.bat',
  'startserver.bat',
  'launch.bat',
  'server.bat',
]);

const launcherNames = new Set(BATCH_LAUNCHER_NAMES);

export function isBatchLauncherName(name: string): boolean {
  return launcherNames.has(name.toLowerCase());
}

/** Archives may use `/` or `\`; launchers are valid only at the effective root. */
export function isRootBatchLauncherEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  return !normalized.includes('/') && isBatchLauncherName(normalized);
}

export function findBatchLauncher(folderPath: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const launcher = entries.find(isBatchLauncherName);
  return launcher ? path.join(folderPath, launcher) : null;
}

/**
 * Return the single wrapper directory shared by every archive entry, or null
 * when any payload exists at the archive root / across multiple roots.
 */
export function findCommonArchiveRoot(entries: readonly string[]): string | null {
  const payload = entries
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .filter((entry) => !entry.startsWith('__MACOSX/'));
  if (payload.length === 0 || payload.some((entry) => !entry.includes('/'))) return null;
  const first = payload[0].split('/')[0];
  const semanticRoots = new Set([
    'config', 'defaultconfigs', 'kubejs', 'libraries', 'mods', 'overrides',
    'plugins', 'resourcepacks', 'scripts', 'world',
  ]);
  if (semanticRoots.has(first.toLowerCase())) return null;
  return payload.every((entry) => entry.split('/')[0] === first) ? `${first}/` : null;
}

export function stripArchiveRoot(entry: string, root: string | null): string {
  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  return root && normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

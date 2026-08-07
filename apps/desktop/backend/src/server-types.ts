import path from 'node:path';
import type { ServerFlavor, ServerTypeOption } from '@msc/shared-types';

/**
 * Registry of supported Java server flavors. Each flavor is a server JAR in a
 * folder, launched with `java -jar <jar> nogui`, plus an optional extension
 * folder (mods/ for Fabric/Forge, plugins/ for Paper). The installer and
 * extension manager are flavor-parameterized by this metadata.
 */
export interface FlavorMeta {
  id: ServerFlavor;
  label: string;
  description: string;
  /** Folder that holds mods/plugins; null for Vanilla. */
  extensionFolder: 'mods' | 'plugins' | null;
  /** Forge runs an installer jar with --installServer at install time. */
  requiresInstallStep: boolean;
}

const FLAVORS: FlavorMeta[] = [
  {
    id: 'vanilla',
    label: 'Vanilla',
    description: 'The official Mojang server. No mods or plugins.',
    extensionFolder: null,
    requiresInstallStep: false,
  },
  {
    id: 'fabric',
    label: 'Fabric',
    description: 'Lightweight mod loader. Mods live in a mods/ folder.',
    extensionFolder: 'mods',
    requiresInstallStep: false,
  },
  {
    id: 'forge',
    label: 'Forge',
    description: 'The classic mod loader. Mods live in a mods/ folder.',
    extensionFolder: 'mods',
    requiresInstallStep: true,
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'High-performance server with plugin support (plugins/ folder).',
    extensionFolder: 'plugins',
    requiresInstallStep: false,
  },
];

const FLAVOR_MAP = new Map(FLAVORS.map((f) => [f.id, f]));

/** Metadata for a flavor, or null for unknown flavors. */
export function flavorMeta(flavor: string): FlavorMeta | null {
  return FLAVOR_MAP.get(flavor as ServerFlavor) ?? null;
}

/** The list of selectable server types for the New Server form. */
export function listServerTypes(): ServerTypeOption[] {
  return FLAVORS.map((f) => ({
    id: f.id,
    label: f.label,
    description: f.description,
    hasExtensions: f.extensionFolder !== null,
    requiresInstallStep: f.requiresInstallStep,
  }));
}

/** Absolute path to a server's extension folder (mods/ or plugins/). */
export function extensionFolderFor(flavor: string, serverFolder: string): string | null {
  const meta = flavorMeta(flavor);
  if (!meta?.extensionFolder) return null;
  return path.join(serverFolder, meta.extensionFolder);
}

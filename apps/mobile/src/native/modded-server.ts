import { registerPlugin } from '@capacitor/core';

export type ModdedFlavor = 'forge' | 'fabric' | 'paper' | 'vanilla';

export interface ModdedFlavorInfo {
  id: ModdedFlavor;
  label: string;
  minimumJava: number;
  maximumJava: number;
  extensionDirectory: 'mods' | 'plugins';
}

export interface LaunchDescriptor {
  kind: 'jar' | 'translated-batch';
  script?: string;
  jar: string;
  mainClass?: string;
  jvmArgs: string[];
  serverArgs: string[];
  classpath: string[];
  workingDirectory?: string;
  source: 'jar' | 'batch-translation';
}

export interface ImportedServerPack {
  canceled: boolean;
  serverId: string;
  name?: string;
  flavor?: ModdedFlavor;
  version?: string;
  requiredJava?: number;
  launch?: LaunchDescriptor;
  serverDirectory?: string;
  status?: 'ready';
}

export interface ModdedExtension {
  name: string;
  enabled: boolean;
  bytes: number;
}

export interface ModdedServerPlugin {
  getFlavorCatalog(): Promise<{ flavors: ModdedFlavorInfo[] }>;
  importServerPack(options: { serverId: string; serverName: string; ramMb: number; eulaAccepted: boolean }): Promise<ImportedServerPack>;
  translateLauncher(options: { serverId: string }): Promise<{ serverId: string; launch: LaunchDescriptor }>;
  listExtensions(options: { serverId: string; kind: 'mods' | 'plugins' }): Promise<{ serverId: string; kind: 'mods' | 'plugins'; extensions: ModdedExtension[] }>;
  setExtensionEnabled(options: { serverId: string; kind: 'mods' | 'plugins'; name: string; enabled: boolean }): Promise<{ serverId: string; kind: 'mods' | 'plugins'; name: string; enabled: boolean }>;
}

export const ModdedServer = registerPlugin<ModdedServerPlugin>('ModdedServer');

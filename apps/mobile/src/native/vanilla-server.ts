import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface VanillaVersion { id: string; url: string; releaseTime: string; }
export interface VanillaVersionList { latestRelease: string; versions: VanillaVersion[]; }
export interface VanillaInstallResult {
  serverId: string;
  name: string;
  version: string;
  serverDirectory: string;
  serverJar: string;
  status: 'ready';
}
export interface VanillaProgress {
  serverId: string;
  status: 'resolving' | 'downloading' | 'verifying' | 'complete' | 'failed';
  percent: number | null;
  message: string;
}
export interface VanillaServerPlugin {
  listVersions(): Promise<VanillaVersionList>;
  install(options: { serverId: string; serverName: string; version: string; ramMb: number; eulaAccepted: boolean; ramOverrideAcknowledged?: boolean }): Promise<VanillaInstallResult>;
  addListener(eventName: 'serverProgress', listenerFunc: (progress: VanillaProgress) => void): Promise<PluginListenerHandle>;
}
export const VanillaServer = registerPlugin<VanillaServerPlugin>('VanillaServer');

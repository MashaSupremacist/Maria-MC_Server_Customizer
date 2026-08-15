import { registerPlugin } from '@capacitor/core';

export interface ServerPropertySetting {
  key: string;
  value: string;
  defaultValue: string;
  known: boolean;
}

export interface ServerPropertiesResult {
  serverId: string;
  exists: boolean;
  properties: Record<string, string>;
  settings: ServerPropertySetting[];
}

export interface ServerPropertiesUpdateResult {
  serverId: string;
  changed: boolean;
  restartRequired: boolean;
  backupPath: string;
  settings?: ServerPropertySetting[];
}

export interface GameruleSetting {
  name: string;
  value: string;
  defaultValue: string;
  available: boolean;
}

export interface GamerulesResult {
  serverId: string;
  rules: GameruleSetting[];
  versionAware: boolean;
  online: boolean;
}

export interface GameruleUpdateResult {
  serverId: string;
  name: string;
  value: string;
  commandSent: boolean;
  restartRequired: boolean;
}

export interface PlayerAdministrationResult {
  serverId: string;
  whitelist: unknown[];
  operators: unknown[];
  bannedPlayers: unknown[];
  bannedIps: unknown[];
}

export interface WorldInfo {
  name: string;
  path: string;
  valid: boolean;
  sizeBytes: number;
  lastModified: number;
}

export interface BackupInfo {
  name: string;
  path: string;
  bytes: number;
  createdAt: number;
}

export interface InstalledServerSummary {
  serverId: string;
  name: string;
  version: string;
  flavor: string;
  ramMb: number;
  status: string;
}

export interface ServerLogTailResult {
  serverId: string;
  exists: boolean;
  path: string;
  latestPath?: string;
  capturedPath?: string;
  lastModified: number;
  text: string;
}

export interface ServerManagementPlugin {
  listServers(): Promise<{ servers: InstalledServerSummary[] }>;
  deleteServer(options: { serverId: string }): Promise<{ serverId: string; deleted: boolean }>;
  getLogTail(options: { serverId: string; maxChars?: number }): Promise<ServerLogTailResult>;
  getServerProperties(options: { serverId: string }): Promise<ServerPropertiesResult>;
  updateServerProperties(options: { serverId: string; values: Record<string, string> }): Promise<ServerPropertiesUpdateResult>;
  resetServerProperties(options: { serverId: string }): Promise<ServerPropertiesUpdateResult>;
  getGamerules(options: { serverId: string }): Promise<GamerulesResult>;
  setGamerule(options: { serverId: string; name: string; value: string }): Promise<GameruleUpdateResult>;
  getPlayerAdministration(options: { serverId: string }): Promise<PlayerAdministrationResult>;
  runPlayerCommand(options: { serverId: string; command: string }): Promise<{ serverId: string; command: string; sent: boolean }>;
  listWorlds(options: { serverId: string }): Promise<{ serverId: string; worlds: WorldInfo[] }>;
  createDefaultWorld(options: { serverId: string; worldName?: string }): Promise<{ serverId: string; worldName: string; created: boolean; generatedByServer: boolean; message: string }>;
  copyWorld(options: { serverId: string; sourceWorld: string; destinationWorld: string }): Promise<{ serverId: string; worldName: string; copied: boolean }>;
  deleteWorld(options: { serverId: string; worldName: string }): Promise<{ serverId: string; worldName: string; deleted: boolean; backupPath: string }>;
  importWorld(options: { serverId: string; worldName?: string }): Promise<{ canceled?: boolean; serverId: string; worldName?: string; imported?: boolean }>;
  exportWorld(options: { serverId: string; worldName: string }): Promise<{ exported: boolean; canceled?: boolean }>;
  listBackups(options: { serverId: string }): Promise<{ serverId: string; backups: BackupInfo[] }>;
  createBackup(options: { serverId: string; retentionLimit?: number }): Promise<{ serverId: string; name: string; path: string; bytes: number }>;
  deleteBackup(options: { serverId: string; name: string }): Promise<{ serverId: string; name: string; deleted: boolean }>;
  restoreBackup(options: { serverId: string; name: string }): Promise<{ serverId: string; restored: boolean; safetyBackupPath: string }>;
  exportBackup(options: { serverId: string; name: string }): Promise<{ exported: boolean; canceled?: boolean }>;
}

export const ServerManagement = registerPlugin<ServerManagementPlugin>('ServerManagement');

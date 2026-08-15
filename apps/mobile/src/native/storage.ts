import { registerPlugin } from '@capacitor/core';

export interface ManagedStorageLayout {
  root: string;
  servers: string;
  backups: string;
  runtimes: string;
  downloads: string;
  logs: string;
  appData: string;
}

export interface ManagedDirectoryResult {
  serverId: string;
  path: string;
  existed: boolean;
}

export interface ManagedFileResult {
  relativePath: string;
  path: string;
  bytes: number;
}

export interface ManagedPathValidation {
  valid: boolean;
  path?: string;
  error?: string;
}

export interface StoragePlugin {
  getStorageLayout(): Promise<ManagedStorageLayout>;
  createServerDirectory(options: { serverId: string }): Promise<ManagedDirectoryResult>;
  deleteServerDirectory(options: { serverId: string }): Promise<{ serverId: string; deleted: boolean }>;
  writeTestFile(options: { relativePath: string; content: string }): Promise<ManagedFileResult>;
  validateManagedPath(options: { relativePath: string }): Promise<ManagedPathValidation>;
  importFile(options?: { destinationRelativePath?: string }): Promise<ManagedFileResult & { canceled?: boolean }>;
  exportFile(options: { relativePath: string }): Promise<{ exported: boolean; canceled?: boolean; relativePath: string }>;
}

export const Storage = registerPlugin<StoragePlugin>('Storage');

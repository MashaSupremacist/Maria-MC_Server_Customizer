import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo,
  AppSettings,
  BackendInfo,
  BackupEntry,
  BedrockAllowlistEntry,
  BedrockPermissionEntry,
  BedrockVersion,
  CommandResult,
  CreateBackupRequest,
  CreateServerInput,
  ConvertServerRequest,
  DetectedServerInfo,
  ExtensionListResponse,
  FolderSelectResult,
  GamerulesDocument,
  ImportWorldRequest,
  InstallBedrockRequest,
  InstallJavaRequest,
  InstallServerRequest,
  InstallVanillaRequest,
  JavaDownloadInfo,
  JavaInstallation,
  JavaProgress,
  JavaRequirement,
  LogLine,
  PackKind,
  PackListResponse,
  PlayerListEntry,
  PlayitSettings,
  PlayitStatus,
  RestoreBackupRequest,
  SaveFolderSuggestion,
  ServerPropertiesDocument,
  ServerRecord,
  ServerStatus,
  ServerTypeOption,
  ShellOpenResult,
  StartServerError,
  UpdatePropertiesRequest,
  UpdateServerInput,
  VanillaVersion,
  WorldDiscoveryResult,
} from '@msc/shared-types';

/**
 * IPC channel names, kept as local constants so the sandboxed preload never
 * needs to resolve a runtime module from node_modules. They must stay in sync
 * with IpcChannels in @msc/shared-types.
 */
const CHANNELS = {
  appInfo: 'app:info',
  checkForUpdate: 'app:check-for-update',
  openReleaseUrl: 'app:open-release-url',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  backendInfo: 'backend:info',
  selectServerLibrary: 'dialog:select-server-library',
  getSettings: 'settings:get',
  setSetting: 'settings:set',
  listServers: 'servers:list',
  createServer: 'servers:create',
  detectServerFolder: 'servers:detect-folder',
  updateServer: 'servers:update',
  deleteServer: 'servers:delete',
  selectJavaExecutable: 'dialog:select-java',
  selectPlayitExecutable: 'dialog:select-playit',
  openServerFolder: 'shell:open-server-folder',
  getServerStatus: 'process:status',
  startServer: 'process:start',
  stopServer: 'process:stop',
  restartServer: 'process:restart',
  forceKillServer: 'process:force-kill',
  sendServerCommand: 'process:command',
  getServerLogs: 'process:logs',
  getVanillaVersions: 'vanilla:versions',
  installVanillaServer: 'vanilla:install',
  cancelVanillaInstall: 'vanilla:cancel',
  detectJava: 'java:detect',
  getRequiredJava: 'java:required',
  getJavaDownloadInfo: 'java:download-info',
  installJava: 'java:install',
  cancelJavaInstall: 'java:cancel',
  getJavaInstallStatus: 'java:install-status',
  getServerProperties: 'servers:properties:get',
  updateServerProperties: 'servers:properties:update',
  getGamerules: 'servers:gamerules:get',
  updateGamerule: 'servers:gamerules:update',
  getWhitelist: 'servers:whitelist:get',
  updateWhitelist: 'servers:whitelist:update',
  getOperators: 'servers:ops:get',
  updateOperators: 'servers:ops:update',
  getBans: 'servers:bans:get',
  updateBans: 'servers:bans:update',
  getIpBans: 'servers:ip-bans:get',
  updateIpBans: 'servers:ip-bans:update',
  runPlayerCommand: 'servers:players:command',
  selectWorldFolder: 'dialog:select-world-folder',
  discoverWorlds: 'worlds:discover',
  getSaveFolders: 'worlds:save-folders',
  importWorld: 'worlds:import',
  cancelWorldImport: 'worlds:cancel',
  listBackups: 'backups:list',
  createBackup: 'backups:create',
  deleteBackup: 'backups:delete',
  restoreBackup: 'backups:restore',
  getPlayitSettings: 'playit:settings:get',
  updatePlayitSettings: 'playit:settings:update',
  detectPlayit: 'playit:detect',
  getPlayitStatus: 'playit:status',
  startPlayit: 'playit:start',
  stopPlayit: 'playit:stop',
  forceKillPlayit: 'playit:kill',
  listServerTypes: 'server-types:list',
  listFabricLoaders: 'server-types:fabric-loaders',
  installServer: 'server:install',
  convertServer: 'server:convert',
  cancelInstall: 'server:install:cancel',
  listExtensions: 'extensions:list',
  uploadExtensions: 'extensions:upload',
  enableExtension: 'extensions:enable',
  disableExtension: 'extensions:disable',
  deleteExtension: 'extensions:delete',
  getBedrockVersions: 'bedrock:versions',
  installBedrockServer: 'bedrock:install',
  cancelBedrockInstall: 'bedrock:install:cancel',
  getBedrockProperties: 'bedrock:properties:get',
  updateBedrockProperties: 'bedrock:properties:update',
  getBedrockAllowlist: 'bedrock:allowlist:get',
  updateBedrockAllowlist: 'bedrock:allowlist:update',
  getBedrockPermissions: 'bedrock:permissions:get',
  updateBedrockPermissions: 'bedrock:permissions:update',
  listPacks: 'packs:list',
  uploadPack: 'packs:upload',
  deletePack: 'packs:delete',
} as const;

/**
 * Narrow, explicit preload bridge. The renderer only receives these methods —
 * no Node APIs, no arbitrary ipcRenderer access.
 */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CHANNELS.appInfo),
  checkForUpdate: (): Promise<import('@msc/shared-types').UpdateInfo> =>
    ipcRenderer.invoke(CHANNELS.checkForUpdate),
  openReleaseUrl: (url: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNELS.openReleaseUrl, url),
  minimizeWindow: (): void => ipcRenderer.send(CHANNELS.windowMinimize),
  toggleMaximizeWindow: (): void =>
    ipcRenderer.send(CHANNELS.windowToggleMaximize),
  closeWindow: (): void => ipcRenderer.send(CHANNELS.windowClose),

  getBackendInfo: (): Promise<BackendInfo> =>
    ipcRenderer.invoke(CHANNELS.backendInfo),
  selectServerLibrary: (): Promise<FolderSelectResult> =>
    ipcRenderer.invoke(CHANNELS.selectServerLibrary),

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke(CHANNELS.getSettings),
  setSetting: (key: keyof AppSettings, value: unknown): Promise<AppSettings> =>
    ipcRenderer.invoke(CHANNELS.setSetting, key, value),

  listServers: (): Promise<ServerRecord[]> =>
    ipcRenderer.invoke(CHANNELS.listServers),
  createServer: (input: CreateServerInput): Promise<ServerRecord> =>
    ipcRenderer.invoke(CHANNELS.createServer, input),
  detectServerFolder: (path: string): Promise<DetectedServerInfo> =>
    ipcRenderer.invoke(CHANNELS.detectServerFolder, path),
  updateServer: (id: string, input: UpdateServerInput): Promise<ServerRecord> =>
    ipcRenderer.invoke(CHANNELS.updateServer, id, input),
  deleteServer: (id: string, deleteFolder = false): Promise<{ deleted: boolean; folderDeleted?: boolean }> =>
    ipcRenderer.invoke(CHANNELS.deleteServer, id, deleteFolder),

  selectJavaExecutable: (): Promise<FolderSelectResult> =>
    ipcRenderer.invoke(CHANNELS.selectJavaExecutable),
  selectPlayitExecutable: (): Promise<FolderSelectResult> =>
    ipcRenderer.invoke(CHANNELS.selectPlayitExecutable),
  openServerFolder: (folderPath: string): Promise<ShellOpenResult> =>
    ipcRenderer.invoke(CHANNELS.openServerFolder, folderPath),

  getServerStatus: (id: string): Promise<ServerStatus> =>
    ipcRenderer.invoke(CHANNELS.getServerStatus, id),
  startServer: (id: string): Promise<{ error: StartServerError | null }> =>
    ipcRenderer.invoke(CHANNELS.startServer, id),
  stopServer: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNELS.stopServer),
  restartServer: (id: string): Promise<{ error: StartServerError | null }> =>
    ipcRenderer.invoke(CHANNELS.restartServer, id),
  forceKillServer: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNELS.forceKillServer),
  sendServerCommand: (id: string, command: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNELS.sendServerCommand, id, command),
  getServerLogs: (id: string): Promise<LogLine[]> =>
    ipcRenderer.invoke(CHANNELS.getServerLogs, id),

  getVanillaVersions: (): Promise<VanillaVersion[]> =>
    ipcRenderer.invoke(CHANNELS.getVanillaVersions),
  installVanillaServer: (request: InstallVanillaRequest): Promise<{ installId: string }> =>
    ipcRenderer.invoke(CHANNELS.installVanillaServer, request),
  cancelVanillaInstall: (installId: string): Promise<{ canceled: boolean }> =>
    ipcRenderer.invoke(CHANNELS.cancelVanillaInstall, installId),

  detectJava: (javaPath: string | null): Promise<JavaInstallation | null> =>
    ipcRenderer.invoke(CHANNELS.detectJava, javaPath),
  getRequiredJava: (version: string, javaPath: string | null): Promise<JavaRequirement> =>
    ipcRenderer.invoke(CHANNELS.getRequiredJava, version, javaPath),
  getJavaDownloadInfo: (major: number): Promise<JavaDownloadInfo> =>
    ipcRenderer.invoke(CHANNELS.getJavaDownloadInfo, major),
  installJava: (request: InstallJavaRequest): Promise<{ javaInstallId: string }> =>
    ipcRenderer.invoke(CHANNELS.installJava, request),
  cancelJavaInstall: (javaInstallId: string): Promise<{ canceled: boolean }> =>
    ipcRenderer.invoke(CHANNELS.cancelJavaInstall, javaInstallId),
  getJavaInstallStatus: (javaInstallId: string): Promise<{ progress: JavaProgress | null }> =>
    ipcRenderer.invoke(CHANNELS.getJavaInstallStatus, javaInstallId),

  getServerProperties: (id: string): Promise<ServerPropertiesDocument> =>
    ipcRenderer.invoke(CHANNELS.getServerProperties, id),
  updateServerProperties: (
    id: string,
    request: UpdatePropertiesRequest,
  ): Promise<{
    document: ServerPropertiesDocument;
    validation: { ok: boolean; errors: Record<string, string> };
  }> => ipcRenderer.invoke(CHANNELS.updateServerProperties, id, request),

  getGamerules: (id: string): Promise<GamerulesDocument> =>
    ipcRenderer.invoke(CHANNELS.getGamerules, id),
  updateGamerule: (id: string, key: string, value: string): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.updateGamerule, id, key, value),
  getWhitelist: (id: string): Promise<PlayerListEntry[]> =>
    ipcRenderer.invoke(CHANNELS.getWhitelist, id),
  updateWhitelist: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.updateWhitelist, id, players),
  getOperators: (id: string): Promise<PlayerListEntry[]> =>
    ipcRenderer.invoke(CHANNELS.getOperators, id),
  updateOperators: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.updateOperators, id, players),
  getBans: (id: string): Promise<PlayerListEntry[]> =>
    ipcRenderer.invoke(CHANNELS.getBans, id),
  updateBans: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.updateBans, id, players),
  getIpBans: (id: string): Promise<PlayerListEntry[]> =>
    ipcRenderer.invoke(CHANNELS.getIpBans, id),
  updateIpBans: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.updateIpBans, id, players),
  runPlayerCommand: (id: string, command: string): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.runPlayerCommand, id, command),
  selectWorldFolder: (): Promise<FolderSelectResult> =>
    ipcRenderer.invoke(CHANNELS.selectWorldFolder),
  discoverWorlds: (folder: string): Promise<WorldDiscoveryResult> =>
    ipcRenderer.invoke(CHANNELS.discoverWorlds, folder),
  getSaveFolders: (): Promise<SaveFolderSuggestion[]> =>
    ipcRenderer.invoke(CHANNELS.getSaveFolders),
  importWorld: (request: ImportWorldRequest): Promise<{ importId: string; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.importWorld, request),
  cancelWorldImport: (importId: string): Promise<{ canceled: boolean }> =>
    ipcRenderer.invoke(CHANNELS.cancelWorldImport, importId),
  listBackups: (serverId: string): Promise<BackupEntry[]> =>
    ipcRenderer.invoke(CHANNELS.listBackups, serverId),
  createBackup: (request: CreateBackupRequest): Promise<{ operationId: string; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.createBackup, request),
  deleteBackup: (backupId: string): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(CHANNELS.deleteBackup, backupId),
  restoreBackup: (request: RestoreBackupRequest): Promise<{ operationId: string; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.restoreBackup, request),

  getPlayitSettings: (): Promise<PlayitSettings> =>
    ipcRenderer.invoke(CHANNELS.getPlayitSettings),
  updatePlayitSettings: (
    patch: Partial<Pick<PlayitSettings, 'playitPath' | 'playitPublicAddress'>>,
  ): Promise<PlayitSettings> => ipcRenderer.invoke(CHANNELS.updatePlayitSettings, patch),
  detectPlayit: (playitPath: string | null): Promise<{ detected: boolean }> =>
    ipcRenderer.invoke(CHANNELS.detectPlayit, playitPath),
  getPlayitStatus: (): Promise<PlayitStatus> =>
    ipcRenderer.invoke(CHANNELS.getPlayitStatus),
  startPlayit: (playitPath: string): Promise<{ error: { code: string; message: string } | null }> =>
    ipcRenderer.invoke(CHANNELS.startPlayit, playitPath),
  stopPlayit: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNELS.stopPlayit),
  forceKillPlayit: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNELS.forceKillPlayit),

  listServerTypes: (): Promise<ServerTypeOption[]> =>
    ipcRenderer.invoke(CHANNELS.listServerTypes),
  listFabricLoaders: (version: string): Promise<string[]> =>
    ipcRenderer.invoke(CHANNELS.listFabricLoaders, version),
  installServer: (request: InstallServerRequest): Promise<{ installId: string }> =>
    ipcRenderer.invoke(CHANNELS.installServer, request),
  convertServer: (request: ConvertServerRequest): Promise<{ operationId: string; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.convertServer, request),
  cancelInstall: (installId: string): Promise<{ canceled: boolean }> =>
    ipcRenderer.invoke(CHANNELS.cancelInstall, installId),
  listExtensions: (serverId: string): Promise<ExtensionListResponse> =>
    ipcRenderer.invoke(CHANNELS.listExtensions, serverId),
  uploadExtensions: (
    serverId: string,
    files: Array<{ name: string; contentBase64: string; sizeBytes: number }>,
  ): Promise<{ ok: boolean; error?: string; added: string[] }> =>
    ipcRenderer.invoke(CHANNELS.uploadExtensions, serverId, files),
  enableExtension: (serverId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.enableExtension, serverId, name),
  disableExtension: (serverId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.disableExtension, serverId, name),
  deleteExtension: (serverId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.deleteExtension, serverId, name),

  getBedrockVersions: (): Promise<BedrockVersion[]> =>
    ipcRenderer.invoke(CHANNELS.getBedrockVersions),
  installBedrockServer: (request: InstallBedrockRequest): Promise<{ installId: string }> =>
    ipcRenderer.invoke(CHANNELS.installBedrockServer, request),
  cancelBedrockInstall: (installId: string): Promise<{ canceled: boolean }> =>
    ipcRenderer.invoke(CHANNELS.cancelBedrockInstall, installId),
  getBedrockProperties: (id: string): Promise<ServerPropertiesDocument> =>
    ipcRenderer.invoke(CHANNELS.getBedrockProperties, id),
  updateBedrockProperties: (
    id: string,
    request: UpdatePropertiesRequest,
  ): Promise<{
    document: ServerPropertiesDocument;
    validation: { ok: boolean; errors: Record<string, string> };
  }> => ipcRenderer.invoke(CHANNELS.updateBedrockProperties, id, request),
  getBedrockAllowlist: (id: string): Promise<BedrockAllowlistEntry[]> =>
    ipcRenderer.invoke(CHANNELS.getBedrockAllowlist, id),
  updateBedrockAllowlist: (id: string, entries: BedrockAllowlistEntry[]): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.updateBedrockAllowlist, id, entries),
  getBedrockPermissions: (id: string): Promise<BedrockPermissionEntry[]> =>
    ipcRenderer.invoke(CHANNELS.getBedrockPermissions, id),
  updateBedrockPermissions: (id: string, entries: BedrockPermissionEntry[]): Promise<CommandResult> =>
    ipcRenderer.invoke(CHANNELS.updateBedrockPermissions, id, entries),
  listPacks: (id: string, kind: PackKind): Promise<PackListResponse> =>
    ipcRenderer.invoke(CHANNELS.listPacks, id, kind),
  uploadPack: (
    id: string,
    kind: PackKind,
    files: Array<{ name: string; contentBase64: string; sizeBytes: number }>,
  ): Promise<{ ok: boolean; error?: string; added: string[] }> =>
    ipcRenderer.invoke(CHANNELS.uploadPack, id, kind, files),
  deletePack: (id: string, kind: PackKind, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNELS.deletePack, id, kind, name),
};

contextBridge.exposeInMainWorld('msc', api);

export type MscBridge = typeof api;

import type {
  AppSettings,
  BackupEntry,
  BedrockAllowlistEntry,
  BedrockPermissionEntry,
  BedrockVersion,
  CommandResult,
  ConvertServerRequest,
  CreateBackupRequest,
  CreateFromPackRequest,
  CreateFromPackResult,
  CreateServerInput,
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
  ModpackImportRequest,
  ModpackImportResult,
  PackInspection,
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
  StartServerError,
  UpdateInfo,
  UpdatePropertiesRequest,
  UpdateServerInput,
  VanillaVersion,
  WorldDiscoveryResult,
} from '@msc/shared-types';

/** Thin client over the narrow preload bridge. */
export const api = {
  getAppInfo: () => window.msc.getAppInfo(),
  checkForUpdate: (): Promise<UpdateInfo> => window.msc.checkForUpdate(),
  openReleaseUrl: (url: string): Promise<{ ok: boolean }> =>
    window.msc.openReleaseUrl(url),
  getBackendInfo: () => window.msc.getBackendInfo(),

  getSettings: (): Promise<AppSettings> => window.msc.getSettings(),
  setServerLibraryPath: (path: string | null): Promise<AppSettings> =>
    window.msc.setSetting('serverLibraryPath', path),
  setLastJavaPath: (path: string | null): Promise<AppSettings> =>
    window.msc.setSetting('lastJavaPath', path),
  selectServerLibrary: () => window.msc.selectServerLibrary(),
  selectJavaExecutable: () => window.msc.selectJavaExecutable(),
  selectPlayitExecutable: () => window.msc.selectPlayitExecutable(),

  listServers: (): Promise<ServerRecord[]> => window.msc.listServers(),
  createServer: (input: CreateServerInput): Promise<ServerRecord> =>
    window.msc.createServer(input),
  detectServerFolder: (path: string): Promise<DetectedServerInfo> =>
    window.msc.detectServerFolder(path),
  inspectPack: (filePath: string): Promise<PackInspection> =>
    window.msc.inspectPack(filePath),
  createServerFromPack: (request: CreateFromPackRequest): Promise<CreateFromPackResult> =>
    window.msc.createServerFromPack(request),
  updateServer: (id: string, input: UpdateServerInput): Promise<ServerRecord> =>
    window.msc.updateServer(id, input),
  deleteServer: (id: string, deleteFolder = false): Promise<{ deleted: boolean; folderDeleted?: boolean; error?: string }> =>
    window.msc.deleteServer(id, deleteFolder),

  openServerFolder: (serverId: string) => window.msc.openServerFolder(serverId),
  getServerStatus: (id: string): Promise<ServerStatus> =>
    window.msc.getServerStatus(id),
  startServer: (id: string): Promise<{ error: StartServerError | null }> =>
    window.msc.startServer(id),
  stopServer: (id: string): Promise<{ ok: boolean }> => window.msc.stopServer(id),
  restartServer: (id: string): Promise<{ error: StartServerError | null }> =>
    window.msc.restartServer(id),
  forceKillServer: (id: string): Promise<{ ok: boolean }> => window.msc.forceKillServer(id),
  sendServerCommand: (id: string, command: string): Promise<{ ok: boolean }> =>
    window.msc.sendServerCommand(id, command),
  getServerLogs: (id: string): Promise<LogLine[]> => window.msc.getServerLogs(id),

  getVanillaVersions: (): Promise<VanillaVersion[]> => window.msc.getVanillaVersions(),
  installVanillaServer: (request: InstallVanillaRequest): Promise<{ installId: string }> =>
    window.msc.installVanillaServer(request),
  cancelVanillaInstall: (installId: string): Promise<{ canceled: boolean }> =>
    window.msc.cancelVanillaInstall(installId),

  detectJava: (javaPath: string | null): Promise<JavaInstallation | null> =>
    window.msc.detectJava(javaPath),
  getRequiredJava: (version: string, javaPath: string | null): Promise<JavaRequirement> =>
    window.msc.getRequiredJava(version, javaPath),
  getJavaDownloadInfo: (major: number): Promise<JavaDownloadInfo> =>
    window.msc.getJavaDownloadInfo(major),
  installJava: (request: InstallJavaRequest): Promise<{ javaInstallId: string }> =>
    window.msc.installJava(request),
  cancelJavaInstall: (javaInstallId: string): Promise<{ canceled: boolean }> =>
    window.msc.cancelJavaInstall(javaInstallId),
  getJavaInstallStatus: (javaInstallId: string): Promise<{ progress: JavaProgress | null }> =>
    window.msc.getJavaInstallStatus(javaInstallId),

  getServerProperties: (id: string): Promise<ServerPropertiesDocument> =>
    window.msc.getServerProperties(id),
  updateServerProperties: (
    id: string,
    request: UpdatePropertiesRequest,
  ): Promise<{
    document: ServerPropertiesDocument;
    validation: { ok: boolean; errors: Record<string, string> };
  }> => window.msc.updateServerProperties(id, request),

  getGamerules: (id: string): Promise<GamerulesDocument> =>
    window.msc.getGamerules(id),
  updateGamerule: (id: string, key: string, value: string): Promise<CommandResult> =>
    window.msc.updateGamerule(id, key, value),

  getWhitelist: (id: string): Promise<PlayerListEntry[]> =>
    window.msc.getWhitelist(id),
  updateWhitelist: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    window.msc.updateWhitelist(id, players),
  getOperators: (id: string): Promise<PlayerListEntry[]> =>
    window.msc.getOperators(id),
  updateOperators: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    window.msc.updateOperators(id, players),
  getBans: (id: string): Promise<PlayerListEntry[]> =>
    window.msc.getBans(id),
  updateBans: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    window.msc.updateBans(id, players),
  getIpBans: (id: string): Promise<PlayerListEntry[]> =>
    window.msc.getIpBans(id),
  updateIpBans: (id: string, players: PlayerListEntry[]): Promise<CommandResult> =>
    window.msc.updateIpBans(id, players),
  runPlayerCommand: (id: string, command: string): Promise<CommandResult> =>
    window.msc.runPlayerCommand(id, command),

  selectWorldFolder: (): Promise<{ path: string | null; canceled: boolean }> =>
    window.msc.selectWorldFolder(),
  discoverWorlds: (folder: string): Promise<WorldDiscoveryResult> =>
    window.msc.discoverWorlds(folder),
  getSaveFolders: (): Promise<SaveFolderSuggestion[]> =>
    window.msc.getSaveFolders(),
  importWorld: (request: ImportWorldRequest): Promise<{ importId: string; error?: string }> =>
    window.msc.importWorld(request),
  cancelWorldImport: (importId: string): Promise<{ canceled: boolean }> =>
    window.msc.cancelWorldImport(importId),

  listBackups: (serverId: string): Promise<BackupEntry[]> =>
    window.msc.listBackups(serverId),
  createBackup: (request: CreateBackupRequest): Promise<{ operationId: string; error?: string }> =>
    window.msc.createBackup(request),
  deleteBackup: (backupId: string): Promise<{ deleted: boolean }> =>
    window.msc.deleteBackup(backupId),
  restoreBackup: (request: RestoreBackupRequest): Promise<{ operationId: string; error?: string }> =>
    window.msc.restoreBackup(request),
  cancelBackup: (operationId: string): Promise<{ canceled: boolean }> =>
    window.msc.cancelBackup(operationId),
  getOperationStatus: (operationId: string) => window.msc.getOperationStatus(operationId),

  getPlayitSettings: (): Promise<PlayitSettings> => window.msc.getPlayitSettings(),
  updatePlayitSettings: (
    patch: Partial<Pick<PlayitSettings, 'playitPath' | 'playitPublicAddress'>>,
  ): Promise<PlayitSettings> => window.msc.updatePlayitSettings(patch),
  detectPlayit: (playitPath: string | null): Promise<{ detected: boolean }> =>
    window.msc.detectPlayit(playitPath),
  getPlayitStatus: (): Promise<PlayitStatus> => window.msc.getPlayitStatus(),
  startPlayit: (): Promise<{ error: { code: string; message: string } | null }> =>
    window.msc.startPlayit(),
  stopPlayit: (): Promise<{ ok: boolean }> => window.msc.stopPlayit(),
  forceKillPlayit: (): Promise<{ ok: boolean }> => window.msc.forceKillPlayit(),

  listServerTypes: (): Promise<ServerTypeOption[]> => window.msc.listServerTypes(),
  listFabricLoaders: (version: string): Promise<string[]> =>
    window.msc.listFabricLoaders(version),
  installServer: (request: InstallServerRequest): Promise<{ installId: string }> =>
    window.msc.installServer(request),
  convertServer: (request: ConvertServerRequest): Promise<{ operationId: string; error?: string }> =>
    window.msc.convertServer(request),
  cancelInstall: (installId: string): Promise<{ canceled: boolean }> =>
    window.msc.cancelInstall(installId),
  listExtensions: (serverId: string): Promise<ExtensionListResponse> =>
    window.msc.listExtensions(serverId),
  uploadExtensions: (
    serverId: string,
  ): Promise<{ ok: boolean; error?: string; added: string[] }> =>
    window.msc.uploadExtensions(serverId),
  enableExtension: (serverId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    window.msc.enableExtension(serverId, name),
  disableExtension: (serverId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    window.msc.disableExtension(serverId, name),
  deleteExtension: (serverId: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    window.msc.deleteExtension(serverId, name),
  selectModpack: (): Promise<FolderSelectResult> => window.msc.selectModpack(),
  importModpack: (request: ModpackImportRequest): Promise<ModpackImportResult> =>
    window.msc.importModpack(request),

  getBedrockVersions: (): Promise<BedrockVersion[]> => window.msc.getBedrockVersions(),
  installBedrockServer: (request: InstallBedrockRequest): Promise<{ installId: string }> =>
    window.msc.installBedrockServer(request),
  cancelBedrockInstall: (installId: string): Promise<{ canceled: boolean }> =>
    window.msc.cancelBedrockInstall(installId),
  getBedrockProperties: (id: string): Promise<ServerPropertiesDocument> =>
    window.msc.getBedrockProperties(id),
  updateBedrockProperties: (
    id: string,
    request: UpdatePropertiesRequest,
  ): Promise<{
    document: ServerPropertiesDocument;
    validation: { ok: boolean; errors: Record<string, string> };
  }> => window.msc.updateBedrockProperties(id, request),
  getBedrockAllowlist: (id: string): Promise<BedrockAllowlistEntry[]> =>
    window.msc.getBedrockAllowlist(id),
  updateBedrockAllowlist: (id: string, entries: BedrockAllowlistEntry[]): Promise<CommandResult> =>
    window.msc.updateBedrockAllowlist(id, entries),
  getBedrockPermissions: (id: string): Promise<BedrockPermissionEntry[]> =>
    window.msc.getBedrockPermissions(id),
  updateBedrockPermissions: (id: string, entries: BedrockPermissionEntry[]): Promise<CommandResult> =>
    window.msc.updateBedrockPermissions(id, entries),
  listPacks: (id: string, kind: PackKind): Promise<PackListResponse> =>
    window.msc.listPacks(id, kind),
  uploadPack: (
    id: string,
    kind: PackKind,
  ): Promise<{ ok: boolean; error?: string; added: string[] }> =>
    window.msc.uploadPack(id, kind),
  deletePack: (id: string, kind: PackKind, name: string): Promise<{ ok: boolean; error?: string }> =>
    window.msc.deletePack(id, kind, name),
};

/** Edition selectors for the application shell. */
export type Edition = 'java' | 'bedrock';

/** Top-level navigation destinations. */
export type PageId =
  | 'dashboard'
  | 'console'
  | 'worlds'
  | 'players'
  | 'settings'
  | 'gamerules'
  | 'datapacks'
  | 'mods-plugins'
  | 'backups'
  | 'playit'
  | 'permissions'
  | 'allowlist'
  | 'behavior-packs'
  | 'resource-packs';

/** IPC channels exposed through the preload bridge (narrow API only). */
export const IpcChannels = {
  appInfo: 'app:info',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  backendInfo: 'backend:info',
  selectServerLibrary: 'dialog:select-server-library',
  getSettings: 'settings:get',
  setSetting: 'settings:set',
  listServers: 'servers:list',
  createServer: 'servers:create',
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

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

/** Application metadata surfaced to the renderer. */
export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

/** Connection details for the local Fastify backend. */
export interface BackendInfo {
  url: string;
  token: string;
}

/** Server library folder selection result. */
export interface FolderSelectResult {
  path: string | null;
  canceled: boolean;
}

export type ServerEdition = 'java' | 'bedrock';

/** Persisted server-instance record. */
export interface ServerRecord {
  id: string;
  name: string;
  edition: ServerEdition;
  serverType: string;
  folderPath: string;
  javaPath: string | null;
  memoryMb: number;
  port: number;
  version: string | null;
  jvmArgs: string[];
  createdAt: string;
  updatedAt: string;
  /** True when the server folder still exists on disk. */
  folderExists: boolean;
}

export interface CreateServerInput {
  name: string;
  edition: ServerEdition;
  serverType: string;
  folderPath: string;
  javaPath?: string | null;
  memoryMb?: number;
  port?: number;
  version?: string | null;
  jvmArgs?: string[];
}

export interface UpdateServerInput {
  name?: string;
  serverType?: string;
  folderPath?: string;
  javaPath?: string | null;
  memoryMb?: number;
  port?: number;
  version?: string | null;
  jvmArgs?: string[];
}

/** App-wide persisted settings (single-row table). */
export interface AppSettings {
  serverLibraryPath: string | null;
  /** Absolute path to the Playit executable (user-selected). */
  playitPath: string | null;
  /** Last known public tunnel address (user-entered or detected). */
  playitPublicAddress: string | null;
}

/** Backend health payload. */
export interface HealthStatus {
  status: 'ok';
  uptimeSeconds: number;
  version: string;
}

/** WebSocket event types emitted by the backend. */
export type WsServerEvent =
  | { type: 'hello'; at: string }
  | { type: 'server:state'; serverId: string; state: ServerState; exitCode: number | null }
  | { type: 'server:log'; serverId: string; log: LogLine }
  | { type: 'server:stats'; serverId: string; stats: ServerStats }
  | { type: 'install:progress'; installId: string; progress: InstallProgress }
  | { type: 'java:progress'; javaInstallId: string; progress: JavaProgress }
  | { type: 'world:import-progress'; importId: string; progress: WorldImportProgress }
  | { type: 'backup:progress'; backupId: string; progress: BackupProgress }
  | { type: 'playit:state'; state: PlayitState }
  | { type: 'playit:log'; log: LogLine };

/** A Minecraft Java Edition release version. */
export interface VanillaVersion {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  releaseTime: string;
}

/** Request to install a new Vanilla server. */
export interface InstallVanillaRequest {
  name: string;
  version: string;
  folderName?: string;
  javaPath?: string | null;
  memoryMb?: number;
  port?: number;
  acceptEula: boolean;
}

/** Java server flavors supported by the unified installer. */
export type ServerFlavor = 'vanilla' | 'fabric' | 'forge' | 'paper';

/** A selectable server type shown in the New Server form. */
export interface ServerTypeOption {
  id: ServerFlavor;
  label: string;
  description: string;
  /** Whether this flavor has a mods/ or plugins/ folder. */
  hasExtensions: boolean;
  /** Forge needs a separate installer bootstrap step. */
  requiresInstallStep: boolean;
}

/** Request to install a new server of any flavor. */
export interface InstallServerRequest {
  flavor: ServerFlavor;
  name: string;
  version: string;
  folderName?: string;
  javaPath?: string | null;
  memoryMb?: number;
  port?: number;
  acceptEula: boolean;
  /** Fabric: loader version (e.g. 0.16.9). */
  loaderVersion?: string;
  /** Fabric: also download Fabric API. */
  includeFabricApi?: boolean;
  /** Paper: specific build; defaults to latest. */
  paperBuild?: string;
  /** Forge: specific build; defaults to latest. */
  forgeBuild?: string;
}

/** Request to convert an existing server to a new flavor (in place). */
export interface ConvertServerRequest {
  serverId: string;
  flavor: ServerFlavor;
  /** For Fabric: loader version. */
  loaderVersion?: string;
  /** For Fabric: also download Fabric API. */
  includeFabricApi?: boolean;
  /** For Paper: build override. */
  paperBuild?: string;
  /** For Forge: build override. */
  forgeBuild?: string;
}

/** A mod/plugin JAR discovered in a server's extension folder. */
export interface ExtensionEntry {
  /** File name on disk (e.g. "coolmod.jar"). */
  name: string;
  /** Whether the file is currently enabled. */
  enabled: boolean;
  /** Size in bytes. */
  sizeBytes: number;
  /** Last modified ISO timestamp. */
  modifiedAt: string;
  /** Metadata from the JAR, when readable. */
  displayName?: string;
  version?: string;
  description?: string;
  authors?: string[];
  /** Loader this extension targets (from its manifest). */
  kind?: 'mod' | 'plugin';
  /** MC version the extension targets, when declared. */
  mcVersion?: string;
  /** Dependency declarations (basic). */
  dependencies?: string[];
  /** Set when the JAR metadata could not be read. */
  metadataError?: string;
}

/** Full listing of a server's mods/plugins folder. */
export interface ExtensionListResponse {
  serverId: string;
  flavor: ServerFlavor;
  /** Folder name, e.g. "mods" or "plugins". */
  folder: string | null;
  entries: ExtensionEntry[];
}

/** Progress of a server installation. */
export interface InstallProgress {
  status:
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'writing-config'
    | 'complete'
    | 'failed'
    | 'canceled';
  percent: number | null;
  message: string;
  /** Error code for the failed state. */
  errorCode?: 'network' | 'checksum' | 'eula' | 'invalid-version' | 'cancelled';
  serverId?: string;
}

/** Server process lifecycle states. */
export type ServerState =
  | 'offline'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'crashed'
  | 'updating';

/** A single console log line with a timestamp. */
export interface LogLine {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Live resource usage of the running server process. */
export interface ServerStats {
  /** CPU percent (0-100) for the server process tree. */
  cpuPercent: number;
  /** Resident memory in MB. */
  memoryMb: number;
  /** Current online player count when parseable from the log, else null. */
  playerCount: number | null;
}

/** Live status of a managed server process. */
export interface ServerStatus {
  serverId: string;
  state: ServerState;
  pid: number | null;
  startedAt: string | null;
  uptimeSeconds: number;
  exitCode: number | null;
  /** The last 500 console lines, oldest first. */
  logs: LogLine[];
  /** Latest resource usage (only meaningful while running). */
  stats: ServerStats;
  /** Local connection address, e.g. 127.0.0.1:25565. */
  address: string | null;
}

/** Describes why a server is not running. */
export interface StartServerError {
  code:
    | 'not-found'
    | 'missing-java'
    | 'missing-jar'
    | 'missing-executable'
    | 'already-running'
    | 'another-server-running'
    | 'folder-not-found'
    | 'incompatible-java';
  message: string;
  runningServerId?: string;
  /** For incompatible-java: the Java feature version found and required. */
  java?: { found: number | null; required: number };
}

/** A detected Java installation. */
export interface JavaInstallation {
  javaPath: string;
  version: string;
  majorVersion: number;
}

/** What Java a Minecraft version needs, and what's detected. */
export interface JavaRequirement {
  minecraftVersion: string;
  requiredJava: number;
  requiredLabel: string;
  detected: JavaInstallation | null;
  compatible: boolean;
  /** Per-server path if one is configured (may not match requirement). */
  serverJavaPath: string | null;
}

/** A downloadable Java runtime from Adoptium. */
export interface JavaDownloadInfo {
  majorVersion: number;
  label: string;
  /** Rough download size for the notice. */
  downloadSizeMb: number;
  installPath: string;
}

/** Request to install a private Java runtime. */
export interface InstallJavaRequest {
  majorVersion: number;
}

/** Progress of a Java runtime installation. */
export interface JavaProgress {
  status: 'downloading' | 'extracting' | 'complete' | 'failed' | 'canceled';
  percent: number | null;
  message: string;
  installPath?: string;
  javaPath?: string;
}

/** A single editable server.properties field (schema-driven). */
export interface ServerPropertyField {
  key: string;
  label: string;
  description: string;
  type: 'boolean' | 'integer' | 'string' | 'enum';
  enumValues?: string[];
  default: string | number | boolean;
  min?: number;
  max?: number;
  restartRequired: boolean;
}

/** A field with its current value from the file. */
export interface ServerPropertyEntry {
  field: ServerPropertyField;
  value: string | number | boolean;
  /** Keys not in the schema (unknown/preserved). */
  isUnknown?: boolean;
}

/** Full server.properties state for the editor. */
export interface ServerPropertiesDocument {
  serverId: string;
  fields: ServerPropertyEntry[];
  /** Raw text of unknown keys for the advanced editor. */
  rawText: string;
  /** Keys whose value changed since the file was read. */
  changedKeys: string[];
  /** Backup file written before the last save (path or null). */
  lastBackupPath: string | null;
}

/** Update request: partial map of key → raw string value. */
export interface UpdatePropertiesRequest {
  values: Record<string, string>;
}

/** A single gamerule: catalog metadata + current value. */
export interface GameruleEntry {
  key: string;
  /** Category grouping for the UI (e.g. "Gameplay", "Drops", "Mobs"). */
  category: string;
  type: 'boolean' | 'integer';
  description: string;
  defaultValue: string | number | boolean;
  min?: number;
  max?: number;
  value: string | number | boolean;
}

/** Full gamerule state for a server. */
export interface GamerulesDocument {
  serverId: string;
  rules: GameruleEntry[];
  /** True when the file was read while the server is offline. */
  offline: boolean;
}

/** A whitelist/operator entry as stored in the JSON file. */
export interface PlayerListEntry {
  uuid: string;
  name: string;
}

/** Result of running a console command. */
export interface CommandResult {
  ok: boolean;
  /** True when the server is offline and the command could not be sent. */
  offline?: boolean;
  error?: string;
}

/** Shell open result. */
export interface ShellOpenResult {
  ok: boolean;
  error?: string;
}

/** A discovered Minecraft world (single-player or server world folder). */
export interface WorldInfo {
  /** Absolute path to the world folder. */
  path: string;
  /** Folder name. */
  name: string;
  /** World name from level.dat, when readable. */
  displayName?: string;
  /** World game mode from level.dat (survival/creative/adventure/spectator). */
  gameMode?: string;
  /** Minecraft version that created the world, when readable. */
  lastPlayedVersion?: string;
  /** Size of the world folder in bytes. */
  sizeBytes: number;
  /** Whether this looks like a Java world (has level.dat). */
  valid: boolean;
}

/** Result of scanning a folder for worlds. */
export interface WorldDiscoveryResult {
  folder: string;
  worlds: WorldInfo[];
  /** Folders found without a level.dat (not valid worlds). */
  invalid: string[];
  canceled: boolean;
}

/** Suggested single-player save locations. */
export interface SaveFolderSuggestion {
  path: string;
  exists: boolean;
}

/** Request to import a world into a server. */
export interface ImportWorldRequest {
  /** Server id to import into. */
  serverId: string;
  /** Absolute path to the source world folder. */
  sourcePath: string;
  /** Optional rename; defaults to the world folder name. */
  targetName?: string;
}

/** Progress of a world import. */
export interface WorldImportProgress {
  status: 'copying' | 'complete' | 'failed' | 'canceled';
  percent: number | null;
  message: string;
  errorCode?: 'not-found' | 'invalid-world' | 'io' | 'cancelled' | 'server-running';
  targetPath?: string;
}

/** A single server backup archive entry. */
export interface BackupEntry {
  /** Unique id of the backup record. */
  id: string;
  /** Server this backup belongs to. */
  serverId: string;
  /** Absolute path to the archive file. */
  filePath: string;
  /** Human-friendly label (defaults to a timestamp). */
  note: string;
  /** Size of the archive in bytes. */
  sizeBytes: number;
  /** ISO timestamp of when the backup was created. */
  createdAt: string;
}

/** Create a backup request. */
export interface CreateBackupRequest {
  serverId: string;
  /** Optional note/label; defaults to a timestamp. */
  note?: string;
}

/** Request to restore a backup. */
export interface RestoreBackupRequest {
  /** Backup record id to restore. */
  backupId: string;
}

/** Progress of a backup create/restore operation. */
export interface BackupProgress {
  status: 'creating' | 'restoring' | 'complete' | 'failed' | 'canceled';
  percent: number | null;
  message: string;
  /** Error code for the failed state. */
  errorCode?: 'not-found' | 'server-running' | 'io' | 'cancelled' | 'invalid-archive';
  backup?: BackupEntry;
}

/** Playit tunnel process lifecycle states. */
export type PlayitState = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed';

/** A detected Playit executable. */
export interface PlayitInstallation {
  /** Absolute path to the playit executable. */
  playitPath: string;
}

/** A claim/setup link detected in Playit output (e.g. https://playit.gg/claim/...). */
export interface PlayitLink {
  kind: 'claim' | 'setup';
  url: string;
}

/** A detected or user-entered public tunnel address (e.g. x.playit.gg). */
export interface PlayitAddress {
  address: string;
}

/** App-wide Playit state persisted in the settings table. */
export interface PlayitSettings {
  /** Absolute path to the playit executable (user-selected). */
  playitPath: string | null;
  /** Last known public address, user-entered or detected from output. */
  playitPublicAddress: string | null;
}

/** Live status of the Playit process. */
export interface PlayitStatus {
  state: PlayitState;
  pid: number | null;
  startedAt: string | null;
  uptimeSeconds: number;
  exitCode: number | null;
  /** The last 500 console lines, oldest first. */
  logs: LogLine[];
  /** The most recent setup/claim link detected in output. */
  links: PlayitLink[];
  /** The most recent public address detected in output. */
  detectedAddress: string | null;
}

/** A Bedrock Dedicated Server release version. */
export interface BedrockVersion {
  id: string;
  type: 'release' | 'preview';
}

/** Request to install a new Bedrock Dedicated Server. */
export interface InstallBedrockRequest {
  name: string;
  version: string;
  folderName?: string;
  port?: number;
  acceptEula: boolean;
}

/** A Bedrock permission level (permissions.json). */
export type BedrockPermissionLevel = 'operator' | 'member' | 'visitor';

/** A Bedrock allowlist entry (allowlist.json). */
export interface BedrockAllowlistEntry {
  name: string;
  xuid?: string;
  ignoresPlayerLimit?: boolean;
  permission?: BedrockPermissionLevel;
}

/** A Bedrock permissions.json entry. */
export interface BedrockPermissionEntry {
  permission: BedrockPermissionLevel;
  xuid?: string;
  name?: string;
}

/** Behavior or resource pack kind. */
export type PackKind = 'behavior' | 'resource';

/** A pack entry found in a server's pack folder. */
export interface PackEntry {
  /** Folder or file name inside the pack directory. */
  name: string;
  kind: PackKind;
  /** Total size in bytes (folder = recursive sum). */
  sizeBytes: number;
  /** Last modified ISO timestamp. */
  modifiedAt: string;
  isFolder: boolean;
  /** Number of files inside (1 for a bare file). */
  fileCount: number;
}

/** Full listing of a server's behavior/resource pack folder. */
export interface PackListResponse {
  serverId: string;
  kind: PackKind;
  entries: PackEntry[];
}

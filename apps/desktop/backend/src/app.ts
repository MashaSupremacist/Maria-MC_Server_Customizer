import Fastify, { type FastifyInstance } from 'fastify';
import websocket, { type WebSocket } from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AppSettings,
  type BackupEntry,
  type BackupProgress,
  type BedrockAllowlistEntry,
  type BedrockPermissionEntry,
  type BedrockVersion,
  type CommandResult,
  type CreateBackupRequest,
  type CreateServerInput,
  type ConvertServerRequest,
  type ExtensionListResponse,
  type GamerulesDocument,
  type HealthStatus,
  type ImportWorldRequest,
  type InstallBedrockRequest,
  type InstallProgress,
  type InstallServerRequest,
  type InstallVanillaRequest,
  type JavaDownloadInfo,
  type JavaInstallation,
  type JavaProgress,
  type JavaRequirement,
  type LogLine,
  type PackKind,
  type PackListResponse,
  type PlayerListEntry,
  type PlayitSettings,
  type PlayitStatus,
  type RestoreBackupRequest,
  type SaveFolderSuggestion,
  type ServerRecord,
  type ServerPropertiesDocument,
  type ServerStatus,
  type ServerTypeOption,
  type StartServerError,
  type UpdatePropertiesRequest,
  type UpdateServerInput,
  type VanillaVersion,
  type WorldDiscoveryResult,
  type WsServerEvent,
} from '@msc/shared-types';
import { openDatabase, type DatabaseResult } from './db';
import { ServerManagerService } from './server-manager';
import { VanillaInstallerService } from './vanilla-installer';
import { JavaService } from './java-service';
import { ServerPropertiesService } from './server-properties';
import { PlayerService } from './player-service';
import { WorldService, suggestSaveFolders } from './world-service';
import { BackupService } from './backup-service';
import { PlayitService } from './playit-service';
import { ServerInstallerService } from './server-installer';
import { ExtensionManagerService } from './extension-manager';
import { BedrockInstallerService } from './bedrock-installer';
import { BedrockPropertiesService } from './bedrock-properties';
import { BedrockPlayerService } from './bedrock-player-service';
import { PackService } from './pack-service';

const SERVER_CREATE_SCHEMA = {
  type: 'object',
  required: ['name', 'edition', 'serverType', 'folderPath'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    edition: { enum: ['java', 'bedrock'] },
    serverType: { type: 'string', minLength: 1, maxLength: 60 },
    folderPath: { type: 'string', minLength: 1 },
    javaPath: { type: ['string', 'null'] },
    memoryMb: { type: 'integer', minimum: 128, maximum: 131072 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    version: { type: ['string', 'null'] },
    jvmArgs: { type: 'array', items: { type: 'string' } },
  },
} as const;

const SERVER_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    serverType: { type: 'string', minLength: 1, maxLength: 60 },
    folderPath: { type: 'string', minLength: 1 },
    javaPath: { type: ['string', 'null'] },
    memoryMb: { type: 'integer', minimum: 128, maximum: 131072 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    version: { type: ['string', 'null'] },
    jvmArgs: { type: 'array', items: { type: 'string' } },
  },
} as const;

const START_SERVER_SCHEMA = {
  type: 'object',
  required: ['serverId'],
  properties: {
    serverId: { type: 'string', minLength: 1 },
  },
} as const;

const COMMAND_SCHEMA = {
  type: 'object',
  required: ['serverId', 'command'],
  properties: {
    serverId: { type: 'string', minLength: 1 },
    command: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const INSTALL_SCHEMA = {
  type: 'object',
  required: ['name', 'version', 'acceptEula'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    version: { type: 'string', minLength: 1, maxLength: 40 },
    folderName: { type: 'string', minLength: 1, maxLength: 120 },
    javaPath: { type: ['string', 'null'] },
    memoryMb: { type: 'integer', minimum: 128, maximum: 131072 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    acceptEula: { type: 'boolean' },
  },
} as const;

const INSTALL_SERVER_SCHEMA = {
  type: 'object',
  required: ['flavor', 'name', 'version', 'acceptEula'],
  properties: {
    flavor: { enum: ['vanilla', 'fabric', 'forge', 'paper'] },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    version: { type: 'string', minLength: 1, maxLength: 40 },
    folderName: { type: 'string', minLength: 1, maxLength: 120 },
    javaPath: { type: ['string', 'null'] },
    memoryMb: { type: 'integer', minimum: 128, maximum: 131072 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    acceptEula: { type: 'boolean' },
    loaderVersion: { type: 'string' },
    includeFabricApi: { type: 'boolean' },
    paperBuild: { type: 'string' },
    forgeBuild: { type: 'string' },
  },
} as const;

const BEDROCK_INSTALL_SCHEMA = {
  type: 'object',
  required: ['name', 'version', 'acceptEula'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    version: { type: 'string', minLength: 1, maxLength: 40 },
    folderName: { type: 'string', minLength: 1, maxLength: 120 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    acceptEula: { type: 'boolean' },
  },
} as const;

const CONVERT_SCHEMA = {
  type: 'object',
  required: ['serverId', 'flavor'],
  additionalProperties: false,
  properties: {
    serverId: { type: 'string', minLength: 1 },
    flavor: { enum: ['vanilla', 'fabric', 'forge', 'paper'] },
    loaderVersion: { type: 'string' },
    includeFabricApi: { type: 'boolean' },
    paperBuild: { type: 'string' },
    forgeBuild: { type: 'string' },
  },
} as const;

const CANCEL_SCHEMA = {
  type: 'object',
  required: ['installId'],
  properties: {
    installId: { type: 'string', minLength: 1 },
  },
} as const;

const DETECT_JAVA_SCHEMA = {
  type: 'object',
  properties: {
    javaPath: { type: ['string', 'null'] },
  },
} as const;

const JAVA_INSTALL_SCHEMA = {
  type: 'object',
  required: ['majorVersion'],
  properties: {
    majorVersion: { type: 'integer', minimum: 8, maximum: 25 },
  },
} as const;

const CANCEL_JAVA_SCHEMA = {
  type: 'object',
  required: ['javaInstallId'],
  properties: {
    javaInstallId: { type: 'string', minLength: 1 },
  },
} as const;

const PROPERTIES_UPDATE_SCHEMA = {
  type: 'object',
  required: ['values'],
  properties: {
    values: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
} as const;

const GAMERULE_UPDATE_SCHEMA = {
  type: 'object',
  required: ['key', 'value'],
  properties: {
    key: { type: 'string', minLength: 1 },
    value: { type: 'string', minLength: 1 },
  },
} as const;

const CREATE_BACKUP_SCHEMA = {
  type: 'object',
  required: ['serverId'],
  additionalProperties: false,
  properties: {
    serverId: { type: 'string', minLength: 1 },
    note: { type: 'string', maxLength: 200 },
  },
} as const;

const RESTORE_BACKUP_SCHEMA = {
  type: 'object',
  required: ['backupId'],
  additionalProperties: false,
  properties: {
    backupId: { type: 'string', minLength: 1 },
  },
} as const;

export interface BuildAppOptions {
  dataDir: string;
  authToken: string;
  appVersion: string;
}

/**
 * Build a Fastify app for the local backend. All routes require the auth
 * token (X-MSC-Token header) except the health endpoint, which only reveals
 * status data (never paths or tokens). WebSocket clients authenticate the
 * same way.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { dataDir, authToken, appVersion } = options;
  const startedAt = Date.now();

  const app = Fastify({ logger: false });
  const db: DatabaseResult = openDatabase(dataDir);

  // Tracks connected WS clients so process events can be broadcast.
  const wsClients = new Set<WebSocket>();
  const broadcast = (event: WsServerEvent): void => {
    const payload = JSON.stringify(event);
    for (const socket of wsClients) {
      try {
        socket.send(payload);
      } catch {
        // drop dead sockets; cleanup happens on close
      }
    }
  };

  const manager = new ServerManagerService(
    db,
    broadcast,
    async (minecraftVersion, javaPath) => {
      if (!minecraftVersion) return null;
      const requirement = await javaService.getRequirement(minecraftVersion, javaPath);
      if (!requirement.compatible) {
        return {
          code: 'incompatible-java' as const,
          message:
            `This server needs ${requirement.requiredLabel}, but the selected Java is ` +
            (requirement.detected
              ? `${requirement.detected.majorVersion} (${requirement.detected.version})`
              : 'not a usable Java runtime'),
          java: {
            found: requirement.detected?.majorVersion ?? null,
            required: requirement.requiredJava,
          },
        };
      }
      return null;
    },
    async () => {
      // Fall back to an app-managed private runtime if one is installed.
      const runtimesRoot = path.join(dataDir, 'runtimes', 'java');
      if (!fs.existsSync(runtimesRoot)) return null;
      try {
        for (const entry of fs.readdirSync(runtimesRoot)) {
          const javaExe = javaService.findJavaExecutable(path.join(runtimesRoot, entry));
          if (javaExe) return javaExe;
        }
      } catch {
        // ignore
      }
      return null;
    },
  );
  const installer = new ServerInstallerService(db, broadcast);
  const extensionManager = new ExtensionManagerService(db);
  extensionManager.setRunningServerId(() => manager.runningServerId());
  const propertiesService = new ServerPropertiesService(db);
  const playerService = new PlayerService(db, manager);
  const worldService = new WorldService(db, broadcast);
  worldService.setRunningServerId(() => manager.runningServerId());
  const backupsDir = path.join(dataDir, 'backups');
  const backupService = new BackupService(db, broadcast, backupsDir);
  backupService.setRunningServerId(() => manager.runningServerId());
  const playitService = new PlayitService(db, broadcast);
  const bedrockInstaller = new BedrockInstallerService(db, broadcast);
  const bedrockPropertiesService = new BedrockPropertiesService(db);
  const bedrockPlayerService = new BedrockPlayerService(db, (id) => manager.runningServerId() === id);
  const packService = new PackService(db, (id) => manager.runningServerId() === id);

  // Private runtimes live under the app data dir.
  const runtimesDir = path.join(dataDir, 'runtimes', 'java');
  fs.mkdirSync(runtimesDir, { recursive: true });
  const javaService = new JavaService(broadcast, { runtimesDir });

  app.addHook('onClose', async () => {
    manager.shutdown();
    playitService.shutdown();
    db.close();
  });

  await app.register(websocket);

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    if (request.url.startsWith('/ws')) {
      // Browser WebSockets cannot set headers, so accept the token via query.
      const queryToken = new URL(request.url, 'http://localhost').searchParams.get(
        'token',
      );
      if (queryToken === authToken) return;
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const token = request.headers['x-msc-token'];
    if (token !== authToken) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/health', async (): Promise<HealthStatus> => {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: appVersion,
    };
  });

  // Servers
  app.get('/servers', async (): Promise<ServerRecord[]> => db.listServers());

  app.post<{ Body: CreateServerInput }>(
    '/servers',
    { schema: { body: SERVER_CREATE_SCHEMA } },
    async (request) => db.createServer(request.body),
  );

  app.put<{ Params: { id: string }; Body: UpdateServerInput }>(
    '/servers/:id',
    { schema: { body: SERVER_UPDATE_SCHEMA } },
    async (request) => {
      const record = db.updateServer(request.params.id, request.body);
      return record ?? replyNotFound();
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { deleteFolder?: string } }>(
    '/servers/:id',
    async (request): Promise<{ deleted: boolean; folderDeleted?: boolean }> => {
      const record = db.getServer(request.params.id);
      if (!record) return { deleted: false };

      // Never delete a folder for a server that is running.
      if (request.query.deleteFolder === 'true') {
        if (manager.isRunning(request.params.id)) {
          return { deleted: false, folderDeleted: false };
        }
        await fs.promises.rm(record.folderPath, { recursive: true, force: true });
      }
      const deleted = db.deleteServer(request.params.id);
      return { deleted, folderDeleted: request.query.deleteFolder === 'true' };
    },
  );

  // Server properties (settings editor)
  app.get<{ Params: { id: string } }>(
    '/servers/:id/properties',
    async (request): Promise<ServerPropertiesDocument> => {
      return propertiesService.read(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: UpdatePropertiesRequest }>(
    '/servers/:id/properties',
    { schema: { body: PROPERTIES_UPDATE_SCHEMA } },
    async (request) => {
      return propertiesService.update(request.params.id, request.body);
    },
  );

  // Gamerules
  app.get<{ Params: { id: string } }>(
    '/servers/:id/gamerules',
    async (request): Promise<GamerulesDocument> => {
      return playerService.readGamerules(request.params.id);
    },
  );

  // World discovery & import
  app.post<{ Body: { folder: string } }>(
    '/worlds/discover',
    async (request): Promise<WorldDiscoveryResult> => {
      return worldService.discover(request.body.folder);
    },
  );

  app.get('/worlds/save-folders', async (): Promise<SaveFolderSuggestion[]> => {
    return suggestSaveFolders();
  });

  app.post<{ Body: ImportWorldRequest }>(
    '/worlds/import',
    async (request): Promise<{ importId: string; error?: string }> => {
      return worldService.import(request.body);
    },
  );

  app.post<{ Body: { importId: string } }>(
    '/worlds/cancel',
    async (request): Promise<{ canceled: boolean }> => {
      return { canceled: worldService.cancel(request.body.importId) };
    },
  );

  // Backups
  app.get<{ Params: { id: string } }>(
    '/servers/:id/backups',
    async (request): Promise<BackupEntry[]> => {
      return backupService.list(request.params.id);
    },
  );

  app.post<{ Body: CreateBackupRequest }>(
    '/backups',
    { schema: { body: CREATE_BACKUP_SCHEMA } },
    async (request): Promise<{ operationId: string; error?: string }> => {
      return backupService.create(request.body);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/backups/:id',
    async (request): Promise<{ deleted: boolean }> => {
      return { deleted: backupService.delete(request.params.id) };
    },
  );

  app.post<{ Body: RestoreBackupRequest }>(
    '/backups/restore',
    { schema: { body: RESTORE_BACKUP_SCHEMA } },
    async (request): Promise<{ operationId: string; error?: string }> => {
      return backupService.restore(request.body);
    },
  );

  app.post<{ Body: { operationId: string } }>(
    '/backups/cancel',
    async (request): Promise<{ canceled: boolean }> => {
      return { canceled: backupService.cancel(request.body.operationId) };
    },
  );

  app.put<{ Params: { id: string }; Body: { key: string; value: string } }>(
    '/servers/:id/gamerules',
    { schema: { body: GAMERULE_UPDATE_SCHEMA } },
    async (request): Promise<CommandResult> => {
      return playerService.updateGamerule(request.params.id, request.body.key, request.body.value);
    },
  );

  // Player administration (whitelist / ops)
  app.get<{ Params: { id: string } }>(
    '/servers/:id/whitelist',
    async (request): Promise<PlayerListEntry[]> => {
      return playerService.readWhitelist(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: PlayerListEntry[] }>(
    '/servers/:id/whitelist',
    async (request): Promise<CommandResult> => {
      return playerService.updateWhitelist(request.params.id, request.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/servers/:id/operators',
    async (request): Promise<PlayerListEntry[]> => {
      return playerService.readOperators(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: PlayerListEntry[] }>(
    '/servers/:id/operators',
    async (request): Promise<CommandResult> => {
      return playerService.updateOperators(request.params.id, request.body);
    },
  );

  // Bans and IP bans
  app.get<{ Params: { id: string } }>(
    '/servers/:id/bans',
    async (request): Promise<PlayerListEntry[]> => {
      return playerService.readBans(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: PlayerListEntry[] }>(
    '/servers/:id/bans',
    async (request): Promise<CommandResult> => {
      return playerService.updateBans(request.params.id, request.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/servers/:id/ip-bans',
    async (request): Promise<PlayerListEntry[]> => {
      return playerService.readIpBans(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: PlayerListEntry[] }>(
    '/servers/:id/ip-bans',
    async (request): Promise<CommandResult> => {
      return playerService.updateIpBans(request.params.id, request.body);
    },
  );

  // Player commands (online only)
  app.post<{ Params: { id: string }; Body: { command: string } }>(
    '/servers/:id/commands',
    async (request): Promise<CommandResult> => {
      return playerService.runCommand(request.params.id, request.body.command);
    },
  );

  // Settings
  app.get('/settings', async (): Promise<AppSettings> => db.getSettings());
  app.put<{ Body: Partial<AppSettings> }>(
    '/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            serverLibraryPath: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      const body = request.body;
      if (body.serverLibraryPath !== undefined) {
        db.setSetting('serverLibraryPath', body.serverLibraryPath);
      }
      return db.getSettings();
    },
  );

  // Process management
  app.get<{ Params: { id: string } }>(
    '/servers/:id/status',
    async (request): Promise<ServerStatus> => manager.status(request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    '/servers/:id/logs',
    async (request): Promise<LogLine[]> => manager.getLogs(request.params.id),
  );

  app.post<{ Body: { serverId: string } }>(
    '/process/start',
    { schema: { body: START_SERVER_SCHEMA } },
    async (request): Promise<{ error: StartServerError | null }> => {
      const error = await manager.start(request.body.serverId);
      return { error };
    },
  );

  app.post('/process/stop', async (): Promise<{ ok: boolean }> => {
    manager.stop();
    return { ok: true };
  });

  app.post('/process/kill', async (): Promise<{ ok: boolean }> => {
    manager.forceKill();
    return { ok: true };
  });

  app.post<{ Body: { serverId: string } }>(
    '/process/restart',
    { schema: { body: START_SERVER_SCHEMA } },
    async (request): Promise<{ error: StartServerError | null }> => {
      const error = await manager.restart(request.body.serverId);
      return { error };
    },
  );

  app.post<{ Body: { serverId: string; command: string } }>(
    '/process/command',
    { schema: { body: COMMAND_SCHEMA } },
    async (request): Promise<{ ok: boolean }> => {
      const ok = manager.sendCommand(request.body.serverId, request.body.command);
      return { ok };
    },
  );

  // Server installer (all flavors)
  app.get('/server-types', async (): Promise<ServerTypeOption[]> => {
    return installer.listServerTypes();
  });

  app.get<{ Querystring: { version: string } }>(
    '/fabric/loaders',
    async (request): Promise<string[]> => {
      return installer.listFabricLoaders(request.query.version);
    },
  );

  app.get('/vanilla/versions', async (): Promise<VanillaVersion[]> => {
    return installer.listVersions();
  });

  app.post<{ Body: InstallVanillaRequest }>(
    '/install/vanilla',
    { schema: { body: INSTALL_SCHEMA } },
    async (request): Promise<{ installId: string }> => {
      const installId = await installer.install({ ...request.body, flavor: 'vanilla' });
      return { installId };
    },
  );

  app.post<{ Body: InstallServerRequest }>(
    '/install/server',
    { schema: { body: INSTALL_SERVER_SCHEMA } },
    async (request): Promise<{ installId: string }> => {
      const installId = await installer.install(request.body);
      return { installId };
    },
  );

  // Bedrock Dedicated Server
  app.get('/bedrock/versions', async (): Promise<BedrockVersion[]> => {
    return bedrockInstaller.listVersions();
  });

  app.post<{ Body: InstallBedrockRequest }>(
    '/install/bedrock',
    { schema: { body: BEDROCK_INSTALL_SCHEMA } },
    async (request): Promise<{ installId: string }> => {
      const installId = await bedrockInstaller.install(request.body);
      return { installId };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/servers/:id/bedrock-properties',
    async (request): Promise<ServerPropertiesDocument> => {
      return bedrockPropertiesService.read(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: UpdatePropertiesRequest }>(
    '/servers/:id/bedrock-properties',
    { schema: { body: PROPERTIES_UPDATE_SCHEMA } },
    async (request) => {
      return bedrockPropertiesService.update(request.params.id, request.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/servers/:id/allowlist',
    async (request): Promise<BedrockAllowlistEntry[]> => {
      return bedrockPlayerService.readAllowlist(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: BedrockAllowlistEntry[] }>(
    '/servers/:id/allowlist',
    async (request): Promise<CommandResult> => {
      return bedrockPlayerService.updateAllowlist(request.params.id, request.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/servers/:id/permissions',
    async (request): Promise<BedrockPermissionEntry[]> => {
      return bedrockPlayerService.readPermissions(request.params.id);
    },
  );

  app.put<{ Params: { id: string }; Body: BedrockPermissionEntry[] }>(
    '/servers/:id/permissions',
    async (request): Promise<CommandResult> => {
      return bedrockPlayerService.updatePermissions(request.params.id, request.body);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { kind: string } }>(
    '/servers/:id/packs',
    async (request): Promise<PackListResponse> => {
      const kind = request.query.kind === 'resource' ? 'resource' : 'behavior';
      return packService.list(request.params.id, kind as PackKind);
    },
  );

  app.post<{
    Params: { id: string; kind: string };
    Body: { files: Array<{ name: string; contentBase64: string; sizeBytes: number }> };
  }>(
    '/servers/:id/packs/:kind/upload',
    async (request): Promise<{ ok: boolean; error?: string; added: string[] }> => {
      const kind = request.params.kind === 'resource' ? 'resource' : 'behavior';
      return packService.upload(request.params.id, kind as PackKind, request.body.files ?? []);
    },
  );

  app.post<{ Params: { id: string; kind: string }; Body: { name: string } }>(
    '/servers/:id/packs/:kind/delete',
    async (request): Promise<{ ok: boolean; error?: string }> => {
      const kind = request.params.kind === 'resource' ? 'resource' : 'behavior';
      return packService.delete(request.params.id, kind as PackKind, request.body.name);
    },
  );

  app.post<{ Body: ConvertServerRequest }>(
    '/servers/convert',
    { schema: { body: CONVERT_SCHEMA } },
    async (request): Promise<{ operationId: string; error?: string }> => {
      return installer.convert(request.body);
    },
  );

  app.post<{ Body: { installId: string } }>(
    '/install/cancel',
    { schema: { body: CANCEL_SCHEMA } },
    async (request): Promise<{ canceled: boolean }> => {
      const canceled =
        installer.cancel(request.body.installId) ||
        bedrockInstaller.cancel(request.body.installId);
      return { canceled };
    },
  );

  // Mods / plugins
  app.get<{ Params: { id: string } }>(
    '/servers/:id/extensions',
    async (request): Promise<ExtensionListResponse> => {
      return extensionManager.list(request.params.id);
    },
  );

  app.post<{ Params: { id: string }; Body: { files: Array<{ name: string; contentBase64: string; sizeBytes: number }> } }>(
    '/servers/:id/extensions/upload',
    async (request): Promise<{ ok: boolean; error?: string; added: string[] }> => {
      return extensionManager.upload(request.params.id, request.body.files ?? []);
    },
  );

  app.post<{ Params: { id: string }; Body: { name: string } }>(
    '/servers/:id/extensions/enable',
    async (request): Promise<{ ok: boolean; error?: string }> => {
      return extensionManager.enable(request.params.id, request.body.name);
    },
  );

  app.post<{ Params: { id: string }; Body: { name: string } }>(
    '/servers/:id/extensions/disable',
    async (request): Promise<{ ok: boolean; error?: string }> => {
      return extensionManager.disable(request.params.id, request.body.name);
    },
  );

  app.post<{ Params: { id: string }; Body: { name: string } }>(
    '/servers/:id/extensions/delete',
    async (request): Promise<{ ok: boolean; error?: string }> => {
      return extensionManager.delete(request.params.id, request.body.name);
    },
  );

  // Java runtime management
  app.post<{ Body: { javaPath?: string | null } }>(
    '/java/detect',
    { schema: { body: DETECT_JAVA_SCHEMA } },
    async (request): Promise<JavaInstallation | null> => {
      return javaService.detect(request.body.javaPath ?? null);
    },
  );

  app.get<{ Querystring: { version: string; javaPath?: string } }>(
    '/java/required',
    async (request): Promise<JavaRequirement> => {
      const version = request.query.version;
      const javaPath = request.query.javaPath ?? null;
      return javaService.getRequirement(version, javaPath);
    },
  );

  app.get<{ Querystring: { major: string } }>(
    '/java/download-info',
    async (request): Promise<JavaDownloadInfo> => {
      const major = parseInt(request.query.major, 10);
      return javaService.getDownloadInfo(major);
    },
  );

  app.post<{ Body: { majorVersion: number } }>(
    '/java/install',
    { schema: { body: JAVA_INSTALL_SCHEMA } },
    async (request): Promise<{ javaInstallId: string }> => {
      const javaInstallId = javaService.install(request.body.majorVersion);
      return { javaInstallId };
    },
  );

  app.post<{ Body: { javaInstallId: string } }>(
    '/java/cancel',
    { schema: { body: CANCEL_JAVA_SCHEMA } },
    async (request): Promise<{ canceled: boolean }> => {
      const canceled = javaService.cancel(request.body.javaInstallId);
      return { canceled };
    },
  );

  app.get<{ Querystring: { id: string } }>(
    '/java/install-status',
    async (request): Promise<{ progress: JavaProgress | null }> => {
      const progress = javaService.getInstallStatus(request.query.id);
      return { progress };
    },
  );

  // Playit tunnel integration
  app.get('/playit/settings', async (): Promise<PlayitSettings> => {
    return playitService.getSettings();
  });

  app.put<{ Body: { playitPath?: string | null; playitPublicAddress?: string | null } }>(
    '/playit/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            playitPath: { type: ['string', 'null'] },
            playitPublicAddress: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request): Promise<PlayitSettings> => {
      const body = request.body;
      if (body.playitPath !== undefined) {
        playitService.setPlayitPath(body.playitPath);
      }
      if (body.playitPublicAddress !== undefined) {
        playitService.setPublicAddress(body.playitPublicAddress);
      }
      return playitService.getSettings();
    },
  );

  app.post<{ Body: { playitPath?: string | null } }>(
    '/playit/detect',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            playitPath: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request): Promise<{ detected: boolean }> => {
      return { detected: playitService.detect(request.body.playitPath ?? null) };
    },
  );

  app.get('/playit/status', async (): Promise<PlayitStatus> => {
    return playitService.getStatus();
  });

  app.post<{ Body: { playitPath: string } }>(
    '/playit/start',
    {
      schema: {
        body: {
          type: 'object',
          required: ['playitPath'],
          additionalProperties: false,
          properties: {
            playitPath: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<{ error: { code: string; message: string } | null }> => {
      const error = playitService.start(request.body.playitPath);
      return { error };
    },
  );

  app.post('/playit/stop', async (): Promise<{ ok: boolean }> => {
    playitService.stop();
    return { ok: true };
  });

  app.post('/playit/kill', async (): Promise<{ ok: boolean }> => {
    playitService.forceKill();
    return { ok: true };
  });

  // WebSocket: token auth is enforced by the onRequest hook.
  // In @fastify/websocket v11 the handler receives the ws WebSocket directly.
  app.get('/ws', { websocket: true }, (socket) => {
    wsClients.add(socket);
    socket.send(
      JSON.stringify({ type: 'hello', at: new Date().toISOString() } satisfies WsServerEvent),
    );
    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  return app;
}

function replyNotFound(): never {
  throw Object.assign(new Error('Not found'), { statusCode: 404 });
}

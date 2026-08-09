import { app, BrowserWindow, dialog, ipcMain as rawIpcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireSingleInstanceOwnership } from './single-instance';
import { createBeforeQuitHandler } from './app-shutdown';
import { BackendClient } from './backend-client';
import { isCanonicalReleaseUrl } from './repository';
import {
  assertTrustedRendererUrl,
  createTrustedRendererPolicy,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
} from './security';
import { checkForUpdate } from './update-check';
import {
  type AppSettings,
  type BackendInfo,
  type BackupEntry,
  type BedrockAllowlistEntry,
  type BedrockPermissionEntry,
  type BedrockVersion,
  type CommandResult,
  type CreateBackupRequest,
  type CreateServerInput,
  type DetectedServerInfo,
  type ConvertServerRequest,
  type ExtensionListResponse,
  type FolderSelectResult,
  type GamerulesDocument,
  type ImportWorldRequest,
  type InstallBedrockRequest,
  type InstallJavaRequest,
  type InstallServerRequest,
  type InstallVanillaRequest,
  type JavaDownloadInfo,
  type JavaInstallation,
  type JavaProgress,
  type JavaRequirement,
  type LogLine,
  type ModpackImportRequest,
  type ModpackImportResult,
  type OperationStatus,
  type CreateFromPackRequest,
  type CreateFromPackResult,
  type PackInspection,
  type PackKind,
  type PackListResponse,
  type PlayerListEntry,
  type PlayitSettings,
  type PlayitStatus,
  type RestoreBackupRequest,
  type SaveFolderSuggestion,
  type ServerPropertiesDocument,
  type ServerRecord,
  type ServerStatus,
  type ServerTypeOption,
  type ShellOpenResult,
  type StartServerError,
  type UpdatePropertiesRequest,
  type UpdateServerInput,
  type VanillaVersion,
  type WorldDiscoveryResult,
  IpcChannels,
} from '@msc/shared-types';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const rendererEntryPath = path.join(__dirname, '../dist/renderer/index.html');
const rendererPolicy = createTrustedRendererPolicy(
  pathToFileURL(rendererEntryPath).toString(),
  process.env.VITE_DEV_SERVER_URL,
);

function assertTrustedIpcSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  assertTrustedRendererUrl(event.senderFrame?.url ?? '', rendererPolicy);
}

// All privileged invoke/send registrations below pass through this one guard.
const ipcMain = {
  handle(
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any,
  ): void {
    rawIpcMain.handle(channel, (event, ...args) => {
      assertTrustedIpcSender(event);
      return listener(event, ...args);
    });
  },
  on(
    channel: string,
    listener: (event: Electron.IpcMainEvent, ...args: any[]) => void,
  ): void {
    rawIpcMain.on(channel, (event, ...args) => {
      if (!isTrustedRendererUrl(event.senderFrame?.url ?? '', rendererPolicy)) return;
      listener(event, ...args);
    });
  },
};

let mainWindow: BrowserWindow | null = null;

// Claim the app-data/process boundary before registering IPC, creating a
// window, or starting the backend. A losing process quits immediately.
const ownsSingleInstance = acquireSingleInstanceOwnership({
  requestLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  onSecondInstance: (listener) => {
    app.on('second-instance', listener);
  },
  getWindow: () => mainWindow,
});

/**
 * Locate a real Node executable to run the backend child process.
 * - Packaged app: use the node.exe bundled in resources/bin (the backend's
 *   native modules are compiled for system Node, not Electron's embedded Node).
 * - Dev / source: use the same Node that launched npm (process.env.NODE is
 *   set by npm when it runs lifecycle scripts).
 */
function resolveNodeExecutable(): string {
  if (process.env.MSC_NODE_EXECUTABLE) {
    return process.env.MSC_NODE_EXECUTABLE;
  }
  if (!isDev) {
    const bundled = path.join(process.resourcesPath, 'bin', 'node.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.env.NODE ?? process.execPath;
}

/** Where app data lives. In dev, inside the repo so it's easy to inspect. */
function getDataDir(): string {
  if (isDev) {
    return path.join(app.getAppPath(), '..', '..', 'data', 'app-data');
  }
  return path.join(app.getPath('userData'), 'app-data');
}

function resolveBackendEntry(): string | null {
  const candidates = [
    // Packaged app: backend lives in resources/backend (extraResources).
    path.join(process.resourcesPath, 'backend', 'dist', 'index.js'),
    // Production (unpacked): backend compiled next to the desktop app.
    path.join(__dirname, '..', '..', 'backend', 'dist', 'index.js'),
    // Dev via workspace: root node_modules/@msc/backend links to packages.
    path.join(app.getAppPath(), '..', '..', 'node_modules', '@msc', 'backend', 'dist', 'index.js'),
    path.join(app.getAppPath(), '..', '..', 'apps', 'desktop', 'backend', 'dist', 'index.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const backendClient = new BackendClient({
  spawnBackend: () => {
    const entry = resolveBackendEntry();
    if (!entry) {
      throw new Error('Backend entry not found. Run `npm run build` first.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const nodeExecutable = resolveNodeExecutable();

    return {
      child: spawn(nodeExecutable, [entry], {
        env: {
          ...process.env,
          MSC_DATA_DIR: dataDir,
          MSC_AUTH_TOKEN: token,
          MSC_APP_VERSION: app.getVersion(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      token,
    };
  },
  onStderr: (text) => {
    process.stderr.write(`[backend] ${text}`);
  },
});

function ensureBackend(): Promise<BackendInfo> {
  return backendClient.ensureBackend();
}

function backendFetch(
  method: string,
  route: string,
  body?: unknown,
): Promise<unknown> {
  return backendClient.fetch(method, route, body);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#050805',
    show: false,
    autoHideMenuBar: true,
    title: 'Minecraft Server Customizer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const denyUntrustedNavigation = (event: Electron.Event, url: string): void => {
    if (!isTrustedRendererUrl(url, rendererPolicy)) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', denyUntrustedNavigation);
  mainWindow.webContents.on('will-redirect', denyUntrustedNavigation);

  // Open only the small set of expected external links in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const rendererSession = mainWindow.webContents.session;
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  rendererSession.setPermissionCheckHandler(() => false);

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(rendererEntryPath);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle(
    IpcChannels.checkForUpdate,
    async (): Promise<import('@msc/shared-types').UpdateInfo> => {
      return checkForUpdate(app.getVersion());
    },
  );

  ipcMain.handle(IpcChannels.openReleaseUrl, async (_event, url: string) => {
    if (typeof url === 'string' && isCanonicalReleaseUrl(url)) {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle(IpcChannels.backendInfo, async (): Promise<BackendInfo> => {
    return ensureBackend();
  });

  ipcMain.handle(
    IpcChannels.operationStatus,
    async (_event, operationId: string): Promise<OperationStatus | null> => {
      try {
        return (await backendFetch(
          'GET',
          `/operations/${encodeURIComponent(operationId)}`,
        )) as OperationStatus;
      } catch (error) {
        if (error instanceof Error && error.message.includes('(404)')) return null;
        throw error;
      }
    },
  );

  ipcMain.handle(
    IpcChannels.selectServerLibrary,
    async (): Promise<FolderSelectResult> => {
      const options: Electron.OpenDialogOptions = {
        title: 'Select a server library folder',
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null, canceled: true };
      }
      return { path: result.filePaths[0], canceled: false };
    },
  );

  ipcMain.handle(IpcChannels.getSettings, async (): Promise<AppSettings> => {
    return (await backendFetch('GET', '/settings')) as AppSettings;
  });

  ipcMain.handle(
    IpcChannels.setSetting,
    async (_event, key: string, value: unknown): Promise<AppSettings> => {
      if (key === 'serverLibraryPath') {
        return (await backendFetch('PUT', '/settings', {
          serverLibraryPath: value,
        })) as AppSettings;
      }
      if (key === 'lastJavaPath') {
        return (await backendFetch('PUT', '/settings', {
          lastJavaPath: value,
        })) as AppSettings;
      }
      throw new Error(`Unknown setting key: ${key}`);
    },
  );

  ipcMain.handle(IpcChannels.listServers, async (): Promise<ServerRecord[]> => {
    return (await backendFetch('GET', '/servers')) as ServerRecord[];
  });

  ipcMain.handle(
    IpcChannels.createServer,
    async (_event, input: CreateServerInput): Promise<ServerRecord> => {
      return (await backendFetch('POST', '/servers', input)) as ServerRecord;
    },
  );

  ipcMain.handle(
    IpcChannels.detectServerFolder,
    async (_event, path: string): Promise<DetectedServerInfo> => {
      return (await backendFetch('POST', '/servers/detect', {
        folderPath: path,
      })) as DetectedServerInfo;
    },
  );

  ipcMain.handle(
    IpcChannels.updateServer,
    async (
      _event,
      id: string,
      input: UpdateServerInput,
    ): Promise<ServerRecord> => {
      return (await backendFetch('PUT', `/servers/${id}`, input)) as ServerRecord;
    },
  );

  ipcMain.handle(
    IpcChannels.deleteServer,
    async (
      _event,
      id: string,
      deleteFolder = false,
    ): Promise<{ deleted: boolean; folderDeleted?: boolean }> => {
      const query = deleteFolder ? '?deleteFolder=true' : '';
      return (await backendFetch(
        'DELETE',
        `/servers/${id}${query}`,
      )) as { deleted: boolean; folderDeleted?: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.selectJavaExecutable,
    async (): Promise<FolderSelectResult> => {
      const options: Electron.OpenDialogOptions = {
        title: 'Select a Java executable (java.exe)',
        properties: ['openFile'],
        filters: [{ name: 'Java Executable', extensions: ['exe'] }],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null, canceled: true };
      }
      return { path: result.filePaths[0], canceled: false };
    },
  );

  ipcMain.handle(
    IpcChannels.selectPlayitExecutable,
    async (): Promise<FolderSelectResult> => {
      const options: Electron.OpenDialogOptions = {
        title: 'Select the Playit executable (playit.exe)',
        properties: ['openFile'],
        filters: [{ name: 'Playit Executable', extensions: ['exe', 'cmd', 'bat'] }],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null, canceled: true };
      }
      const selectedPath = path.resolve(result.filePaths[0]);
      const extension = path.extname(selectedPath).toLowerCase();
      const selectedStat = await fs.promises.lstat(selectedPath);
      if (!selectedStat.isFile() || !['.exe', '.cmd', '.bat'].includes(extension)) {
        throw new Error('The selected Playit path is not a supported executable file');
      }
      await backendFetch('PUT', '/playit/settings', { playitPath: selectedPath });
      return { path: selectedPath, canceled: false };
    },
  );

  ipcMain.handle(
    IpcChannels.selectModpack,
    async (): Promise<FolderSelectResult> => {
      const options: Electron.OpenDialogOptions = {
        title: 'Select a modpack (.mrpack or .zip)',
        properties: ['openFile'],
        filters: [
          { name: 'Modpack', extensions: ['mrpack', 'zip'] },
        ],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null, canceled: true };
      }
      return { path: result.filePaths[0], canceled: false };
    },
  );

  ipcMain.handle(
    IpcChannels.openServerFolder,
    async (_event, serverId: string): Promise<ShellOpenResult> => {
      try {
        if (typeof serverId !== 'string' || serverId.length === 0) {
          return { ok: false, error: 'A registered server ID is required' };
        }
        const servers = (await backendFetch('GET', '/servers')) as ServerRecord[];
        const server = servers.find((record) => record.id === serverId);
        if (!server) {
          return { ok: false, error: 'Registered server not found' };
        }
        const storedPath = path.resolve(server.folderPath);
        const registeredStat = await fs.promises.lstat(storedPath);
        if (!registeredStat.isDirectory()) {
          return { ok: false, error: 'Registered server path is not a directory' };
        }
        const canonicalPath = await fs.promises.realpath(storedPath);
        const canonicalStat = await fs.promises.lstat(canonicalPath);
        if (!canonicalStat.isDirectory()) {
          return { ok: false, error: 'Canonical server path is not a directory' };
        }
        const error = await shell.openPath(canonicalPath);
        return error ? { ok: false, error } : { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.getServerStatus,
    async (_event, id: string): Promise<ServerStatus> => {
      return (await backendFetch('GET', `/servers/${id}/status`)) as ServerStatus;
    },
  );

  ipcMain.handle(
    IpcChannels.startServer,
    async (_event, id: string): Promise<{ error: StartServerError | null }> => {
      return (await backendFetch('POST', '/process/start', {
        serverId: id,
      })) as { error: StartServerError | null };
    },
  );

  ipcMain.handle(
    IpcChannels.stopServer,
    async (_event, id: string): Promise<{ ok: boolean }> => {
      return (await backendFetch('POST', '/process/stop', { serverId: id })) as { ok: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.forceKillServer,
    async (_event, id: string): Promise<{ ok: boolean }> => {
      return (await backendFetch('POST', '/process/kill', { serverId: id })) as { ok: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.restartServer,
    async (_event, id: string): Promise<{ error: StartServerError | null }> => {
      return (await backendFetch('POST', '/process/restart', {
        serverId: id,
      })) as { error: StartServerError | null };
    },
  );

  ipcMain.handle(
    IpcChannels.sendServerCommand,
    async (_event, id: string, command: string): Promise<{ ok: boolean }> => {
      return (await backendFetch('POST', '/process/command', {
        serverId: id,
        command,
      })) as { ok: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.getServerLogs,
    async (_event, id: string): Promise<LogLine[]> => {
      return (await backendFetch('GET', `/servers/${id}/logs`)) as LogLine[];
    },
  );

  ipcMain.handle(
    IpcChannels.selectWorldFolder,
    async (): Promise<FolderSelectResult> => {
      const options: Electron.OpenDialogOptions = {
        title: 'Select a folder to scan for Minecraft worlds',
        properties: ['openDirectory'],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null, canceled: true };
      }
      return { path: result.filePaths[0], canceled: false };
    },
  );

  ipcMain.handle(
    IpcChannels.discoverWorlds,
    async (_event, folder: string): Promise<WorldDiscoveryResult> => {
      return (await backendFetch('POST', '/worlds/discover', {
        folder,
      })) as WorldDiscoveryResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getSaveFolders,
    async (): Promise<SaveFolderSuggestion[]> => {
      return (await backendFetch('GET', '/worlds/save-folders')) as SaveFolderSuggestion[];
    },
  );

  ipcMain.handle(
    IpcChannels.importWorld,
    async (
      _event,
      request: ImportWorldRequest,
    ): Promise<{ importId: string; error?: string }> => {
      return (await backendFetch('POST', '/worlds/import', request)) as {
        importId: string;
        error?: string;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.cancelWorldImport,
    async (_event, importId: string): Promise<{ canceled: boolean }> => {
      return (await backendFetch('POST', '/worlds/cancel', {
        importId,
      })) as { canceled: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.listBackups,
    async (_event, serverId: string): Promise<BackupEntry[]> => {
      return (await backendFetch(
        'GET',
        `/servers/${encodeURIComponent(serverId)}/backups`,
      )) as BackupEntry[];
    },
  );

  ipcMain.handle(
    IpcChannels.createBackup,
    async (
      _event,
      request: CreateBackupRequest,
    ): Promise<{ operationId: string; error?: string }> => {
      return (await backendFetch('POST', '/backups', request)) as {
        operationId: string;
        error?: string;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.deleteBackup,
    async (_event, backupId: string): Promise<{ deleted: boolean }> => {
      return (await backendFetch(
        'DELETE',
        `/backups/${encodeURIComponent(backupId)}`,
      )) as { deleted: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.restoreBackup,
    async (
      _event,
      request: RestoreBackupRequest,
    ): Promise<{ operationId: string; error?: string }> => {
      return (await backendFetch('POST', '/backups/restore', request)) as {
        operationId: string;
        error?: string;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.cancelBackup,
    async (_event, operationId: string): Promise<{ canceled: boolean }> => {
      return (await backendFetch('POST', '/backups/cancel', { operationId })) as { canceled: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.getPlayitSettings,
    async (): Promise<PlayitSettings> => {
      return (await backendFetch('GET', '/playit/settings')) as PlayitSettings;
    },
  );

  ipcMain.handle(
    IpcChannels.updatePlayitSettings,
    async (
      _event,
      patch: Partial<Pick<PlayitSettings, 'playitPath' | 'playitPublicAddress'>>,
    ): Promise<PlayitSettings> => {
      if (patch.playitPath !== undefined && patch.playitPath !== null) {
        const current = (await backendFetch('GET', '/playit/settings')) as PlayitSettings;
        if (path.resolve(patch.playitPath) !== current.playitPath) {
          throw new Error('Playit executable changes must come from the native file picker');
        }
      }
      return (await backendFetch('PUT', '/playit/settings', patch)) as PlayitSettings;
    },
  );

  ipcMain.handle(
    IpcChannels.detectPlayit,
    async (_event, playitPath: string | null): Promise<{ detected: boolean }> => {
      return (await backendFetch('POST', '/playit/detect', {
        playitPath,
      })) as { detected: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.getPlayitStatus,
    async (): Promise<PlayitStatus> => {
      return (await backendFetch('GET', '/playit/status')) as PlayitStatus;
    },
  );

  ipcMain.handle(
    IpcChannels.startPlayit,
    async (): Promise<{ error: { code: string; message: string } | null }> => {
      const settings = (await backendFetch('GET', '/playit/settings')) as PlayitSettings;
      if (!settings.playitPath) {
        return { error: { code: 'not-configured', message: 'No Playit executable selected' } };
      }
      return (await backendFetch('POST', '/playit/start', {
        playitPath: settings.playitPath,
      })) as { error: { code: string; message: string } | null };
    },
  );

  ipcMain.handle(
    IpcChannels.stopPlayit,
    async (): Promise<{ ok: boolean }> => {
      return (await backendFetch('POST', '/playit/stop')) as { ok: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.forceKillPlayit,
    async (): Promise<{ ok: boolean }> => {
      return (await backendFetch('POST', '/playit/kill')) as { ok: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.listServerTypes,
    async (): Promise<ServerTypeOption[]> => {
      return (await backendFetch('GET', '/server-types')) as ServerTypeOption[];
    },
  );

  ipcMain.handle(
    IpcChannels.listFabricLoaders,
    async (_event, version: string): Promise<string[]> => {
      const query = new URLSearchParams({ version });
      return (await backendFetch(
        'GET',
        `/fabric/loaders?${query.toString()}`,
      )) as string[];
    },
  );

  ipcMain.handle(
    IpcChannels.installServer,
    async (_event, request: InstallServerRequest): Promise<{ installId: string }> => {
      return (await backendFetch('POST', '/install/server', request)) as { installId: string };
    },
  );

  ipcMain.handle(
    IpcChannels.convertServer,
    async (
      _event,
      request: ConvertServerRequest,
    ): Promise<{ operationId: string; error?: string }> => {
      return (await backendFetch('POST', '/servers/convert', request)) as {
        operationId: string;
        error?: string;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.cancelInstall,
    async (_event, installId: string): Promise<{ canceled: boolean }> => {
      return (await backendFetch('POST', '/install/cancel', { installId })) as {
        canceled: boolean;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.listExtensions,
    async (_event, serverId: string): Promise<ExtensionListResponse> => {
      return (await backendFetch(
        'GET',
        `/servers/${encodeURIComponent(serverId)}/extensions`,
      )) as ExtensionListResponse;
    },
  );

  ipcMain.handle(
    IpcChannels.uploadExtensions,
    async (
      _event,
      serverId: string,
    ): Promise<{ ok: boolean; error?: string; added: string[] }> => {
      const options = {
        title: 'Select mods or plugins',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [{ name: 'Java archives', extensions: ['jar'] }],
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || selection.filePaths.length === 0) return { ok: true, added: [] };
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(serverId)}/extensions/upload`,
        { filePaths: selection.filePaths },
      )) as { ok: boolean; error?: string; added: string[] };
    },
  );

  ipcMain.handle(
    IpcChannels.enableExtension,
    async (_event, serverId: string, name: string): Promise<{ ok: boolean; error?: string }> => {
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(serverId)}/extensions/enable`,
        { name },
      )) as { ok: boolean; error?: string };
    },
  );

  ipcMain.handle(
    IpcChannels.disableExtension,
    async (_event, serverId: string, name: string): Promise<{ ok: boolean; error?: string }> => {
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(serverId)}/extensions/disable`,
        { name },
      )) as { ok: boolean; error?: string };
    },
  );

  ipcMain.handle(
    IpcChannels.deleteExtension,
    async (_event, serverId: string, name: string): Promise<{ ok: boolean; error?: string }> => {
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(serverId)}/extensions/delete`,
        { name },
      )) as { ok: boolean; error?: string };
    },
  );

  ipcMain.handle(
    IpcChannels.importModpack,
    async (_event, request: ModpackImportRequest): Promise<ModpackImportResult> => {
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(request.serverId)}/modpack-import`,
        { filePath: request.filePath, force: request.force },
      )) as ModpackImportResult;
    },
  );

  ipcMain.handle(
    IpcChannels.inspectPack,
    async (_event, filePath: string): Promise<PackInspection> => {
      return (await backendFetch('POST', '/packs/inspect', { filePath })) as PackInspection;
    },
  );

  ipcMain.handle(
    IpcChannels.createServerFromPack,
    async (_event, request: CreateFromPackRequest): Promise<CreateFromPackResult> => {
      return (await backendFetch(
        'POST',
        '/servers/from-pack',
        request,
      )) as CreateFromPackResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getBedrockVersions,
    async (): Promise<BedrockVersion[]> => {
      return (await backendFetch('GET', '/bedrock/versions')) as BedrockVersion[];
    },
  );

  ipcMain.handle(
    IpcChannels.installBedrockServer,
    async (_event, request: InstallBedrockRequest): Promise<{ installId: string }> => {
      return (await backendFetch('POST', '/install/bedrock', request)) as { installId: string };
    },
  );

  ipcMain.handle(
    IpcChannels.cancelBedrockInstall,
    async (_event, installId: string): Promise<{ canceled: boolean }> => {
      return (await backendFetch('POST', '/install/cancel', { installId })) as {
        canceled: boolean;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.getBedrockProperties,
    async (_event, id: string): Promise<ServerPropertiesDocument> => {
      return (await backendFetch(
        'GET',
        `/servers/${encodeURIComponent(id)}/bedrock-properties`,
      )) as ServerPropertiesDocument;
    },
  );

  ipcMain.handle(
    IpcChannels.updateBedrockProperties,
    async (
      _event,
      id: string,
      request: UpdatePropertiesRequest,
    ): Promise<{
      document: ServerPropertiesDocument;
      validation: { ok: boolean; errors: Record<string, string> };
    }> => {
      return (await backendFetch(
        'PUT',
        `/servers/${encodeURIComponent(id)}/bedrock-properties`,
        request,
      )) as {
        document: ServerPropertiesDocument;
        validation: { ok: boolean; errors: Record<string, string> };
      };
    },
  );

  ipcMain.handle(
    IpcChannels.getBedrockAllowlist,
    async (_event, id: string): Promise<BedrockAllowlistEntry[]> => {
      return (await backendFetch(
        'GET',
        `/servers/${encodeURIComponent(id)}/allowlist`,
      )) as BedrockAllowlistEntry[];
    },
  );

  ipcMain.handle(
    IpcChannels.updateBedrockAllowlist,
    async (
      _event,
      id: string,
      entries: BedrockAllowlistEntry[],
    ): Promise<CommandResult> => {
      return (await backendFetch(
        'PUT',
        `/servers/${encodeURIComponent(id)}/allowlist`,
        entries,
      )) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getBedrockPermissions,
    async (_event, id: string): Promise<BedrockPermissionEntry[]> => {
      return (await backendFetch(
        'GET',
        `/servers/${encodeURIComponent(id)}/permissions`,
      )) as BedrockPermissionEntry[];
    },
  );

  ipcMain.handle(
    IpcChannels.updateBedrockPermissions,
    async (
      _event,
      id: string,
      entries: BedrockPermissionEntry[],
    ): Promise<CommandResult> => {
      return (await backendFetch(
        'PUT',
        `/servers/${encodeURIComponent(id)}/permissions`,
        entries,
      )) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.listPacks,
    async (_event, id: string, kind: PackKind): Promise<PackListResponse> => {
      const query = new URLSearchParams({ kind });
      return (await backendFetch(
        'GET',
        `/servers/${encodeURIComponent(id)}/packs?${query.toString()}`,
      )) as PackListResponse;
    },
  );

  ipcMain.handle(
    IpcChannels.uploadPack,
    async (
      _event,
      id: string,
      kind: PackKind,
    ): Promise<{ ok: boolean; error?: string; added: string[] }> => {
      const options = {
        title: `Select ${kind} pack`,
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [{ name: 'Bedrock packs', extensions: ['mcpack', 'zip', 'mcworld', 'mcaddon'] }],
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || selection.filePaths.length === 0) return { ok: true, added: [] };
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(id)}/packs/${encodeURIComponent(kind)}/upload`,
        { filePaths: selection.filePaths },
      )) as { ok: boolean; error?: string; added: string[] };
    },
  );

  ipcMain.handle(
    IpcChannels.deletePack,
    async (_event, id: string, kind: PackKind, name: string): Promise<{ ok: boolean; error?: string }> => {
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(id)}/packs/${encodeURIComponent(kind)}/delete`,
        { name },
      )) as { ok: boolean; error?: string };
    },
  );

  ipcMain.handle(
    IpcChannels.getGamerules,
    async (_event, id: string): Promise<GamerulesDocument> => {
      return (await backendFetch('GET', `/servers/${id}/gamerules`)) as GamerulesDocument;
    },
  );

  ipcMain.handle(
    IpcChannels.updateGamerule,
    async (_event, id: string, key: string, value: string): Promise<CommandResult> => {
      return (await backendFetch('PUT', `/servers/${id}/gamerules`, {
        key,
        value,
      })) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getWhitelist,
    async (_event, id: string): Promise<PlayerListEntry[]> => {
      return (await backendFetch('GET', `/servers/${id}/whitelist`)) as PlayerListEntry[];
    },
  );

  ipcMain.handle(
    IpcChannels.updateWhitelist,
    async (_event, id: string, players: PlayerListEntry[]): Promise<CommandResult> => {
      return (await backendFetch('PUT', `/servers/${id}/whitelist`, players)) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getOperators,
    async (_event, id: string): Promise<PlayerListEntry[]> => {
      return (await backendFetch('GET', `/servers/${id}/operators`)) as PlayerListEntry[];
    },
  );

  ipcMain.handle(
    IpcChannels.updateOperators,
    async (_event, id: string, players: PlayerListEntry[]): Promise<CommandResult> => {
      return (await backendFetch('PUT', `/servers/${id}/operators`, players)) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getBans,
    async (_event, id: string): Promise<PlayerListEntry[]> => {
      return (await backendFetch('GET', `/servers/${id}/bans`)) as PlayerListEntry[];
    },
  );

  ipcMain.handle(
    IpcChannels.updateBans,
    async (_event, id: string, players: PlayerListEntry[]): Promise<CommandResult> => {
      return (await backendFetch('PUT', `/servers/${id}/bans`, players)) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getIpBans,
    async (_event, id: string): Promise<PlayerListEntry[]> => {
      return (await backendFetch('GET', `/servers/${id}/ip-bans`)) as PlayerListEntry[];
    },
  );

  ipcMain.handle(
    IpcChannels.updateIpBans,
    async (_event, id: string, players: PlayerListEntry[]): Promise<CommandResult> => {
      return (await backendFetch('PUT', `/servers/${id}/ip-bans`, players)) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.runPlayerCommand,
    async (_event, id: string, command: string): Promise<CommandResult> => {
      return (await backendFetch('POST', `/servers/${id}/commands`, {
        command,
      })) as CommandResult;
    },
  );

  ipcMain.handle(
    IpcChannels.getVanillaVersions,
    async (): Promise<VanillaVersion[]> => {
      return (await backendFetch('GET', '/vanilla/versions')) as VanillaVersion[];
    },
  );

  ipcMain.handle(
    IpcChannels.installVanillaServer,
    async (
      _event,
      request: InstallVanillaRequest,
    ): Promise<{ installId: string }> => {
      return (await backendFetch('POST', '/install/vanilla', request)) as {
        installId: string;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.cancelVanillaInstall,
    async (_event, installId: string): Promise<{ canceled: boolean }> => {
      return (await backendFetch('POST', '/install/cancel', {
        installId,
      })) as { canceled: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.detectJava,
    async (_event, javaPath: string | null): Promise<JavaInstallation | null> => {
      return (await backendFetch('POST', '/java/detect', {
        javaPath,
      })) as JavaInstallation | null;
    },
  );

  ipcMain.handle(
    IpcChannels.getRequiredJava,
    async (
      _event,
      version: string,
      javaPath: string | null,
    ): Promise<JavaRequirement> => {
      const query = new URLSearchParams({ version });
      if (javaPath) query.set('javaPath', javaPath);
      return (await backendFetch(
        'GET',
        `/java/required?${query.toString()}`,
      )) as JavaRequirement;
    },
  );

  ipcMain.handle(
    IpcChannels.getJavaDownloadInfo,
    async (_event, major: number): Promise<JavaDownloadInfo> => {
      return (await backendFetch(
        'GET',
        `/java/download-info?major=${major}`,
      )) as JavaDownloadInfo;
    },
  );

  ipcMain.handle(
    IpcChannels.installJava,
    async (
      _event,
      request: InstallJavaRequest,
    ): Promise<{ javaInstallId: string }> => {
      return (await backendFetch('POST', '/java/install', request)) as {
        javaInstallId: string;
      };
    },
  );

  ipcMain.handle(
    IpcChannels.cancelJavaInstall,
    async (_event, javaInstallId: string): Promise<{ canceled: boolean }> => {
      return (await backendFetch('POST', '/java/cancel', {
        javaInstallId,
      })) as { canceled: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.getJavaInstallStatus,
    async (_event, javaInstallId: string): Promise<{ progress: JavaProgress | null }> => {
      return (await backendFetch(
        'GET',
        `/java/install-status?id=${encodeURIComponent(javaInstallId)}`,
      )) as { progress: JavaProgress | null };
    },
  );

  ipcMain.handle(
    IpcChannels.getServerProperties,
    async (_event, id: string): Promise<ServerPropertiesDocument> => {
      return (await backendFetch(
        'GET',
        `/servers/${id}/properties`,
      )) as ServerPropertiesDocument;
    },
  );

  ipcMain.handle(
    IpcChannels.updateServerProperties,
    async (
      _event,
      id: string,
      request: UpdatePropertiesRequest,
    ): Promise<{
      document: ServerPropertiesDocument;
      validation: { ok: boolean; errors: Record<string, string> };
    }> => {
      return (await backendFetch(
        'PUT',
        `/servers/${id}/properties`,
        request,
      )) as {
        document: ServerPropertiesDocument;
        validation: { ok: boolean; errors: Record<string, string> };
      };
    },
  );

  ipcMain.on(IpcChannels.windowMinimize, () => {
    mainWindow?.minimize();
  });

  ipcMain.on(IpcChannels.windowToggleMaximize, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on(IpcChannels.windowClose, () => {
    mainWindow?.close();
  });
}

if (ownsSingleInstance) {
  app.whenReady().then(async () => {
    registerIpcHandlers();
    createMainWindow();

    // Start the backend alongside the window; failures are logged but do not
    // prevent the shell from opening (the UI surfaces backend status).
    // Use ensureBackend so the eager start shares the same promise as IPC calls.
    void ensureBackend().catch((err: unknown) => {
      console.error('Failed to start backend:', err);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('before-quit', createBeforeQuitHandler({
    shutdownBackend: () => backendClient.shutdown(),
    quit: () => app.quit(),
    onError: (error) => console.error('Failed to stop backend cleanly:', error),
  }));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

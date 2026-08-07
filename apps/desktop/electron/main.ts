import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendInfo: BackendInfo | null = null;
let backendStartPromise: Promise<BackendInfo> | null = null;

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

function spawnBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = resolveBackendEntry();
    if (!entry) {
      reject(new Error('Backend entry not found. Run `npm run build` first.'));
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const nodeExecutable = resolveNodeExecutable();

    const child = spawn(nodeExecutable, [entry], {
      env: {
        ...process.env,
        MSC_DATA_DIR: dataDir,
        MSC_AUTH_TOKEN: token,
        MSC_APP_VERSION: app.getVersion(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/MSC_READY (\d+)/);
      if (match && !settled) {
        settled = true;
        backendProcess = child;
        backendInfo = {
          url: `http://127.0.0.1:${match[1]}`,
          token,
        };
        resolve();
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[backend] ${chunk.toString()}`);
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Backend exited early with code ${code}`));
      }
      backendProcess = null;
    });

    // If it exits without ever signaling ready, fail after a short grace.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Backend did not signal readiness in time'));
      }
    }, 15000);
  });
}

function ensureBackend(): Promise<BackendInfo> {
  if (backendInfo) return Promise.resolve(backendInfo);
  // Share a single spawn across concurrent callers (dashboard mount + IPC).
  if (!backendStartPromise) {
    backendStartPromise = spawnBackend().then((): BackendInfo => {
      if (!backendInfo) throw new Error('Backend unavailable');
      return backendInfo;
    });
  }
  return backendStartPromise;
}

async function backendFetch(
  method: string,
  route: string,
  body?: unknown,
): Promise<unknown> {
  const info = await ensureBackend();
  const headers: Record<string, string> = {
    'x-msc-token': info.token,
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${info.url}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend ${method} ${route} failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<unknown>;
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

  // Open external links in the system browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
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
    if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle(IpcChannels.backendInfo, async (): Promise<BackendInfo> => {
    return ensureBackend();
  });

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
      if (key !== 'serverLibraryPath') {
        throw new Error(`Unknown setting key: ${key}`);
      }
      const settings = (await backendFetch('PUT', '/settings', {
        serverLibraryPath: value,
      })) as AppSettings;
      return settings;
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
      return { path: result.filePaths[0], canceled: false };
    },
  );

  ipcMain.handle(
    IpcChannels.openServerFolder,
    async (_event, folderPath: string): Promise<ShellOpenResult> => {
      try {
        if (!folderPath || !fs.existsSync(folderPath)) {
          return { ok: false, error: `Folder not found: ${folderPath}` };
        }
        const error = await shell.openPath(folderPath);
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
    async (): Promise<{ ok: boolean }> => {
      return (await backendFetch('POST', '/process/stop')) as { ok: boolean };
    },
  );

  ipcMain.handle(
    IpcChannels.forceKillServer,
    async (): Promise<{ ok: boolean }> => {
      return (await backendFetch('POST', '/process/kill')) as { ok: boolean };
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
    async (
      _event,
      playitPath: string,
    ): Promise<{ error: { code: string; message: string } | null }> => {
      return (await backendFetch('POST', '/playit/start', {
        playitPath,
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
      files: Array<{ name: string; contentBase64: string; sizeBytes: number }>,
    ): Promise<{ ok: boolean; error?: string; added: string[] }> => {
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(serverId)}/extensions/upload`,
        { files },
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
      files: Array<{ name: string; contentBase64: string; sizeBytes: number }>,
    ): Promise<{ ok: boolean; error?: string; added: string[] }> => {
      return (await backendFetch(
        'POST',
        `/servers/${encodeURIComponent(id)}/packs/${encodeURIComponent(kind)}/upload`,
        { files },
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
      return (await backendFetch('POST', `/servers/${id}/gamerules`, {
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

app.on('before-quit', () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

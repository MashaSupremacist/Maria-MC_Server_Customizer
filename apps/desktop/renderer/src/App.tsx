import { useEffect, useState } from 'react';
import { type AppInfo, type Edition, type ServerRecord } from '@msc/shared-types';
import TitleBar from './components/TitleBar';
import Sidebar, { type NavItem } from './components/Sidebar';
import PlaceholderPage from './components/PlaceholderPage';
import ServerForm from './components/ServerForm';
import BedrockServerForm from './components/BedrockServerForm';
import ServerControls from './components/ServerControls';
import DashboardStats from './components/DashboardStats';
import ConsolePage from './components/ConsolePage';
import SettingsPage from './components/SettingsPage';
import GamerulesPage from './components/GamerulesPage';
import PlayersPage from './components/PlayersPage';
import WorldsPage from './components/WorldsPage';
import BackupsPage from './components/BackupsPage';
import PlayitPage from './components/PlayitPage';
import PlayitIndicator from './components/PlayitIndicator';
import ModsPluginsPage from './components/ModsPluginsPage';
import AllowlistPage from './components/AllowlistPage';
import PermissionsPage from './components/PermissionsPage';
import PackPage from './components/PackPage';
import DeleteServerDialog from './components/DeleteServerDialog';
import UpdateBanner from './components/UpdateBanner';
import { useServerRuntime } from './hooks/useServerRuntime';
import { useVanillaInstall } from './hooks/useVanillaInstall';
import { useBedrockInstall } from './hooks/useBedrockInstall';
import { api } from './lib/api';

const javaNav: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', page: 'dashboard' },
  { id: 'console', label: 'Console', page: 'console' },
  { id: 'worlds', label: 'Worlds', page: 'worlds' },
  { id: 'players', label: 'Players', page: 'players' },
  { id: 'settings', label: 'Settings', page: 'settings' },
  { id: 'gamerules', label: 'Gamerules', page: 'gamerules' },
  { id: 'datapacks', label: 'Datapacks', page: 'datapacks' },
  { id: 'mods-plugins', label: 'Mods / Plugins', page: 'mods-plugins' },
  { id: 'backups', label: 'Backups', page: 'backups' },
  { id: 'playit', label: 'Playit', page: 'playit' },
];

const bedrockNav: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', page: 'dashboard' },
  { id: 'console', label: 'Console', page: 'console' },
  { id: 'worlds', label: 'Worlds', page: 'worlds' },
  { id: 'players', label: 'Players', page: 'players' },
  { id: 'settings', label: 'Settings', page: 'settings' },
  { id: 'permissions', label: 'Permissions', page: 'permissions' },
  { id: 'allowlist', label: 'Allowlist', page: 'allowlist' },
  { id: 'behavior-packs', label: 'Behavior Packs', page: 'behavior-packs' },
  { id: 'resource-packs', label: 'Resource Packs', page: 'resource-packs' },
  { id: 'backups', label: 'Backups', page: 'backups' },
  { id: 'playit', label: 'Playit', page: 'playit' },
];

export default function App(): React.JSX.Element {
  const [edition, setEdition] = useState<Edition>('java');
  const [activePage, setActivePage] = useState<string>('dashboard');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const selectedServer = servers.find((s) => s.id === selectedId) ?? null;
  const runtime = useServerRuntime(selectedId);
  const install = useVanillaInstall((server) => {
    setServers((prev) => [...prev, server]);
    setSelectedId(server.id);
  });
  const bedrockInstall = useBedrockInstall((server) => {
    setServers((prev) => [...prev, server]);
    setSelectedId(server.id);
  });

  useEffect(() => {
    let cancelled = false;
    void api.getAppInfo().then((info) => {
      if (!cancelled) setAppInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSettings(), api.listServers()])
      .then(([settings, list]) => {
        if (cancelled) return;
        setLibraryPath(settings.serverLibraryPath);
        setServers(list);
        if (list.length > 0 && !selectedId) {
          setSelectedId(list[0].id);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLibraryError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nav = edition === 'java' ? javaNav : bedrockNav;

  const handleEditionChange = (next: Edition): void => {
    setEdition(next);
    setActivePage('dashboard');
  };

  const handleSelectLibrary = async (): Promise<void> => {
    try {
      const result = await api.selectServerLibrary();
      if (result.canceled || !result.path) return;
      const settings = await api.setServerLibraryPath(result.path);
      setLibraryPath(settings.serverLibraryPath);
      setLibraryError(null);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  };

  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);

  const handleDeleteServer = async (server: ServerRecord): Promise<void> => {
    if (runtime.state === 'online' && selectedId === server.id) {
      window.alert(`"${server.name}" is currently running. Stop it before deleting.`);
      return;
    }
    setDeleteTarget(server);
  };

  const confirmDeleteServer = async (deleteFolder: boolean): Promise<void> => {
    if (!deleteTarget) return;
    const server = deleteTarget;
    setDeleteTarget(null);
    try {
      const res = await api.deleteServer(server.id, deleteFolder);
      if (!res.deleted) {
        window.alert('Failed to delete the server.');
        return;
      }
      if (selectedId === server.id) setSelectedId(null);
      await refreshServers();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const refreshServers = async (): Promise<void> => {
    const list = await api.listServers();
    setServers(list);
    setSelectedId((prev) => (prev && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null)));
  };

  const renderContent = (): React.JSX.Element => {
    // Pages that need a selected server.
    if (selectedServer) {
      if (activePage === 'console') {
        return <ConsolePage server={selectedServer} runtime={runtime} />;
      }
      if (activePage === 'settings') {
        return <SettingsPage server={selectedServer} />;
      }
      if (activePage === 'gamerules') {
        return <GamerulesPage server={selectedServer} />;
      }
      if (activePage === 'players') {
        return <PlayersPage server={selectedServer} />;
      }
      if (activePage === 'worlds') {
        return <WorldsPage server={selectedServer} />;
      }
      if (activePage === 'backups') {
        return <BackupsPage server={selectedServer} />;
      }
      if (activePage === 'playit') {
        return <PlayitPage server={selectedServer} runtime={runtime} />;
      }
      if (activePage === 'mods-plugins') {
        return <ModsPluginsPage server={selectedServer} runtime={runtime} />;
      }
      if (activePage === 'allowlist') {
        return <AllowlistPage server={selectedServer} />;
      }
      if (activePage === 'permissions') {
        return <PermissionsPage server={selectedServer} />;
      }
      if (activePage === 'behavior-packs') {
        return <PackPage server={selectedServer} kind="behavior" />;
      }
      if (activePage === 'resource-packs') {
        return <PackPage server={selectedServer} kind="resource" />;
      }
    }
    if (activePage === 'console' || activePage === 'dashboard') {
      if (selectedServer) {
        return (
          <section className="page">
            <header className="page-header">
              <h1>Dashboard</h1>
              <span className="page-edition muted">{selectedServer.name}</span>
              {appInfo && <span className="page-version muted">v{appInfo.version}</span>}
              <PlayitIndicator />
            </header>
            <ServerControls
              server={selectedServer}
              runtime={runtime}
              onJavaPathUpdated={(javaPath) => {
                setServers((prev) =>
                  prev.map((s) =>
                    s.id === selectedServer.id ? { ...s, javaPath } : s,
                  ),
                );
              }}
            />
            <DashboardStats server={selectedServer} runtime={runtime} />
            {runtime.state === 'crashed' && (
              <div className="panel crash-panel">
                <h2 className="panel-title">Crash Details</h2>
                <div className="dash-row">
                  <span className="muted">Exit code</span>
                  <span className="text-danger">
                    {runtime.exitCode ?? 'unknown'}
                  </span>
                </div>
                <div className="dash-row">
                  <span className="muted">Last error lines</span>
                </div>
                <div className="console console-small">
                  {runtime.logs
                    .filter((l) => l.level === 'error')
                    .slice(-10)
                    .map((l, i) => (
                      <div key={i} className="console-line console-error">
                        <span className="console-time">
                          {formatTime(l.timestamp)}
                        </span>
                        <span className="console-text">{l.text}</span>
                      </div>
                    ))}
                  {runtime.logs.filter((l) => l.level === 'error').length === 0 && (
                    <p className="muted console-empty">No error lines captured.</p>
                  )}
                </div>
              </div>
            )}
          </section>
        );
      }
      // No server yet: show library + create form.
      return (
        <section className="page">
          <header className="page-header">
            <h1>Dashboard</h1>
            <span className="page-edition muted">
              {edition === 'java' ? 'Java Edition' : 'Bedrock Edition'}
            </span>
            {appInfo && <span className="page-version muted">v{appInfo.version}</span>}
          </header>
          <div className="panel panel-stretch">
            <h2 className="panel-title">Server Library</h2>
            <div className="dash-row dash-row-column">
              <span className="muted">Where server instances are stored</span>
              <span className="path-text">{libraryPath ?? 'Not set'}</span>
            </div>
            <div className="dash-row">
              <button type="button" className="btn" onClick={() => void handleSelectLibrary()}>
                {libraryPath ? 'Change Folder' : 'Select Folder'}
              </button>
            </div>
            {libraryError && <div className="error-banner">{libraryError}</div>}
          </div>
          {libraryPath ? (
            <div className="panel-stretch">
              {edition === 'java' ? (
                <ServerForm
                  libraryPath={libraryPath}
                  install={install}
                  onCreated={(server) => {
                    setServers((prev) => [...prev, server]);
                    setSelectedId(server.id);
                  }}
                />
              ) : (
                <BedrockServerForm
                  libraryPath={libraryPath}
                  install={bedrockInstall}
                  onCreated={(server) => {
                    setServers((prev) => [...prev, server]);
                    setSelectedId(server.id);
                  }}
                />
              )}
            </div>
          ) : (
            <p className="muted panel-stretch">Choose a library folder to create servers.</p>
          )}
        </section>
      );
    }
    return (
      <PlaceholderPage
        pageId={activePage}
        edition={edition}
        appVersion={appInfo?.version}
      />
    );
  };

  return (
    <div className="app-shell">
      <TitleBar appName={appInfo?.name ?? 'Minecraft Server Customizer'} />
      <div className="app-body">
        <Sidebar
          edition={edition}
          nav={nav}
          activePage={activePage}
          onEditionChange={handleEditionChange}
          onNavigate={setActivePage}
        />
        <main className="content">
          <UpdateBanner />
          {servers.length > 0 && (
            <div className="server-picker">
              {servers.map((server) => (
                <div key={server.id} className="server-chip-group">
                  <button
                    type="button"
                    className={`server-chip${selectedId === server.id ? ' active' : ''}${server.folderExists ? '' : ' chip-missing'}`}
                    title={server.folderExists ? server.name : `${server.name} (folder missing on disk)`}
                    onClick={() => setSelectedId(server.id)}
                  >
                    <span className={`chip-edition chip-edition-${server.edition}`}>
                      {server.edition}
                    </span>
                    {server.name}
                    {!server.folderExists && <span className="chip-missing-badge">missing</span>}
                  </button>
                  <button
                    type="button"
                    className="server-chip-delete"
                    title="Delete server"
                    onClick={() => void handleDeleteServer(server)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {install.install.phase === 'installing' && (
            <div className="install-banner">
              <div className="install-banner-row">
                <span className="muted">
                  {install.install.progress.percent != null
                    ? `Installing server… ${install.install.progress.percent}% — ${install.install.progress.message}`
                    : `Installing server… ${install.install.progress.message}`}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => void install.cancel()}>
                  Cancel
                </button>
              </div>
              <div className="progress-track">
                <div
                  className={
                    install.install.progress.percent != null
                      ? 'progress-fill'
                      : 'progress-fill indeterminate'
                  }
                  style={
                    install.install.progress.percent != null
                      ? { width: `${install.install.progress.percent}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          )}
          {renderContent()}
        </main>
      </div>
      {deleteTarget && (
        <DeleteServerDialog
          server={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={(deleteFolder) => void confirmDeleteServer(deleteFolder)}
        />
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

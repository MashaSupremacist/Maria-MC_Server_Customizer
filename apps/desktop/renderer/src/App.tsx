import { useEffect, useState } from 'react';
import { type AppInfo, type Edition, type ServerRecord } from '@msc/shared-types';
import TitleBar from './components/TitleBar';
import Sidebar, { type NavItem } from './components/Sidebar';
import PlaceholderPage from './components/PlaceholderPage';
import CreateServerView from './components/CreateServerView';
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
import EmptyStatePanel from './components/EmptyStatePanel';
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
  /** Last java.exe used, persisted in settings; pre-filled for new servers. */
  const [lastJavaPath, setLastJavaPath] = useState<string | null>(null);
  /** True when the "add server" create view is shown, even if servers exist. */
  const [addingServer, setAddingServer] = useState(false);

  const selectedServer = servers.find((s) => s.id === selectedId) ?? null;
  const runtime = useServerRuntime(selectedId);
  const install = useVanillaInstall((server) => handleServerCreated(server));
  const bedrockInstall = useBedrockInstall((server) => handleServerCreated(server));

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
        setLastJavaPath(settings.lastJavaPath);
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
    setAddingServer(false);
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

  /** Shared by install + add-existing: append, select, and exit the add view. */
  const handleServerCreated = (server: ServerRecord): void => {
    // Dedupe by id: the install hooks can fire onCreated more than once
    // (React StrictMode double-mounts the WS subscription in dev), so never
    // append a server that's already in the list.
    setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]));
    setSelectedId(server.id);
    setAddingServer(false);
    // Remember the chosen java.exe for the next server.
    if (server.edition === 'java' && server.javaPath) {
      setLastJavaPath(server.javaPath);
      void api.setLastJavaPath(server.javaPath).catch(() => {
        // Non-fatal: the next server just won't be pre-filled.
      });
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

  const handleNavigate = (page: string): void => {
    setActivePage(page);
    setAddingServer(false);
  };

  const pageTitle = (page: string): string => {
    const item = nav.find((n) => n.page === page);
    return item ? item.label : page;
  };

  const renderContent = (): React.JSX.Element => {
    // "Add server" view: shown even when servers exist (from the picker button).
    if (addingServer) {
      return (
        <CreateServerView
          edition={edition}
          appInfo={appInfo}
          libraryPath={libraryPath}
          libraryError={libraryError}
          lastJavaPath={lastJavaPath}
          install={install}
          bedrockInstall={bedrockInstall}
          onSelectLibrary={handleSelectLibrary}
          onCreated={handleServerCreated}
        />
      );
    }
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
        return <PlayersPage server={selectedServer} runtime={runtime} />;
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
              {selectedServer.edition === 'java' && (
                <span className={`flavor-badge flavor-${selectedServer.serverType}`}>
                  {selectedServer.serverType}
                </span>
              )}
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
        <CreateServerView
          edition={edition}
          appInfo={appInfo}
          libraryPath={libraryPath}
          libraryError={libraryError}
          lastJavaPath={lastJavaPath}
          install={install}
          bedrockInstall={bedrockInstall}
          onSelectLibrary={handleSelectLibrary}
          onCreated={handleServerCreated}
        />
      );
    }
    // A server-required page with no server: explain + offer to add one.
    if (activePage === 'datapacks') {
      // Datapacks is genuinely not implemented yet — keep the placeholder.
      return (
        <PlaceholderPage
          pageId={activePage}
          edition={edition}
          appVersion={appInfo?.version}
        />
      );
    }
    return (
      <section className="page">
        <header className="page-header">
          <h1>{pageTitle(activePage)}</h1>
          <span className="page-edition muted">
            {edition === 'java' ? 'Java Edition' : 'Bedrock Edition'}
          </span>
          {appInfo && <span className="page-version muted">v{appInfo.version}</span>}
        </header>
        <EmptyStatePanel
          edition={edition}
          pageTitle={pageTitle(activePage)}
          onAddServer={() => setAddingServer(true)}
        />
      </section>
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
          selectedServerName={selectedServer?.name ?? null}
          onEditionChange={handleEditionChange}
          onNavigate={handleNavigate}
          onAddServer={() => {
            setAddingServer(true);
          }}
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
                    onClick={() => {
                      setSelectedId(server.id);
                      setAddingServer(false);
                    }}
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
              <button
                type="button"
                className="server-chip server-chip-add"
                title="Add another server"
                onClick={() => {
                  setAddingServer(true);
                }}
              >
                + Add {edition === 'java' ? 'Java' : 'Bedrock'} Server
              </button>
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

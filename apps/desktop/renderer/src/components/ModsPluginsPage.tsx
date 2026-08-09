import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExtensionEntry,
  ExtensionListResponse,
  ServerFlavor,
  ServerRecord,
  ServerTypeOption,
} from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket } from '../lib/socket';
import type { ServerRuntime } from '../hooks/useServerRuntime';

interface ModsPluginsPageProps {
  server: ServerRecord;
  runtime: ServerRuntime;
}

interface ConvertState {
  busy: boolean;
  error: string | null;
  target: ServerFlavor;
  progress: string | null;
}

const FLAVOR_LABELS: Record<string, string> = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  paper: 'Paper',
};

/**
 * Shared Mods / Plugins manager for Fabric/Forge (mods/) and Paper
 * (plugins/) servers. Lists files with JAR metadata, enables/disables via
 * renames, uploads, deletes, and converts the server type in place.
 * Vanilla servers show a "not supported" notice.
 */
export default function ModsPluginsPage({ server, runtime }: ModsPluginsPageProps): React.JSX.Element {
  const conversionStorageKey = `msc.active-server-conversion:${server.id}`;
  const [data, setData] = useState<ExtensionListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverTypes, setServerTypes] = useState<ServerTypeOption[]>([]);
  const [convert, setConvert] = useState<ConvertState>({
    busy: false,
    error: null,
    target: 'fabric',
    progress: null,
  });
  const runningRef = useRef(runtime.state);
  runningRef.current = runtime.state;

  const serverRunning = runtime.state === 'online' || runtime.state === 'starting' || runtime.state === 'stopping';

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listExtensions(server.id);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void api.listServerTypes().then(setServerTypes).catch(() => undefined);
  }, []);

  // Subscribe to install:progress for convert progress. The operation id is
  // the only way to attribute an event to this page's convert, so startConvert
  // records it and the handler ignores events for other operations.
  const [convertOperationId, setConvertOperationId] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(conversionStorageKey);
    setConvertOperationId(saved);
    if (saved) {
      setBusy(true);
      setConvert((prev) => ({
        ...prev,
        busy: true,
        error: null,
        progress: 'Recovering conversion status…',
      }));
    } else {
      setBusy(false);
      setConvert((prev) => ({ ...prev, busy: false, progress: null }));
    }
  }, [conversionStorageKey]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void connectWebSocket().then((ws) => {
      if (cancelled) return;
      unsubscribe = ws.onEvent((event) => {
        if (event.type !== 'install:progress') return;
        if (event.installId !== convertOperationId) return;
        const progress = event.progress;
        if (progress.status === 'complete') {
          window.sessionStorage.removeItem(conversionStorageKey);
          setBusy(false);
          setConvertOperationId(null);
          setConvert((prev) => ({ ...prev, busy: false, progress: null }));
          setNotice('Server type converted.');
          void refresh();
        } else if (progress.status === 'failed' || progress.status === 'canceled') {
          window.sessionStorage.removeItem(conversionStorageKey);
          setBusy(false);
          setConvertOperationId(null);
          setConvert((prev) => ({ ...prev, busy: false, progress: null, error: progress.message }));
        } else {
          setConvert((prev) => ({ ...prev, progress: progress.message }));
        }
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [conversionStorageKey, convertOperationId, refresh]);

  // Polling is the reliable reconciliation channel across socket loss/remount.
  useEffect(() => {
    if (!convertOperationId) return;
    let stopped = false;
    const reconcile = async (): Promise<void> => {
      try {
        const operation = await api.getOperationStatus(convertOperationId);
        if (stopped || !operation || operation.kind !== 'server-conversion') return;
        if (operation.state === 'succeeded') {
          window.sessionStorage.removeItem(conversionStorageKey);
          setBusy(false);
          setConvertOperationId(null);
          setConvert((prev) => ({ ...prev, busy: false, progress: null }));
          setNotice('Server type converted.');
          void refresh();
        } else if (operation.state === 'failed' || operation.state === 'canceled') {
          window.sessionStorage.removeItem(conversionStorageKey);
          setBusy(false);
          setConvertOperationId(null);
          setConvert((prev) => ({
            ...prev,
            busy: false,
            progress: null,
            error: operation.message,
          }));
        } else {
          setBusy(true);
          setConvert((prev) => ({ ...prev, busy: true, progress: operation.message }));
        }
      } catch {
        // Keep the session id and retry; socket delivery may still recover first.
      }
    };
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), 1_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [conversionStorageKey, convertOperationId, refresh]);

  const requireStopped = (): boolean => {
    if (serverRunning) {
      setError('Stop the server before changing mods/plugins.');
      return true;
    }
    return false;
  };

  const toggle = async (entry: ExtensionEntry): Promise<void> => {
    if (requireStopped()) return;
    setBusy(true);
    setError(null);
    try {
      const res = entry.enabled
        ? await api.disableExtension(server.id, entry.name)
        : await api.enableExtension(server.id, entry.name);
      if (!res.ok) setError(res.error ?? 'Failed to toggle.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: ExtensionEntry): Promise<void> => {
    if (requireStopped()) return;
    if (!window.confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteExtension(server.id, entry.name);
      if (!res.ok) setError(res.error ?? 'Failed to delete.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onFilesSelected = async (): Promise<void> => {
    if (requireStopped()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.uploadExtensions(server.id);
      if (!res.ok) setError(res.error ?? 'Upload failed.');
      else setNotice(`Added ${res.added.length} file(s). Restart the server to load them.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (): Promise<void> => {
    const res = await api.openServerFolder(server.id);
    if (!res.ok) setError(res.error ?? 'Could not open folder.');
  };

  const importModpack = async (): Promise<void> => {
    if (requireStopped()) return;
    if (server.serverType !== 'fabric' && server.serverType !== 'forge') {
      setError('Modpacks require a Fabric or Forge server. Convert the server first.');
      return;
    }
    const picked = await api.selectModpack();
    if (!picked.path) return;
    setBusy(true);
    setError(null);
    setNotice('Importing modpack…');
    try {
      const res = await api.importModpack({ serverId: server.id, filePath: picked.path });
      if (!res.ok) {
        setError(res.error ?? 'Modpack import failed.');
        setNotice(null);
      } else {
        setNotice(
          `Modpack imported: ${res.modsAdded} mod(s), ${res.filesCopied} file(s) copied` +
            (res.skipped > 0 ? ` (${res.skipped} skipped)` : '') +
            '. Restart the server to load them.',
        );
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const startConvert = async (): Promise<void> => {
    if (requireStopped()) return;
    setBusy(true);
    setConvert((c) => ({ ...c, busy: true, error: null, progress: 'Preparing…' }));
    try {
      const res = await api.convertServer({ serverId: server.id, flavor: convert.target });
      if (res.error) {
        setConvert((c) => ({ ...c, busy: false, error: res.error ?? 'Conversion failed' }));
        setBusy(false);
        return;
      }
      // Record the operation id so install:progress events are attributed to
      // this convert (the backend emits a stream keyed by operationId).
      setConvertOperationId(res.operationId);
      window.sessionStorage.setItem(conversionStorageKey, res.operationId);
      setConvert((c) => ({ ...c, progress: 'Downloading…' }));
    } catch (err) {
      setConvert((c) => ({ ...c, busy: false, error: err instanceof Error ? err.message : String(err) }));
      setBusy(false);
    }
  };

  const cancelConvert = async (): Promise<void> => {
    if (!convertOperationId) return;
    try {
      const result = await api.cancelInstall(convertOperationId);
      if (result.canceled) {
        setConvert((prev) => ({ ...prev, progress: 'Canceling conversion…' }));
      } else {
        setConvert((prev) => ({
          ...prev,
          error: 'This conversion is no longer cancellable.',
        }));
      }
      // Do not clear storage/state until polling or WebSocket confirms terminal.
    } catch (err) {
      setConvert((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const hasExtensions = data?.folder != null;

  return (
    <section className="page">
      <header className="page-header">
        <h1>{data?.folder === 'plugins' ? 'Plugins' : 'Mods'}</h1>
        <span className="page-edition muted">{server.name}</span>
        <span className="page-edition muted">{FLAVOR_LABELS[server.serverType] ?? server.serverType}</span>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}
      {error && <div className="error-banner">{error}</div>}

      {!hasExtensions ? (
        <div className="panel">
          <h2 className="panel-title">Not Supported</h2>
          <p className="muted">
            This server type ({FLAVOR_LABELS[server.serverType] ?? server.serverType}) does not
            support mods or plugins. Convert it to Fabric, Forge, or Paper below to add them.
          </p>
          <ConvertControls
            server={server}
            serverTypes={serverTypes}
            convert={convert}
            setConvert={setConvert}
            onConvert={() => void startConvert()}
            onCancel={() => void cancelConvert()}
          />
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">{data?.folder === 'plugins' ? 'Plugins' : 'Mods'}</h2>
              <span className="muted">{data?.entries.length ?? 0} installed</span>
            </div>
            <p className="muted">
              {data?.folder === 'plugins'
                ? 'Paper plugins live in the plugins/ folder. Changes require a server restart.'
                : 'Mods live in the mods/ folder. Changes require a server restart.'}
            </p>
            <div className="dash-row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || serverRunning}
                onClick={() => void onFilesSelected()}
              >
                {busy ? 'Uploading…' : 'Upload .jar'}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void openFolder()}>
                Open Folder
              </button>
              {(server.serverType === 'fabric' || server.serverType === 'forge') && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || serverRunning}
                  onClick={() => void importModpack()}
                >
                  Import Modpack (.mrpack / .zip)
                </button>
              )}
              {serverRunning && <span className="muted">Stop the server to modify files.</span>}
            </div>
          </div>

          <div className="panel panel-stretch">
            {loading ? (
              <p className="muted">Loading…</p>
            ) : data?.entries.length === 0 ? (
              <p className="muted">No {data?.folder === 'plugins' ? 'plugins' : 'mods'} yet. Upload .jar files above.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Version</th>
                    <th>Size</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data?.entries.map((entry) => (
                    <tr key={entry.name} className={entry.enabled ? '' : 'ext-disabled'}>
                      <td>
                        <div>{entry.displayName ?? entry.name}</div>
                        {entry.metadataError && (
                          <div className="muted field-description">{entry.metadataError}</div>
                        )}
                        {!entry.enabled && <span className="ext-badge">disabled</span>}
                      </td>
                      <td>{entry.version ?? '—'}</td>
                      <td>{formatBytes(entry.sizeBytes)}</td>
                      <td className="table-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy || serverRunning}
                          onClick={() => void toggle(entry)}
                        >
                          {entry.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy || serverRunning}
                          onClick={() => void remove(entry)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <ConvertControls
            server={server}
            serverTypes={serverTypes}
            convert={convert}
            setConvert={setConvert}
            onConvert={() => void startConvert()}
            onCancel={() => void cancelConvert()}
          />
        </>
      )}
    </section>
  );
}

interface ConvertControlsProps {
  server: ServerRecord;
  serverTypes: ServerTypeOption[];
  convert: ConvertState;
  setConvert: React.Dispatch<React.SetStateAction<ConvertState>>;
  onConvert: () => void;
  onCancel: () => void;
}

function ConvertControls({ server, serverTypes, convert, setConvert, onConvert, onCancel }: ConvertControlsProps): React.JSX.Element {
  const options = (serverTypes.length > 0 ? serverTypes : []).filter((t) => t.id !== server.serverType);
  return (
    <div className="panel panel-stretch">
      <div className="panel-title-row">
        <h2 className="panel-title">Convert Server Type</h2>
      </div>
      <p className="muted">
        Swap this server to a different type in place (the world folder is preserved). This
        downloads the new server jar and, for Forge, runs the installer.
      </p>
      <div className="dash-row">
        <select
          className="input"
          value={convert.target}
          onChange={(e) => setConvert((c) => ({ ...c, target: e.target.value as ServerFlavor }))}
          disabled={convert.busy}
        >
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-sm" disabled={convert.busy || options.length === 0} onClick={onConvert}>
          {convert.busy ? 'Converting…' : 'Convert'}
        </button>
        {convert.busy && (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {convert.progress && <p className="muted">{convert.progress}</p>}
      {convert.error && <div className="error-banner">{convert.error}</div>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

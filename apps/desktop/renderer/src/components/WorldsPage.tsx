import { useEffect, useState } from 'react';
import type {
  SaveFolderSuggestion,
  ServerRecord,
  WorldDiscoveryResult,
  WorldImportProgress,
} from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket } from '../lib/socket';

interface WorldsPageProps {
  server: ServerRecord;
}

interface ActiveImport {
  importId: string;
  progress: WorldImportProgress;
}

export default function WorldsPage({ server }: WorldsPageProps): React.JSX.Element {
  const [scanFolder, setScanFolder] = useState<string | null>(null);
  const [result, setResult] = useState<WorldDiscoveryResult | null>(null);
  const [suggestions, setSuggestions] = useState<SaveFolderSuggestion[]>([]);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState<ActiveImport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getSaveFolders()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, []);

  // Subscribe to import progress.
  useEffect(() => {
    let cancelled = false;
    void connectWebSocket().then((ws) => {
      if (cancelled) return;
      ws.onEvent((event) => {
        if (event.type !== 'world:import-progress') return;
        setImporting((prev) => {
          if (!prev || prev.importId !== event.importId) return prev;
          if (event.progress.status === 'complete' || event.progress.status === 'failed' || event.progress.status === 'canceled') {
            setNotice(event.progress.message);
            return null;
          }
          return { importId: event.importId, progress: event.progress };
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickFolder = async (): Promise<void> => {
    const result = await api.selectWorldFolder();
    if (!result.canceled && result.path) {
      setScanFolder(result.path);
      setScanning(true);
      setError(null);
      try {
        const discovered = await api.discoverWorlds(result.path);
        setResult(discovered);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setScanning(false);
      }
    }
  };

  const scanSuggestion = async (folder: string): Promise<void> => {
    setScanFolder(folder);
    setScanning(true);
    setError(null);
    try {
      const discovered = await api.discoverWorlds(folder);
      setResult(discovered);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const importWorld = async (sourcePath: string): Promise<void> => {
    setNotice(null);
    setError(null);
    try {
      const response = await api.importWorld({ serverId: server.id, sourcePath });
      if (response.error) {
        setError(response.error);
        return;
      }
      setImporting({
        importId: response.importId,
        progress: { status: 'copying', percent: 0, message: 'Starting import…' },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelImport = async (): Promise<void> => {
    if (!importing) return;
    try {
      await api.cancelWorldImport(importing.importId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  return (
    <section className="page">
      <header className="page-header">
        <h1>Worlds</h1>
        <span className="page-edition muted">{server.name}</span>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}
      {error && <div className="error-banner">{error}</div>}

      {server.edition === 'bedrock' ? (
        <div className="panel">
          <h2 className="panel-title">Bedrock worlds</h2>
          <p className="muted">
            Bedrock worlds live inside the server folder (the world named by{' '}
            <code>level-name</code> in <code>server.properties</code>). Bedrock
            world import is not available yet — open the server folder to manage
            worlds directly.
          </p>
          <div className="dash-row">
            <button
              type="button"
              className="btn"
              onClick={() => void api.openServerFolder(server.folderPath)}
            >
              Open Server Folder
            </button>
          </div>
        </div>
      ) : (
        <>
      <div className="panel">
        <h2 className="panel-title">Find Worlds</h2>
        <p className="muted">
          Scan a folder for single-player worlds. Worlds are copied into the
          server — your originals are never touched.
        </p>
        <div className="dash-row">
          <button type="button" className="btn" onClick={() => void pickFolder()}>
            {scanFolder ? 'Change Folder…' : 'Choose Folder…'}
          </button>
          {scanFolder && (
            <span className="path-text form-path">{scanFolder}</span>
          )}
        </div>
        {suggestions.length > 0 && (
          <div className="suggestions-row">
            {suggestions.filter((s) => s.exists).map((s) => (
              <button
                key={s.path}
                type="button"
                className="btn btn-sm"
                onClick={() => void scanSuggestion(s.path)}
              >
                {s.path.split(/[\\/]/).pop()}
              </button>
            ))}
          </div>
        )}
      </div>

      {scanning && <p className="muted">Scanning…</p>}

      {result && (
        <div className="panel panel-stretch">
          <div className="panel-title-row">
            <h2 className="panel-title">Discovered Worlds</h2>
            <span className="muted">{result.worlds.length} found</span>
          </div>
          {result.worlds.length === 0 ? (
            <p className="muted">No valid worlds (folders with level.dat) found here.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>World</th>
                  <th>Game mode</th>
                  <th>Version</th>
                  <th>Size</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.worlds.map((world) => (
                  <tr key={world.path}>
                    <td>
                      {world.displayName || world.name}
                      <span className="muted"> · {world.name}</span>
                    </td>
                    <td>{world.gameMode ?? '—'}</td>
                    <td>{world.lastPlayedVersion ?? '—'}</td>
                    <td>{formatBytes(world.sizeBytes)}</td>
                    <td className="table-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!!importing}
                        onClick={() => void importWorld(world.path)}
                      >
                        Import
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {importing && (
        <div className="panel panel-stretch">
          <h2 className="panel-title">Importing World</h2>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${importing.progress.percent ?? 0}%` }}
            />
          </div>
          <div className="dash-row">
            <span className="muted">{importing.progress.message}</span>
            <button type="button" className="btn btn-sm" onClick={() => void cancelImport()}>
              Cancel
            </button>
          </div>
        </div>
      )}
        </>
      )}
    </section>
  );
}

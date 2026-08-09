import { useCallback, useEffect, useState } from 'react';
import type {
  BackupEntry,
  BackupProgress,
  ServerRecord,
} from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket } from '../lib/socket';

interface BackupsPageProps {
  server: ServerRecord;
}

interface ActiveOperation {
  operationId: string;
  kind: 'backup' | 'restore';
  progress: BackupProgress;
}

export default function BackupsPage({ server }: BackupsPageProps): React.JSX.Element {
  const storageKey = `msc.active-backup.${server.id}`;
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BackupEntry | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listBackups(server.id);
      setBackups(list);
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
    const saved = window.sessionStorage.getItem(storageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as Pick<ActiveOperation, 'operationId' | 'kind'>;
      setBusy(true);
      setOperation({
        ...parsed,
        progress: {
          status: parsed.kind === 'backup' ? 'creating' : 'restoring',
          percent: null,
          message: 'Recovering operation status…',
        },
      });
    } catch {
      window.sessionStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  // Subscribe to backup progress events.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void connectWebSocket().then((ws) => {
      if (cancelled) return;
      unsubscribe = ws.onEvent((event) => {
        if (event.type !== 'backup:progress') return;
        const { backupId, progress } = event;
        setOperation((prev) => {
          if (!prev || prev.operationId !== backupId) return prev;
          if (
            progress.status === 'complete' ||
            progress.status === 'failed' ||
            progress.status === 'canceled'
          ) {
            setBusy(false);
            setNotice(progress.message);
            window.sessionStorage.removeItem(storageKey);
            if (progress.status === 'complete') {
              void refresh();
            }
            return null;
          }
          return { ...prev, progress };
        });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [refresh, storageKey]);

  useEffect(() => {
    if (!operation) return;
    let stopped = false;
    const reconcile = async (): Promise<void> => {
      try {
        const status = await api.getOperationStatus(operation.operationId);
        if (stopped || !status || status.kind !== 'backup') return;
        const progress: BackupProgress = {
          status: status.status as BackupProgress['status'],
          percent: status.percent,
          message: status.message,
        };
        if (status.state !== 'active') {
          window.sessionStorage.removeItem(storageKey);
          setBusy(false);
          setNotice(status.message);
          setOperation(null);
          if (status.state === 'succeeded') void refresh();
        } else {
          setOperation((current) => current ? { ...current, progress } : current);
        }
      } catch {
        // Retry; live WebSocket progress remains the primary path.
      }
    };
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), 1_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [operation?.operationId, refresh, storageKey]);

  const createBackup = async (): Promise<void> => {
    setNotice(null);
    setError(null);
    try {
      const response = await api.createBackup({
        serverId: server.id,
        note: note.trim() || undefined,
      });
      if (response.error) {
        setError(response.error);
        return;
      }
      setBusy(true);
      setNote('');
      setOperation({
        operationId: response.operationId,
        kind: 'backup',
        progress: { status: 'creating', percent: 0, message: 'Starting backup…' },
      });
      window.sessionStorage.setItem(storageKey, JSON.stringify({ operationId: response.operationId, kind: 'backup' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const restoreBackup = async (backup: BackupEntry): Promise<void> => {
    if (!window.confirm(`Restore backup "${backup.note}"?\n\nThe current server folder will be replaced (a safety backup is created automatically).`)) {
      return;
    }
    setNotice(null);
    setError(null);
    try {
      const response = await api.restoreBackup({ backupId: backup.id });
      if (response.error) {
        setError(response.error);
        return;
      }
      setBusy(true);
      setOperation({
        operationId: response.operationId,
        kind: 'restore',
        progress: { status: 'restoring', percent: 0, message: 'Starting restore…' },
      });
      window.sessionStorage.setItem(storageKey, JSON.stringify({ operationId: response.operationId, kind: 'restore' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelOperation = async (): Promise<void> => {
    if (!operation) return;
    try {
      const result = await api.cancelBackup(operation.operationId);
      if (!result.canceled) setError('This operation is no longer cancellable.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteBackup = async (backup: BackupEntry): Promise<void> => {
    setConfirmDelete(null);
    setError(null);
    try {
      const result = await api.deleteBackup(backup.id);
      if (!result.deleted) {
        setError('Failed to delete the backup.');
        return;
      }
      setBackups((prev) => prev.filter((b) => b.id !== backup.id));
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

  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  return (
    <section className="page">
      <header className="page-header">
        <h1>Backups</h1>
        <span className="page-edition muted">{server.name}</span>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <h2 className="panel-title">Create Backup</h2>
        <p className="muted">
          Backups are stored outside the server folder and do not include the
          running server process. Stop the server first for a consistent snapshot.
        </p>
        <div className="dash-row">
          <input
            type="text"
            className="input form-path"
            placeholder="Optional note (e.g. before adding a mod)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
          />
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void createBackup()}
          >
            Create Backup
          </button>
        </div>
      </div>

      {operation && (
        <div className="panel panel-stretch">
          <h2 className="panel-title">
            {operation.kind === 'backup' ? 'Creating Backup' : 'Restoring Backup'}
          </h2>
          <div className="progress-track">
            <div
              className={
                operation.progress.percent != null
                  ? 'progress-fill'
                  : 'progress-fill indeterminate'
              }
              style={
                operation.progress.percent != null
                  ? { width: `${operation.progress.percent}%` }
                  : undefined
              }
            />
          </div>
          <div className="dash-row">
            <span className="muted">{operation.progress.message}</span>
            <button type="button" className="btn btn-sm" onClick={() => void cancelOperation()}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="panel panel-stretch">
        <div className="panel-title-row">
          <h2 className="panel-title">Backup List</h2>
          <span className="muted">{backups.length} stored</span>
        </div>
        {loading ? (
          <p className="muted">Loading backups…</p>
        ) : backups.length === 0 ? (
          <p className="muted">No backups yet. Create one above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Note</th>
                <th>Created</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.id}>
                  <td>{backup.note}</td>
                  <td>{formatDate(backup.createdAt)}</td>
                  <td>{formatBytes(backup.sizeBytes)}</td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void restoreBackup(backup)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => setConfirmDelete(backup)}
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

      {confirmDelete && (
        <div className="dialog-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">Delete Backup</div>
            <p>
              Delete backup <strong>{confirmDelete.note}</strong>? This cannot be
              undone.
            </p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void deleteBackup(confirmDelete)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

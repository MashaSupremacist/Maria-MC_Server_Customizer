import { useCallback, useEffect, useState } from 'react';
import type { PackEntry, PackKind, ServerRecord } from '@msc/shared-types';
import { api } from '../lib/api';

interface PackPageProps {
  server: ServerRecord;
  kind: PackKind;
}

export default function PackPage({ server, kind }: PackPageProps): React.JSX.Element {
  const [entries, setEntries] = useState<PackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PackEntry | null>(null);

  const isBehavior = kind === 'behavior';
  const title = isBehavior ? 'Behavior Packs' : 'Resource Packs';
  const folder = isBehavior ? 'behavior_packs' : 'resource_packs';

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listPacks(server.id, kind);
      setEntries(result.entries);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [server.id, kind]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFileChosen = async (): Promise<void> => {
    setNotice(null);
    setLoadError(null);
    setBusy(true);
    try {
      const result = await api.uploadPack(server.id, kind);
      if (!result.ok) {
        setLoadError(result.error ?? 'Upload failed');
      } else {
        setNotice(`Uploaded ${result.added.join(', ')}`);
        await refresh();
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deletePack = async (entry: PackEntry): Promise<void> => {
    setConfirmDelete(null);
    setBusy(true);
    setLoadError(null);
    try {
      const result = await api.deletePack(server.id, kind, entry.name);
      if (!result.ok) {
        setLoadError(result.error ?? 'Delete failed');
      } else {
        setNotice(`Deleted ${entry.name}`);
        await refresh();
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const formatDate = (iso: string): string => {
    return new Date(iso).toLocaleString();
  };

  return (
    <section className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <span className="page-edition muted">{server.name}</span>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}
      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="panel">
        <h2 className="panel-title">Upload Pack</h2>
        <p className="muted">
          Add <code>.mcpack</code> or <code>.zip</code> archives. They are extracted into the
          server&apos;s <code>{folder}/</code> folder so Bedrock loads them. Stop the
          server first.
        </p>
        <div className="dash-row">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void onFileChosen()}
          >
            {busy ? 'Importing…' : 'Select Pack Files'}
          </button>
        </div>
      </div>

      <div className="panel panel-stretch">
        <div className="panel-title-row">
          <h2 className="panel-title">{folder}/</h2>
          <span className="muted">{entries.length} packs</span>
        </div>
        {loading ? (
          <p className="muted">Loading packs…</p>
        ) : entries.length === 0 ? (
          <p className="muted">No packs installed yet. Upload one above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Files</th>
                <th>Size</th>
                <th>Modified</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.name}>
                  <td>{entry.name}</td>
                  <td className="muted">{entry.isFolder ? 'folder' : 'file'}</td>
                  <td>{entry.fileCount}</td>
                  <td>{formatBytes(entry.sizeBytes)}</td>
                  <td>{formatDate(entry.modifiedAt)}</td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => setConfirmDelete(entry)}
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
            <div className="dialog-title">Delete Pack</div>
            <p>
              Delete <strong>{confirmDelete.name}</strong> from {folder}/? This cannot be
              undone.
            </p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void deletePack(confirmDelete)}
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

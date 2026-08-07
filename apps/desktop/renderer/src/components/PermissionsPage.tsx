import { useEffect, useState } from 'react';
import type { BedrockPermissionEntry, BedrockPermissionLevel, ServerRecord } from '@msc/shared-types';
import { api } from '../lib/api';

interface PermissionsPageProps {
  server: ServerRecord;
}

const LEVELS: BedrockPermissionLevel[] = ['operator', 'member', 'visitor'];

export default function PermissionsPage({ server }: PermissionsPageProps): React.JSX.Element {
  const [entries, setEntries] = useState<BedrockPermissionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [xuid, setXuid] = useState('');
  const [level, setLevel] = useState<BedrockPermissionLevel>('operator');

  const load = async (): Promise<void> => {
    try {
      setEntries(await api.getBedrockPermissions(server.id));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, successMsg: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await fn();
      if (!result.ok) {
        setNotice(`Failed: ${result.error ?? 'unknown error'}`);
      } else {
        setNotice(successMsg);
        await load();
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const entry: BedrockPermissionEntry = {
      permission: level,
      name: trimmed,
      xuid: xuid.trim() || undefined,
    };
    void run(
      async () => api.updateBedrockPermissions(server.id, [...entries, entry]),
      `${trimmed} granted ${level}`,
    );
    setName('');
    setXuid('');
  };

  const remove = (entry: BedrockPermissionEntry): void => {
    void run(
      async () => api.updateBedrockPermissions(server.id, entries.filter((e) => e !== entry)),
      `${entry.name ?? entry.xuid ?? 'entry'} removed`,
    );
  };

  return (
    <section className="page">
      <header className="page-header">
        <h1>Permissions</h1>
        <span className="page-edition muted">{server.name}</span>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}
      {loadError && <div className="error-banner">{loadError}</div>}
      {loading && <p className="muted">Loading permissions…</p>}

      <div className="panel">
        <h2 className="panel-title">Add Permission</h2>
        <p className="muted">
          Permission entries are stored in <code>permissions.json</code> at the
          server root. <code>operator</code> grants full control; <code>member</code>{' '}
          is a normal player; <code>visitor</code> cannot build.
        </p>
        <div className="players-row">
          <input
            id="perm-name"
            className="input input-sm"
            placeholder="Player name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <input
            id="perm-xuid"
            className="input input-sm"
            placeholder="XUID (optional)"
            value={xuid}
            onChange={(e) => setXuid(e.target.value)}
            disabled={busy}
          />
          <select
            className="input input-sm"
            value={level}
            onChange={(e) => setLevel(e.target.value as BedrockPermissionLevel)}
            disabled={busy}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || (!name.trim() && !xuid.trim())}
            onClick={add}
          >
            Grant
          </button>
        </div>
      </div>

      <div className="panel panel-stretch">
        <div className="panel-title-row">
          <h2 className="panel-title">Permissions</h2>
          <span className="muted">{entries.length} entries</span>
        </div>
        {entries.length === 0 ? (
          <p className="muted">No permission entries yet.</p>
        ) : (
          <table className="players-table">
            <thead>
              <tr>
                <th>Permission</th>
                <th>Name</th>
                <th>XUID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={`${entry.name ?? entry.xuid}-${i}`}>
                  <td>{entry.permission}</td>
                  <td>{entry.name || '—'}</td>
                  <td className="muted">{entry.xuid || '—'}</td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => void remove(entry)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

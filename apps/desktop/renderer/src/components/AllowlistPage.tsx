import { useEffect, useState } from 'react';
import type { BedrockAllowlistEntry, ServerRecord } from '@msc/shared-types';
import { api } from '../lib/api';

interface AllowlistPageProps {
  server: ServerRecord;
}

export default function AllowlistPage({ server }: AllowlistPageProps): React.JSX.Element {
  const [entries, setEntries] = useState<BedrockAllowlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [xuid, setXuid] = useState('');

  const load = async (): Promise<void> => {
    try {
      setEntries(await api.getBedrockAllowlist(server.id));
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
    const entry: BedrockAllowlistEntry = { name: trimmed, xuid: xuid.trim() || undefined };
    void run(async () => api.updateBedrockAllowlist(server.id, [...entries, entry]), `${trimmed} added to the allowlist`);
    setName('');
    setXuid('');
  };

  const remove = (entry: BedrockAllowlistEntry): void => {
    void run(
      async () => api.updateBedrockAllowlist(server.id, entries.filter((e) => e !== entry)),
      `${entry.name} removed from the allowlist`,
    );
  };

  return (
    <section className="page">
      <header className="page-header">
        <h1>Allowlist</h1>
        <span className="page-edition muted">{server.name}</span>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}
      {loadError && <div className="error-banner">{loadError}</div>}
      {loading && <p className="muted">Loading allowlist…</p>}

      <div className="panel">
        <h2 className="panel-title">Add Player</h2>
        <p className="muted">
          Bedrock allowlist entries are stored in <code>allowlist.json</code> at the
          server root. Edits are applied while the server is stopped; use
          <code> /allowlist</code> commands while online.
        </p>
        <div className="players-row">
          <input
            id="allowlist-name"
            className="input input-sm"
            placeholder="Player name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <input
            id="allowlist-xuid"
            className="input input-sm"
            placeholder="XUID (optional)"
            value={xuid}
            onChange={(e) => setXuid(e.target.value)}
            disabled={busy}
          />
          <button type="button" className="btn btn-sm" disabled={busy || !name.trim()} onClick={add}>
            Add to Allowlist
          </button>
        </div>
      </div>

      <div className="panel panel-stretch">
        <div className="panel-title-row">
          <h2 className="panel-title">Allowlist</h2>
          <span className="muted">{entries.length} entries</span>
        </div>
        {entries.length === 0 ? (
          <p className="muted">No allowlisted players yet.</p>
        ) : (
          <table className="players-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>XUID</th>
                <th>Permission</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={`${entry.name}-${i}`}>
                  <td>{entry.name}</td>
                  <td className="muted">{entry.xuid || '—'}</td>
                  <td className="muted">{entry.permission ?? 'member'}</td>
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

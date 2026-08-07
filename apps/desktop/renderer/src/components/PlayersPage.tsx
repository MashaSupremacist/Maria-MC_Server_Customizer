import { useEffect, useState } from 'react';
import type { PlayerListEntry, ServerRecord } from '@msc/shared-types';
import { api } from '../lib/api';

interface PlayersPageProps {
  server: ServerRecord;
}

type ListKey = 'whitelist' | 'ops' | 'bans' | 'ipbans';

const LISTS: { key: ListKey; title: string; addLabel: string }[] = [
  { key: 'whitelist', title: 'Whitelist', addLabel: 'Whitelist player' },
  { key: 'ops', title: 'Operators', addLabel: 'Make operator' },
  { key: 'bans', title: 'Bans', addLabel: 'Ban player' },
  { key: 'ipbans', title: 'IP Bans', addLabel: 'Ban IP' },
];

export default function PlayersPage({ server }: PlayersPageProps): React.JSX.Element {
  const isBedrock = server.edition === 'bedrock';
  const [lists, setLists] = useState<Record<ListKey, PlayerListEntry[]>>({
    whitelist: [],
    ops: [],
    bans: [],
    ipbans: [],
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    // Bedrock does not use Java whitelist/ops/bans JSON files; those live in
    // the dedicated Allowlist and Permissions pages.
    if (isBedrock) {
      setLoading(false);
      return;
    }
    try {
      const [whitelist, ops, bans, ipbans] = await Promise.all([
        api.getWhitelist(server.id),
        api.getOperators(server.id),
        api.getBans(server.id),
        api.getIpBans(server.id),
      ]);
      setLists({ whitelist, ops, bans, ipbans });
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

  const addPlayer = async (list: ListKey, name: string): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const entry: PlayerListEntry = { name: trimmed, uuid: '' };
    const current = lists[list];
    const next = [...current, entry];
    await run(async () => {
      switch (list) {
        case 'whitelist':
          return api.updateWhitelist(server.id, next);
        case 'ops':
          return api.updateOperators(server.id, next);
        case 'bans':
          return api.updateBans(server.id, next);
        case 'ipbans':
          return api.updateIpBans(server.id, next);
      }
    }, `${trimmed} added to ${LISTS.find((l) => l.key === list)?.title ?? list}`);
  };

  const removePlayer = async (list: ListKey, name: string): Promise<void> => {
    const next = lists[list].filter((p) => p.name !== name);
    await run(async () => {
      switch (list) {
        case 'whitelist':
          return api.updateWhitelist(server.id, next);
        case 'ops':
          return api.updateOperators(server.id, next);
        case 'bans':
          return api.updateBans(server.id, next);
        case 'ipbans':
          return api.updateIpBans(server.id, next);
      }
    }, `${name} removed from ${LISTS.find((l) => l.key === list)?.title ?? list}`);
  };

  const sendCommand = async (command: string, successMsg: string): Promise<void> => {
    await run(async () => api.runPlayerCommand(server.id, command), successMsg);
  };

  return (
    <section className="page">
      <header className="page-header">
        <h1>Players</h1>
        <span className="page-edition muted">{server.name}</span>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}
      {loadError && <div className="error-banner">{loadError}</div>}
      {loading && <p className="muted">Loading players…</p>}

      {isBedrock && (
        <div className="panel">
          <h2 className="panel-title">Bedrock players</h2>
          <p className="muted">
            Bedrock Edition keeps player access in its own files. Use the
            <strong> Allowlist</strong> page to control who may join and the
            <strong> Permissions</strong> page to grant operator/member/visitor levels.
            The quick actions below send Bedrock console commands while the server is online.
          </p>
        </div>
      )}

      {!isBedrock && LISTS.map(({ key, title, addLabel }) => {
        const entries = lists[key];
        const isIp = key === 'ipbans';
        return (
          <div key={key} className="gamerule-group">
            <h3 className="gamerule-category">{title}</h3>
            <div className="players-row">
              <input
                id={`add-${key}`}
                className="input input-sm"
                placeholder={isIp ? '1.2.3.4' : 'Player name'}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  const input = document.getElementById(`add-${key}`) as HTMLInputElement | null;
                  if (input) {
                    void addPlayer(key, input.value);
                    input.value = '';
                  }
                }}
              >
                {addLabel}
              </button>
            </div>
            {entries.length === 0 ? (
              <p className="muted">No entries.</p>
            ) : (
              <table className="players-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    {!isIp && <th>UUID</th>}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={`${key}-${entry.name}`}>
                      <td>{entry.name}</td>
                      {!isIp && <td className="muted">{entry.uuid || '—'}</td>}
                      <td className="table-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void removePlayer(key, entry.name)}
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
        );
      })}

      <div className="gamerule-group">
        <h3 className="gamerule-category">Quick actions (online)</h3>
        <div className="players-row">
          <input id="cmd-player" className="input input-sm" placeholder="Player name" />
          {['/kick', '/op', '/deop', '/ban'].map((cmd) => (
            <button
              key={cmd}
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                const input = document.getElementById('cmd-player') as HTMLInputElement | null;
                const name = input?.value.trim() ?? '';
                if (name) {
                  void sendCommand(`${cmd} ${name}`, `${cmd} ${name} sent`);
                  if (input) input.value = '';
                }
              }}
            >
              {cmd}
            </button>
          ))}
        </div>
        <p className="muted">
          Quick actions send Minecraft console commands, so they only work while the server is online.
          {!isBedrock && (
            <>
              {' '}Offline edits (whitelist, ops, bans) are applied directly to the JSON files when the
              server is stopped.
            </>
          )}
        </p>
      </div>
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { GamerulesDocument, ServerRecord } from '@msc/shared-types';
import { api } from '../lib/api';

interface GamerulesPageProps {
  server: ServerRecord;
}

export default function GamerulesPage({ server }: GamerulesPageProps): React.JSX.Element {
  const [doc, setDoc] = useState<GamerulesDocument | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    api
      .getGamerules(server.id)
      .then((document) => {
        if (!cancelled) {
          setDoc(document);
          setDrafts(Object.fromEntries(document.rules.map((rule) => [rule.key, String(rule.value)])));
          setLoadError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [server.id]);

  const groups = useMemo(() => {
    if (!doc) return [];
    const filtered = search.trim()
      ? doc.rules.filter((r) =>
          r.key.toLowerCase().includes(search.trim().toLowerCase()) ||
          r.description.toLowerCase().includes(search.trim().toLowerCase()),
        )
      : doc.rules;
    const byCategory = new Map<string, typeof filtered>();
    for (const rule of filtered) {
      const list = byCategory.get(rule.category) ?? [];
      list.push(rule);
      byCategory.set(rule.category, list);
    }
    return [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [doc, search]);

  const apply = async (key: string, rawValue: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.updateGamerule(server.id, key, rawValue);
      if (!result.ok) {
        setNotice(`Failed: ${result.error ?? 'unknown error'}`);
      } else {
        setNotice(`${key} updated${doc?.offline ? ' (applied to gamerules.json)' : ''}`);
        // Refresh to reflect new value.
        const fresh = await api.getGamerules(server.id);
        setDoc(fresh);
        setDrafts(Object.fromEntries(fresh.rules.map((rule) => [rule.key, String(rule.value)])));
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="page">
        <header className="page-header">
          <h1>Gamerules</h1>
          <span className="page-edition muted">{server.name}</span>
        </header>
        <div className="error-banner">{loadError}</div>
      </section>
    );
  }

  if (!doc) {
    return (
      <section className="page">
        <header className="page-header">
          <h1>Gamerules</h1>
          <span className="page-edition muted">{server.name}</span>
        </header>
        <p className="muted">Loading gamerules…</p>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Gamerules</h1>
        <span className="page-edition muted">{server.name}</span>
        <span className="page-version muted">{doc.offline ? 'offline (file)' : 'live'}</span>
      </header>

      <div className="console-toolbar">
        <input
          className="input input-sm"
          placeholder="Search gamerules…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {notice && <div className="notice-banner">{notice}</div>}

      {groups.length === 0 && <p className="muted">No gamerules match.</p>}

      {groups.map(([category, rules]) => (
        <div key={category} className="gamerule-group">
          <h3 className="gamerule-category">{category}</h3>
          <div className="settings-list">
            {rules.map((rule) => (
              <div key={rule.key} className="settings-field">
                <div className="settings-field-header">
                  <label className="form-label" htmlFor={`gr-${rule.key}`}>
                    {rule.key}
                  </label>
                </div>
                <div className="settings-field-controls">
                  {rule.type === 'boolean' ? (
                    <select
                      id={`gr-${rule.key}`}
                      className="input input-sm"
                      value={String(rule.value)}
                      disabled={busy}
                      onChange={(e) => void apply(rule.key, e.target.value)}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      id={`gr-${rule.key}`}
                      className="input input-sm"
                      type="number"
                      value={drafts[rule.key] ?? String(rule.value)}
                      disabled={busy}
                      onChange={(e) => setDrafts((current) => ({ ...current, [rule.key]: e.target.value }))}
                      onBlur={(e) => {
                        if (e.target.value !== String(rule.value)) {
                          void apply(rule.key, e.target.value);
                        }
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void apply(rule.key, String(rule.defaultValue))}
                  >
                    Reset
                  </button>
                </div>
                <p className="muted field-description">
                  <code>{rule.key}</code> — {rule.description}
                  {rule.min !== undefined && rule.max !== undefined
                    ? ` (${rule.min}–${rule.max})`
                    : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

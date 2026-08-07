import { useEffect, useState } from 'react';
import type { ServerPropertiesDocument, ServerRecord } from '@msc/shared-types';
import { api } from '../lib/api';

interface SettingsPageProps {
  server: ServerRecord;
}

interface DraftValue {
  raw: string;
}

export default function SettingsPage({ server }: SettingsPageProps): React.JSX.Element {
  const [doc, setDoc] = useState<ServerPropertiesDocument | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setErrors({});
    setNotice(null);
    const isBedrock = server.edition === 'bedrock';
    (isBedrock ? api.getBedrockProperties(server.id) : api.getServerProperties(server.id))
      .then((document) => {
        if (cancelled) return;
        setDoc(document);
        const initial: Record<string, DraftValue> = {};
        for (const entry of document.fields) {
          initial[entry.field.key] = { raw: String(entry.value) };
        }
        setDrafts(initial);
        setRawText(document.rawText);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, server.edition]);

  const setValue = (key: string, raw: string): void => {
    setDrafts((prev) => ({ ...prev, [key]: { raw } }));
    // Clear any prior error for this key.
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = async (): Promise<void> => {
    if (!doc) return;
    setNotice(null);
    const values: Record<string, string> = {};
    for (const entry of doc.fields) {
      values[entry.field.key] = drafts[entry.field.key]?.raw ?? String(entry.value);
    }
    try {
      const result = server.edition === 'bedrock'
        ? await api.updateBedrockProperties(server.id, { values })
        : await api.updateServerProperties(server.id, { values });
      setErrors(result.validation.errors);
      if (result.validation.ok) {
        setDoc(result.document);
        setNotice(
          result.document.lastBackupPath
            ? `Saved. A backup was written to ${result.document.lastBackupPath}`
            : 'Saved.',
        );
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const resetField = (key: string, defaultValue: string | number | boolean): void => {
    setValue(key, String(defaultValue));
  };

  const renderField = (
    key: string,
    label: string,
    description: string,
    type: string,
    raw: string,
    enumValues: string[] | undefined,
    fieldDefault: string | number | boolean,
    restartRequired: boolean,
  ): React.JSX.Element => {
    const error = errors[key];
    return (
      <div className="settings-field">
        <div className="settings-field-header">
          <label className="form-label" htmlFor={`prop-${key}`}>
            {label}
          </label>
          {restartRequired && <span className="restart-badge">restart</span>}
          {error && <span className="text-danger">{error}</span>}
        </div>
        <div className="settings-field-controls">
          {type === 'boolean' ? (
            <select
              id={`prop-${key}`}
              className="input input-sm"
              value={raw}
              onChange={(e) => setValue(key, e.target.value)}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : type === 'enum' && enumValues ? (
            <select
              id={`prop-${key}`}
              className="input input-sm"
              value={raw}
              onChange={(e) => setValue(key, e.target.value)}
            >
              {enumValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`prop-${key}`}
              className="input input-sm"
              type={type === 'integer' ? 'number' : 'text'}
              value={raw}
              onChange={(e) => setValue(key, e.target.value)}
            />
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => resetField(key, fieldDefault)}
            title={`Reset to default (${String(fieldDefault)})`}
          >
            Reset
          </button>
        </div>
        <p className="muted field-description">
          <code>{key}</code> — {description}
        </p>
      </div>
    );
  };

  if (loadError) {
    return (
      <section className="page">
        <header className="page-header">
          <h1>Settings</h1>
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
          <h1>Settings</h1>
          <span className="page-edition muted">{server.name}</span>
        </header>
        <p className="muted">Loading server.properties…</p>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Settings</h1>
        <span className="page-edition muted">{server.name}</span>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setRawMode((prev) => !prev);
              setNotice(null);
            }}
          >
            {rawMode ? 'Friendly Editor' : 'Advanced (raw)'}
          </button>
        </div>
      </header>

      {notice && <div className="notice-banner">{notice}</div>}

      {rawMode ? (
        <div className="panel">
          <h2 className="panel-title">Raw server.properties</h2>
          <p className="muted">
            Edit the file directly. Comments and unknown keys are preserved on
            save; known fields are still validated.
          </p>
          <textarea
            className="input raw-editor"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
          />
          <div className="dash-row">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                // Parse raw text into values for the schema fields.
                try {
                  const values: Record<string, string> = {};
                  for (const line of rawText.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
                    const eq = trimmed.indexOf('=');
                    const colon = trimmed.indexOf(':');
                    const sep = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
                    if (sep < 0) continue;
                    values[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
                  }
                  const result = server.edition === 'bedrock'
                    ? await api.updateBedrockProperties(server.id, { values })
                    : await api.updateServerProperties(server.id, { values });
                  setErrors(result.validation.errors);
                  if (result.validation.ok) {
                    setDoc(result.document);
                    setNotice('Saved from raw editor.');
                  }
                } catch (err) {
                  setLoadError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Save Raw
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-list">
          {doc.fields.map((entry) =>
            renderField(
              entry.field.key,
              entry.field.label,
              entry.field.description,
              entry.field.type,
              drafts[entry.field.key]?.raw ?? String(entry.value),
              entry.field.enumValues,
              entry.field.default,
              entry.field.restartRequired,
            ),
          )}
        </div>
      )}

      <div className="dash-row settings-actions">
        <button type="button" className="btn" onClick={() => void save()} disabled={rawMode}>
          Save Changes
        </button>
        {Object.keys(errors).length > 0 && (
          <span className="text-danger">
            {Object.keys(errors).length} invalid field(s) — fix them to save.
          </span>
        )}
      </div>
    </section>
  );
}

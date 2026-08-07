import { useState } from 'react';
import type { ServerRecord } from '@msc/shared-types';
import type { BedrockInstallController } from '../hooks/useBedrockInstall';

interface BedrockServerFormProps {
  libraryPath: string | null;
  install: BedrockInstallController;
  onCreated: (server: ServerRecord) => void;
}

export default function BedrockServerForm({
  libraryPath,
  install,
  onCreated,
}: BedrockServerFormProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [port, setPort] = useState(19132);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [acceptEula, setAcceptEula] = useState(false);

  const releases = install.versions.filter((v) => v.type === 'release');
  const previews = install.versions.filter((v) => v.type === 'preview');

  const canInstall =
    name.trim().length > 0 && !!libraryPath && !!selectedVersion;

  const busy = install.install.phase === 'installing';
  const progress = install.install.phase === 'installing' ? install.install.progress : null;

  const startInstall = (): void => {
    void install.start({
      name: name.trim(),
      version: selectedVersion,
      folderName: folderName.trim() || undefined,
      port,
      acceptEula,
    });
  };

  return (
    <div className="panel">
      <h2 className="panel-title">New Bedrock Server</h2>
      <p className="muted form-help">
        Installs the official Bedrock Dedicated Server (bedrock_server.exe).
        Bedrock does not use Java — it runs as a native Windows executable.
      </p>
      <div className="form-row">
        <label className="form-label" htmlFor="bedrock-server-name">
          Server name
        </label>
        <input
          id="bedrock-server-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Bedrock Server"
          disabled={busy}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="bedrock-server-folder">
          Folder name (optional)
        </label>
        <input
          id="bedrock-server-folder"
          className="input"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          placeholder="auto from name"
          disabled={busy}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="bedrock-server-version">
          Bedrock version
        </label>
        {install.versionsError ? (
          <span className="text-danger">{install.versionsError}</span>
        ) : install.versions.length === 0 ? (
          <span className="muted">Loading versions…</span>
        ) : (
          <select
            id="bedrock-server-version"
            className="input"
            value={selectedVersion || (releases[0]?.id ?? previews[0]?.id ?? '')}
            onChange={(e) => setSelectedVersion(e.target.value)}
            disabled={busy}
          >
            {releases.length > 0 && (
              <optgroup label="Releases">
                {releases.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                  </option>
                ))}
              </optgroup>
            )}
            {previews.length > 0 && (
              <optgroup label="Preview">
                {previews.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="bedrock-server-port">
          Port
        </label>
        <input
          id="bedrock-server-port"
          className="input"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(Number(e.target.value) || 19132)}
          disabled={busy}
        />
        <p className="muted form-help">Bedrock default is UDP 19132.</p>
      </div>
      <div className="form-row">
        <label className="dash-row muted checkbox-label">
          <input
            type="checkbox"
            checked={acceptEula}
            onChange={(e) => setAcceptEula(e.target.checked)}
            disabled={busy}
          />
          I agree to the Minecraft End User License Agreement (EULA)
        </label>
      </div>

      {busy && progress && (
        <div className="form-row">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress.percent ?? 0}%` }}
            />
          </div>
          <div className="dash-row">
            <span className="muted">{progress.message}</span>
            <button type="button" className="btn btn-sm" onClick={() => void install.cancel()}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {install.error && <div className="error-banner">{install.error}</div>}
      <div className="form-row">
        <button
          type="button"
          className="btn"
          disabled={!canInstall || busy || !acceptEula}
          onClick={startInstall}
        >
          {busy ? 'Installing…' : 'Install Bedrock Server'}
        </button>
        {!libraryPath && <span className="muted">Choose a library folder first.</span>}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ServerFlavor, ServerRecord, ServerTypeOption, VanillaVersion } from '@msc/shared-types';
import { api } from '../lib/api';
import type { InstallController } from '../hooks/useVanillaInstall';

interface ServerFormProps {
  libraryPath: string | null;
  install: InstallController;
  onCreated: (server: ServerRecord) => void;
}

export default function ServerForm({
  libraryPath,
  install,
  onCreated,
}: ServerFormProps): React.JSX.Element {
  const [flavor, setFlavor] = useState<ServerFlavor>('vanilla');
  const [name, setName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [javaPath, setJavaPath] = useState<string | null>(null);
  const [memoryMb, setMemoryMb] = useState(1024);
  const [acceptEula, setAcceptEula] = useState(false);
  const [versions, setVersions] = useState<VanillaVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [showJavaGuide, setShowJavaGuide] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Fabric / Forge options
  const [loaderVersion, setLoaderVersion] = useState('');
  const [includeFabricApi, setIncludeFabricApi] = useState(false);
  const [forgeBuild, setForgeBuild] = useState('');
  const [paperBuild, setPaperBuild] = useState('');
  const [fabricLoaders, setFabricLoaders] = useState<string[]>([]);
  const [fabricLoadersError, setFabricLoadersError] = useState<string | null>(null);

  const flavorMeta = install.serverTypes.find((t) => t.id === flavor);

  // Load the Minecraft version list once.
  useEffect(() => {
    let cancelled = false;
    api
      .getVanillaVersions()
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        if (list.length > 0) setSelectedVersion(list[0].id);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setVersionsError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load Fabric loader versions when a Fabric server + version is selected.
  useEffect(() => {
    if (flavor !== 'fabric' || !selectedVersion) return;
    let cancelled = false;
    setFabricLoaders([]);
    setFabricLoadersError(null);
    api
      .listFabricLoaders?.(selectedVersion)
      .then((loaders) => {
        if (cancelled) return;
        setFabricLoaders(loaders);
        if (loaders.length > 0 && !loaderVersion) setLoaderVersion(loaders[0]);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFabricLoadersError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flavor, selectedVersion]);

  const canInstall =
    name.trim().length > 0 && !!libraryPath && !!selectedVersion;

  const pickJava = async (): Promise<void> => {
    const result = await api.selectJavaExecutable();
    if (!result.canceled && result.path) setJavaPath(result.path);
  };

  const busy = install.install.phase === 'installing';
  const progress = install.install.phase === 'installing' ? install.install.progress : null;

  const startInstall = (): void => {
    void install.start({
      flavor,
      name: name.trim(),
      version: selectedVersion,
      folderName: folderName.trim() || undefined,
      javaPath,
      memoryMb,
      acceptEula,
      loaderVersion: flavor === 'fabric' ? loaderVersion || undefined : undefined,
      includeFabricApi: flavor === 'fabric' ? includeFabricApi : undefined,
      paperBuild: flavor === 'paper' ? paperBuild || undefined : undefined,
      forgeBuild: flavor === 'forge' ? forgeBuild || undefined : undefined,
    });
  };

  return (
    <div className="panel">
      <h2 className="panel-title">New Server</h2>
      <div className="form-row">
        <label className="form-label" htmlFor="server-flavor">
          Server type
        </label>
        <select
          id="server-flavor"
          className="input"
          value={flavor}
          onChange={(e) => setFlavor(e.target.value as ServerFlavor)}
          disabled={busy}
        >
          {(install.serverTypes.length > 0 ? install.serverTypes : defaultTypes).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {flavorMeta && <p className="muted form-help">{flavorMeta.description}</p>}
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="server-name">
          Server name
        </label>
        <input
          id="server-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Server"
          disabled={busy}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="server-folder">
          Folder name (optional)
        </label>
        <input
          id="server-folder"
          className="input"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          placeholder="auto from name"
          disabled={busy}
        />
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="server-version">
          Minecraft version
        </label>
        {!loaded ? (
          <span className="muted">Loading versions…</span>
        ) : versionsError ? (
          <span className="text-danger">{versionsError}</span>
        ) : (
          <select
            id="server-version"
            className="input"
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(e.target.value)}
            disabled={busy}
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
                {v.type === 'snapshot' ? ' (snapshot)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>
      {flavor === 'fabric' && (
        <div className="form-row">
          <label className="form-label" htmlFor="fabric-loader">
            Fabric loader
          </label>
          {fabricLoadersError ? (
            <span className="text-danger">{fabricLoadersError}</span>
          ) : fabricLoaders.length === 0 ? (
            <span className="muted">Loading loaders…</span>
          ) : (
            <select
              id="fabric-loader"
              className="input"
              value={loaderVersion}
              onChange={(e) => setLoaderVersion(e.target.value)}
              disabled={busy}
            >
              {fabricLoaders.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
          <label className="dash-row muted checkbox-label" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={includeFabricApi}
              onChange={(e) => setIncludeFabricApi(e.target.checked)}
              disabled={busy}
            />
            Also install Fabric API
          </label>
        </div>
      )}
      <div className="form-row">
        <label className="form-label" htmlFor="server-memory">
          RAM (MB)
        </label>
        <input
          id="server-memory"
          className="input"
          type="number"
          min={128}
          max={131072}
          step={256}
          value={memoryMb}
          onChange={(e) => setMemoryMb(Number(e.target.value) || 1024)}
          disabled={busy}
        />
      </div>
      <div className="form-row">
        <label className="form-label">Java executable</label>
        <div className="form-inline">
          <span className="path-text form-path">{javaPath ?? 'Not selected'}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void pickJava()}
            disabled={busy}
          >
            {javaPath ? 'Change' : 'Select java.exe'}
          </button>
          {!javaPath && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowJavaGuide((v) => !v)}
              disabled={busy}
            >
              {showJavaGuide ? 'Hide guide' : 'How to choose java.exe'}
            </button>
          )}
        </div>

        {!javaPath && (
          <div className="muted form-help">
            Don&apos;t have a java.exe file yet?{' '}
            <a
              href="#"
              className="link"
              onClick={(e) => {
                e.preventDefault();
                window.open(
                  'https://adoptium.net/temurin/releases/?version=21&os=windows&arch=x64&package=jdk',
                  '_blank',
                );
              }}
            >
              Click here to download Java for free (Windows .zip)
            </a>
          </div>
        )}

        {!javaPath && showJavaGuide && (
          <div className="java-guide">
            <ol>
              <li>Click the link above and download the <strong>.zip</strong> (Windows x64, JDK).</li>
              <li>Right-click the downloaded zip → <strong>Extract All</strong>.</li>
              <li>Open the extracted folder (e.g. <code>jdk-21.0.2</code>).</li>
              <li>Open the <code>bin</code> folder inside it.</li>
              <li>You&apos;ll see <code>java.exe</code> — select that exact file with the button above.</li>
            </ol>
          </div>
        )}
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
          {busy ? 'Installing…' : 'Install Server'}
        </button>
        {!libraryPath && <span className="muted">Choose a library folder first.</span>}
      </div>
    </div>
  );
}

/** Fallback types before the backend responds. */
const defaultTypes: ServerTypeOption[] = [
  { id: 'vanilla', label: 'Vanilla', description: 'The official Mojang server. No mods or plugins.', hasExtensions: false, requiresInstallStep: false },
  { id: 'fabric', label: 'Fabric', description: 'Lightweight mod loader. Mods live in a mods/ folder.', hasExtensions: true, requiresInstallStep: false },
  { id: 'forge', label: 'Forge', description: 'The classic mod loader. Mods live in a mods/ folder.', hasExtensions: true, requiresInstallStep: true },
  { id: 'paper', label: 'Paper', description: 'High-performance server with plugin support (plugins/ folder).', hasExtensions: true, requiresInstallStep: false },
];

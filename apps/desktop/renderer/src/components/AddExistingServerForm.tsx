import { useState } from 'react';
import type {
  DetectedServerInfo,
  ServerFlavor,
  ServerRecord,
} from '@msc/shared-types';
import { api } from '../lib/api';

/** Java flavors the user may pick when auto-detection is wrong. */
const FLAVOR_OPTIONS: { value: ServerFlavor; label: string }[] = [
  { value: 'vanilla', label: 'Vanilla' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'forge', label: 'Forge' },
  { value: 'paper', label: 'Paper' },
];

/** Human label for a server type string (bedrock or a flavor). */
function serverTypeLabelFor(serverType: string | null, edition: DetectedServerInfo['edition'] | undefined): string {
  if (edition === 'bedrock') return 'Bedrock';
  if (!serverType) return '';
  const opt = FLAVOR_OPTIONS.find((o) => o.value === serverType);
  return opt?.label ?? serverType;
}

interface AddExistingServerFormProps {
  /** Last java.exe used; pre-fills the form for detected Java servers. */
  initialJavaPath?: string | null;
  onCreated: (server: ServerRecord) => void;
  onSwitchToInstall: () => void;
}

const DETECTION_HINTS = [
  'server.jar (or a single .jar) for Vanilla',
  'fabric-server-launch.jar for Fabric',
  'forge-*.jar for Forge',
  'paper-*.jar for Paper',
  'bedrock_server.exe for Bedrock',
];

/**
 * Lets the user register a server folder that already contains a Minecraft
 * server. The folder is inspected on the backend (edition + flavor detected)
 * and only a lightweight DB record is created — no downloads, no install step.
 */
export default function AddExistingServerForm({
  initialJavaPath = null,
  onCreated,
  onSwitchToInstall,
}: AddExistingServerFormProps): React.JSX.Element {
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedServerInfo | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState<string>('');
  const [acceptEula, setAcceptEula] = useState(false);
  const [javaPath, setJavaPath] = useState<string | null>(initialJavaPath);
  const [memoryMb, setMemoryMb] = useState(1024);
  const [port, setPort] = useState(25565);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Manual flavor pick; 'auto' = trust detection. */
  const [flavorOverride, setFlavorOverride] = useState<ServerFlavor | 'auto'>('auto');

  const pickFolder = async (): Promise<void> => {
    setError(null);
    try {
      const result = await api.selectServerLibrary();
      if (result.canceled || !result.path) return;
      setChecking(true);
      const info = await api.detectServerFolder(result.path);
      setPickedPath(result.path);
      setDetected(info);
      setVersion(info.version ?? '');
      setAcceptEula(false);
      setJavaPath(null);
      setMemoryMb(1024);
      setPort(25565);
      setFlavorOverride('auto');
      if (info.edition) {
        // Default the name to the folder name.
        const base = result.path.split(/[\\/]/).pop() ?? 'My Server';
        setName(base);
      } else {
        setName('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const canAdd =
    !!pickedPath &&
    !!detected?.edition &&
    name.trim().length > 0 &&
    (detected.edition === 'bedrock' || acceptEula) &&
    !saving;

  /** The flavor recorded for this server: manual override or the detected one. */
  const effectiveServerType =
    detected?.edition === 'java' && flavorOverride !== 'auto'
      ? flavorOverride
      : detected?.serverType ?? null;

  const addServer = async (): Promise<void> => {
    if (!pickedPath || !detected?.edition || !effectiveServerType) return;
    setError(null);
    setSaving(true);
    try {
      const record = await api.createServer({
        name: name.trim(),
        edition: detected.edition,
        serverType: effectiveServerType,
        folderPath: pickedPath,
        javaPath: detected.edition === 'java' ? javaPath : null,
        memoryMb: detected.edition === 'java' ? memoryMb : undefined,
        port,
        version: version.trim() || null,
        acceptEula,
      });
      onCreated(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const pickJava = async (): Promise<void> => {
    const result = await api.selectJavaExecutable();
    if (!result.canceled && result.path) setJavaPath(result.path);
  };

  const editionLabel = detected?.edition === 'bedrock' ? 'Bedrock' : 'Java';
  const serverTypeLabel = serverTypeLabelFor(effectiveServerType, detected?.edition);

  return (
    <div className="panel">
      <h2 className="panel-title">Add Existing Server</h2>
      <p className="muted form-help">
        Point at a folder that already contains a Minecraft server. The app
        detects the edition and type automatically — nothing is downloaded or
        overwritten.
      </p>

      <div className="form-row">
        <button
          type="button"
          className="btn"
          onClick={() => void pickFolder()}
          disabled={checking || saving}
        >
          {checking ? 'Checking…' : pickedPath ? 'Choose Another Folder' : 'Choose Folder'}
        </button>
      </div>

      {pickedPath && (
        <div className="dash-row">
          <span className="path-text form-path">{pickedPath}</span>
        </div>
      )}

      {pickedPath && detected && !detected.edition && (
        <div className="empty-state-muted">
          <p className="text-danger">No Minecraft server detected in this folder.</p>
          <p className="muted">
            Recognized files: {DETECTION_HINTS.join(', ')}.
          </p>
          <button type="button" className="btn btn-sm" onClick={onSwitchToInstall}>
            Install a new server instead
          </button>
        </div>
      )}

      {pickedPath && detected?.edition && (
        <div className="form-stack">
          <div className="form-row">
            <span className="form-label">Detected</span>
            <div className="dash-row">
              <span className={`chip-edition chip-edition-${detected.edition}`}>
                {editionLabel}
              </span>
              <span className="muted">{serverTypeLabel}</span>
            </div>
          </div>

          {detected.edition === 'java' && (
            <div className="form-row">
              <label className="form-label" htmlFor="add-existing-flavor">
                Java flavor
              </label>
              <select
                id="add-existing-flavor"
                className="input"
                value={flavorOverride}
                onChange={(e) =>
                  setFlavorOverride(e.target.value as ServerFlavor | 'auto')
                }
                disabled={saving}
              >
                <option value="auto">
                  Auto ({serverTypeLabelFor(detected.serverType, 'java')})
                </option>
                {FLAVOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="muted form-help">
                Auto-detected from the jar name (fabric-server-launch.jar,
                forge-*.jar, paper-*.jar, server.jar). If detection is wrong —
                e.g. a renamed jar that's actually Forge — pick the right
                flavor here so the correct jar is launched.
              </p>
            </div>
          )}

          <div className="form-row">
            <label className="form-label" htmlFor="add-existing-name">
              Server name
            </label>
            <input
              id="add-existing-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Server"
              disabled={saving}
            />
          </div>

          {detected.edition === 'java' && (
            <div className="form-row">
              <label className="form-label" htmlFor="add-existing-version">
                Minecraft version
              </label>
              <input
                id="add-existing-version"
                className="input"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="e.g. 1.7.10"
                disabled={saving}
              />
              <p className="muted form-help">
                Detected from the jar name when possible. Used to pick the
                right Java runtime (e.g. 1.7.10 needs Java 8).
              </p>
            </div>
          )}

          {detected.edition === 'java' && (
            <>
              <div className="form-row">
                <label className="form-label">Java executable</label>
                <div className="form-inline">
                  <span className="path-text form-path">{javaPath ?? 'Not selected'}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void pickJava()}
                    disabled={saving}
                  >
                    {javaPath ? 'Change' : 'Select java.exe'}
                  </button>
                </div>
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="add-existing-memory">
                  RAM (MB)
                </label>
                <input
                  id="add-existing-memory"
                  className="input"
                  type="number"
                  min={128}
                  max={131072}
                  step={256}
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(Number(e.target.value) || 1024)}
                  disabled={saving}
                />
              </div>
            </>
          )}

          <div className="form-row">
            <label className="form-label" htmlFor="add-existing-port">
              Port
            </label>
            <input
              id="add-existing-port"
              className="input"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 25565)}
              disabled={saving}
            />
          </div>

          {detected.edition === 'java' && (
            <div className="form-row">
              <label className="form-label" htmlFor="add-existing-eula">
                EULA
              </label>
              <label className="checkbox-label">
                <input
                  id="add-existing-eula"
                  type="checkbox"
                  checked={acceptEula}
                  onChange={(e) => setAcceptEula(e.target.checked)}
                  disabled={saving}
                />
                <span>
                  I agree to the Minecraft End User License Agreement (EULA).
                  This writes an <code>eula.txt</code> with <code>eula=true</code>{' '}
                  into the server folder so it can start.
                </span>
              </label>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          <div className="form-row">
            <button
              type="button"
              className="btn"
              disabled={!canAdd}
              onClick={() => void addServer()}
            >
              {saving ? 'Adding…' : 'Add Server'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

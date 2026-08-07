import { useEffect, useState } from 'react';
import type {
  CreateFromPackResult,
  PackInspection,
  ServerRecord,
  VanillaVersion,
} from '@msc/shared-types';
import { api } from '../lib/api';

interface PackServerFormProps {
  /** Last java.exe used; pre-fills the form. */
  initialJavaPath?: string | null;
  onCreated: (server: ServerRecord) => void;
}

/** Minecraft version → required Java feature version (mirrors the backend). */
function requiredJavaForMinecraft(minecraftVersion: string): number {
  const parts = minecraftVersion.split('.').map((n) => parseInt(n, 10));
  const [a, b] = parts;
  if (a >= 25) return 25;
  if (a >= 21) return 21;
  if (a === 1 && b >= 21) return 21;
  if (a === 1 && b === 20 && (parts[2] ?? 0) >= 5) return 21;
  if (a === 1 && b >= 18) return 17;
  if (a === 1 && b === 17) return 16;
  return 8;
}

function javaLabel(major: number): string {
  return `Java ${major}`;
}

/**
 * "New Server from Pack": pick a server-pack .zip/.mrpack, the backend sniffs
 * the MC version + loader + required Java, and it's extracted into a fresh
 * server folder. This is the flow for packs like Lost Era (1.7.10 Forge).
 */
export default function PackServerForm({
  initialJavaPath = null,
  onCreated,
}: PackServerFormProps): React.JSX.Element {
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<PackInspection | null>(null);
  const [name, setName] = useState('');
  const [javaPath, setJavaPath] = useState<string | null>(initialJavaPath);
  const [memoryMb, setMemoryMb] = useState(1024);
  const [port, setPort] = useState(25565);
  const [acceptEula, setAcceptEula] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateFromPackResult | null>(null);
  /** Manual loader pick; null = use what detection found. */
  const [flavorOverride, setFlavorOverride] = useState<'forge' | 'fabric' | 'vanilla' | 'auto'>(
    'auto',
  );
  /** Minecraft version override — pre-set to the detected version. */
  const [mcVersionOverride, setMcVersionOverride] = useState('');
  /** Available Minecraft versions from the Mojang manifest. */
  const [versions, setVersions] = useState<VanillaVersion[]>([]);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Load the Minecraft version list once.
  useEffect(() => {
    let cancelled = false;
    api
      .getVanillaVersions()
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setVersionsError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed the version override with the detected pack version once.
  useEffect(() => {
    if (inspection?.mcVersion && !mcVersionOverride) {
      setMcVersionOverride(inspection.mcVersion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection?.mcVersion]);

  const pickPack = async (): Promise<void> => {
    setError(null);
    setResult(null);
    try {
      const picked = await api.selectModpack();
      if (!picked.path) return;
      setInspecting(true);
      setPickedPath(picked.path);
      setFlavorOverride('auto');
      setMcVersionOverride('');
      const info = await api.inspectPack(picked.path);
      setInspection(info);
      if (info.ok) {
        const base = picked.path.split(/[\\/]/).pop()?.replace(/\.(zip|mrpack)$/i, '') ?? '';
        setName(info.name || base);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspecting(false);
    }
  };

  const needsManualVersion = flavorOverride !== 'auto' && flavorOverride !== 'vanilla';

  // The required Java follows the *selected* version, not the sniffed one.
  const effectiveVersion = mcVersionOverride || inspection?.mcVersion || null;
  const effectiveRequiredJava = effectiveVersion
    ? requiredJavaForMinecraft(effectiveVersion)
    : (inspection?.requiredJava ?? 8);
  const effectiveRequiredLabel = javaLabel(effectiveRequiredJava);

  const canCreate =
    !!pickedPath &&
    !!inspection?.ok &&
    name.trim().length > 0 &&
    acceptEula &&
    !creating &&
    (!needsManualVersion || mcVersionOverride.trim().length > 0);

  const pickJava = async (): Promise<void> => {
    const result = await api.selectJavaExecutable();
    if (!result.canceled && result.path) setJavaPath(result.path);
  };

  const createServer = async (): Promise<void> => {
    if (!pickedPath) return;
    setError(null);
    setCreating(true);
    try {
      const res = await api.createServerFromPack({
        filePath: pickedPath,
        name: name.trim(),
        javaPath,
        memoryMb,
        port,
        acceptEula,
        flavorOverride: flavorOverride === 'auto' ? undefined : flavorOverride,
        mcVersionOverride: mcVersionOverride.trim() || inspection?.mcVersion || undefined,
      });
      setResult(res);
      if (res.ok && res.server) {
        onCreated(res.server);
      } else {
        setError(res.error ?? 'Failed to create server from pack.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel-title">New Server from Pack</h2>
      <p className="muted form-help">
        Point at a server-pack .zip (e.g. a CurseForge/Technic server pack). The
        app reads the Minecraft version, loader, and required Java from the pack,
        then extracts it into a fresh server folder. Nothing is downloaded except
        the Forge installer when the pack needs it.
      </p>

      <div className="form-row">
        <button
          type="button"
          className="btn"
          onClick={() => void pickPack()}
          disabled={inspecting || creating}
        >
          {inspecting ? 'Inspecting…' : pickedPath ? 'Choose Another Pack' : 'Choose Pack (.zip / .mrpack)'}
        </button>
      </div>

      {pickedPath && (
        <div className="dash-row">
          <span className="path-text form-path">{pickedPath}</span>
        </div>
      )}

      {pickedPath && inspection && !inspection.ok && (
        <div className="error-banner">{inspection.error ?? 'Pack could not be read.'}</div>
      )}

      {pickedPath && inspection?.ok && (
        <div className="form-stack">
          <div className="form-row">
            <span className="form-label">Detected</span>
            <div className="dash-row">
              <span className="chip-edition chip-edition-java">Java</span>
              <span className="muted">
                MC {inspection.mcVersion ?? 'unknown'} ·{' '}
                {inspection.loader ?? 'vanilla'} ·{' '}
                {inspection.requiredJavaLabel}
              </span>
            </div>
            {inspection.needsInstallStep && (
              <p className="muted form-help">
                This pack ships a Forge installer — the app will run it to
                generate the server jar.
              </p>
            )}
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="pack-flavor">
              Java flavor
            </label>
            <select
              id="pack-flavor"
              className="input"
              value={flavorOverride}
              onChange={(e) =>
                setFlavorOverride(
                  e.target.value as 'auto' | 'forge' | 'fabric' | 'vanilla',
                )
              }
              disabled={creating}
            >
              <option value="auto">
                Auto ({inspection.loader ?? 'unknown'})
              </option>
              <option value="vanilla">Vanilla</option>
              <option value="fabric">Fabric</option>
              <option value="forge">Forge</option>
            </select>
            <p className="muted form-help">
              If the pack's mods are for a specific loader that wasn't
              detected (e.g. a CurseForge zip without a manifest), pick it
              here — the app will download that loader's server jar.
            </p>
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="pack-mc-version">
              Minecraft version
            </label>
            {versionsError ? (
              <span className="text-danger">{versionsError}</span>
            ) : versions.length === 0 ? (
              <span className="muted">Loading versions…</span>
            ) : (
              <select
                id="pack-mc-version"
                className="input"
                value={
                  versions.some((v) => v.id === mcVersionOverride)
                    ? mcVersionOverride
                    : mcVersionOverride || ''
                }
                onChange={(e) => setMcVersionOverride(e.target.value)}
                disabled={creating}
              >
                {mcVersionOverride &&
                  !versions.some((v) => v.id === mcVersionOverride) && (
                    <option value={mcVersionOverride}>{mcVersionOverride}</option>
                  )}
                {!mcVersionOverride && (
                  <option value="" disabled>
                    Select a version…
                  </option>
                )}
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                    {v.type === 'snapshot' ? ' (snapshot)' : ''}
                  </option>
                ))}
              </select>
            )}
            <p className="muted form-help">
              The pack's detected version is pre-selected. Change it if your
              mods target a different Minecraft version — the server jar will
              be downloaded for this version.
            </p>
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="pack-server-name">
              Server name
            </label>
            <input
              id="pack-server-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Server"
              disabled={creating}
            />
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="pack-server-memory">
              RAM (MB)
            </label>
            <input
              id="pack-server-memory"
              className="input"
              type="number"
              min={128}
              max={131072}
              step={256}
              value={memoryMb}
              onChange={(e) => setMemoryMb(Number(e.target.value) || 1024)}
              disabled={creating}
            />
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="pack-server-port">
              Port
            </label>
            <input
              id="pack-server-port"
              className="input"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 25565)}
              disabled={creating}
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
                disabled={creating}
              >
                {javaPath ? 'Change' : 'Select java.exe'}
              </button>
            </div>
            <p className="muted form-help">
              {effectiveRequiredLabel} recommended for MC{' '}
              {effectiveVersion ?? 'this version'}.
            </p>
            <p className="muted form-help">
              Wrong java version?{' '}
              <a
                href="#"
                className="link"
                onClick={(e) => {
                  e.preventDefault();
                  window.open(
                    `https://adoptium.net/temurin/releases/?version=${effectiveRequiredJava}&os=windows&arch=x64&package=jdk`,
                    '_blank',
                  );
                }}
              >
                Download {effectiveRequiredLabel} here!
              </a>
            </p>
          </div>

          <div className="form-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={acceptEula}
                onChange={(e) => setAcceptEula(e.target.checked)}
                disabled={creating}
              />
              <span>
                I agree to the Minecraft End User License Agreement (EULA). This
                writes an <code>eula.txt</code> with <code>eula=true</code>.
              </span>
            </label>
          </div>

          {result?.ok && (
            <div className="notice-banner">
              Server created: {result.modsAdded ?? 0} mod(s),{' '}
              {result.filesCopied ?? 0} file(s) copied
              {result.skipped ? ` (${result.skipped} skipped)` : ''}.
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          <div className="form-row">
            <button
              type="button"
              className="btn"
              disabled={!canCreate}
              onClick={() => void createServer()}
            >
              {creating ? 'Creating…' : 'Create Server from Pack'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

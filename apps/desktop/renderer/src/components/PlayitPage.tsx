import { useState } from 'react';
import type { ServerRecord } from '@msc/shared-types';
import { api } from '../lib/api';
import { usePlayit } from '../hooks/usePlayit';
import type { ServerRuntime } from '../hooks/useServerRuntime';

interface PlayitPageProps {
  server: ServerRecord | null;
  /** Minecraft server runtime, used for the online-but-Playit-offline warning. */
  runtime: ServerRuntime;
}

export default function PlayitPage({ server, runtime }: PlayitPageProps): React.JSX.Element {
  const playit = usePlayit();
  const [addressInput, setAddressInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const running = playit.state === 'online' || playit.state === 'starting' || playit.state === 'stopping';
  const serverOnline = runtime.state === 'online';
  const needTunnelWarning = serverOnline && !running;

  const selectExecutable = async (): Promise<void> => {
    try {
      const result = await api.selectPlayitExecutable();
      if (result.canceled || !result.path) return;
      const detected = await api.detectPlayit(result.path);
      if (!detected.detected) {
        playit.setPlayitPath(null).catch(() => undefined);
        // show an inline notice via error
        return;
      }
      await playit.setPlayitPath(result.path);
    } catch (err) {
      // surface through the hook's error state is not possible here; use local alert
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStart = async (): Promise<void> => {
    setBusy(true);
    await playit.start();
    setBusy(false);
  };

  const handleStop = async (): Promise<void> => {
    setBusy(true);
    await playit.stop();
    setBusy(false);
  };

  const handleForceKill = async (): Promise<void> => {
    setBusy(true);
    await playit.forceKill();
    setBusy(false);
  };

  const saveAddress = async (): Promise<void> => {
    const trimmed = addressInput.trim();
    if (!trimmed) return;
    await playit.setPublicAddress(trimmed);
    setAddressInput('');
  };

  const openLink = (url: string): void => {
    window.open(url, '_blank', 'noopener');
  };

  const detected = playit.detectedAddress;

  return (
    <section className="page">
      <header className="page-header">
        <h1>Playit</h1>
        <span className="page-edition muted">{server ? server.name : 'No server selected'}</span>
      </header>

      <div className="panel panel-stretch">
        <div className="panel-title-row">
          <h2 className="panel-title">Getting Started</h2>
          <button type="button" className="btn btn-sm" onClick={() => setGuideOpen((o) => !o)}>
            {guideOpen ? 'Hide Guide' : 'Show Guide'}
          </button>
        </div>
        {guideOpen ? (
          <ol className="java-guide playit-guide">
            <li>
              Don&apos;t have the Playit agent yet?{' '}
              <a
                href="#"
                className="link"
                onClick={(e) => {
                  e.preventDefault();
                  openLink('https://playit.gg/download');
                }}
              >
                Download it free from playit.gg
              </a>{' '}
              (Windows agent, single <code>playit.exe</code>).
            </li>
            <li>
              Click <strong>Select…</strong> below and choose the <code>playit.exe</code> you
              downloaded. The app remembers it.
            </li>
            <li>
              Click <strong>Start Playit</strong>. The app streams its output here and watches
              for a setup link.
            </li>
            <li>
              When Playit is new, it prints a claim link like{' '}
              <code>https://playit.gg/claim/…</code>. Click <strong>Open</strong> on it — it
              opens in your browser, where you log in or create a free account to claim this
              agent.
            </li>
            <li>
              In the Playit dashboard, create a <strong>TCP tunnel</strong> forwarding to{' '}
              <code>127.0.0.1:{server?.port ?? 25565}</code> (your server&apos;s port). Playit
              assigns a public address like <code>myserver.playit.gg</code>.
            </li>
            <li>
              Enter that address in the <strong>Public Address</strong> field below (or let the
              app detect it from Playit&apos;s output). That&apos;s the address friends use to
              join — add <code>:25565</code> if needed.
            </li>
          </ol>
        ) : (
          <p className="muted">
            New to Playit? The guide covers downloading the agent, logging in / claiming, and
            pointing a tunnel at your server.
          </p>
        )}
      </div>

      {needTunnelWarning && (
        <div className="error-banner playit-warning">
          Your Minecraft server is online, but Playit is not running. Friends cannot join
          through the tunnel yet.
        </div>
      )}
      {playit.error && <div className="error-banner">{playit.error}</div>}

      <div className="panel">
        <h2 className="panel-title">Executable</h2>
        <p className="muted">
          Playit exposes your server through a public address. Choose the Playit agent you
          downloaded, then start it and complete the setup in your browser.
        </p>
        <div className="dash-row">
          <span className="path-text">{playit.settings?.playitPath ?? 'Not selected'}</span>
          <button type="button" className="btn btn-sm" onClick={() => void selectExecutable()}>
            {playit.settings?.playitPath ? 'Change…' : 'Select…'}
          </button>
        </div>
      </div>

      <div className="panel panel-stretch">
        <div className="panel-title-row">
          <h2 className="panel-title">Status</h2>
          <span className={`status-badge status-${statusClass(playit.state)}`}>{playit.state}</span>
        </div>
        <div className="dash-row">
          <span className="muted">Process</span>
          <span>{playit.pid ? `PID ${playit.pid}` : 'Not running'}</span>
        </div>
        <div className="dash-row">
          <span className="muted">Uptime</span>
          <span>{running ? formatUptime(playit.uptimeSeconds) : '—'}</span>
        </div>
        {playit.exitCode !== null && playit.state === 'crashed' && (
          <div className="dash-row">
            <span className="muted">Exit code</span>
            <span className="text-danger">{playit.exitCode}</span>
          </div>
        )}
        <div className="dash-row">
          {!running ? (
            <button
              type="button"
              className="btn"
              disabled={busy || !playit.settings?.playitPath}
              onClick={() => void handleStart()}
            >
              Start Playit
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void handleStop()}>
                Stop
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void handleForceKill()}
              >
                Force Kill
              </button>
            </>
          )}
        </div>
      </div>

      {playit.links.length > 0 && (
        <div className="panel panel-stretch">
          <h2 className="panel-title">Setup Required</h2>
          <p className="muted">
            Playit is not set up yet. Open the link below in your browser to claim this agent
            and assign it to your server.
          </p>
          {playit.links.map((link) => (
            <div key={link.url} className="dash-row">
              <span className="path-text">{link.url}</span>
              <button type="button" className="btn btn-sm" onClick={() => openLink(link.url)}>
                Open
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="panel panel-stretch">
        <h2 className="panel-title">Public Address</h2>
        <p className="muted">
          After setup, Playit shows a public address like <code>myserver.playit.gg</code>.
          Enter it here so the app can show it on the dashboard, or use the address detected
          from Playit output.
        </p>
        <div className="dash-row">
          <span className="muted">Current</span>
          <span className="path-text">
            {playit.settings?.playitPublicAddress ?? detected ?? 'Not set'}
          </span>
        </div>
        <div className="dash-row">
          <input
            type="text"
            className="input form-path"
            placeholder="e.g. myserver.playit.gg"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
          />
          <button type="button" className="btn btn-sm" disabled={!addressInput.trim()} onClick={() => void saveAddress()}>
            Save
          </button>
        </div>
      </div>

      <div className="panel panel-stretch">
        <h2 className="panel-title">Logs</h2>
        <div className="console console-small">
          {playit.logs.length === 0 && <p className="muted console-empty">No output yet.</p>}
          {playit.logs.map((log, i) => (
            <div key={`${log.timestamp}-${i}`} className={`console-line ${logClass(log.level)}`}>
              <span className="console-time">{formatTime(log.timestamp)}</span>
              <span className="console-text">{log.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function statusClass(state: string): string {
  switch (state) {
    case 'online':
      return 'ok';
    case 'crashed':
      return 'danger';
    case 'starting':
    case 'stopping':
      return 'warn';
    default:
      return 'muted';
  }
}

function logClass(level: 'info' | 'warn' | 'error'): string {
  switch (level) {
    case 'error':
      return 'console-error';
    case 'warn':
      return 'console-warn';
    default:
      return '';
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

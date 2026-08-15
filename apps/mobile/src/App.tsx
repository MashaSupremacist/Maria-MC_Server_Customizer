import { useEffect, useRef, useState } from 'react';
import type { PageId } from '@msc/shared-types';
import {
  DeviceInfo,
  type NativeAppDataDirectory,
  type NativeDeviceInfo,
  type NativeMemoryInfo,
  type NativeSafetyInfo,
  type NativeStorageInfo,
} from './native/device-info';
import {
  Storage,
  type ManagedStorageLayout,
} from './native/storage';
import {
  JAVA_RUNTIME_MAJORS,
  JavaRuntime,
  type JavaRuntimeInfo,
  type JavaRuntimeMajor,
  type JavaRuntimeProgress,
} from './native/java-runtime';
import {
  VanillaServer,
  type VanillaProgress,
  type VanillaVersion,
} from './native/vanilla-server';
import { HostingProcess, type HostingProcessStatus } from './native/hosting-process';
import { ModdedServer, type ModdedFlavorInfo } from './native/modded-server';
import { Connectivity, type ConnectivityStatus } from './native/connectivity';
import { DirectTransport, type DirectTransportStatus } from './native/direct-transport';
import { PlayitResearch, type PlayitResearchCapabilities } from './native/playit-research';
import {
  ServerManagement,
  type BackupInfo,
  type GameruleSetting,
  type PlayerAdministrationResult,
  type ServerPropertiesResult,
  type WorldInfo,
} from './native/server-management';

type MobilePage = Extract<PageId, 'dashboard' | 'console' | 'players' | 'settings'> | 'gamerules' | 'worlds' | 'backups' | 'connectivity' | 'logs' | 'playit-research';

type DashboardServer = {
  serverId: string;
  name: string;
  version: string;
  flavor?: string;
};

type NavItem = {
  id: MobilePage;
  label: string;
  icon: string;
};

function nativeErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '';
}

const primaryNav: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '⌂' },
  { id: 'console', label: 'Console', icon: '▤' },
  { id: 'players', label: 'Players', icon: '♙' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

const moreItems: Array<{ label: string; page?: MobilePage }> = [
  { label: 'Worlds', page: 'worlds' },
  { label: 'Gamerules', page: 'gamerules' },
  { label: 'Backups', page: 'backups' },
  { label: 'Mods' }, { label: 'Plugins' }, { label: 'Logs', page: 'logs' }, { label: 'Connectivity', page: 'connectivity' }, { label: 'Playit research', page: 'playit-research' }, { label: 'App Settings' },
];

function App() {
  const [activePage, setActivePage] = useState<MobilePage>('dashboard');
  const [moreOpen, setMoreOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdServer, setCreatedServer] = useState<DashboardServer | null>(null);

  useEffect(() => {
    let active = true;
    void ServerManagement.listServers().then(({ servers }) => {
      if (!active || !servers.length) return;
      const server = servers[0];
      setCreatedServer({
        serverId: server.serverId,
        name: server.name,
        version: server.version,
        flavor: server.flavor,
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const selectPage = (page: MobilePage) => {
    setActivePage(page);
    setMoreOpen(false);
  };

  return (
    <div className="mobile-app">
      <header className="topbar">
        <div>
          <p className="eyebrow">MINECRAFT SERVER CUSTOMIZER</p>
          <h1>{primaryNav.find((item) => item.id === activePage)?.label ?? 'More'}</h1>
        </div>
        <span className="connection-dot" title="Hosting is not connected" aria-label="Hosting is not connected" />
      </header>

      <main className="page-content">
        {activePage === 'dashboard' && (
          createOpen ? (
            <VanillaSetup onCancel={() => setCreateOpen(false)} onCreated={(server) => {
              setCreatedServer(server);
              setCreateOpen(false);
            }} />
          ) : <Dashboard createdServer={createdServer} onCreate={() => setCreateOpen(true)} onDeleted={() => setCreatedServer(null)} />
        )}
        {activePage === 'console' && <Console />}
        {activePage === 'logs' && <LogsPage serverId={createdServer?.serverId ?? null} />}
        {activePage === 'players' && <PlayerAdministration serverId={createdServer?.serverId ?? null} />}
        {activePage === 'gamerules' && <GamerulesPage serverId={createdServer?.serverId ?? null} />}
        {activePage === 'worlds' && <WorldsPage serverId={createdServer?.serverId ?? null} />}
        {activePage === 'backups' && <BackupsPage serverId={createdServer?.serverId ?? null} />}
        {activePage === 'connectivity' && <ConnectivityPage serverId={createdServer?.serverId ?? null} />}
        {activePage === 'playit-research' && <PlayitResearchPage />}
        {activePage === 'settings' && <Settings serverId={createdServer?.serverId ?? null} />}
      </main>

      {moreOpen && (
        <section className="more-panel" aria-label="More navigation">
          <div className="section-heading">
            <span>More tools</span>
            <span className="muted">Coming in later phases</span>
          </div>
          <div className="more-grid">
            {moreItems.map((item) => (
              <button className="more-item" key={item.label} type="button" disabled={!item.page} onClick={() => item.page && selectPage(item.page)}>
                <span className="more-item-mark">•</span>
                {item.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <nav className="bottom-nav" aria-label="Primary navigation">
        {primaryNav.map((item) => (
          <button
            className={`nav-item ${activePage === item.id && !moreOpen ? 'active' : ''}`}
            key={item.id}
            type="button"
            onClick={() => selectPage(item.id)}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
        <button className={`nav-item ${moreOpen ? 'active' : ''}`} type="button" onClick={() => setMoreOpen((open) => !open)}>
          <span className="nav-icon" aria-hidden="true">•••</span>
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}

type ConsoleFilter = 'all' | 'info' | 'warn' | 'error';

const emptyConnectivity: ConnectivityStatus = {
  localIp: null,
  serverPort: 25565,
  lanAddress: null,
  networkConnected: false,
  wifiConnected: false,
  networkType: 'offline',
  portAvailable: false,
  portConflict: false,
  serverId: '',
};

const emptyDirectTransport: DirectTransportStatus = {
  status: 'IDLE',
  active: false,
  transport: 'tls-tcp',
  host: '',
  port: 44333,
  message: 'Direct transport test has not started',
  startedAt: 0,
  updatedAt: 0,
  completedAt: 0,
  probes: 0,
  reconnects: 0,
  bytesSent: 0,
  bytesReceived: 0,
  lastRttMs: -1,
  tlsProtocol: '',
  certificateFingerprint: '',
};

function ConnectivityPage({ serverId }: { serverId: string | null }) {
  const [status, setStatus] = useState<ConnectivityStatus>(emptyConnectivity);
  const [directStatus, setDirectStatus] = useState<DirectTransportStatus>(emptyDirectTransport);
  const [directHost, setDirectHost] = useState('');
  const [directPort, setDirectPort] = useState('44333');
  const [directToken, setDirectToken] = useState('');
  const [directFingerprint, setDirectFingerprint] = useState('');
  const [directDuration, setDirectDuration] = useState('60');
  const [directError, setDirectError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = () => void Connectivity.getStatus(serverId ? { serverId } : undefined)
      .then((next) => { if (active) setStatus(next); })
      .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [serverId]);

  useEffect(() => {
    let active = true;
    const refresh = () => void DirectTransport.getStatus()
      .then((next) => { if (active) setDirectStatus(next); })
      .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const startDirectTest = async () => {
    setDirectError('');
    try {
      const next = await DirectTransport.startTest({
        host: directHost.trim(),
        port: Number.parseInt(directPort, 10),
        token: directToken,
        certificateFingerprint: directFingerprint,
        durationSeconds: Number.parseInt(directDuration, 10),
        payloadBytes: 65_537,
      });
      setDirectStatus(next);
    } catch (error) {
      setDirectError(nativeErrorMessage(error) || 'Could not start the direct transport test.');
    }
  };

  const stopDirectTest = async () => {
    setDirectError('');
    try {
      await DirectTransport.stopTest();
      setDirectStatus(await DirectTransport.getStatus());
    } catch (error) {
      setDirectError(nativeErrorMessage(error) || 'Could not stop the direct transport test.');
    }
  };

  const address = status.lanAddress;
  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard?.writeText(address);
      setMessage('LAN address copied.');
    } catch {
      setMessage('Copy is unavailable on this device.');
    }
  };

  const shareAddress = async () => {
    if (!address) return;
    const share = (navigator as Navigator & { share?: (data: { title: string; text: string }) => Promise<void> }).share;
    if (share) {
      try {
        await share.call(navigator, { title: 'Minecraft LAN server', text: address });
        setMessage('LAN address shared.');
        return;
      } catch {
        // The share sheet can be dismissed; copying remains a useful fallback.
      }
    }
    await copyAddress();
  };

  return (
    <div className="stack">
      <section className="status-card">
        <div>
          <span className="status-label"><span className={`status-dot ${status.networkConnected ? 'online' : ''}`} /> {status.networkConnected ? 'LAN READY' : 'NETWORK OFFLINE'}</span>
          <h2>{address ?? 'LAN address unavailable'}</h2>
          <p className="muted">Give this address to a Minecraft client connected to the same local network.</p>
        </div>
        <div className="storage-actions">
          <button className="button primary" type="button" onClick={() => void copyAddress()} disabled={!address}>Copy address</button>
          <button className="button" type="button" onClick={() => void shareAddress()} disabled={!address}>Share address</button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading"><span>LAN connection</span><span className="muted">Auto-refreshing</span></div>
        <div className="settings-list">
          <div className="setting-row"><span>Local IP</span><strong>{status.localIp ?? 'Unavailable'}</strong></div>
          <div className="setting-row"><span>Server port</span><strong>{status.serverPort}</strong></div>
          <div className="setting-row"><span>Network</span><strong>{status.networkType}</strong></div>
          <div className="setting-row"><span>Port status</span><strong>{status.portConflict ? 'Unavailable' : status.portAvailable ? 'Available' : 'Checking'}</strong></div>
        </div>
        {!status.networkConnected && <p className="warning-text">Connect to Wi-Fi or another local network before sharing an address.</p>}
        {status.portConflict && <p className="warning-text">Port {status.serverPort} is already in use by another local process.</p>}
        {message && <p className="storage-message" aria-live="polite">{message}</p>}
      </section>

      <section className="panel native-panel direct-transport-panel">
        <div className="section-heading">
          <span>Direct transport lab</span>
          <span className={`bridge-state ${directStatus.status === 'RUNNING' || directStatus.status === 'COMPLETE' ? 'ready' : directStatus.status === 'FAILED' ? 'unavailable' : ''}`}>{directStatus.status}</span>
        </div>
        <p className="settings-hint">Phase 22A proves that this phone can initiate a certificate-pinned TLS 1.3 path to a reachable PC. It does not connect Minecraft yet and does not use a relay or tunnel provider.</p>
        <label className="direct-field"><span>PC hostname or IP</span><input className="text-input" value={directHost} onChange={(event) => setDirectHost(event.target.value)} placeholder="192.168.1.20 or public IP" autoCapitalize="none" autoCorrect="off" disabled={directStatus.active} /></label>
        <label className="direct-field"><span>Listener port</span><input className="text-input compact-input" inputMode="numeric" value={directPort} onChange={(event) => setDirectPort(event.target.value)} disabled={directStatus.active} /></label>
        <label className="direct-field"><span>One-time token</span><input className="text-input" type="password" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder="Printed by the PC listener" autoCapitalize="none" autoCorrect="off" disabled={directStatus.active} /></label>
        <label className="direct-field direct-fingerprint"><span>Certificate SHA-256</span><textarea className="text-input" value={directFingerprint} onChange={(event) => setDirectFingerprint(event.target.value)} placeholder="64 hexadecimal characters" autoCapitalize="characters" autoCorrect="off" disabled={directStatus.active} /></label>
        <label className="direct-field"><span>Test duration</span><select className="text-input" value={directDuration} onChange={(event) => setDirectDuration(event.target.value)} disabled={directStatus.active}><option value="60">1 minute</option><option value="300">5 minutes</option><option value="1800">30 minutes</option></select></label>
        <div className="storage-actions">
          <button className="button primary" type="button" onClick={() => void startDirectTest()} disabled={directStatus.active}>Start direct test</button>
          <button className="button" type="button" onClick={() => void stopDirectTest()} disabled={!directStatus.active}>Stop test</button>
        </div>
        <div className="settings-list direct-metrics">
          <div className="setting-row"><span>Transport</span><strong>{directStatus.tlsProtocol || 'TLS/TCP pending'}</strong></div>
          <div className="setting-row"><span>Echo probes</span><strong>{directStatus.probes}</strong></div>
          <div className="setting-row"><span>Reconnects</span><strong>{directStatus.reconnects}</strong></div>
          <div className="setting-row"><span>Last round trip</span><strong>{directStatus.lastRttMs >= 0 ? `${directStatus.lastRttMs} ms` : '—'}</strong></div>
          <div className="setting-row"><span>Transferred</span><strong>{formatBytes(directStatus.bytesSent + directStatus.bytesReceived)}</strong></div>
        </div>
        <p className="storage-message" aria-live="polite">{directStatus.message}</p>
        {directError && <p className="warning-text">{directError}</p>}
        <p className="settings-hint">Start the matching listener with <code>node tools/phase22a/msc-direct-listener.mjs --port 44333</code>. Test on LAN first, then map the PC port and retry while the phone uses mobile data.</p>
      </section>
    </div>
  );
}

const emptyPlayitCapabilities: PlayitResearchCapabilities = {
  status: 'research-only',
  release: 'v1.0.10',
  abi: 'unknown',
  asset: null,
  downloadUrl: null,
  architectureSupported: false,
  executionMode: 'app-private-process',
  defaultPathsCompatible: false,
  secretRequired: true,
  agentPrepared: false,
  integrationReady: false,
  message: 'Reading Playit capability information…',
};

function PlayitResearchPage() {
  const [capabilities, setCapabilities] = useState<PlayitResearchCapabilities>(emptyPlayitCapabilities);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void PlayitResearch.getCapabilities()
      .then((next) => { if (active) setCapabilities(next); })
      .catch(() => { if (active) setError('Playit diagnostics are unavailable in this environment.'); });
    return () => { active = false; };
  }, []);

  return (
    <div className="stack">
      <section className="status-card">
        <div>
          <span className="status-label"><span className="status-dot" /> RESEARCH ONLY</span>
          <h2>Playit tunnel readiness</h2>
          <p className="muted">This checkpoint verifies Android compatibility before any account or tunnel setup is added.</p>
        </div>
        <span className="bridge-state">{capabilities.integrationReady ? 'Ready' : 'Phase 22 required'}</span>
      </section>
      <section className="panel">
        <div className="section-heading"><span>Agent capability</span><span className="muted">{capabilities.release}</span></div>
        <div className="settings-list">
          <div className="setting-row"><span>Android ABI</span><strong>{capabilities.abi}</strong></div>
          <div className="setting-row"><span>Candidate asset</span><strong>{capabilities.asset ?? 'Unavailable'}</strong></div>
          <div className="setting-row"><span>Execution mode</span><strong>{capabilities.executionMode}</strong></div>
          <div className="setting-row"><span>Secret provisioning</span><strong>{capabilities.secretRequired ? 'Required' : 'Not required'}</strong></div>
          <div className="setting-row"><span>Agent prepared</span><strong>{capabilities.agentPrepared ? 'Yes' : 'No'}</strong></div>
        </div>
        <p className="settings-hint">{capabilities.message} The official agent must use app-private socket, secret, and log paths on Android.</p>
        {capabilities.downloadUrl && <p className="settings-hint"><a href={capabilities.downloadUrl} target="_blank" rel="noreferrer">View official release asset</a></p>}
        {error && <p className="warning-text">{error}</p>}
      </section>
    </div>
  );
}

function LogsPage({ serverId }: { serverId: string | null }) {
  const [text, setText] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = () => {
      if (!serverId) {
        setText('');
        return;
      }
      void ServerManagement.getLogTail({ serverId, maxChars: 65_536 }).then((result) => {
        if (!active) return;
        setText(result.text);
        setPath(result.path);
        setError('');
      }).catch(() => { if (active) setError('Could not read the server logs.'); });
    };
    load();
    const timer = window.setInterval(load, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [serverId]);

  const exportLogs = () => {
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `minecraft-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!serverId) return <section className="panel placeholder"><strong>Create or restore a server first</strong><p className="muted">Server logs become available after an installed server is selected.</p></section>;
  return (
    <div className="stack">
      <section className="panel console-toolbar">
        <div className="section-heading"><span>Server logs</span><span className="console-state">latest.log + captured console</span></div>
        <div className="console-actions">
          <button className="button" type="button" onClick={() => void ServerManagement.getLogTail({ serverId, maxChars: 65_536 }).then((result) => { setText(result.text); setPath(result.path); setError(''); }).catch(() => setError('Could not read the server logs.'))}>Refresh</button>
          <button className="button" type="button" onClick={exportLogs} disabled={!text}>Export</button>
        </div>
        <p className="storage-path">{path || 'Reading managed server logs…'}</p>
        {error && <p className="warning-text">{error}</p>}
      </section>
      <section className="panel console-panel">
        <pre className="console-output" aria-live="polite">{text || 'No captured server output yet.'}</pre>
      </section>
    </div>
  );
}

function Console() {
  const [status, setStatus] = useState<HostingProcessStatus | null>(null);
  const [rawOutput, setRawOutput] = useState('');
  const [clearAt, setClearAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => void HostingProcess.getStatus().then((next) => {
      if (!active) return;
      setStatus(next);
      setRawOutput(next.output || '');
    }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!paused && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [rawOutput, paused]);

  const visibleOutput = rawOutput.length < clearAt ? rawOutput : rawOutput.slice(clearAt);
  const lines = visibleOutput.split(/\r?\n/).filter((line) => {
    const normalized = line.toLowerCase();
    const matchesFilter = filter === 'all'
      || (filter === 'error' && /(error|exception|crash|failed|fatal)/.test(normalized))
      || (filter === 'warn' && /warn/.test(normalized))
      || (filter === 'info' && !/(error|exception|crash|failed|fatal|warn)/.test(normalized));
    return matchesFilter && (!query || normalized.includes(query.toLowerCase()));
  });

  const sendCommand = () => {
    const value = command.trim();
    if (!value) return;
    void HostingProcess.sendInput({ input: `${value}\n` });
    setHistory((previous) => [value, ...previous.filter((item) => item !== value)].slice(0, 30));
    setHistoryIndex(-1);
    setCommand('');
  };

  const moveHistory = (direction: number) => {
    if (!history.length) return;
    const nextIndex = Math.max(-1, Math.min(history.length - 1, historyIndex + direction));
    setHistoryIndex(nextIndex);
    setCommand(nextIndex < 0 ? '' : history[nextIndex]);
  };

  const exportLogs = () => {
    const blob = new Blob([visibleOutput], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `minecraft-console-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack console-page">
      <section className="panel console-toolbar">
        <div className="section-heading"><span>Live console</span><span className={`console-state ${status?.serverStatus === 'ONLINE' ? 'online' : ''}`}>{status?.serverStatus ?? 'OFFLINE'}</span></div>
        <div className="console-actions">
          <button className="button" type="button" onClick={() => setPaused((value) => !value)}>{paused ? 'Resume scroll' : 'Pause scroll'}</button>
          <button className="button" type="button" onClick={() => setClearAt(rawOutput.length)}>Clear</button>
          <button className="button" type="button" onClick={exportLogs}>Export</button>
        </div>
        <div className="console-filters">
          <input className="text-input console-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search output" aria-label="Search console output" />
          <select className="text-input console-filter" value={filter} onChange={(event) => setFilter(event.target.value as ConsoleFilter)} aria-label="Filter console output">
            <option value="all">All lines</option><option value="info">Info</option><option value="warn">Warnings</option><option value="error">Errors</option>
          </select>
        </div>
      </section>
      <section className="panel console-panel">
        <pre className="console-output" ref={outputRef} aria-live="polite">
          {lines.length ? lines.map((line, index) => <span className={/(error|exception|crash|failed|fatal)/i.test(line) ? 'console-line error' : /warn/i.test(line) ? 'console-line warn' : 'console-line'} key={`${index}-${line}`}>{line}{'\n'}</span>) : <span className="muted">No output yet. Start a server to stream its logs.</span>}
        </pre>
        <div className="console-command">
          <input className="text-input" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') sendCommand();
            if (event.key === 'ArrowUp') { event.preventDefault(); moveHistory(1); }
            if (event.key === 'ArrowDown') { event.preventDefault(); moveHistory(-1); }
          }} placeholder="Enter server command" aria-label="Server command" />
          <button className="button primary" type="button" onClick={sendCommand} disabled={!command.trim()}>Send</button>
        </div>
      </section>
    </div>
  );
}

function Dashboard({ onCreate, onDeleted, createdServer }: { onCreate: () => void; onDeleted: () => void; createdServer: DashboardServer | null }) {
  const [hosting, setHosting] = useState<HostingProcessStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!createdServer) return;
    let active = true;
    const refresh = () => void HostingProcess.getStatus().then((status) => { if (active) setHosting(status); }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [createdServer]);
  const serverStatus = hosting?.serverStatus ?? 'OFFLINE';
  const start = () => createdServer && void HostingProcess.startServer({ serverId: createdServer.serverId });
  const stop = (force = false) => void HostingProcess.stop({ force });
  const restart = () => { if (!createdServer) return; void HostingProcess.stop({ force: false }).finally(() => window.setTimeout(start, 1000)); };
  const remove = async () => {
    if (!createdServer || serverStatus !== 'OFFLINE') return;
    if (!window.confirm(`Permanently delete ${createdServer.name} and all of its worlds, logs, and files?`)) return;
    setError('');
    try {
      await ServerManagement.deleteServer({ serverId: createdServer.serverId });
      onDeleted();
    } catch (deleteError) {
      setError(String(deleteError).includes('SERVER_MUST_BE_STOPPED')
        ? 'Stop the server before deleting it.'
        : 'Could not delete the server.');
    }
  };
  return (
    <div className="stack">
      <section className="status-card">
        <div>
          <span className="status-label"><span className="status-dot" /> {serverStatus}</span>
          <h2>{createdServer ? createdServer.name : 'No active server'}</h2>
          <p className="muted">{createdServer ? 'Manage the foreground Minecraft process.' : 'Create a server to begin configuring your Android host.'}</p>
        </div>
        {createdServer ? <div className="storage-actions">
          <button className="button primary" type="button" onClick={start} disabled={serverStatus === 'STARTING' || serverStatus === 'ONLINE' || serverStatus === 'STOPPING'}>Start</button>
          <button className="button" type="button" onClick={() => stop(false)} disabled={serverStatus === 'OFFLINE' || serverStatus === 'STOPPING'}>Stop</button>
          <button className="button" type="button" onClick={restart} disabled={serverStatus !== 'ONLINE'}>Restart</button>
          <button className="button" type="button" onClick={() => stop(true)} disabled={serverStatus === 'OFFLINE'}>Force stop</button>
          <button className="button danger" type="button" onClick={() => void remove()} disabled={serverStatus !== 'OFFLINE'}>Delete server</button>
        </div> : <button className="button primary" type="button" onClick={onCreate}>Create server</button>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <span>Saved servers</span>
          <span className="count-badge">{createdServer ? 1 : 0}</span>
        </div>
        {createdServer ? (
          <div className="empty-state">
            <strong>{createdServer.name}</strong>
            <p className="muted">{createdServer.flavor ?? 'Vanilla'} {createdServer.version} · {serverStatus}</p>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-mark">+</div>
            <strong>Your server list is empty</strong>
            <p className="muted">Create a Vanilla Java server to begin.</p>
          </div>
        )}
        {error && <p className="warning-text">{error}</p>}
      </section>
    </div>
  );
}

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

function recommendedRamMb(safety: NativeSafetyInfo | null): number {
  if (!safety || safety.totalMemoryBytes <= 0) return 1024;
  const total = safety.totalMemoryBytes;
  const recommended = total >= 12 * GIBIBYTE ? 4608
    : total >= 8 * GIBIBYTE ? 3072
      : total >= 6 * GIBIBYTE ? 2048
        : total >= 4 * GIBIBYTE ? 1024
          : 768;
  return Math.max(512, Math.min(8192, Math.floor(recommended / 256) * 256));
}

function safeRamLimitMb(safety: NativeSafetyInfo | null): number {
  if (!safety) return 8192;
  const safeBytes = Math.min(safety.totalMemoryBytes / 2, safety.availableMemoryBytes * 0.75);
  return Math.max(512, Math.min(8192, Math.floor(Math.max(0, safeBytes) / MEBIBYTE / 256) * 256));
}

function formatMemory(bytes: number): string {
  return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
}

function ramSafetyWarnings(safety: NativeSafetyInfo | null, ramMb: number, recommended: number, safeLimit: number): string[] {
  const warnings: string[] = [];
  if (!Number.isFinite(ramMb) || ramMb < 512 || ramMb > 8192) warnings.push('Choose between 512 MB and 8192 MB.');
  if (safety) {
    if (safety.lowMemory || safety.availableMemoryBytes < safety.totalMemoryBytes * 0.2) {
      warnings.push('Android reports low available memory; close other apps before hosting.');
    }
    if (['severe', 'critical', 'emergency', 'shutdown'].includes(safety.thermalStatus)) {
      warnings.push(`Device thermal state is ${safety.thermalStatus}; let the phone cool before hosting.`);
    }
    if (safety.batteryPercent >= 0 && safety.batteryPercent < 20 && !safety.charging) {
      warnings.push('Battery is below 20%; connect a charger before hosting.');
    }
    if (safety.totalStorageBytes > 0 && (safety.availableStorageBytes < 2 * GIBIBYTE || safety.availableStorageBytes < safety.totalStorageBytes * 0.1)) {
      warnings.push('Available storage is low; leave room for worlds and server logs.');
    }
  }
  if (ramMb > safeLimit) warnings.push(`This allocation exceeds the conservative device limit of ${safeLimit} MB.`);
  else if (ramMb > recommended) warnings.push(`This is above the recommended allocation of ${recommended} MB.`);
  return warnings;
}

function VanillaSetup({ onCancel, onCreated }: {
  onCancel: () => void;
  onCreated: (server: { serverId: string; name: string; version: string; flavor?: string }) => void;
}) {
  const [versions, setVersions] = useState<VanillaVersion[]>([]);
  const [version, setVersion] = useState('');
  const [name, setName] = useState('My Survival Server');
  const [ramMb, setRamMb] = useState(1024);
  const [ramTouched, setRamTouched] = useState(false);
  const [safety, setSafety] = useState<NativeSafetyInfo | null>(null);
  const [ramOverrideAcknowledged, setRamOverrideAcknowledged] = useState(false);
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [progress, setProgress] = useState<VanillaProgress | null>(null);
  const [error, setError] = useState('');
  const [flavors, setFlavors] = useState<ModdedFlavorInfo[]>([]);

  useEffect(() => {
    let listener: { remove: () => Promise<void> } | undefined;
    void VanillaServer.addListener('serverProgress', setProgress).then((handle) => { listener = handle; }).catch(() => undefined);
    void VanillaServer.listVersions().then((result) => {
      setVersions(result.versions);
      setVersion(result.latestRelease);
    }).catch(() => setError('Could not discover Minecraft versions.'));
    void DeviceInfo.getSafetyInfo().then(setSafety).catch(() => undefined);
    void ModdedServer.getFlavorCatalog().then((result) => setFlavors(result.flavors)).catch(() => undefined);
    return () => { void listener?.remove(); };
  }, []);

  useEffect(() => {
    if (safety && !ramTouched) setRamMb(recommendedRamMb(safety));
  }, [ramTouched, safety]);

  const recommended = recommendedRamMb(safety);
  const safeLimit = safeRamLimitMb(safety);
  const warnings = ramSafetyWarnings(safety, ramMb, recommended, safeLimit);
  const requiresAcknowledgement = warnings.length > 0;

  const install = async () => {
    setError('');
    if (!eulaAccepted) { setError('You must accept the Minecraft EULA to continue.'); return; }
    if (requiresAcknowledgement && !ramOverrideAcknowledged) {
      setError('Review the RAM safety warnings and acknowledge the allocation to continue.');
      return;
    }
    try {
      await VanillaServer.install({
        serverId: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'vanilla-server',
        serverName: name,
        version,
        ramMb,
        eulaAccepted,
        ramOverrideAcknowledged: requiresAcknowledgement ? ramOverrideAcknowledged : true,
      });
      onCreated({ serverId: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'vanilla-server', name, version });
      } catch (installError) {
        const runtimeRequirement = String(installError).match(/JAVA_RUNTIME_REQUIRED:(\d+)/);
        setError(runtimeRequirement
          ? `Java ${runtimeRequirement[1]} is required. Download it from Settings first.`
          : String(installError).includes('RAM_OVERRIDE_REQUIRED')
          ? 'This RAM allocation is unsafe for the current device. Lower it or acknowledge the warning.'
        : 'Could not install the Vanilla server.');
    }
  };

  const importPack = async () => {
    setError('');
    if (!eulaAccepted) { setError('You must accept the Minecraft EULA to import a server pack.'); return; }
    try {
      const result = await ModdedServer.importServerPack({
        serverId: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'server-pack',
        serverName: name,
        ramMb,
        eulaAccepted,
      });
      if (result.canceled) return;
      onCreated({ serverId: result.serverId, name, version: result.version ?? 'pack', flavor: result.flavor });
    } catch (importError) {
      setError(String(importError).includes('Unsupported Windows command')
        ? 'This pack uses unsupported Windows commands. Configure its Java launch manually.'
        : 'Could not import the server pack.');
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="section-heading"><span>Create server</span><span className="muted">Vanilla Java</span></div>
        <label className="setting-row"><span>Server name</span><input className="text-input" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="setting-row"><span>Minecraft version</span>
          <select className="text-input" value={version} onChange={(event) => setVersion(event.target.value)} disabled={!versions.length}>
            {!versions.length && <option>Loading versions…</option>}
            {versions.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select>
        </label>
        <label className="setting-row"><span>Memory (MB)</span><input className="text-input" type="number" min={512} max={8192} step={256} value={ramMb} onChange={(event) => { setRamTouched(true); setRamOverrideAcknowledged(false); setRamMb(Number(event.target.value)); }} /></label>
        <div className="ram-safety" aria-live="polite">
          {safety ? <p className="muted">Device memory: {formatMemory(safety.totalMemoryBytes)} total · {formatMemory(safety.availableMemoryBytes)} available · allocation {ramMb || 0} MB · recommended {recommended} MB</p> : <p className="muted">Reading device memory and safety status…</p>}
          {warnings.map((warning) => <p className="warning-text" key={warning}>{warning}</p>)}
          {requiresAcknowledgement && <label className="setting-row acknowledgement"><span>I understand this allocation may reduce device stability</span><input type="checkbox" checked={ramOverrideAcknowledged} onChange={(event) => setRamOverrideAcknowledged(event.target.checked)} /></label>}
        </div>
        <label className="setting-row"><span>I accept the Minecraft EULA</span><input type="checkbox" checked={eulaAccepted} onChange={(event) => setEulaAccepted(event.target.checked)} /></label>
        <p className="settings-hint">Supported imported flavors: {flavors.length ? flavors.map((flavor) => `${flavor.label} (Java ${flavor.minimumJava}–${flavor.maximumJava})`).join(' · ') : 'Forge, Fabric, and Paper'}. Packs with standard start.bat/run.bat Java launchers are translated for Android.</p>
        <div className="storage-actions">
          <button className="button" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" onClick={() => void install()} disabled={!version || (requiresAcknowledgement && !ramOverrideAcknowledged) || progress?.status === 'downloading' || progress?.status === 'verifying'}>Create</button>
          <button className="button" type="button" onClick={() => void importPack()} disabled={requiresAcknowledgement && !ramOverrideAcknowledged}>Import Forge/Fabric/Paper pack</button>
        </div>
        {progress && <p className="storage-message">{progress.message}{progress.percent == null ? '' : ` ${progress.percent}%`}</p>}
        {error && <p className="warning-text">{error}</p>}
      </section>
    </div>
  );
}

const propertyLabels: Record<string, string> = {
  motd: 'Message of the day', gamemode: 'Gamemode', difficulty: 'Difficulty', hardcore: 'Hardcore', pvp: 'Player versus player',
  'online-mode': 'Online mode', 'max-players': 'Maximum players', 'server-port': 'Server port', 'white-list': 'Whitelist',
  'enforce-whitelist': 'Enforce whitelist', 'spawn-protection': 'Spawn protection', 'view-distance': 'View distance',
  'simulation-distance': 'Simulation distance', 'allow-flight': 'Allow flight', 'allow-nether': 'Allow Nether',
  'generate-structures': 'Generate structures', 'enable-command-block': 'Command blocks', 'player-idle-timeout': 'Player idle timeout',
};

const booleanProperties = new Set(['hardcore', 'pvp', 'online-mode', 'white-list', 'enforce-whitelist', 'allow-flight', 'allow-nether', 'generate-structures', 'enable-command-block']);
const enumProperties: Record<string, string[]> = { gamemode: ['survival', 'creative', 'adventure', 'spectator'], difficulty: ['peaceful', 'easy', 'normal', 'hard'] };

function ServerPropertiesEditor({ serverId }: { serverId: string | null }) {
  const [data, setData] = useState<ServerPropertiesResult | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    if (!serverId) return;
    setError('');
    try {
      const result = await ServerManagement.getServerProperties({ serverId });
      setData(result);
      setDraft(Object.fromEntries(result.settings.map((setting) => [setting.key, setting.value])));
    } catch (loadError) { setError(String(loadError)); }
  };

  useEffect(() => { void load(); }, [serverId]);

  const save = async () => {
    if (!serverId) return;
    setMessage(''); setError('');
    try {
      const result = await ServerManagement.updateServerProperties({ serverId, values: draft });
      setMessage(result.changed ? `Saved. Backup created; restart required.` : 'No changes to save.');
      await load();
    } catch (saveError) { setError(String(saveError)); }
  };

  const reset = async () => {
    if (!serverId || !window.confirm('Reset supported server settings to defaults? A backup will be created first.')) return;
    setMessage(''); setError('');
    try {
      await ServerManagement.resetServerProperties({ serverId });
      setMessage('Defaults restored. Restart required.');
      await load();
    } catch (resetError) { setError(String(resetError)); }
  };

  if (!serverId) return <section className="panel placeholder"><strong>Create a server first</strong><p className="muted">Server settings become available after a Vanilla server is installed.</p></section>;
  return (
    <section className="panel native-panel">
      <div className="section-heading"><span>Vanilla settings</span><span className="muted">server.properties</span></div>
      {!data ? <p className="storage-message">Reading server settings…</p> : <>
        <p className="settings-hint">Changes are validated and backed up before writing. Restart the server to apply them.</p>
        <div className="settings-editor">
          {data.settings.map((setting) => {
            const value = draft[setting.key] ?? setting.value;
            const options = enumProperties[setting.key];
            return <label className="setting-row" key={setting.key}>
              <span><strong>{propertyLabels[setting.key] ?? setting.key}</strong><small>{setting.key} · default {setting.defaultValue}</small></span>
              {booleanProperties.has(setting.key) ? <select className="text-input" value={value} onChange={(event) => setDraft((current) => ({ ...current, [setting.key]: event.target.value }))}><option value="true">Enabled</option><option value="false">Disabled</option></select>
                : options ? <select className="text-input" value={value} onChange={(event) => setDraft((current) => ({ ...current, [setting.key]: event.target.value }))}>{options.map((option) => <option key={option}>{option}</option>)}</select>
                  : <input className="text-input" type={setting.key === 'motd' ? 'text' : 'number'} value={value} onChange={(event) => setDraft((current) => ({ ...current, [setting.key]: event.target.value }))} />}
            </label>;
          })}
        </div>
        <div className="storage-actions"><button className="button primary" type="button" onClick={() => void save()}>Save settings</button><button className="button" type="button" onClick={() => void reset()}>Reset defaults</button><button className="button" type="button" onClick={() => void load()}>Reload</button></div>
        {message && <p className="storage-message">{message}</p>}
        {error && <p className="warning-text">{error}</p>}
      </>}
    </section>
  );
}

function GamerulesPage({ serverId }: { serverId: string | null }) {
  const [rules, setRules] = useState<GameruleSetting[]>([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    if (!serverId) return;
    try { setRules((await ServerManagement.getGamerules({ serverId })).rules); } catch (loadError) { setError(String(loadError)); }
  };
  useEffect(() => { void load(); }, [serverId]);
  const save = async (rule: GameruleSetting) => {
    if (!serverId) return;
    try {
      const result = await ServerManagement.setGamerule({ serverId, name: rule.name, value: rule.value });
      setMessage(result.commandSent ? `${rule.name} applied to the running server.` : `${rule.name} saved; apply after restart.`);
    } catch (saveError) { setError(String(saveError)); }
  };
  if (!serverId) return <section className="panel placeholder"><strong>Create a server first</strong><p className="muted">Gamerules require an installed server.</p></section>;
  return <div className="stack"><section className="panel native-panel"><div className="section-heading"><span>Gamerules</span><span className="muted">Version-aware catalog</span></div><input className="text-input full-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search gamerules" aria-label="Search gamerules" />{rules.filter((rule) => rule.name.toLowerCase().includes(query.toLowerCase())).map((rule) => <div className="setting-row" key={rule.name}><span><strong>{rule.name}</strong><small>{rule.available ? `Default: ${rule.defaultValue}` : 'Not available for this server version'}</small></span><span className="inline-control">{rule.value === 'true' || rule.value === 'false' ? <select className="text-input" value={rule.value} disabled={!rule.available} onChange={(event) => setRules((current) => current.map((item) => item.name === rule.name ? { ...item, value: event.target.value } : item))}><option value="true">Enabled</option><option value="false">Disabled</option></select> : <input className="text-input compact-input" type="number" value={rule.value} disabled={!rule.available} onChange={(event) => setRules((current) => current.map((item) => item.name === rule.name ? { ...item, value: event.target.value } : item))} />}<button className="button" type="button" onClick={() => void save(rule)} disabled={!rule.available}>Apply</button></span></div>)}{message && <p className="storage-message">{message}</p>}{error && <p className="warning-text">{error}</p>}</section></div>;
}

function PlayerAdministration({ serverId }: { serverId: string | null }) {
  const [data, setData] = useState<PlayerAdministrationResult | null>(null);
  const [command, setCommand] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => { if (!serverId) return; try { setData(await ServerManagement.getPlayerAdministration({ serverId })); } catch (loadError) { setError(String(loadError)); } };
  useEffect(() => { void load(); }, [serverId]);
  const run = async () => { if (!serverId || !command.trim()) return; setError(''); try { await ServerManagement.runPlayerCommand({ serverId, command: command.trim() }); setMessage('Command sent to the running server.'); setCommand(''); await load(); } catch (runError) { setError(String(runError)); } };
  if (!serverId) return <section className="panel placeholder"><strong>Create a server first</strong><p className="muted">Player administration requires an installed server.</p></section>;
  const groups: Array<[string, unknown[]]> = [['Whitelist', data?.whitelist ?? []], ['Operators', data?.operators ?? []], ['Banned players', data?.bannedPlayers ?? []], ['Banned IPs', data?.bannedIps ?? []]];
  return <div className="stack"><section className="panel native-panel"><div className="section-heading"><span>Player administration</span><button className="button" type="button" onClick={() => void load()}>Refresh</button></div><p className="settings-hint">Commands are sent to the live server: /op, /deop, /whitelist add/remove, /ban, /pardon, /ban-ip, /pardon-ip, and /kick.</p><div className="console-command"><input className="text-input" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void run(); }} placeholder="/whitelist add Player" aria-label="Player administration command" /><button className="button primary" type="button" onClick={() => void run()} disabled={!command.trim()}>Send</button></div>{groups.map(([label, entries]) => <div className="admin-group" key={label}><div className="section-heading"><span>{label}</span><span className="count-badge">{entries.length}</span></div>{entries.length ? entries.map((entry, index) => <div className="native-detail" key={`${label}-${index}`}><span>{index + 1}</span><strong>{typeof entry === 'string' ? entry : JSON.stringify(entry)}</strong></div>) : <p className="storage-message">No entries.</p>}</div>)}{message && <p className="storage-message">{message}</p>}{error && <p className="warning-text">{error}</p>}</section></div>;
}

function WorldsPage({ serverId }: { serverId: string | null }) {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [worldName, setWorldName] = useState('world');
  const [copyName, setCopyName] = useState('world-copy');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => { if (!serverId) return; try { setWorlds((await ServerManagement.listWorlds({ serverId })).worlds); } catch (loadError) { setError(String(loadError)); } };
  useEffect(() => { void load(); }, [serverId]);
  const create = async () => { if (!serverId) return; try { await ServerManagement.createDefaultWorld({ serverId, worldName }); setMessage('World directory created; start the server to generate it.'); await load(); } catch (createError) { setError(String(createError)); } };
  const importWorld = async () => { if (!serverId) return; try { const result = await ServerManagement.importWorld({ serverId, worldName }); setMessage(result.canceled ? 'Import canceled.' : 'World imported.'); await load(); } catch (importError) { setError(String(importError)); } };
  const exportWorld = async (name: string) => { if (!serverId) return; try { const result = await ServerManagement.exportWorld({ serverId, worldName: name }); setMessage(result.canceled ? 'Export canceled.' : 'World exported.'); } catch (exportError) { setError(String(exportError)); } };
  const deleteWorld = async (name: string) => { if (!serverId || !window.confirm(`Delete ${name}? A safety backup will be created first.`)) return; try { await ServerManagement.deleteWorld({ serverId, worldName: name }); setMessage('World deleted after safety backup.'); await load(); } catch (deleteError) { setError(String(deleteError)); } };
  const copyWorld = async (name: string) => { if (!serverId) return; try { await ServerManagement.copyWorld({ serverId, sourceWorld: name, destinationWorld: copyName }); setMessage('World copied.'); await load(); } catch (copyError) { setError(String(copyError)); } };
  if (!serverId) return <section className="panel placeholder"><strong>Create a server first</strong><p className="muted">World management requires an installed server.</p></section>;
  return <div className="stack"><section className="panel native-panel"><div className="section-heading"><span>Worlds</span><button className="button" type="button" onClick={() => void load()}>Refresh</button></div><p className="settings-hint">Stop the server before importing, copying, or deleting worlds. Imports are extracted into managed storage and protected against ZIP path traversal.</p><div className="console-command"><input className="text-input" value={worldName} onChange={(event) => setWorldName(event.target.value)} placeholder="World name" /><button className="button" type="button" onClick={() => void create()}>Create default</button><button className="button" type="button" onClick={() => void importWorld()}>Import ZIP</button></div>{worlds.map((world) => <div className="world-row" key={world.name}><div><strong>{world.name}</strong><span className="muted">{world.valid ? 'Valid Java world' : 'Directory pending generation'} · {formatBytes(world.sizeBytes)}</span></div><div className="world-actions"><button className="button" type="button" onClick={() => void exportWorld(world.name)} disabled={!world.valid}>Export</button><button className="button" type="button" onClick={() => void copyWorld(world.name)} disabled={!world.valid}>Copy</button><button className="button danger" type="button" onClick={() => void deleteWorld(world.name)} disabled={!world.valid}>Delete</button></div></div>)}{!worlds.length && <p className="storage-message">No worlds found.</p>}<div className="console-command"><input className="text-input" value={copyName} onChange={(event) => setCopyName(event.target.value)} placeholder="Copy destination name" /><span className="muted">Choose Copy on a world above.</span></div>{message && <p className="storage-message">{message}</p>}{error && <p className="warning-text">{error}</p>}</section></div>;
}

function BackupsPage({ serverId }: { serverId: string | null }) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [retention, setRetention] = useState(10);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => { if (!serverId) return; try { setBackups((await ServerManagement.listBackups({ serverId })).backups); } catch (loadError) { setError(String(loadError)); } };
  useEffect(() => { void load(); }, [serverId]);
  const create = async () => { if (!serverId) return; try { await ServerManagement.createBackup({ serverId, retentionLimit: retention }); setMessage('Backup created.'); await load(); } catch (createError) { setError(String(createError)); } };
  const restore = async (name: string) => { if (!serverId || !window.confirm('Restore this backup? The current server state will be backed up first.')) return; try { await ServerManagement.restoreBackup({ serverId, name }); setMessage('Backup restored.'); await load(); } catch (restoreError) { setError(String(restoreError)); } };
  const remove = async (name: string) => { if (!serverId || !window.confirm('Delete this backup permanently?')) return; try { await ServerManagement.deleteBackup({ serverId, name }); setMessage('Backup deleted.'); await load(); } catch (deleteError) { setError(String(deleteError)); } };
  const exportBackup = async (name: string) => { if (!serverId) return; try { const result = await ServerManagement.exportBackup({ serverId, name }); setMessage(result.canceled ? 'Export canceled.' : 'Backup exported.'); } catch (exportError) { setError(String(exportError)); } };
  if (!serverId) return <section className="panel placeholder"><strong>Create a server first</strong><p className="muted">Backups require an installed server.</p></section>;
  return <div className="stack"><section className="panel native-panel"><div className="section-heading"><span>Backups and restore</span><button className="button" type="button" onClick={() => void load()}>Refresh</button></div><p className="settings-hint">Stop the server before creating or restoring a backup. Restore validates the archive and creates a safety backup of the current state first.</p><div className="console-command"><label className="muted">Retention <input className="text-input compact-input" type="number" min={1} max={100} value={retention} onChange={(event) => setRetention(Number(event.target.value))} /></label><button className="button primary" type="button" onClick={() => void create()}>Manual backup</button></div>{backups.map((backup) => <div className="world-row" key={backup.name}><div><strong>{backup.name}</strong><span className="muted">{formatBytes(backup.bytes)}</span></div><div className="world-actions"><button className="button" type="button" onClick={() => void restore(backup.name)}>Restore</button><button className="button" type="button" onClick={() => void exportBackup(backup.name)}>Export</button><button className="button danger" type="button" onClick={() => void remove(backup.name)}>Delete</button></div></div>)}{!backups.length && <p className="storage-message">No backups yet.</p>}{message && <p className="storage-message">{message}</p>}{error && <p className="warning-text">{error}</p>}</section></div>;
}

function Settings({ serverId }: { serverId: string | null }) {
  const [device, setDevice] = useState<NativeDeviceInfo | null>(null);
  const [memory, setMemory] = useState<NativeMemoryInfo | null>(null);
  const [storage, setStorage] = useState<NativeStorageInfo | null>(null);
  const [directories, setDirectories] = useState<NativeAppDataDirectory | null>(null);
  const [bridgeState, setBridgeState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [storageLayout, setStorageLayout] = useState<ManagedStorageLayout | null>(null);
  const [storageState, setStorageState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [storageMessage, setStorageMessage] = useState('');
  const [testFilePath, setTestFilePath] = useState<string | null>(null);
  const [pathSafetyState, setPathSafetyState] = useState<'blocked' | 'failed' | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<JavaRuntimeInfo | null>(null);
  const [runtimeState, setRuntimeState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [runtimeMessage, setRuntimeMessage] = useState('');
  const [runtimeProgress, setRuntimeProgress] = useState<JavaRuntimeProgress | null>(null);
  const [runtimePromptMajor, setRuntimePromptMajor] = useState<JavaRuntimeMajor | null>(null);
  const [runtimeOutput, setRuntimeOutput] = useState('');

  const loadNativeInfo = async () => {
    setBridgeState('loading');
    try {
      const [nextDevice, nextMemory, nextStorage, nextDirectories] = await Promise.all([
        DeviceInfo.getDeviceInfo(),
        DeviceInfo.getMemoryInfo(),
        DeviceInfo.getStorageInfo(),
        DeviceInfo.getAppDataDirectory(),
      ]);
      setDevice(nextDevice);
      setMemory(nextMemory);
      setStorage(nextStorage);
      setDirectories(nextDirectories);
      setBridgeState('ready');
    } catch {
      setBridgeState('unavailable');
    }
  };

  const loadStorageLayout = async () => {
    setStorageState('loading');
    try {
      setStorageLayout(await Storage.getStorageLayout());
      setStorageState('ready');
      setStorageMessage('');
    } catch {
      setStorageState('unavailable');
    }
  };

  const loadRuntimeInfo = async () => {
    setRuntimeState('loading');
    try {
      setRuntimeInfo(await JavaRuntime.getRuntimeInfo());
      setRuntimeState('ready');
    } catch {
      setRuntimeState('unavailable');
    }
  };

  useEffect(() => {
    void loadNativeInfo();
    void loadStorageLayout();
    void loadRuntimeInfo();
    let progressHandle: { remove: () => Promise<void> } | undefined;
    void JavaRuntime.addListener('runtimeProgress', (progress) => {
      setRuntimeProgress(progress);
      setRuntimeMessage(progress.message);
    }).then((handle) => {
      progressHandle = handle;
    }).catch(() => undefined);
    return () => {
      void progressHandle?.remove();
    };
  }, []);

  const createTestServer = async () => {
    try {
      const result = await Storage.createServerDirectory({ serverId: 'phase3-test' });
      setStorageMessage(result.existed ? 'Test server directory already exists.' : 'Test server directory created.');
    } catch {
      setStorageMessage('Could not create the test server directory.');
    }
  };

  const writeTestFile = async () => {
    try {
      const result = await Storage.writeTestFile({
        relativePath: 'servers/phase3-test/storage-test.txt',
        content: 'Minecraft Server Customizer Android storage test\n',
      });
      setTestFilePath(result.relativePath);
      setStorageMessage('Test file written inside managed storage.');
    } catch {
      setStorageMessage('Create the test server directory before writing a test file.');
    }
  };

  const validatePathSafety = async () => {
    try {
      const result = await Storage.validateManagedPath({ relativePath: '../outside-managed-storage.txt' });
      setPathSafetyState(result.valid ? 'failed' : 'blocked');
      setStorageMessage(result.valid ? 'Path safety check failed.' : 'Path traversal was blocked.');
    } catch {
      setPathSafetyState('blocked');
      setStorageMessage('Path traversal was blocked.');
    }
  };

  const importFile = async () => {
    try {
      const result = await Storage.importFile({ destinationRelativePath: 'downloads/imported-test-file' });
      if (result.canceled) {
        setStorageMessage('Import canceled.');
      } else {
        setTestFilePath(result.relativePath);
        setStorageMessage('File imported into managed downloads.');
      }
    } catch {
      setStorageMessage('Could not import the selected file.');
    }
  };

  const exportFile = async () => {
    if (!testFilePath) return;
    try {
      const result = await Storage.exportFile({ relativePath: testFilePath });
      setStorageMessage(result.canceled ? 'Export canceled.' : 'File exported successfully.');
    } catch {
      setStorageMessage('Could not export the managed file.');
    }
  };

  const deleteTestServer = async () => {
    try {
      await Storage.deleteServerDirectory({ serverId: 'phase3-test' });
      setTestFilePath(null);
      setStorageMessage('Test server directory deleted.');
    } catch {
      setStorageMessage('Could not delete the test server directory.');
    }
  };

  const downloadRuntime = async (majorVersion: JavaRuntimeMajor) => {
    setRuntimePromptMajor(null);
    setRuntimeOutput('');
    setRuntimeProgress({ majorVersion, status: 'resolving', percent: null, message: `Preparing Java ${majorVersion}…` });
    setRuntimeMessage(`Preparing Java ${majorVersion}…`);
    try {
      const result = await JavaRuntime.downloadRuntime({ majorVersion });
      setRuntimeOutput(result.runtime.versionOutput);
      setRuntimeMessage(`Java ${majorVersion} installed and verified.`);
      setRuntimeProgress({ majorVersion, status: 'complete', percent: 100, message: `Java ${majorVersion} is ready` });
      await loadRuntimeInfo();
    } catch (error) {
      const detail = nativeErrorMessage(error);
      setRuntimeMessage(detail
        ? `Could not install Java ${majorVersion}: ${detail}`
        : `Could not install Java ${majorVersion}. Check the runtime progress message for details.`);
      setRuntimeProgress(null);
    }
  };

  const verifyRuntime = async (majorVersion: JavaRuntimeMajor) => {
    setRuntimeMessage(`Running Java ${majorVersion} verification…`);
    try {
      const result = await JavaRuntime.verifyRuntime({ majorVersion });
      setRuntimeOutput(result.output);
      setRuntimeMessage(`Java ${majorVersion} verified successfully.`);
    } catch (error) {
      const detail = nativeErrorMessage(error);
      setRuntimeMessage(detail
        ? `Java ${majorVersion} verification failed: ${detail}`
        : `Java ${majorVersion} verification failed.`);
    }
  };

  return (
    <div className="stack">
      <ServerPropertiesEditor serverId={serverId} />
      <section className="panel">
        <div className="section-heading"><span>Application</span><span className="muted">Phase 4 runtime manager</span></div>
        <div className="setting-row"><span>Theme</span><strong>Green / black</strong></div>
        <div className="setting-row"><span>Active server limit</span><strong>One at a time</strong></div>
        <div className="setting-row"><span>Hosting runtime</span><strong className="muted">Runtime manager only</strong></div>
      </section>
      <section className="panel native-panel">
        <div className="section-heading">
          <span>Device information</span>
          <span className={`bridge-state ${bridgeState}`}>{bridgeState === 'ready' ? 'Connected' : bridgeState === 'loading' ? 'Reading…' : 'Unavailable'}</span>
        </div>
        {bridgeState === 'ready' && device && memory && storage && directories ? (
          <>
            <div className="native-info-grid">
              <InfoCard label="Android" value={`${device.androidVersion} (API ${device.sdkInt})`} />
              <InfoCard label="Architecture" value={device.architecture} />
              <InfoCard label="Memory available" value={`${formatBytes(memory.availableBytes)} / ${formatBytes(memory.totalBytes)}`} />
              <InfoCard label="Storage available" value={`${formatBytes(storage.availableBytes)} / ${formatBytes(storage.totalBytes)}`} />
            </div>
            <div className="native-detail"><span>Device</span><strong>{device.manufacturer} {device.model}</strong></div>
            <div className="native-detail"><span>App data</span><strong title={directories.path}>{directories.path}</strong></div>
            <div className="native-detail"><span>Server directory</span><strong title={directories.serverDirectory}>{directories.serverDirectory}</strong></div>
            {memory.lowMemory && <p className="warning-text">Android reports low available memory.</p>}
          </>
        ) : (
          <div className="native-unavailable">
            <strong>{bridgeState === 'loading' ? 'Reading native device information…' : 'Native bridge unavailable'}</strong>
            <p className="muted">Open this screen in the Android app to query Kotlin. Browser previews do not expose native device APIs.</p>
          </div>
        )}
        <button className="button" type="button" onClick={() => void loadNativeInfo()} disabled={bridgeState === 'loading'}>
          {bridgeState === 'loading' ? 'Reading…' : 'Refresh device info'}
        </button>
      </section>
      <section className="panel native-panel">
        <div className="section-heading">
          <span>Managed storage</span>
          <span className={`bridge-state ${storageState}`}>{storageState === 'ready' ? 'Protected' : storageState === 'loading' ? 'Reading…' : 'Unavailable'}</span>
        </div>
        {storageState === 'ready' && storageLayout ? (
          <>
            <div className="native-detail"><span>Root</span><strong title={storageLayout.root}>{storageLayout.root}</strong></div>
            <div className="native-detail"><span>Servers</span><strong title={storageLayout.servers}>{storageLayout.servers}</strong></div>
            <div className="native-detail"><span>Backups</span><strong title={storageLayout.backups}>{storageLayout.backups}</strong></div>
            <div className="native-detail"><span>Downloads</span><strong title={storageLayout.downloads}>{storageLayout.downloads}</strong></div>
            <div className="storage-actions">
              <button className="button" type="button" onClick={() => void createTestServer()}>Create test server</button>
              <button className="button" type="button" onClick={() => void writeTestFile()}>Write test file</button>
              <button className="button" type="button" onClick={() => void importFile()}>Import file</button>
              <button className="button" type="button" onClick={() => void exportFile()} disabled={!testFilePath}>Export test file</button>
              <button className="button danger" type="button" onClick={() => void deleteTestServer()}>Delete test server</button>
              <button className={`button ${pathSafetyState === 'blocked' ? 'safe' : ''}`} type="button" onClick={() => void validatePathSafety()}>
                Test path safety
              </button>
            </div>
            {testFilePath && <p className="storage-path">Test file: {testFilePath}</p>}
            {storageMessage && <p className={`storage-message ${pathSafetyState === 'failed' ? 'warning-text' : ''}`}>{storageMessage}</p>}
          </>
        ) : (
          <div className="native-unavailable">
            <strong>{storageState === 'loading' ? 'Preparing managed storage…' : 'Managed storage unavailable'}</strong>
            <p className="muted">The Android app owns these directories. Browser previews cannot access them.</p>
          </div>
        )}
        <button className="button" type="button" onClick={() => void loadStorageLayout()} disabled={storageState === 'loading'}>
          {storageState === 'loading' ? 'Reading…' : 'Refresh storage'}
        </button>
      </section>
      <section className="panel native-panel">
        <div className="section-heading">
          <span>Java runtimes</span>
          <span className={`bridge-state ${runtimeState}`}>{runtimeState === 'ready' ? 'Private' : runtimeState === 'loading' ? 'Reading…' : 'Unavailable'}</span>
        </div>
        {runtimeState === 'ready' && runtimeInfo ? (
          <>
            <div className="native-detail"><span>Architecture</span><strong>{runtimeInfo.architecture}</strong></div>
            <div className="native-detail"><span>Runtime directory</span><strong title={runtimeInfo.root}>{runtimeInfo.root}</strong></div>
            <div className="runtime-list">
              {JAVA_RUNTIME_MAJORS.map((majorVersion) => {
                const installed = runtimeInfo.installed.find((runtime) => runtime.majorVersion === majorVersion);
                return (
                  <div className="runtime-row" key={majorVersion}>
                    <div>
                      <strong>Java {majorVersion}</strong>
                      <span className="muted">{installed ? `Installed · ${installed.version}` : 'Not installed'}</span>
                    </div>
                    <button
                      className="button"
                      type="button"
                      onClick={() => installed ? void verifyRuntime(majorVersion) : setRuntimePromptMajor(majorVersion)}
                      disabled={runtimeProgress?.status === 'downloading' || runtimeProgress?.status === 'extracting'}
                    >
                      {installed ? 'Verify' : 'Download'}
                    </button>
                  </div>
                );
              })}
            </div>
            {runtimePromptMajor !== null && (
              <div className="runtime-notice">
                <strong>Java Runtime Required</strong>
                <p>Minecraft requires Java {runtimePromptMajor}. Minecraft Server Customizer can download a private runtime for this server. It will be stored only inside the app's data directory.</p>
                <div className="runtime-notice-actions">
                  <button className="button primary" type="button" onClick={() => void downloadRuntime(runtimePromptMajor)}>Download Runtime</button>
                  <button className="button" type="button" onClick={() => setRuntimePromptMajor(null)}>Cancel</button>
                </div>
              </div>
            )}
            {runtimeProgress && <p className="storage-message">{runtimeProgress.message}{runtimeProgress.percent !== null ? ` ${runtimeProgress.percent}%` : ''}</p>}
            {runtimeMessage && <p className="storage-message">{runtimeMessage}</p>}
            {runtimeOutput && <pre className="runtime-output">{runtimeOutput}</pre>}
          </>
        ) : (
          <div className="native-unavailable">
            <strong>{runtimeState === 'loading' ? 'Reading Java runtime information…' : 'Java runtime manager unavailable'}</strong>
            <p className="muted">Runtime downloads are private to the Android app and are not available in browser previews.</p>
          </div>
        )}
        <button className="button" type="button" onClick={() => void loadRuntimeInfo()} disabled={runtimeState === 'loading'}>
          {runtimeState === 'loading' ? 'Reading…' : 'Refresh runtimes'}
        </button>
      </section>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return <div className="native-info-card"><span>{label}</span><strong>{value}</strong></div>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <section className="panel placeholder">
      <div className="empty-mark">—</div>
      <h2>{title}</h2>
      <p className="muted">{description}</p>
    </section>
  );
}

export default App;

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type {
  LogLine,
  PlayitLink,
  PlayitSettings,
  PlayitState,
  PlayitStatus,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import type { WsBroadcast } from './world-service';

const LOG_LIMIT = 500;
/** After this long in "starting" with a live process, treat Playit as online. */
const ONLINE_GRACE_MS = 5000;

/**
 * Manages the Playit agent process (one at a time). Detects setup/claim links
 * and public tunnel addresses in the agent output, broadcasts state + log
 * events over WebSocket, and persists the selected executable path + last
 * known public address in the settings table.
 *
 * Phase 11 intentionally does NOT automate the tunnel API — the user completes
 * the setup flow in their browser, and the app just launches/stops the agent.
 */
export class PlayitService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private child: ChildProcess | null = null;
  private state: PlayitState = 'offline';
  private startedAt: number | null = null;
  private exitCode: number | null = null;
  private logs: LogLine[] = [];
  private links: PlayitLink[] = [];
  private detectedAddress: string | null = null;
  private onlineTimer: NodeJS.Timeout | null = null;

  constructor(db: DatabaseResult, broadcast: WsBroadcast) {
    this.db = db;
    this.broadcast = broadcast;
  }

  /** All Playit-related persisted settings. */
  getSettings(): PlayitSettings {
    const settings = this.db.getSettings();
    return {
      playitPath: settings.playitPath ?? null,
      playitPublicAddress: settings.playitPublicAddress ?? null,
    };
  }

  /** Persist the selected Playit executable path. */
  setPlayitPath(playitPath: string | null): PlayitSettings {
    this.db.setSetting('playitPath', playitPath);
    return this.getSettings();
  }

  /** Persist the user-entered (or detected) public address. */
  setPublicAddress(address: string | null): PlayitSettings {
    this.db.setSetting('playitPublicAddress', address);
    return this.getSettings();
  }

  /** Detect whether a path is a usable Playit executable. */
  detect(playitPath: string | null): boolean {
    if (!playitPath) return false;
    try {
      return fs.existsSync(playitPath);
    } catch {
      return false;
    }
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Current process state. */
  stateOf(): PlayitState {
    return this.state;
  }

  getStatus(): PlayitStatus {
    const running = this.child !== null;
    return {
      state: running ? this.state : 'offline',
      pid: running && this.child?.pid ? this.child.pid : null,
      startedAt: running && this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeSeconds:
        running && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      exitCode: running ? this.exitCode : null,
      logs: running ? this.logs : [],
      links: running ? this.links : [],
      detectedAddress: running ? this.detectedAddress : null,
    };
  }

  /**
   * Start the Playit agent. Returns an error object with a `code` when the
   * process cannot be launched, or null on success.
   */
  start(playitPath: string): { code: string; message: string } | null {
    if (this.child) {
      return {
        code: 'already-running',
        message: 'Playit is already running',
      };
    }
    if (!playitPath) {
      return {
        code: 'no-executable',
        message: 'No Playit executable selected. Choose one first.',
      };
    }
    if (!fs.existsSync(playitPath)) {
      return {
        code: 'missing-executable',
        message: `Playit executable not found: ${playitPath}`,
      };
    }

    this.state = 'starting';
    this.startedAt = Date.now();
    this.exitCode = null;
    this.logs = [];
    this.links = [];
    this.detectedAddress = null;
    this.clearOnlineTimer();
    this.setState('starting');

    this.pushLog(`Starting Playit: ${playitPath}`);

    // Fallback: some agent versions never print a "tunnel ready" style line
    // after startup, so if the process stays alive past the grace period we
    // treat it as online (running). The process-alive check keeps this from
    // firing for a process that died silently before the timer elapses.
    this.onlineTimer = setTimeout(() => {
      this.onlineTimer = null;
      if (this.child && this.state === 'starting') {
        this.pushLog('Playit process is up; marking online', 'info');
        this.setState('online');
      }
    }, ONLINE_GRACE_MS);

    // Run playit with a TTY-ish context in mind; the agent writes setup links
    // to stdout when it is not yet claimed. windowsHide keeps the console
    // window from flashing on Windows.
    // .cmd/.bat paths (tests use a cmd wrapper) must be spawned via cmd /c —
    // Windows cannot exec a script file directly.
    const isCmdWrapper = /\.(cmd|bat)$/i.test(playitPath);
    const child = isCmdWrapper
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', playitPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(playitPath, [], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of splitLines(chunk.toString())) {
        if (!line) continue;
        this.handleOutputLine(line);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of splitLines(chunk.toString())) {
        if (!line) continue;
        // Rust tools (playitd) write their INFO logs to stderr — treat it as
        // a first-class output stream so online/claim/address detection works.
        this.handleOutputLine(line, 'warn');
      }
    });

    child.on('error', (err) => {
      this.pushLog(`Process error: ${err.message}`, 'error');
      this.child = null;
      this.clearOnlineTimer();
      this.setState('crashed', 1);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.clearOnlineTimer();
      const exitCode = code ?? (signal ? 1 : null);
      this.pushLog(`Playit exited (code ${exitCode})`, 'info');

      const wasStopping = this.state === 'stopping';
      if (wasStopping) {
        this.setState('offline', exitCode);
      } else if (this.state === 'starting' || this.state === 'online') {
        this.setState('crashed', exitCode);
      } else {
        this.setState('offline', exitCode);
      }
      this.startedAt = null;
    });

    return null;
  }

  /** Graceful stop: terminate the process (playit has no stop command). */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.setState('stopping');
    this.pushLog('Stopping Playit...');
    this.killChild(child);
    // If the process does not exit quickly, force-kill the tree.
    const timer = setTimeout(() => {
      if (this.child === child) {
        this.pushLog('Playit did not exit, force-killing', 'warn');
        this.forceKill();
      }
    }, 10000);
    child.once('exit', () => clearTimeout(timer));
  }

  /** Force-kill the Playit process, including its tree on Windows. */
  forceKill(): void {
    const child = this.child;
    if (!child) return;
    this.killChild(child);
  }

  private killChild(child: ChildProcess): void {
    const pid = child.pid;
    if (process.platform === 'win32' && pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        return;
      } catch {
        // fall through to child.kill
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead
    }
  }

  /** Ensure the managed process is stopped when the backend shuts down. */
  shutdown(): void {
    this.clearOnlineTimer();
    if (this.child) {
      this.pushLog('Backend shutting down; stopping Playit', 'warn');
      this.killChild(this.child);
    }
    this.child = null;
    this.state = 'offline';
  }

  private clearOnlineTimer(): void {
    if (this.onlineTimer) {
      clearTimeout(this.onlineTimer);
      this.onlineTimer = null;
    }
  }

  /**
   * Process one output line from the agent (stdout or stderr): log it,
   * watch for setup links + public addresses, and flip to online when the
   * daemon reports it is up.
   */
  private handleOutputLine(line: string, level?: LogLine['level']): void {
    this.pushLog(line, level ?? classifyLine(line));
    const link = findSetupLink(line);
    if (link) {
      // Keep the newest link first, dedupe, cap the list.
      this.links = [link, ...this.links.filter((l) => l.url !== link.url)].slice(0, 5);
    }
    const address = findPublicAddress(line);
    if (address) {
      this.detectedAddress = address;
    }
    if (isOnlineLine(line)) {
      this.clearOnlineTimer();
      this.setState('online');
    }
  }

  private setState(state: PlayitState, exitCode: number | null = null): void {
    this.state = state;
    if (state === 'offline' || state === 'crashed') {
      this.exitCode = exitCode;
    }
    this.broadcast({ type: 'playit:state', state } satisfies WsServerEvent);
  }

  private pushLog(text: string, level: LogLine['level'] = 'info'): void {
    const log: LogLine = {
      timestamp: new Date().toISOString(),
      level,
      text,
    };
    this.logs.push(log);
    if (this.logs.length > LOG_LIMIT) {
      this.logs.splice(0, this.logs.length - LOG_LIMIT);
    }
    this.broadcast({ type: 'playit:log', log } satisfies WsServerEvent);
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** A Playit setup/claim link, e.g. https://playit.gg/claim/<code>. */
export function findSetupLink(line: string): PlayitLink | null {
  const claim = line.match(/https:\/\/playit\.gg\/claim\/[A-Za-z0-9_-]+/);
  if (claim) return { kind: 'claim', url: claim[0] };
  const setup = line.match(/https:\/\/playit\.gg\/account\/tunnels/);
  if (setup) return { kind: 'setup', url: setup[0] };
  return null;
}

/** A public tunnel address, e.g. xxxx.playit.gg or xxxx.playit.gg:25565. */
export function findPublicAddress(line: string): string | null {
  const match = line.match(/([a-z0-9-]+\.playit\.gg(?::\d+)?)/);
  return match ? match[1] : null;
}

function isOnlineLine(line: string): boolean {
  return (
    /tunnel established|tunnel ready|connected|Starting playitd daemon|playitd::daemon|playitd::ui|agent: (tunnel|connected)|tunnel running/i.test(
      line,
    ) || /Secret found/i.test(line)
  );
}

function classifyLine(line: string): LogLine['level'] {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('exception') || lower.includes('fatal')) {
    return 'error';
  }
  if (lower.includes('warn')) return 'warn';
  return 'info';
}

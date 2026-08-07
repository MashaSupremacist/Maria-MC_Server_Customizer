import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pidusage from 'pidusage';
import type {
  LogLine,
  ServerFlavor,
  ServerState,
  ServerStats,
  ServerStatus,
  StartServerError,
} from '@msc/shared-types';

export interface ServerConfig {
  serverId: string;
  name: string;
  folderPath: string;
  javaPath: string;
  memoryMb: number;
  jvmArgs: string[];
  /** Server port for the local address display. */
  port: number;
  /** Server flavor: affects which jar is launched. */
  flavor?: ServerFlavor;
  /** Server edition: bedrock launches bedrock_server.exe directly. */
  edition?: 'java' | 'bedrock';
}

export interface ProcessEvents {
  onState: (serverId: string, state: ServerState, exitCode: number | null) => void;
  onLog: (serverId: string, log: LogLine) => void;
  onStats: (serverId: string, stats: ServerStats) => void;
}

const LOG_LIMIT = 500;
const STATS_INTERVAL_MS = 2000;

/** Find the server jar in a server folder, flavor-aware. */
export function findServerJar(
  folderPath: string,
  flavor: ServerFlavor = 'vanilla',
): string | null {
  if (!fs.existsSync(folderPath)) return null;
  if (flavor === 'fabric') {
    const fabric = path.join(folderPath, 'fabric-server-launch.jar');
    return fs.existsSync(fabric) ? fabric : null;
  }
  if (flavor === 'forge') {
    // Forge generates forge-<mc>-<build>.jar (the installer is removed).
    // A -shim.jar launcher may also exist; prefer the real server jar.
    const forgeJars = fs
      .readdirSync(folderPath)
      .filter((f) => f.startsWith('forge-') && f.endsWith('.jar') && f !== 'forge-installer.jar');
    const real = forgeJars.find((f) => !f.includes('-shim.'));
    return real ? path.join(folderPath, real) : forgeJars.length > 0 ? path.join(folderPath, forgeJars[0]) : null;
  }
  if (flavor === 'paper') {
    const paperJars = fs
      .readdirSync(folderPath)
      .filter((f) => f.startsWith('paper-') && f.endsWith('.jar'));
    return paperJars.length > 0 ? path.join(folderPath, paperJars[0]) : null;
  }
  // Vanilla: server.jar, or a single jar.
  const direct = path.join(folderPath, 'server.jar');
  if (fs.existsSync(direct)) return direct;
  try {
    const jars = fs
      .readdirSync(folderPath)
      .filter((f) => f.endsWith('.jar') && f !== 'server.jar');
    return jars.length === 1 ? path.join(folderPath, jars[0]) : null;
  } catch {
    return null;
  }
}

/** Find the executable/launcher for a server folder, edition-aware. */
export function findServerExecutable(
  folderPath: string,
  edition: 'java' | 'bedrock' = 'java',
  flavor: ServerFlavor = 'vanilla',
): string | null {
  if (edition === 'bedrock') {
    // Official BDS ships bedrock_server.exe; also accept .cmd/.bat wrappers
    // (mirrors Playit, and lets users wrap the exe with launch scripts).
    for (const name of ['bedrock_server.exe', 'bedrock_server.cmd', 'bedrock_server.bat']) {
      const candidate = path.join(folderPath, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  return findServerJar(folderPath, flavor);
}

/**
 * Manages one running server process at a time. Only one server may run
 * across all instances (Phase 3 constraint from the project plan).
 */
export class ProcessManager {
  private readonly events: ProcessEvents;
  private child: ChildProcess | null = null;
  private state: ServerState = 'offline';
  private serverId: string | null = null;
  private startedAt: number | null = null;
  private exitCode: number | null = null;
  private logs: LogLine[] = [];
  private port: number | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private stats: ServerStats = { cpuPercent: 0, memoryMb: 0, playerCount: null, onlinePlayers: [] };

  constructor(events: ProcessEvents) {
    this.events = events;
  }

  get runningServerId(): string | null {
    return this.serverId;
  }

  private setState(state: ServerState, exitCode: number | null = null): void {
    this.state = state;
    if (state === 'offline' || state === 'crashed') {
      this.exitCode = exitCode;
    }
    if (this.serverId) {
      this.events.onState(this.serverId, state, exitCode);
    }
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
    if (this.serverId) {
      this.events.onLog(this.serverId, log);
    }
  }

  start(config: ServerConfig): StartServerError | null {
    if (this.child) {
      return {
        code: 'already-running',
        message: `"${this.runningServerId ?? '?'}" is already running`,
      };
    }
    if (!fs.existsSync(config.folderPath)) {
      return { code: 'folder-not-found', message: `Folder not found: ${config.folderPath}` };
    }
    const edition = config.edition ?? 'java';
    const executable = findServerExecutable(
      config.folderPath,
      edition,
      config.flavor ?? 'vanilla',
    );
    if (!executable) {
      if (edition === 'bedrock') {
        return {
          code: 'missing-executable',
          message: 'No bedrock_server.exe found in the server folder',
        };
      }
      return {
        code: 'missing-jar',
        message: 'No server.jar (or single .jar) found in the server folder',
      };
    }
    if (edition === 'java' && !fs.existsSync(config.javaPath)) {
      return {
        code: 'missing-java',
        message: `Java executable not found: ${config.javaPath}`,
      };
    }

    this.serverId = config.serverId;
    this.logs = [];
    this.exitCode = null;
    this.startedAt = Date.now();
    this.port = config.port;
    this.stats = { cpuPercent: 0, memoryMb: 0, playerCount: null, onlinePlayers: [] };
    this.setState('starting');

    let launch: { command: string; args: string[] };
    let isCmdWrapper = false;
    if (edition === 'bedrock') {
      launch = { command: executable, args: [] };
      isCmdWrapper = /\.(cmd|bat)$/i.test(executable);
      this.pushLog(`Starting "${config.name}"…`);
      this.pushLog(`Command: ${executable}`);
    } else {
      launch = {
        command: config.javaPath,
        args: [
          `-Xms${config.memoryMb}M`,
          `-Xmx${config.memoryMb}M`,
          ...config.jvmArgs,
          '-jar',
          executable,
          'nogui',
        ],
      };
      this.pushLog(`Starting "${config.name}" with ${config.memoryMb} MB RAM...`);
      this.pushLog(`Command: ${config.javaPath} ${launch.args.join(' ')}`);
    }

    // Windows cannot exec a .cmd/.bat directly; route them through cmd /c.
    // Real bedrock_server.exe spawns directly. (Tests use .cmd wrappers.)
    let command = launch.command;
    let args = launch.args;
    if (isCmdWrapper) {
      command = process.env.ComSpec ?? 'cmd.exe';
      args = ['/d', '/s', '/c', launch.command];
    }

    const child = spawn(command, args, {
      cwd: config.folderPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.startStatsTimer(child.pid);

    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = splitLines(chunk.toString());
      const isBedrock = edition === 'bedrock';
      // If this chunk carries the online seed line, seed the baseline BEFORE
      // processing deltas. The seed and a join/leave can land in the same
      // stdout chunk; without the up-front seed the delta is silently dropped
      // because playerCount is still null.
      const chunkHasSeed = lines.some((l) =>
        isBedrock ? isBedrockOnlineLine(l) : isOnlineLine(l),
      );
      if (chunkHasSeed && this.stats.playerCount === null) {
        this.stats = { ...this.stats, playerCount: 0 };
        this.emitStats();
      }
      for (const line of lines) {
        if (!line) continue;
        this.pushLog(line, classifyLine(line));
        const playerCount = isBedrock ? null : parsePlayerCount(line);
        if (playerCount !== null) {
          // Full player-count report: refresh the tracked names when the
          // server lists them, otherwise keep what join/leave lines gave us.
          const names = parsePlayerList(line);
          let onlinePlayers = this.stats.onlinePlayers;
          if (names !== null) {
            onlinePlayers = names;
          } else if (playerCount === 0) {
            onlinePlayers = [];
          }
          this.stats = {
            ...this.stats,
            playerCount: names && names.length > 0 ? names.length : playerCount,
            onlinePlayers,
          };
          this.emitStats();
        } else {
          const name = isBedrock ? parseBedrockPlayerName(line) : parsePlayerName(line);
          const delta = isBedrock
            ? parseBedrockPlayerDelta(line)
            : parsePlayerDelta(line);
          if (delta !== null && name !== null) {
            const current = this.stats.onlinePlayers;
            const onlinePlayers =
              delta > 0
                ? current.includes(name)
                  ? current
                  : [...current, name]
                : current.filter((n) => n !== name);
            this.stats = {
              ...this.stats,
              playerCount:
                this.stats.playerCount === null
                  ? null
                  : Math.max(0, this.stats.playerCount + delta),
              onlinePlayers,
            };
            this.emitStats();
          }
        }
        const online = isBedrock ? isBedrockOnlineLine(line) : isOnlineLine(line);
        if (online) {
          // Seed a baseline so join/leave deltas work even when the full
          // player-count report never appears.
          if (this.stats.playerCount === null) {
            this.stats = { ...this.stats, playerCount: 0 };
            this.emitStats();
          }
          this.setState('online');
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of splitLines(chunk.toString())) {
        if (!line) continue;
        this.pushLog(line, 'warn');
      }
    });

    child.on('error', (err) => {
      this.pushLog(`Process error: ${err.message}`, 'error');
      this.setState('crashed', 1);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.clearStatsTimer();
      const exitCode = code ?? (signal ? 1 : null);
      this.pushLog(`Process exited (code ${exitCode})`, 'info');

      const wasStopping = this.state === 'stopping';
      if (wasStopping) {
        this.setState('offline', exitCode);
      } else if (this.state === 'starting' || this.state === 'online') {
        this.setState('crashed', exitCode);
      } else {
        this.setState('offline', exitCode);
      }
      this.serverId = null;
      this.startedAt = null;
    });

    return null;
  }

  /** Graceful stop: send "stop" to stdin, then SIGTERM after 20s. */
  stop(): void {
    if (!this.child || !this.serverId) return;
    this.setState('stopping');
    this.pushLog('Sending "stop" command...');
    try {
      this.child.stdin?.write('stop\n');
    } catch {
      // stdin may be closed already; fall through to kill
    }
    const child = this.child;
    setTimeout(() => {
      if (this.child === child) {
        this.pushLog('Graceful stop timed out, terminating process', 'warn');
        this.forceKill();
      }
    }, 20000);
  }

  /** Force-kill the child process, including its tree on Windows. */
  forceKill(): void {
    const child = this.child;
    if (!child) return;
    const pid = child.pid;
    if (process.platform === 'win32' && pid) {
      // taskkill /T kills the entire process tree (java spawns may have
      // wrappers or child JVM processes that child.kill would orphan).
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

  sendCommand(command: string): boolean {
    if (!this.child || !this.serverId) return false;
    try {
      this.child.stdin?.write(`${command}\n`);
      this.pushLog(`> ${command}`);
      return true;
    } catch {
      return false;
    }
  }

  getStatus(serverId: string): ServerStatus {
    const running = this.serverId === serverId;
    return {
      serverId,
      state: running ? this.state : 'offline',
      pid: running && this.child ? this.child.pid ?? null : null,
      startedAt: running && this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeSeconds:
        running && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      exitCode: running ? this.exitCode : null,
      logs: running ? this.logs : [],
      stats: running
        ? this.stats
        : { cpuPercent: 0, memoryMb: 0, playerCount: null, onlinePlayers: [] },
      address: running && this.port ? `127.0.0.1:${this.port}` : null,
    };
  }

  shutdown(): void {
    this.clearStatsTimer();
    this.forceKill();
  }

  private startStatsTimer(pid: number | undefined): void {
    this.clearStatsTimer();
    if (!pid) return;
    this.statsTimer = setInterval(() => {
      void pidusage(pid).then((usage) => {
        // Guard against the process having exited.
        if (!this.child || this.child.pid !== pid) return;
        this.stats = {
          ...this.stats,
          cpuPercent: round1(usage.cpu),
          memoryMb: round1(usage.memory / (1024 * 1024)),
        };
        this.emitStats();
      }).catch(() => {
        // process gone; stop sampling
        this.clearStatsTimer();
      });
    }, STATS_INTERVAL_MS);
  }

  private clearStatsTimer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private emitStats(): void {
    if (this.serverId) {
      this.events.onStats(this.serverId, this.stats);
    }
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Detect the "Done" line that marks a Vanilla/Patch server as online. */
function isOnlineLine(line: string): boolean {
  return /Done \([0-9.]+s\)/.test(line);
}

/** Detect the line that marks a Bedrock Dedicated Server as online. */
export function isBedrockOnlineLine(line: string): boolean {
  return /Server started\./.test(line) || /Level "[^"]+" started/.test(line);
}

/**
 * Parse an online player count from a Vanilla server log line like
 * "There are 3 of a max of 20 players online:". Returns null when the line
 * is not a player-count report.
 */
export function parsePlayerCount(line: string): number | null {
  const match = line.match(/There are (\d+) of a max of \d+ players online/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Parse the comma-separated player names from a full player-count line like
 * "There are 2 of a max of 20 players online: Steve, Alex". Returns null
 * when no names are listed (the modern Vanilla report omits them).
 */
export function parsePlayerList(line: string): string[] | null {
  const match = line.match(/players online:\s*(.*)$/);
  if (!match) return null;
  const tail = match[1].trim();
  if (!tail) return [];
  return tail
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * Extract the player name from a join/leave line, or null. Accepts both bare
 * lines (test fakes) and real server output that carries the standard prefix
 * ("[12:00:01] [Server thread/INFO]: Steve joined the game").
 */
export function parsePlayerName(line: string): string | null {
  const match = line.match(/^([A-Za-z0-9_]{1,16}) (?:joined the game|left the game)/);
  if (match) return match[1];
  const prefixed = line.match(
    /^\[\d{2}:\d{2}:\d{2}\] \[[^\]]+\/(?:INFO|WARN|ERROR)\]:\s*([A-Za-z0-9_]{1,16}) (?:joined the game|left the game)/,
  );
  return prefixed ? prefixed[1] : null;
}

/** Detect a player join/leave line; returns +1/-1 delta or null. */
export function parsePlayerDelta(line: string): number | null {
  if (/joined the game/.test(line)) return 1;
  if (/left the game/.test(line)) return -1;
  return null;
}

/** Extract the player name from a Bedrock connect/disconnect line, or null. */
export function parseBedrockPlayerName(line: string): string | null {
  const match = line.match(/(?:Player connected|Player disconnected):\s*([^,\s]+)/);
  return match ? match[1] : null;
}

/** Detect a Bedrock player connect/disconnect line; returns +1/-1 or null. */
export function parseBedrockPlayerDelta(line: string): number | null {
  if (/Player connected:/.test(line)) return 1;
  if (/Player disconnected:/.test(line)) return -1;
  return null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function classifyLine(line: string): LogLine['level'] {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('exception') || lower.includes('fatal')) {
    return 'error';
  }
  if (lower.includes('warn')) return 'warn';
  return 'info';
}

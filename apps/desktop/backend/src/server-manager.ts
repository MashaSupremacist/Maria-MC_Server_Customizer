import type {
  LogLine,
  ServerState,
  ServerStatus,
  StartServerError,
  WsServerEvent,
} from '@msc/shared-types';
import type { DatabaseResult } from './db';
import { findServerJar, ProcessManager, type ServerConfig } from './process-manager';

export type WsBroadcast = (event: WsServerEvent) => void;

/** Validates a javaPath against a Minecraft version before launch. */
export type JavaValidator = (
  minecraftVersion: string | null,
  javaPath: string,
) => Promise<StartServerError | null>;

/** Resolves a java.exe when a server record has none configured. */
export type JavaPathResolver = () => Promise<string | null>;

/**
 * Bridges the ProcessManager (which manages the single running process) to
 * server records and WebSocket clients. The renderer subscribes via /ws and
 * receives state + log events for the server it manages.
 */
export class ServerManagerService {
  private readonly db: DatabaseResult;
  private readonly broadcast: WsBroadcast;
  private readonly processManager: ProcessManager;
  private readonly validateJava: JavaValidator | null;
  private readonly resolveJavaPath: JavaPathResolver | null;

  constructor(
    db: DatabaseResult,
    broadcast: WsBroadcast,
    validateJava: JavaValidator | null = null,
    resolveJavaPath: JavaPathResolver | null = null,
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.validateJava = validateJava;
    this.resolveJavaPath = resolveJavaPath;
    this.processManager = new ProcessManager({
      onState: (serverId, state, exitCode) => {
        this.broadcast({
          type: 'server:state',
          serverId,
          state,
          exitCode,
        } satisfies WsServerEvent);
      },
      onLog: (serverId, log) => {
        this.broadcast({ type: 'server:log', serverId, log } satisfies WsServerEvent);
      },
      onStats: (serverId, stats) => {
        this.broadcast({ type: 'server:stats', serverId, stats } satisfies WsServerEvent);
      },
    });
  }

  status(serverId: string): ServerStatus {
    return this.processManager.getStatus(serverId);
  }

  runningServerId(): string | null {
    return this.processManager.runningServerId;
  }

  isRunning(serverId: string): boolean {
    return this.processManager.runningServerId === serverId;
  }

  async start(serverId: string): Promise<StartServerError | null> {
    const record = this.db.getServer(serverId);
    if (!record) {
      return { code: 'not-found', message: `No server record with id ${serverId}` };
    }
    if (record.edition !== 'bedrock') {
      if (!record.javaPath) {
        if (this.resolveJavaPath) {
          const resolved = await this.resolveJavaPath();
          if (resolved) {
            this.db.updateServer(serverId, { javaPath: resolved });
            record.javaPath = resolved;
          }
        }
        if (!record.javaPath) {
          return { code: 'missing-java', message: 'No Java executable configured for this server' };
        }
      }
    }

    // One server at a time: refuse to start if another instance is running.
    const runningId = this.processManager.runningServerId;
    if (runningId && runningId !== serverId) {
      return {
        code: 'another-server-running',
        message: `"${runningId}" is already running. Stop it first.`,
        runningServerId: runningId,
      };
    }

    // Validate Java compatibility before launching (Bedrock needs no Java).
    if (record.edition !== 'bedrock' && this.validateJava) {
      const validationError = await this.validateJava(record.version, record.javaPath as string);
      if (validationError) return validationError;
    }

    const config: ServerConfig = {
      serverId: record.id,
      name: record.name,
      folderPath: record.folderPath,
      javaPath: record.edition === 'bedrock' ? '' : (record.javaPath as string),
      memoryMb: record.memoryMb,
      jvmArgs: record.jvmArgs,
      port: record.port,
      flavor: record.serverType as ServerConfig['flavor'],
      edition: record.edition,
    };
    return this.processManager.start(config);
  }

  stop(): void {
    this.processManager.stop();
  }

  forceKill(): void {
    this.processManager.forceKill();
  }

  async restart(serverId: string): Promise<StartServerError | null> {
    const runningId = this.processManager.runningServerId;
    if (runningId && runningId !== serverId) {
      return {
        code: 'another-server-running',
        message: `"${runningId}" is already running. Stop it first.`,
        runningServerId: runningId,
      };
    }
    if (runningId === serverId) {
      this.processManager.stop();
      void this.startAfterStop(serverId);
      return null;
    }
    return this.start(serverId);
  }

  private async startAfterStop(serverId: string): Promise<void> {
    // Wait for the process manager to fully clear before starting again.
    await waitUntil(() => this.processManager.runningServerId === null);
    await this.start(serverId);
  }

  sendCommand(serverId: string, command: string): boolean {
    const runningId = this.processManager.runningServerId;
    if (runningId !== serverId) return false;
    return this.processManager.sendCommand(command);
  }

  getLogs(serverId: string): LogLine[] {
    return this.processManager.getStatus(serverId).logs;
  }

  /** Ensure the managed server is stopped when the backend shuts down. */
  shutdown(): void {
    this.processManager.shutdown();
  }
}

/** Poll a predicate on an interval until it returns true. */
function waitUntil(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const poll = (): void => {
      if (predicate()) {
        resolve();
      } else {
        setTimeout(poll, 250);
      }
    };
    poll();
  });
}

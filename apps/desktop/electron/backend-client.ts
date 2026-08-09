import {
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { BackendInfo } from '@msc/shared-types';

export interface SpawnedBackend {
  child: ChildProcess;
  token: string;
}

export interface BackendClientOptions {
  spawnBackend: () => SpawnedBackend;
  fetchImpl?: typeof fetch;
  terminateTree?: (child: ChildProcess, force: boolean) => Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
  startupTimeoutMs?: number;
  startupReapTimeoutMs?: number;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  shutdownRequestTimeoutMs?: number;
  shutdownGraceMs?: number;
  shutdownReapMs?: number;
  maxStartupAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  onStderr?: (text: string) => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REAP_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_MAX_STARTUP_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 1_000;

/** Owns the local backend child and its authenticated HTTP connection. */
export class BackendClient {
  private readonly fetchImpl: typeof fetch;
  private readonly terminateTree: (child: ChildProcess, force: boolean) => Promise<void>;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly startupTimeoutMs: number;
  private readonly startupReapTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly shutdownRequestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly shutdownReapMs: number;
  private readonly maxStartupAttempts: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private child: ChildProcess | null = null;
  private info: BackendInfo | null = null;
  private startPromise: Promise<BackendInfo> | null = null;
  private generation = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: BackendClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.terminateTree = options.terminateTree ?? ((child, force) => terminateProcessTree(child, force));
    this.sleep = options.sleep ?? delay;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.startupReapTimeoutMs = options.startupReapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.shutdownRequestTimeoutMs =
      options.shutdownRequestTimeoutMs ?? DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.shutdownReapMs = options.shutdownReapMs ?? DEFAULT_REAP_TIMEOUT_MS;
    this.maxStartupAttempts = options.maxStartupAttempts ?? DEFAULT_MAX_STARTUP_ATTEMPTS;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  ensureBackend(): Promise<BackendInfo> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Backend is shutting down'));
    }
    if (this.startPromise) return this.startPromise;

    const operation = this.ensureWithRetry();
    this.startPromise = operation;
    const clear = (): void => {
      if (this.startPromise === operation) this.startPromise = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  async fetch(method: string, route: string, body?: unknown): Promise<unknown> {
    const info = await this.ensureBackend();
    return this.request(info, method, route, body, this.requestTimeoutMs);
  }

  /** Stop the backend gracefully, then force-reap its full tree if needed. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const operation = this.performShutdown();
    this.shutdownPromise = operation;
    return operation;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;

    const child = this.child;
    const info = this.info;
    const generation = this.generation;
    if (!child) {
      this.info = null;
      this.startPromise = null;
      return;
    }

    if (info) {
      try {
        await this.request(
          info,
          'POST',
          '/shutdown',
          undefined,
          this.shutdownRequestTimeoutMs,
        );
      } catch {
        // The backend may close its listener before the response reaches us.
      }
    }

    if (!(await waitForChildExit(child, this.shutdownGraceMs))) {
      await this.terminateTree(child, true);
      await waitForChildExit(child, this.shutdownReapMs);
    }
    this.clearIfCurrent(child, generation);
    this.startPromise = null;
  }

  private async ensureWithRetry(): Promise<BackendInfo> {
    const cachedInfo = this.info;
    const cachedChild = this.child;
    if (cachedInfo && cachedChild) {
      if (await this.isHealthy(cachedInfo)) return cachedInfo;
      const cachedGeneration = this.generation;
      this.clearIfCurrent(cachedChild, cachedGeneration);
      await this.terminateTree(cachedChild, true);
      await waitForChildExit(cachedChild, this.startupReapTimeoutMs);
    } else if (cachedInfo || cachedChild) {
      this.info = null;
      this.child = null;
    }

    let lastError: unknown = new Error('Backend unavailable');
    for (let attempt = 0; attempt < this.maxStartupAttempts; attempt += 1) {
      if (this.shuttingDown) throw new Error('Backend is shutting down');
      try {
        return await this.startOnce();
      } catch (error) {
        lastError = error;
        if (attempt + 1 < this.maxStartupAttempts) {
          const retryDelay = Math.min(
            this.maxRetryDelayMs,
            this.initialRetryDelayMs * 2 ** attempt,
          );
          await this.sleep(retryDelay);
        }
      }
    }
    throw lastError;
  }

  private startOnce(): Promise<BackendInfo> {
    let spawned: SpawnedBackend;
    try {
      spawned = this.options.spawnBackend();
    } catch (error) {
      return Promise.reject(error);
    }

    const { child, token } = spawned;
    const generation = ++this.generation;
    this.child = child;
    this.info = null;

    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.options.onStderr?.(String(chunk));
    });

    return new Promise<BackendInfo>((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let lineBuffer = '';
      let settled = false;
      let completing = false;
      let startupTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanupReadiness = (): void => {
        if (startupTimer) clearTimeout(startupTimer);
        child.stdout?.off('data', onStdout);
        child.stdout?.off('end', onStdoutEnd);
      };

      const fail = (error: Error, terminate: boolean): void => {
        if (settled || completing) return;
        completing = true;
        cleanupReadiness();
        this.clearIfCurrent(child, generation);
        void (async () => {
          if (terminate) {
            await this.terminateTree(child, true);
            await waitForChildExit(child, this.startupReapTimeoutMs);
          }
          settled = true;
          completing = false;
          reject(error);
        })();
      };

      const processLine = (line: string): void => {
        if (settled || completing) return;
        const match = line.trim().match(/^MSC_READY (\d+)$/);
        if (!match) return;
        if (this.shuttingDown || this.child !== child || this.generation !== generation) {
          fail(new Error('Backend start was superseded'), true);
          return;
        }
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          fail(new Error('Backend reported an invalid port'), true);
          return;
        }
        const backendInfo = { url: `http://127.0.0.1:${port}`, token };
        settled = true;
        cleanupReadiness();
        this.info = backendInfo;
        resolve(backendInfo);
      };

      const consumeLines = (text: string, flush = false): void => {
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
        if (flush && lineBuffer.length > 0) {
          const finalLine = lineBuffer;
          lineBuffer = '';
          processLine(finalLine);
        }
      };

      const onStdout = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        consumeLines(decoder.write(buffer));
      };
      const onStdoutEnd = (): void => consumeLines(decoder.end(), true);
      const onError = (error: Error): void => {
        if (!settled) {
          fail(error, true);
        } else {
          this.clearIfCurrent(child, generation);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (!settled) {
          fail(
            new Error(`Backend exited before readiness (code ${String(code)}, signal ${String(signal)})`),
            false,
          );
        } else {
          this.clearIfCurrent(child, generation);
        }
      };

      child.stdout?.on('data', onStdout);
      child.stdout?.on('end', onStdoutEnd);
      child.on('error', onError);
      child.on('exit', onExit);

      startupTimer = setTimeout(() => {
        fail(new Error('Backend did not signal readiness in time'), true);
      }, this.startupTimeoutMs);
      startupTimer.unref();
    });
  }

  private clearIfCurrent(child: ChildProcess, generation: number): void {
    if (this.child !== child || this.generation !== generation) return;
    this.child = null;
    this.info = null;
  }

  private async isHealthy(info: BackendInfo): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${info.url}/health`, {
        method: 'GET',
        headers: { 'x-msc-token': info.token },
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async request(
    info: BackendInfo,
    method: string,
    route: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'x-msc-token': info.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(`${info.url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Backend ${method} ${route} failed (${response.status}): ${text}`);
    }
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) as unknown : null;
  }
}

export interface ProcessTreeOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}

/** Terminate a child, using taskkill so Windows descendants are included. */
export async function terminateProcessTree(
  child: ChildProcess,
  force: boolean,
  options: ProcessTreeOptions = {},
): Promise<void> {
  if (hasExited(child)) return;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && child.pid) {
    const spawnProcess = options.spawnProcess ?? spawn;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        const args = ['/pid', String(child.pid), '/T'];
        if (force) args.push('/F');
        const killer = spawnProcess('taskkill', args, {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => {
          try {
            child.kill(force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            // The child already exited.
          }
          finish();
        });
        killer.once('exit', finish);
      } catch {
        try {
          child.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // The child already exited.
        }
        finish();
      }
    });
    return;
  }
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The child already exited.
  }
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    timer.unref();
    child.once('exit', onExit);
    child.once('error', onExit);
    if (hasExited(child)) finish(true);
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, delayMs));
    timer.unref();
  });
}

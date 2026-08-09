import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

export type DownloadDigestAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface DownloadDigest {
  algorithm: DownloadDigestAlgorithm;
  /** Lower- or upper-case hexadecimal digest. */
  value: string;
}

export type DownloadErrorCode =
  | 'network'
  | 'http'
  | 'connect-timeout'
  | 'idle-timeout'
  | 'overall-timeout'
  | 'cancelled'
  | 'size'
  | 'checksum'
  | 'disk';

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly statusCode?: number;
  readonly expected?: string | number;
  readonly actual?: string | number;

  constructor(
    code: DownloadErrorCode,
    message: string,
    options: {
      cause?: unknown;
      statusCode?: number;
      expected?: string | number;
      actual?: string | number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DownloadError';
    this.code = code;
    this.statusCode = options.statusCode;
    this.expected = options.expected;
    this.actual = options.actual;
  }
}

export interface DownloadTimeouts {
  /** Time allowed to receive response headers. */
  connectMs: number;
  /** Maximum pause between response body chunks. */
  idleMs: number;
  /** Maximum time for the complete download and commit. */
  overallMs: number;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface DownloadRequest {
  url: string | URL;
  destination: string;
  expectedBytes?: number;
  maximumBytes?: number;
  expectedDigest?: DownloadDigest;
  signal?: AbortSignal;
  timeouts?: Partial<DownloadTimeouts>;
  onProgress?: (progress: DownloadProgress) => void;
  headers?: HeadersInit;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  digest?: DownloadDigest;
}

type TimerHandle = unknown;

export interface DownloadTimerApi {
  setTimeout(callback: () => void, milliseconds: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface DownloadServiceOptions {
  fetchImpl?: typeof fetch;
  timers?: DownloadTimerApi;
  randomId?: () => string;
}

const DEFAULT_TIMEOUTS: DownloadTimeouts = {
  connectMs: 30_000,
  idleMs: 30_000,
  overallMs: 30 * 60_000,
};

const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024 * 1024;

/** Stream downloads to verified temporary files before atomically committing. */
export class DownloadService {
  private readonly fetchImpl: typeof fetch;
  private readonly timers: DownloadTimerApi;
  private readonly randomId: () => string;

  constructor(options: DownloadServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timers = options.timers ?? {
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.randomId = options.randomId ?? crypto.randomUUID;
  }

  async download(request: DownloadRequest): Promise<DownloadResult> {
    validateRequest(request);
    const timeouts = { ...DEFAULT_TIMEOUTS, ...request.timeouts };
    validateTimeouts(timeouts);

    const maximumBytes = request.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    const partPath = `${request.destination}.${this.randomId()}.part`;
    const controller = new AbortController();
    let terminalError: DownloadError | null = null;
    let connectTimer: TimerHandle | null = null;
    let idleTimer: TimerHandle | null = null;
    let overallTimer: TimerHandle | null = null;

    const fail = (error: DownloadError): void => {
      if (terminalError) return;
      terminalError = error;
      controller.abort(error);
    };
    const callerCanceled = (): void => {
      fail(new DownloadError('cancelled', 'Download canceled by caller'));
    };
    if (request.signal?.aborted) callerCanceled();
    else request.signal?.addEventListener('abort', callerCanceled, { once: true });

    const resetIdleTimer = (): void => {
      if (idleTimer !== null) this.timers.clearTimeout(idleTimer);
      idleTimer = this.timers.setTimeout(() => {
        fail(new DownloadError('idle-timeout', 'Download stalled while reading response data'));
      }, timeouts.idleMs);
    };

    try {
      if (terminalError) throw terminalError;
      overallTimer = this.timers.setTimeout(() => {
        fail(new DownloadError('overall-timeout', 'Download exceeded the overall time limit'));
      }, timeouts.overallMs);
      connectTimer = this.timers.setTimeout(() => {
        fail(new DownloadError('connect-timeout', 'Download timed out waiting for response headers'));
      }, timeouts.connectMs);

      let response: Response;
      try {
        response = await this.fetchImpl(request.url, {
          headers: request.headers,
          signal: controller.signal,
        });
      } catch (error) {
        throw terminalError ?? new DownloadError('network', 'Download request failed', { cause: error });
      } finally {
        if (connectTimer !== null) {
          this.timers.clearTimeout(connectTimer);
          connectTimer = null;
        }
      }
      if (terminalError) throw terminalError;

      if (!response.ok) {
        throw new DownloadError('http', `Download failed with HTTP ${response.status}`, {
          statusCode: response.status,
        });
      }
      if (!response.body) {
        throw new DownloadError('network', 'Download response had no body');
      }

      const declaredBytes = parseContentLength(response.headers.get('content-length'));
      if (declaredBytes !== null && declaredBytes > maximumBytes) {
        throw sizeError('Download exceeds the maximum allowed size', maximumBytes, declaredBytes);
      }
      if (
        declaredBytes !== null &&
        request.expectedBytes !== undefined &&
        declaredBytes !== request.expectedBytes
      ) {
        throw sizeError('Download size does not match the expected size', request.expectedBytes, declaredBytes);
      }

      const hash = request.expectedDigest
        ? crypto.createHash(request.expectedDigest.algorithm)
        : null;
      let receivedBytes = 0;
      let destinationFailure: unknown;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          resetIdleTimer();
          receivedBytes += chunk.length;
          if (receivedBytes > maximumBytes) {
            callback(sizeError('Download exceeds the maximum allowed size', maximumBytes, receivedBytes));
            return;
          }
          if (request.expectedBytes !== undefined && receivedBytes > request.expectedBytes) {
            callback(sizeError('Download exceeds the expected size', request.expectedBytes, receivedBytes));
            return;
          }
          hash?.update(chunk);
          emitProgress(request.onProgress, receivedBytes, request.expectedBytes ?? declaredBytes);
          callback(null, chunk);
        },
      });
      const destination = fs.createWriteStream(partPath, { flags: 'wx' });
      destination.on('error', (error) => {
        destinationFailure = error;
      });

      resetIdleTimer();
      let source: Readable | null = null;
      const abortSource = (): void => {
        const reason = controller.signal.reason;
        source?.destroy(reason instanceof Error ? reason : new Error('Download aborted'));
      };
      try {
        source = Readable.fromWeb(response.body as never);
        if (controller.signal.aborted) abortSource();
        else controller.signal.addEventListener('abort', abortSource, { once: true });
        await pipeline(source, meter, destination);
        await finished(destination);
      } catch (error) {
        if (terminalError) throw terminalError;
        if (error instanceof DownloadError) throw error;
        if (destinationFailure) {
          throw new DownloadError('disk', 'Failed to write downloaded file', {
            cause: destinationFailure,
          });
        }
        throw new DownloadError('network', 'Download stream failed', { cause: error });
      } finally {
        controller.signal.removeEventListener('abort', abortSource);
        if (idleTimer !== null) {
          this.timers.clearTimeout(idleTimer);
          idleTimer = null;
        }
      }

      if (request.expectedBytes !== undefined && receivedBytes !== request.expectedBytes) {
        throw sizeError('Download size does not match the expected size', request.expectedBytes, receivedBytes);
      }
      if (terminalError) throw terminalError;

      let actualDigest: DownloadDigest | undefined;
      if (hash && request.expectedDigest) {
        const actual = hash.digest('hex');
        const expected = request.expectedDigest.value.trim().toLowerCase();
        if (actual !== expected) {
          throw new DownloadError('checksum', 'Download checksum does not match', {
            expected,
            actual,
          });
        }
        actualDigest = { algorithm: request.expectedDigest.algorithm, value: actual };
      }

      if (request.signal?.aborted) throw new DownloadError('cancelled', 'Download canceled by caller');
      try {
        await fs.promises.rename(partPath, request.destination);
      } catch (error) {
        throw new DownloadError('disk', 'Failed to commit downloaded file', { cause: error });
      }
      return { path: request.destination, bytes: receivedBytes, digest: actualDigest };
    } finally {
      if (connectTimer !== null) this.timers.clearTimeout(connectTimer);
      if (idleTimer !== null) this.timers.clearTimeout(idleTimer);
      if (overallTimer !== null) this.timers.clearTimeout(overallTimer);
      request.signal?.removeEventListener('abort', callerCanceled);
      await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
    }
  }
}

function validateRequest(request: DownloadRequest): void {
  if (!request.destination || path.basename(request.destination) === '') {
    throw new TypeError('A download destination is required');
  }
  validateByteCount('expectedBytes', request.expectedBytes);
  validateByteCount('maximumBytes', request.maximumBytes);
  if (
    request.expectedBytes !== undefined &&
    request.maximumBytes !== undefined &&
    request.expectedBytes > request.maximumBytes
  ) {
    throw new TypeError('expectedBytes cannot exceed maximumBytes');
  }
  if (request.expectedDigest && !/^[a-f\d]+$/i.test(request.expectedDigest.value.trim())) {
    throw new TypeError('Expected digest must be hexadecimal');
  }
}

function validateByteCount(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function validateTimeouts(timeouts: DownloadTimeouts): void {
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be greater than zero`);
    }
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sizeError(message: string, expected: number, actual: number): DownloadError {
  return new DownloadError('size', message, { expected, actual });
}

function emitProgress(
  callback: DownloadRequest['onProgress'],
  receivedBytes: number,
  totalBytes: number | null,
): void {
  if (!callback) return;
  const percent = totalBytes && totalBytes > 0
    ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
    : null;
  try {
    callback({ receivedBytes, totalBytes, percent });
  } catch {
    // Progress reporting must not corrupt an otherwise valid download.
  }
}

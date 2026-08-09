export type MetadataFetchErrorCode = 'timeout' | 'network' | 'too-large';

export class MetadataFetchError extends Error {
  constructor(
    public readonly code: MetadataFetchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MetadataFetchError';
  }
}

export interface MetadataFetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumBytes?: number;
}

export interface MetadataResponse {
  ok: boolean;
  status: number;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_BYTES = 4 * 1024 * 1024;

/** Fetch a small metadata document with an overall deadline and size bound. */
export async function fetchMetadata(
  url: string,
  options: MetadataFetchOptions = {},
): Promise<MetadataResponse> {
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (externalSignal?.aborted) abortFromCaller();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Metadata request timed out', 'TimeoutError'));
  }, Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  try {
    const response = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
    const maximumBytes = Math.max(1, options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new MetadataFetchError(
        'too-large',
        `Metadata response exceeds ${maximumBytes} bytes`,
      );
    }

    if (!response.body) return { ok: response.ok, status: response.status, text: '' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MetadataFetchError(
          'too-large',
          `Metadata response exceeds ${maximumBytes} bytes`,
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: response.ok,
      status: response.status,
      text: new TextDecoder().decode(bytes),
    };
  } catch (error) {
    if (error instanceof MetadataFetchError) throw error;
    if (externalSignal?.aborted) {
      throw new DOMException('Metadata request canceled', 'AbortError');
    }
    if (timedOut) {
      throw new MetadataFetchError('timeout', `Metadata request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, { cause: error });
    }
    throw new MetadataFetchError(
      'network',
      error instanceof Error ? error.message : 'Metadata request failed',
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function fetchMetadataJson<T>(
  url: string,
  options: MetadataFetchOptions = {},
): Promise<
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; value: undefined }
> {
  const response = await fetchMetadata(url, options);
  if (!response.ok) return { ok: false, status: response.status, value: undefined };
  try {
    return { ok: true, status: response.status, value: JSON.parse(response.text) as T };
  } catch (error) {
    throw new MetadataFetchError('network', 'Metadata response is not valid JSON', { cause: error });
  }
}

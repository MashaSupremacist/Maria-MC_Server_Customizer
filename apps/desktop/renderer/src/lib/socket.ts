import type { BackendInfo, WsServerEvent } from '@msc/shared-types';

export type WsConnectionState = 'connecting' | 'open' | 'closed';
export type WsEventHandler = (event: WsServerEvent) => void;

export interface WsClient {
  readonly state: WsConnectionState;
  close: () => void;
  onEvent: (handler: WsEventHandler) => () => void;
}

interface SocketTransport {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  close: () => void;
}

type TimerHandle = unknown;

export interface ReconnectingWebSocketOptions {
  getBackendInfo: () => Promise<BackendInfo>;
  createSocket: (url: string) => SocketTransport;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelTimer?: (handle: TimerHandle) => void;
  random?: () => number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  jitterRatio?: number;
}

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

/**
 * A durable event client. Subscriptions outlive individual WebSocket
 * transports, so reconnecting does not require components to resubscribe.
 */
export class ReconnectingWebSocketClient implements WsClient {
  private readonly handlers = new Set<WsEventHandler>();
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimer: (handle: TimerHandle) => void;
  private readonly random: () => number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly jitterRatio: number;
  private connectionState: WsConnectionState = 'closed';
  private socket: SocketTransport | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private connecting = false;
  private stopped = true;
  private attempt = 0;
  private generation = 0;

  constructor(private readonly options: ReconnectingWebSocketOptions) {
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.cancelTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  }

  get state(): WsConnectionState {
    return this.connectionState;
  }

  start(): void {
    this.stopped = false;
    if (this.socket || this.connecting || this.reconnectTimer !== null) return;
    void this.openSocket();
  }

  close(): void {
    this.stopped = true;
    this.generation += 1;
    this.connectionState = 'closed';
    this.connecting = false;
    this.attempt = 0;
    if (this.reconnectTimer !== null) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  onEvent(handler: WsEventHandler): () => void {
    this.handlers.add(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.handlers.delete(handler);
    };
  }

  private async openSocket(): Promise<void> {
    if (this.stopped || this.socket || this.connecting) return;
    this.connecting = true;
    this.connectionState = 'connecting';
    const generation = this.generation;

    try {
      // Fetch on every attempt: getBackendInfo can restart the backend and
      // return a new port/token after a crash.
      const info = await this.options.getBackendInfo();
      if (this.stopped || generation !== this.generation) return;

      const url = new URL(info.url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/ws';
      url.searchParams.set('token', info.token);

      const socket = this.options.createSocket(url.toString());
      if (this.stopped || generation !== this.generation) {
        socket.close();
        return;
      }

      this.socket = socket;
      const disconnect = (): void => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.connectionState = 'closed';
        this.scheduleReconnect();
      };
      socket.onopen = () => {
        if (this.socket !== socket || this.stopped) return;
        this.connectionState = 'open';
        this.attempt = 0;
      };
      socket.onerror = () => {
        try {
          socket.close();
        } finally {
          disconnect();
        }
      };
      socket.onclose = disconnect;
      socket.onmessage = (message) => {
        if (this.socket !== socket) return;
        let event: WsServerEvent;
        try {
          event = JSON.parse(String(message.data)) as WsServerEvent;
        } catch {
          return;
        }
        for (const handler of this.handlers) {
          try {
            handler(event);
          } catch {
            // One consumer must not block delivery to the others.
          }
        }
      };
    } catch {
      if (!this.stopped && generation === this.generation) {
        this.connectionState = 'closed';
        this.scheduleReconnect();
      }
    } finally {
      if (generation === this.generation) this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;

    const exponentialDelay = Math.min(
      this.maxReconnectDelayMs,
      this.initialReconnectDelayMs * 2 ** Math.min(this.attempt, 30),
    );
    this.attempt += 1;
    const jitter = exponentialDelay * this.jitterRatio;
    const delay = Math.min(
      this.maxReconnectDelayMs,
      Math.max(0, Math.round(exponentialDelay - jitter + this.random() * jitter * 2)),
    );

    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }
}

let sharedWs: ReconnectingWebSocketClient | null = null;

/** Return the app-wide client, starting its single physical connection. */
export function connectWebSocket(): Promise<WsClient> {
  if (!sharedWs) {
    sharedWs = new ReconnectingWebSocketClient({
      getBackendInfo: () => window.msc.getBackendInfo(),
      createSocket: (url) => new WebSocket(url) as unknown as SocketTransport,
    });
  }
  sharedWs.start();
  return Promise.resolve(sharedWs);
}

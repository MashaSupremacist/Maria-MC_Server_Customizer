import type { WsServerEvent } from '@msc/shared-types';

export type WsConnectionState = 'connecting' | 'open' | 'closed';

export interface WsClient {
  readonly state: WsConnectionState;
  close: () => void;
  onEvent: (handler: (event: WsServerEvent) => void) => void;
}

let sharedWs: WsClient | null = null;
let connecting: Promise<WsClient> | null = null;

/**
 * Connect to the backend WebSocket. The URL + token come from the main
 * process via getBackendInfo; the token authenticates the connection.
 * The connection is shared across the app (server runtime + installs).
 */
export function connectWebSocket(): Promise<WsClient> {
  // Reuse an open connection.
  if (sharedWs) return Promise.resolve(sharedWs);
  // Share a single in-flight connection attempt.
  if (connecting) return connecting;

  connecting = (async (): Promise<WsClient> => {
    const info = await window.msc.getBackendInfo();
    const url = new URL(info.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.searchParams.set('token', info.token);

    return new Promise<WsClient>((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      const handlers: Array<(event: WsServerEvent) => void> = [];
      let settled = false;

      ws.onopen = () => {
        settled = true;
        sharedWs = {
          state: 'open',
          close: () => {
            sharedWs = null;
            ws.close();
          },
          onEvent: (handler) => handlers.push(handler),
        };
        resolve(sharedWs);
      };
      ws.onerror = (event) => {
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket connection failed'));
        }
        void event;
      };
      ws.onclose = () => {
        sharedWs = null;
        // Clear any pending reference so a later call reconnects fresh.
        connecting = null;
      };
      ws.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as WsServerEvent;
          for (const handler of handlers) handler(event);
        } catch {
          // ignore malformed messages
        }
      };
    });
  })();

  void connecting.finally(() => {
    // Clear the in-flight reference once settled so future calls can
    // reconnect if the socket closed.
    setTimeout(() => {
      connecting = null;
    }, 0);
  });
  return connecting;
}

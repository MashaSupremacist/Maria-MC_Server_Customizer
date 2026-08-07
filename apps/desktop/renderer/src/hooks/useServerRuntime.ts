import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLine, ServerState, ServerStats, StartServerError } from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket, type WsClient } from '../lib/socket';

export interface ServerRuntime {
  state: ServerState;
  pid: number | null;
  uptimeSeconds: number;
  exitCode: number | null;
  logs: LogLine[];
  stats: ServerStats;
  address: string | null;
  /** A non-null value surfaces a start/restart rejection. */
  error: string | null;
  /** The structured start error (e.g. incompatible-java) for dialog handling. */
  startError: StartServerError | null;
  clearError: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  forceKill: () => Promise<void>;
  sendCommand: (command: string) => Promise<void>;
}

/**
 * Tracks a server's live status via the WebSocket, keeping logs and state
 * fresh for the selected server id. Returns actions that call the backend.
 */
export function useServerRuntime(serverId: string | null): ServerRuntime {
  const [state, setState] = useState<ServerState>('offline');
  const [pid, setPid] = useState<number | null>(null);
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [startError, setStartError] = useState<StartServerError | null>(null);
  const [stats, setStats] = useState<ServerStats>({
    cpuPercent: 0,
    memoryMb: 0,
    playerCount: null,
    onlinePlayers: [],
  });
  const [address, setAddress] = useState<string | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const serverIdRef = useRef<string | null>(null);
  serverIdRef.current = serverId;

  // Re-pull the full status from the backend. The WebSocket stream is the
  // primary live channel, but a fresh fetch after an action guarantees the
  // UI reflects reality even if a WS event was missed or the socket was not
  // connected when the action happened.
  const refreshStatus = useCallback(async (id: string): Promise<void> => {
    try {
      const status = await api.getServerStatus(id);
      setState(status.state);
      setPid(status.pid);
      setUptimeSeconds(status.uptimeSeconds);
      setExitCode(status.exitCode);
      setLogs(status.logs);
      setStats(status.stats);
      setAddress(status.address);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Establish the WebSocket once and route events to the current server.
  // The connection is shared app-wide; do NOT close it here (other hooks and
  // the Java dialog subscribe to the same socket). StrictMode's double-mount
  // would otherwise close the shared socket right after it opens.
  useEffect(() => {
    let cancelled = false;
    void connectWebSocket()
      .then((ws) => {
        if (cancelled) return;
        wsRef.current = ws;
        ws.onEvent((event) => {
          if (serverIdRef.current === null) return;
          if (event.type === 'server:state' && event.serverId === serverIdRef.current) {
            setState(event.state);
            setExitCode(event.exitCode);
          } else if (event.type === 'server:log' && event.serverId === serverIdRef.current) {
            setLogs((prev) => [...prev.slice(-499), event.log]);
          } else if (event.type === 'server:stats' && event.serverId === serverIdRef.current) {
            setStats(event.stats);
          }
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      wsRef.current = null;
    };
  }, []);

  // Load initial status + logs when the selected server changes.
  useEffect(() => {
    if (!serverId) {
      setState('offline');
      setLogs([]);
      setPid(null);
      setUptimeSeconds(0);
      setExitCode(null);
      setStats({ cpuPercent: 0, memoryMb: 0, playerCount: null, onlinePlayers: [] });
      setAddress(null);
      return;
    }
    void refreshStatus(serverId);
  }, [serverId, refreshStatus]);

  // Poll status every 10s so the dashboard stays accurate even if a
  // WebSocket event is missed.
  useEffect(() => {
    if (!serverId) return;
    const timer = setInterval(() => {
      void refreshStatus(serverId);
    }, 10_000);
    return () => clearInterval(timer);
  }, [serverId, refreshStatus]);

  // Tick uptime while the server is running.
  useEffect(() => {
    if (state !== 'online' && state !== 'starting' && state !== 'stopping') {
      return;
    }
    const timer = setInterval(() => {
      setUptimeSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [state]);

  const run = useCallback(
    async (action: () => Promise<{ error: unknown } | { ok: boolean }>): Promise<void> => {
      if (!serverId) return;
      setError(null);
      setStartError(null);
      try {
        const result = await action();
        if ('error' in result && result.error) {
          const err = result.error as StartServerError;
          setStartError(err);
          setError(err.message ?? String(err));
        }
        // Refresh from the backend after every action so status, uptime,
        // memory, and logs update even if the WebSocket event never arrives.
        if (serverId) {
          await refreshStatus(serverId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [serverId, refreshStatus],
  );

  const clearError = useCallback(() => {
    setError(null);
    setStartError(null);
  }, []);

  const start = useCallback(
    () => run(() => api.startServer(serverId as string)),
    [run, serverId],
  );
  const stop = useCallback(() => run(() => api.stopServer()), [run]);
  const restart = useCallback(
    () => run(() => api.restartServer(serverId as string)),
    [run, serverId],
  );
  const forceKill = useCallback(() => run(() => api.forceKillServer()), [run]);
  const sendCommand = useCallback(
    async (command: string): Promise<void> => {
      if (!serverId) return;
      try {
        await api.sendServerCommand(serverId, command);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [serverId],
  );

  return {
    state,
    pid,
    uptimeSeconds,
    exitCode,
    logs,
    stats,
    address,
    error,
    startError,
    clearError,
    start,
    stop,
    restart,
    forceKill,
    sendCommand,
  };
}

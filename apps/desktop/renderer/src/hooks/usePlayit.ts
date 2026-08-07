import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLine, PlayitLink, PlayitSettings, PlayitState, PlayitStatus } from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket, type WsClient } from '../lib/socket';

export interface PlayitRuntime {
  settings: PlayitSettings | null;
  state: PlayitState;
  pid: number | null;
  uptimeSeconds: number;
  exitCode: number | null;
  logs: LogLine[];
  links: PlayitLink[];
  detectedAddress: string | null;
  error: string | null;
  setPlayitPath: (playitPath: string | null) => Promise<void>;
  setPublicAddress: (address: string | null) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  forceKill: () => Promise<void>;
}

/**
 * Tracks the Playit tunnel process via the shared WebSocket (playit:state and
 * playit:log events), plus persisted settings. Actions call the backend.
 */
export function usePlayit(): PlayitRuntime {
  const [settings, setSettings] = useState<PlayitSettings | null>(null);
  const [state, setState] = useState<PlayitState>('offline');
  const [pid, setPid] = useState<number | null>(null);
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [links, setLinks] = useState<PlayitLink[]>([]);
  const [detectedAddress, setDetectedAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WsClient | null>(null);

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const status: PlayitStatus = await api.getPlayitStatus();
      setState(status.state);
      setPid(status.pid);
      setUptimeSeconds(status.uptimeSeconds);
      setExitCode(status.exitCode);
      setLogs(status.logs);
      setLinks(status.links);
      setDetectedAddress(status.detectedAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Load persisted settings + status once.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getPlayitSettings(), api.getPlayitStatus()])
      .then(([s, status]) => {
        if (cancelled) return;
        setSettings(s);
        setState(status.state);
        setPid(status.pid);
        setUptimeSeconds(status.uptimeSeconds);
        setExitCode(status.exitCode);
        setLogs(status.logs);
        setLinks(status.links);
        setDetectedAddress(status.detectedAddress);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to Playit WebSocket events (shared connection).
  useEffect(() => {
    let cancelled = false;
    void connectWebSocket()
      .then((ws) => {
        if (cancelled) return;
        wsRef.current = ws;
        ws.onEvent((event) => {
          if (event.type === 'playit:state') {
            setState(event.state);
          } else if (event.type === 'playit:log') {
            setLogs((prev) => [...prev.slice(-499), event.log]);
          }
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      wsRef.current = null;
    };
  }, []);

  // Poll status every 10s so the UI stays accurate even if a WS event is missed.
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshStatus();
    }, 10_000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  // Tick uptime while running.
  useEffect(() => {
    if (state !== 'online' && state !== 'starting' && state !== 'stopping') return;
    const timer = setInterval(() => {
      setUptimeSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [state]);

  const setPlayitPath = useCallback(async (playitPath: string | null): Promise<void> => {
    setError(null);
    try {
      const next = await api.updatePlayitSettings({ playitPath });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setPublicAddress = useCallback(async (address: string | null): Promise<void> => {
    setError(null);
    try {
      const next = await api.updatePlayitSettings({ playitPublicAddress: address });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      if (!settings?.playitPath) {
        setError('No Playit executable selected. Choose one first.');
        return;
      }
      const result = await api.startPlayit(settings.playitPath);
      if (result.error) {
        setError(result.error.message);
      }
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [settings, refreshStatus]);

  const stop = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await api.stopPlayit();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshStatus]);

  const forceKill = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await api.forceKillPlayit();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshStatus]);

  return {
    settings,
    state,
    pid,
    uptimeSeconds,
    exitCode,
    logs,
    links,
    detectedAddress,
    error,
    setPlayitPath,
    setPublicAddress,
    start,
    stop,
    forceKill,
  };
}

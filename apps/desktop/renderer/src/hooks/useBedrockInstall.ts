import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BedrockVersion,
  InstallBedrockRequest,
  InstallProgress,
  ServerRecord,
} from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket } from '../lib/socket';

export type BedrockInstallPhase =
  | { phase: 'idle' }
  | { phase: 'installing'; installId: string; progress: InstallProgress };

export interface BedrockInstallController {
  install: BedrockInstallPhase;
  error: string | null;
  versions: BedrockVersion[];
  versionsError: string | null;
  start: (request: Omit<InstallBedrockRequest, 'acceptEula'> & { acceptEula: boolean }) => Promise<void>;
  cancel: () => Promise<void>;
  clearError: () => void;
}

/**
 * Holds the Bedrock server installation state at the App level so switching
 * tabs does not cancel or reset an in-progress installation.
 */
export function useBedrockInstall(onCreated: (server: ServerRecord) => void): BedrockInstallController {
  const [install, setInstall] = useState<BedrockInstallPhase>({ phase: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<BedrockVersion[]>([]);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const installRef = useRef(install);
  installRef.current = install;

  // Load the Bedrock version list once.
  useEffect(() => {
    let cancelled = false;
    api
      .getBedrockVersions()
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setVersionsError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to install:progress events (single subscription, shared socket).
  useEffect(() => {
    let cancelled = false;
    void connectWebSocket().then((ws) => {
      if (cancelled) return;
      ws.onEvent((event) => {
        if (event.type !== 'install:progress') return;
        setInstall((prev) => {
          if (prev.phase !== 'installing' || prev.installId !== event.installId) {
            return prev;
          }
          const progress = event.progress;
          if (progress.status === 'complete' && progress.serverId) {
            void api.listServers().then((servers) => {
              const created = servers.find((s) => s.id === progress.serverId);
              if (created) onCreatedRef.current(created);
            });
            return { phase: 'idle' };
          }
          if (progress.status === 'failed' || progress.status === 'canceled') {
            setError(progress.message);
            return { phase: 'idle' };
          }
          return { phase: 'installing', installId: event.installId, progress };
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(
    async (request: Omit<InstallBedrockRequest, 'acceptEula'> & { acceptEula: boolean }): Promise<void> => {
      setError(null);
      try {
        const result = await api.installBedrockServer(request);
        setInstall({
          phase: 'installing',
          installId: result.installId,
          progress: {
            status: 'downloading',
            percent: 0,
            message: 'Starting installation…',
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const prev = installRef.current;
    if (prev.phase !== 'installing') return;
    setInstall({ phase: 'idle' });
    try {
      await api.cancelBedrockInstall(prev.installId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { install, error, versions, versionsError, start, cancel, clearError };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InstallProgress,
  InstallServerRequest,
  ServerFlavor,
  ServerRecord,
  ServerTypeOption,
} from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket } from '../lib/socket';

export type InstallPhase =
  | { phase: 'idle' }
  | { phase: 'installing'; installId: string; progress: InstallProgress };

export interface InstallController {
  install: InstallPhase;
  error: string | null;
  serverTypes: ServerTypeOption[];
  start: (request: Omit<InstallServerRequest, 'acceptEula'> & { acceptEula: boolean }) => Promise<void>;
  cancel: () => Promise<void>;
  clearError: () => void;
}

const ACTIVE_INSTALL_KEY = 'msc.active-java-install';

function recoverInstall(): InstallPhase {
  const installId = window.sessionStorage.getItem(ACTIVE_INSTALL_KEY);
  return installId
    ? { phase: 'installing', installId, progress: { status: 'downloading', percent: null, message: 'Recovering installation status…' } }
    : { phase: 'idle' };
}

/**
 * Holds the server installation state at the App level so switching tabs does
 * not cancel or reset an in-progress installation. Supports all flavors
 * (Vanilla / Fabric / Forge / Paper) via the generic installer.
 */
export function useVanillaInstall(onCreated: (server: ServerRecord) => void): InstallController {
  const [install, setInstall] = useState<InstallPhase>(recoverInstall);
  const [error, setError] = useState<string | null>(null);
  const [serverTypes, setServerTypes] = useState<ServerTypeOption[]>([]);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const installRef = useRef(install);
  installRef.current = install;

  // Load the selectable server types once.
  useEffect(() => {
    let cancelled = false;
    api
      .listServerTypes()
      .then((types) => {
        if (!cancelled) setServerTypes(types);
      })
      .catch(() => {
        // types are optional for the form; defaults apply
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to install:progress events (single subscription, shared socket).
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void connectWebSocket().then((ws) => {
      if (cancelled) return;
      unsubscribe = ws.onEvent((event) => {
        if (event.type !== 'install:progress') return;
        setInstall((prev) => {
          if (prev.phase !== 'installing' || prev.installId !== event.installId) {
            return prev;
          }
          const progress = event.progress;
          if (progress.status === 'complete' && progress.serverId) {
            window.sessionStorage.removeItem(ACTIVE_INSTALL_KEY);
            // Record is already persisted; refresh the server list.
            void api.listServers().then((servers) => {
              const created = servers.find((s) => s.id === progress.serverId);
              if (created) onCreatedRef.current(created);
            });
            return { phase: 'idle' };
          }
          if (progress.status === 'failed' || progress.status === 'canceled') {
            window.sessionStorage.removeItem(ACTIVE_INSTALL_KEY);
            setError(progress.message);
            return { phase: 'idle' };
          }
          return { phase: 'installing', installId: event.installId, progress };
        });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const activeInstallId = install.phase === 'installing' ? install.installId : null;
  useEffect(() => {
    if (!activeInstallId) return;
    let stopped = false;
    const reconcile = async (): Promise<void> => {
      try {
        const status = await api.getOperationStatus(activeInstallId);
        if (stopped || !status || status.kind !== 'server-install') return;
        const progress: InstallProgress = {
          status: status.status as InstallProgress['status'],
          percent: status.percent,
          message: status.message,
          ...(status.serverId ? { serverId: status.serverId } : {}),
        };
        if (progress.status === 'complete' && progress.serverId) {
          window.sessionStorage.removeItem(ACTIVE_INSTALL_KEY);
          const servers = await api.listServers();
          if (stopped) return;
          const created = servers.find((server) => server.id === progress.serverId);
          if (created) onCreatedRef.current(created);
          setInstall({ phase: 'idle' });
        } else if (progress.status === 'failed' || progress.status === 'canceled') {
          window.sessionStorage.removeItem(ACTIVE_INSTALL_KEY);
          setError(progress.message);
          setInstall({ phase: 'idle' });
        } else {
          setInstall({ phase: 'installing', installId: activeInstallId, progress });
        }
      } catch {
        // WebSocket events remain the primary path; retry transient polling failures.
      }
    };
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), 1_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeInstallId]);

  const start = useCallback(
    async (request: Omit<InstallServerRequest, 'acceptEula'> & { acceptEula: boolean }): Promise<void> => {
      setError(null);
      try {
        const result = await api.installServer(request);
        window.sessionStorage.setItem(ACTIVE_INSTALL_KEY, result.installId);
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
    try {
      const result = await api.cancelInstall(prev.installId);
      if (!result.canceled) setError('The installation is no longer cancellable.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { install, error, serverTypes, start, cancel, clearError };
}

/** The default flavor when none is chosen yet. */
export const DEFAULT_FLAVOR: ServerFlavor = 'vanilla';

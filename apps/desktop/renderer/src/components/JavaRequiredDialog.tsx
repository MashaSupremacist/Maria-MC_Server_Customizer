import { useEffect, useRef, useState } from 'react';
import type {
  JavaDownloadInfo,
  JavaRequirement,
  ServerRecord,
} from '@msc/shared-types';
import { api } from '../lib/api';
import { connectWebSocket } from '../lib/socket';

interface JavaRequiredDialogProps {
  server: ServerRecord;
  requirement: JavaRequirement | null;
  onClose: () => void;
  onJavaInstalled: (javaPath: string) => Promise<void>;
}

type Phase =
  | { phase: 'notice' }
  | { phase: 'downloading'; percent: number | null; message: string }
  | { phase: 'done'; javaPath: string }
  | { phase: 'error'; message: string };

export default function JavaRequiredDialog({
  server,
  requirement,
  onClose,
  onJavaInstalled,
}: JavaRequiredDialogProps): React.JSX.Element {
  const [downloadInfo, setDownloadInfo] = useState<JavaDownloadInfo | null>(null);
  const [phase, setPhase] = useState<Phase>({ phase: 'notice' });
  const javaPollAbortRef = useRef<AbortController | null>(null);
  const javaInstallIdRef = useRef<string | null>(null);

  const requiredJava = requirement?.requiredJava ?? 21;
  const sessionKey = `msc.active-java-runtime-install:${requiredJava}`;

  // Fetch download size for the notice.
  useEffect(() => {
    let cancelled = false;
    api
      .getJavaDownloadInfo(requiredJava)
      .then((info) => {
        if (!cancelled) setDownloadInfo(info);
      })
      .catch(() => {
        // size is optional in the notice
      });
    return () => {
      cancelled = true;
    };
  }, [requiredJava]);

  useEffect(() => {
    return () => javaPollAbortRef.current?.abort();
  }, []);

  const trackInstall = (
    javaInstallId: string,
    abortController: AbortController,
  ): void => {
    javaInstallIdRef.current = javaInstallId;
    void pollForJava(javaInstallId, (progress) => {
      setPhase({
        phase: 'downloading',
        percent: progress.percent,
        message: progress.message,
      });
      return progress.status;
    }, abortController.signal, () => {
      window.sessionStorage.removeItem(sessionKey);
      if (javaInstallIdRef.current === javaInstallId) javaInstallIdRef.current = null;
    }).then((javaPath) => {
      if (!abortController.signal.aborted) setPhase({ phase: 'done', javaPath });
    }).catch((err: unknown) => {
      if (!abortController.signal.aborted) {
        setPhase({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }).finally(() => {
      if (javaPollAbortRef.current === abortController) javaPollAbortRef.current = null;
    });
  };

  // Recover an installation after dialog remount or a renderer/socket reconnect.
  useEffect(() => {
    const javaInstallId = window.sessionStorage.getItem(sessionKey);
    if (!javaInstallId) return;
    const abortController = new AbortController();
    javaPollAbortRef.current?.abort();
    javaPollAbortRef.current = abortController;
    setPhase({ phase: 'downloading', percent: null, message: 'Recovering Java installation…' });
    trackInstall(javaInstallId, abortController);
    return () => abortController.abort();
    // trackInstall deliberately captures this required-major session key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const install = async (): Promise<void> => {
    const abortController = new AbortController();
    javaPollAbortRef.current?.abort();
    javaPollAbortRef.current = abortController;
    setPhase({ phase: 'downloading', percent: 0, message: 'Starting download…' });
    try {
      const { javaInstallId } = await api.installJava({ majorVersion: requiredJava });
      if (abortController.signal.aborted) return;
      window.sessionStorage.setItem(sessionKey, javaInstallId);
      trackInstall(javaInstallId, abortController);
    } catch (err) {
      if (abortController.signal.aborted) return;
      setPhase({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const cancelInstall = async (): Promise<void> => {
    const javaInstallId = javaInstallIdRef.current;
    if (!javaInstallId) return;
    try {
      const result = await api.cancelJavaInstall(javaInstallId);
      if (result.canceled) {
        setPhase({ phase: 'downloading', percent: null, message: 'Canceling installation…' });
      } else {
        setPhase({ phase: 'error', message: 'This Java installation is no longer cancellable.' });
      }
      // Keep the ID until polling observes a terminal state.
    } catch (err) {
      setPhase({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const chooseExisting = async (): Promise<void> => {
    const result = await api.selectJavaExecutable();
    if (result.canceled || !result.path) return;
    await onJavaInstalled(result.path);
    onClose();
  };

  const useInstalled = async (): Promise<void> => {
    if (phase.phase === 'done' && phase.javaPath) {
      await onJavaInstalled(phase.javaPath);
      onClose();
    }
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <h2 className="dialog-title">Java Runtime Required</h2>

        {phase.phase === 'notice' && (
          <>
            <p>
              This Minecraft version requires <strong>{requirement?.requiredLabel ?? `Java ${requiredJava}`}</strong>.
            </p>
            <p className="muted">
              The application can download a private Java runtime inside the
              Minecraft Server Customizer data folder. This will not replace
              your system Java or modify the Windows PATH environment variable.
            </p>
            <div className="dialog-details">
              <div className="dash-row">
                <span className="muted">Download size</span>
                <span>{downloadInfo ? `~${downloadInfo.downloadSizeMb} MB` : '…'}</span>
              </div>
              <div className="dash-row">
                <span className="muted">Install location</span>
                <span className="path-text">{downloadInfo?.installPath ?? '…'}</span>
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => void install()}>
                Install Java
              </button>
              <button type="button" className="btn" onClick={() => void chooseExisting()}>
                Choose Existing Java
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {phase.phase === 'downloading' && (
          <>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${phase.percent ?? 0}%` }}
              />
            </div>
            <p className="muted">{phase.message}</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => void cancelInstall()}>
                Cancel Installation
              </button>
            </div>
          </>
        )}

        {phase.phase === 'done' && (
          <>
            <p>Java runtime installed successfully.</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => void useInstalled()}>
                Use This Java
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {phase.phase === 'error' && (
          <>
            <div className="error-banner">{phase.message}</div>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

async function pollForJava(
  javaInstallId: string,
  onProgress: (progress: {
    status: string;
    percent: number | null;
    message: string;
    javaPath?: string;
  }) => string,
  signal: AbortSignal,
  onTerminal: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval>;
    const cleanup = (): void => {
      clearTimeout(timeout);
      clearInterval(pollTimer);
      unsubscribe?.();
      unsubscribe = null;
      signal.removeEventListener('abort', abort);
    };
    const succeed = (javaPath: string): void => {
      if (done) return;
      done = true;
      onTerminal();
      cleanup();
      resolve(javaPath);
    };
    const fail = (message: string, terminal = false): void => {
      if (done) return;
      done = true;
      if (terminal) onTerminal();
      cleanup();
      reject(new Error(message));
    };
    const abort = (): void => fail('Java installation tracking canceled');
    const timeout = setTimeout(() => {
      fail('Java installation timed out');
    }, 10 * 60 * 1000);

    // Poll the backend status endpoint every second as the reliable channel.
    const reconcile = async (): Promise<void> => {
      if (done) return;
      try {
        const operation = await api.getOperationStatus(javaInstallId);
        if (!operation || operation.kind !== 'java-install') return;
        const status = onProgress(operation);
        if (status === 'complete' && operation.javaPath) {
          succeed(operation.javaPath);
        } else if (operation.state === 'failed' || operation.state === 'canceled') {
          fail(operation.message || 'Java installation failed', true);
        }
      } catch {
        // transient; keep polling
      }
    };
    void reconcile();
    pollTimer = setInterval(() => void reconcile(), 1000);

    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    // Also subscribe to the socket for instant updates.
    void connectWebSocket().then((ws) => {
      if (done) return;
      const handler = (event: import('@msc/shared-types').WsServerEvent): void => {
        if (event.type !== 'java:progress' || event.javaInstallId !== javaInstallId) return;
        const status = onProgress(event.progress);
        if (status === 'complete' && event.progress.javaPath) {
          succeed(event.progress.javaPath);
        } else if (status === 'failed' || status === 'canceled') {
          fail(event.progress.message || 'Java installation failed', true);
        }
      };
      unsubscribe = ws.onEvent(handler);
      if (done) {
        unsubscribe();
        unsubscribe = null;
      }
    });
  });
}

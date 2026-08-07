import { useEffect, useState } from 'react';
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

  const requiredJava = requirement?.requiredJava ?? 21;

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

  const install = async (): Promise<void> => {
    setPhase({ phase: 'downloading', percent: 0, message: 'Starting download…' });
    try {
      const { javaInstallId } = await api.installJava({ majorVersion: requiredJava });
      // Progress arrives over the WebSocket; poll for completion via detect.
      const javaPath = await pollForJava(javaInstallId, (progress) => {
        setPhase({
          phase: 'downloading',
          percent: progress.percent,
          message: progress.message,
        });
        return progress.status;
      });
      setPhase({ phase: 'done', javaPath });
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => {
      done = true;
      reject(new Error('Java installation timed out'));
    }, 10 * 60 * 1000);

    // Poll the backend status endpoint every second as the reliable channel.
    const pollTimer = setInterval(async () => {
      if (done) return;
      try {
        const { progress } = await api.getJavaInstallStatus(javaInstallId);
        if (!progress) return;
        const status = onProgress(progress);
        if (status === 'complete' && progress.javaPath) {
          clearTimeout(timeout);
          clearInterval(pollTimer);
          done = true;
          resolve(progress.javaPath);
        } else if (status === 'failed' || status === 'canceled') {
          clearTimeout(timeout);
          clearInterval(pollTimer);
          done = true;
          reject(new Error(progress.message || 'Java installation failed'));
        }
      } catch {
        // transient; keep polling
      }
    }, 1000);

    // Also subscribe to the socket for instant updates.
    void connectWebSocket().then((ws) => {
      const handler = (event: import('@msc/shared-types').WsServerEvent): void => {
        if (event.type !== 'java:progress' || event.javaInstallId !== javaInstallId) return;
        const status = onProgress(event.progress);
        if (status === 'complete' && event.progress.javaPath) {
          clearTimeout(timeout);
          clearInterval(pollTimer);
          done = true;
          resolve(event.progress.javaPath);
        } else if (status === 'failed' || status === 'canceled') {
          clearTimeout(timeout);
          clearInterval(pollTimer);
          done = true;
          reject(new Error(event.progress.message || 'Java installation failed'));
        }
      };
      ws.onEvent(handler);
    });
  });
}

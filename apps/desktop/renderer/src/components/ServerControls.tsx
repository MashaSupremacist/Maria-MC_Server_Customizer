import { useEffect, useState } from 'react';
import type { JavaRequirement, ServerRecord } from '@msc/shared-types';
import type { ServerRuntime } from '../hooks/useServerRuntime';
import { api } from '../lib/api';
import JavaRequiredDialog from './JavaRequiredDialog';

interface ServerControlsProps {
  server: ServerRecord;
  runtime: ServerRuntime;
  onJavaPathUpdated?: (javaPath: string) => void;
}

const STATE_LABEL: Record<string, string> = {
  offline: 'Offline',
  starting: 'Starting',
  online: 'Online',
  stopping: 'Stopping',
  crashed: 'Crashed',
  updating: 'Updating',
};

export default function ServerControls({
  server,
  runtime,
  onJavaPathUpdated,
}: ServerControlsProps): React.JSX.Element {
  const isBedrock = server.edition === 'bedrock';
  const {
    state,
    pid,
    uptimeSeconds,
    exitCode,
    startError,
    clearError,
    start,
    stop,
    restart,
    forceKill,
    error,
  } = runtime;

  const [javaDialogOpen, setJavaDialogOpen] = useState(false);
  const [requirement, setRequirement] = useState<JavaRequirement | null>(null);

  // When start fails because Java is missing or incompatible, open the
  // Java setup dialog with the correct requirement (Java servers only).
  useEffect(() => {
    if (isBedrock) return;
    if (startError?.code === 'incompatible-java' || startError?.code === 'missing-java') {
      setJavaDialogOpen(true);
      void api
        .getRequiredJava(server.version ?? '', server.javaPath)
        .then(setRequirement)
        .catch(() => setRequirement(null));
    }
  }, [startError, server.version, server.javaPath, isBedrock]);

  const handleJavaInstalled = async (javaPath: string): Promise<void> => {
    await api.updateServer(server.id, { javaPath });
    onJavaPathUpdated?.(javaPath);
    clearError();
  };

  const stateClass = (): string => {
    switch (state) {
      case 'online':
        return 'status-ok';
      case 'crashed':
        return 'status-danger';
      case 'starting':
      case 'stopping':
        return 'status-warn';
      default:
        return 'muted';
    }
  };

  return (
    <div className="panel">
      <div className="panel-title-row">
        <h2 className="panel-title">Server Controls</h2>
        <div className="dash-row">
          <span className={`status-dot ${stateClass()}`} />
          <span className={state === 'crashed' ? 'text-danger' : ''}>
            {STATE_LABEL[state] ?? state}
          </span>
          {pid !== null && <span className="muted">PID {pid}</span>}
          {uptimeSeconds > 0 && state !== 'offline' && (
            <span className="muted">{formatUptime(uptimeSeconds)}</span>
          )}
          {state === 'crashed' && exitCode !== null && (
            <span className="text-danger">exit {exitCode}</span>
          )}
        </div>
      </div>

      <div className="dash-row">
        <button
          type="button"
          className="btn btn-start"
          disabled={state === 'online' || state === 'starting' || state === 'stopping'}
          onClick={() => void start()}
        >
          Start
        </button>
        <button
          type="button"
          className="btn btn-stop"
          disabled={state === 'offline' || state === 'stopping'}
          onClick={() => void stop()}
        >
          Stop
        </button>
        <button
          type="button"
          className="btn btn-restart"
          disabled={state === 'offline' || state === 'starting' || state === 'stopping'}
          onClick={() => void restart()}
        >
          Restart
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={state === 'offline'}
          onClick={() => void forceKill()}
        >
          Force Kill
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void api.openServerFolder(server.folderPath)}
        >
          Open Folder
        </button>
      </div>

      <div className="dash-row muted">
        <span>{server.folderPath}</span>
        {isBedrock ? (
          <>
            <span>· Bedrock server</span>
            <span>· port {server.port}</span>
          </>
        ) : (
          <>
            <span>· {server.memoryMb} MB</span>
            {server.javaPath ? (
              <span>· {server.javaPath}</span>
            ) : (
              <span className="text-danger">· no Java configured</span>
            )}
          </>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {javaDialogOpen && !isBedrock && (
        <JavaRequiredDialog
          server={server}
          requirement={requirement}
          onClose={() => {
            setJavaDialogOpen(false);
            clearError();
          }}
          onJavaInstalled={handleJavaInstalled}
        />
      )}
    </div>
  );
}

function formatUptime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
